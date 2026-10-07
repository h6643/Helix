/**
 * Helix 应用自身的更新通道（tauri-plugin-updater）。
 *
 * 检查与安装是两个独立的 Rust 命令（helix_update / helix_update_install）。
 * 安装期间后端经 `helix:event` 回推两类事件：
 *   app_update_progress   { downloaded, total } —— 下载中（节流 ~256KB）
 *   app_update_installing {}                    —— 下载完，开始安装
 * 本模块把它们映射为一条可原地更新的 toast（含进度条）。
 *
 * Windows 语义：安装器（passive 进度窗）拉起后本进程立即退出，装完由
 * 安装器自动重启应用 —— 成功路径等不到 updateInstall 的 resolve；
 * 只有失败（如下载中断）才会 reject。
 */
import { useHelixStore } from "@/stores/helix-store";

export interface HelixAppUpdateInfo {
  available: boolean;
  current?: string;
  version?: string;
  notes?: string | null;
  date?: string | null;
}

/** 检查 GitHub Release 上是否有更新的 Helix 版本。失败（离线 / release
 *  尚无 latest.json）直接抛错，由调用方决定静默还是提示。 */
export async function checkHelixAppUpdate(): Promise<HelixAppUpdateInfo> {
  return await window.electron.helix.update();
}

let installing = false;

/** 一键下载并安装更新（Windows 上装完自动重启）。安装进行中重复调用会被忽略。 */
export async function installHelixAppUpdate(version?: string): Promise<void> {
  if (installing) return;
  installing = true;

  const label = version ? `Helix v${version}` : "Helix";
  const toastId = useHelixStore.getState().showToast({
    type: "info",
    title: `正在下载 ${label}`,
    description: "准备中…",
    duration: 0, // 常驻：由进度事件驱动文案/进度条，直到安装或失败
  });

  const unsubscribe = window.electron.helix.onEvent((method, params) => {
    if (method === "app_update_progress") {
      const p = params as { downloaded?: number; total?: number | null };
      const downloaded = p?.downloaded ?? 0;
      const total = p?.total ?? null;
      const pct =
        total && total > 0
          ? Math.min(100, Math.round((downloaded / total) * 100))
          : undefined;
      useHelixStore.getState().updateToast(toastId, {
        description:
          total && total > 0
            ? `已下载 ${fmtBytes(downloaded)} / ${fmtBytes(total)}（${pct}%）`
            : `已下载 ${fmtBytes(downloaded)}`,
        progress: pct,
      });
    } else if (method === "app_update_installing") {
      useHelixStore.getState().updateToast(toastId, {
        title: `正在安装 ${label}`,
        description: "应用将自动重启完成更新",
        progress: 100,
      });
    }
  });

  try {
    await window.electron.helix.updateInstall();
  } catch (e) {
    const st = useHelixStore.getState();
    st.dismissToast(toastId);
    st.showToast({
      type: "error",
      title: "更新失败",
      description: `${e instanceof Error ? e.message : String(e)}；点击重试`,
      duration: 12000,
      onClick: () => void installHelixAppUpdate(version),
    });
  } finally {
    unsubscribe();
    installing = false;
  }
}

/** 字节数说人话（下载进度用）。 */
function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 || v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
