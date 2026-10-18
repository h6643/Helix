//! `export_slides_png` — 用本机 PowerPoint（COM 自动化）把 PPTX 逐页导出 PNG，
//! 给侧栏文档预览做「Office 级」渲染。
//!
//! 只在 Windows 有意义：COM 驱动的是用户自己装的 POWERPNT.EXE，版式、字体、
//! SmartArt 都是真 PowerPoint 的渲染结果。任何失败（没装 Office、被企业策略拦、
//! 超时）都只返回 Err，由前端降级到 pptx-preview 版面渲染，绝不弹错阻塞预览。

use crate::fs::resolve_safe;
use crate::state::AppState;
use base64::Engine;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn export_slides_png(
    state: State<'_, Arc<AppState>>,
    file_path: String,
) -> Result<Value, String> {
    export_slides_png_windows(state, &file_path)
}

const EXPORT_PS1: &str = r#"
param([string]$Src, [string]$OutDir)
$ErrorActionPreference = 'Stop'
try {
  $pp = New-Object -ComObject PowerPoint.Application
} catch {
  exit 3
}
$doc = $null
try {
  # Open(FileName, ReadOnly, Untitled, WithWindow)：只读 + 不弹窗口，
  # 不打扰用户已经打开的其他演示文稿。
  $doc = $pp.Presentations.Open($Src, $true, $false, $false)
  $n = $doc.Slides.Count
  for ($i = 1; $i -le $n; $i++) {
    $out = Join-Path $OutDir ('slide-{0:D3}.png' -f $i)
    $doc.Slides.Item($i).Export($out, 'PNG', 1280, 720)
  }
} finally {
  if ($null -ne $doc) { [void]$doc.Close() }
  # 故意不 Quit()：若用户正开着别的演示文稿，Quit 会连人家一起关掉，
  # 留一个后台 POWERPNT 进程远比丢用户数据便宜。
}
exit 0
"#;

#[cfg(windows)]
fn export_slides_png_windows(
    state: State<'_, Arc<AppState>>,
    file_path: &str,
) -> Result<Value, String> {
    use std::os::windows::process::CommandExt;
    use std::path::Path;

    let resolved = resolve_safe(&state, file_path).ok_or_else(|| "Path is outside working directory".to_string())?;
    let ext = resolved
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if ext != "pptx" {
        return Err("仅支持 .pptx 的原生导出".to_string());
    }
    if !Path::new(&resolved).is_file() {
        return Err("文件不存在".to_string());
    }

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let out_dir = std::env::temp_dir().join(format!("helix-ppt-{}-{}", std::process::id(), stamp));
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    // 清理路径很多：统一包一层，任何 return 前都把临时目录删掉。
    let body = || -> Result<Vec<String>, String> {
        let script = out_dir.join("export.ps1");
        std::fs::write(&script, EXPORT_PS1).map_err(|e| e.to_string())?;
        let mut cmd = std::process::Command::new("powershell.exe");
        cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&script)
            .arg("-Src")
            .arg(&resolved)
            .arg("-OutDir")
            .arg(&out_dir);
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
        let out = cmd.output().map_err(|e| format!("启动 PowerShell 失败: {e}"))?;
        if !out.status.success() {
            if out.status.code() == Some(3) {
                return Err("未检测到本机 PowerPoint".to_string());
            }
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(format!(
                "PowerPoint 导出失败: {}",
                if stderr.is_empty() { "未知错误" } else { &stderr }
            ));
        }
        let mut files: Vec<_> = std::fs::read_dir(&out_dir)
            .map_err(|e| e.to_string())?
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.starts_with("slide-") && n.ends_with(".png"))
                    .unwrap_or(false)
            })
            .collect();
        files.sort();
        if files.is_empty() {
            return Err("PowerPoint 导出了 0 页".to_string());
        }
        let engine = base64::engine::general_purpose::STANDARD;
        files
            .iter()
            .map(|p| {
                let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
                Ok(engine.encode(bytes))
            })
            .collect()
    };
    let slides = body();
    let _ = std::fs::remove_dir_all(&out_dir);
    Ok(json!({ "slides": slides? }))
}
