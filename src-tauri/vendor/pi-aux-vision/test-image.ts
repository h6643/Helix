import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const execFileAsync = promisify(execFile);

/** 兜底:1x1 红色 PNG(验证链路用,PowerShell 不可用时)。 */
const FALLBACK_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/**
 * 生成一张测试图(白底 + 标题文字 + 红/蓝/绿色块),用于 /vision test 验证全链路。
 * 优先用 PowerShell + System.Drawing(Windows),失败回退内嵌最小 PNG。
 */
export async function generateTestImage(): Promise<string> {
  const outPath = path.join(os.tmpdir(), "pi-aux-vision-test.png");
  const escaped = outPath.replace(/'/g, "''");

  const script = String.raw`
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 480, 240
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$g.FillRectangle([System.Drawing.Brushes]::Yellow, 0, 0, 480, 40)
$font = New-Object System.Drawing.Font("Arial", 26, [System.Drawing.FontStyle]::Bold)
$g.DrawString("AUX-VISION TEST 1234", $font, [System.Drawing.Brushes]::Black, 16, 60)
$g.FillRectangle([System.Drawing.Brushes]::Red, 40, 140, 120, 60)
$g.FillRectangle([System.Drawing.Brushes]::Blue, 200, 140, 120, 60)
$g.FillRectangle([System.Drawing.Brushes]::Green, 360, 140, 80, 60)
$bmp.Save('${escaped}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
`;

  try {
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 15000, windowsHide: true },
    );
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) return outPath;
  } catch {
    // fall through to embedded fallback
  }

  fs.writeFileSync(outPath, Buffer.from(FALLBACK_PNG_BASE64, "base64"));
  return outPath;
}
