/**
 * Image processing utilities for clipboard paste support
 */

import type { ImageAttachment } from "@/stores/helix-store";

const MAX_IMAGE_SIZE = 2048; // Maximum dimension in pixels
const MAX_IMAGES_PER_MESSAGE = 5;
const SUPPORTED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

function validateImageType(type: string): boolean {
  return SUPPORTED_TYPES.includes(type);
}

function generateImageId(): string {
  return `img-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

async function getImageDimensions(
  dataUrl: string,
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () =>
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = reject;
    img.src = dataUrl;
  });
}

export async function compressImage(
  dataUrl: string,
  maxWidth: number = MAX_IMAGE_SIZE,
  quality: number = 0.85,
): Promise<string> {
  const { width, height } = await getImageDimensions(dataUrl);

  // No compression needed if already within limits
  if (width <= maxWidth && height <= maxWidth) {
    return dataUrl;
  }

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;

  // Calculate new dimensions maintaining aspect ratio
  let newWidth = width;
  let newHeight = height;
  if (width > height) {
    newWidth = Math.min(width, maxWidth);
    newHeight = Math.round((height / width) * newWidth);
  } else {
    newHeight = Math.min(height, maxWidth);
    newWidth = Math.round((width / height) * newHeight);
  }

  canvas.width = newWidth;
  canvas.height = newHeight;

  const img = await loadImage(dataUrl);
  ctx.drawImage(img, 0, 0, newWidth, newHeight);

  return canvas.toDataURL("image/jpeg", quality);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

export async function processClipboardImage(
  blob: Blob,
): Promise<ImageAttachment | null> {
  if (!validateImageType(blob.type)) {
    return null;
  }

  const dataUrl = await blobToDataUrl(blob);
  const compressed = await compressImage(dataUrl);
  const { width, height } = await getImageDimensions(compressed);

  return {
    id: generateImageId(),
    dataUrl: compressed,
    mediaType: blob.type,
    width,
    height,
    name: `clipboard-image-${Date.now()}.${blob.type.split("/")[1] || "png"}`,
  };
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * `blobToDataUrl` 的逆操作：把 Rust 回传的 data URL 变回 Blob，好让浏览器截图走
 * 粘贴那一条同样的加工管线（类型校验 / 压缩 / 尺寸）。用 atob 而不是
 * `fetch(dataUrl)` —— 后者要过页面的 CSP connect-src。
 */
export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(",");
  const meta = dataUrl.slice(5, comma); // 去掉 "data:"，取 ";base64" 前的 MIME
  const bin = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: meta.split(";")[0] || "image/png" });
}

/**
 * 把 data URL 重编码成 PNG Blob。
 *
 * 为什么非要重编码：Chromium（WebView2）的 `navigator.clipboard.write` 对图片
 * **只认 image/png**，塞 image/jpeg 会直接抛 NotAllowedError。粘贴进来的截图
 * 大多被 `compressImage` 压成了 JPEG，所以复制前必须过一道 canvas 转 PNG。
 */
export async function dataUrlToPngBlob(dataUrl: string): Promise<Blob> {
  const blob = dataUrlToBlob(dataUrl);
  if (blob.type === "image/png") return blob;

  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return blob;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (out) => (out ? resolve(out) : reject(new Error("png encode failed"))),
      "image/png",
    ),
  );
}

/**
 * 从粘贴板文本（text/html 或 text/plain）里找出内联图片的 data URL。
 *
 * 为什么需要：Helix 自己的「复制」为了图文一起写的是 text/html（图以
 * `data:image/...;base64,` 内联），粘回输入框时剪贴板没有原生 image/* 位图，
 * 得靠这段从 html 里把图捕回来。正则只抓 png/jpeg/webp/gif（与粘贴支持一致），
 * 并限制单张 base64 体量，避免把一整段超长文本当图误吞。
 */
export function extractImageDataUrls(text: string): string[] {
  if (!text) return [];
  const re = /data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]+)/gi;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // base64 体量上限 ~8MB（约 11M 字符），超出视为误匹配
    if (m[2].length > 11_000_000) continue;
    const sub = m[1].toLowerCase() === "jpg" ? "jpeg" : m[1].toLowerCase();
    out.push(`data:image/${sub};base64,${m[2]}`);
    if (out.length >= 5) break; // 与 MAX_IMAGES_PER_MESSAGE 对齐
  }
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 复制「文字 + 图片」到剪贴板。
 *
 * 两条关键约束（Chromium / WebView2 的 Async Clipboard API）：
 *  • **图片不能和文字装进同一个 ClipboardItem**（只允许 text/plain + text/html
 *    这类纯文本共存，一旦掺 image/* 就抛 NotSupportedError）——所以图文同现
 *    靠的是 `text/html`（图以 data URL 内联），而不是另开一路 image/png。
 *  • 一个 ClipboardItem 可放多种文本 MIME（text/plain + text/html），这样粘到
 *    富文本目标（Word/邮件/微信）拿 html（图文都在），粘到纯文本目标（记事本）
 *    拿 text/plain，不会因只给 html 而粘空。
 * 只有“无文字、单张图”的情况才走 image/png（粘进画图/聊天框直接成图）。
 *
 * 降级顺序：有文字→ text/plain + text/html；被拒→ 只留 text/plain；
 * 只有图→ image/png（被拒退回 data URL 文本）；环境缺 API → reject 给调用方，
 * 调用方再退回最原始的 writeText。
 *
 * ⚠ `ClipboardItem` 与 `write()` 必须在**点击事件的同步段**里完成（用户手势
 * 窗口）；PNG 编码以 `Promise<Blob>` 的形式塞进 item，不在这里 await。
 * 本函数**不同步抛错**：环境缺 API 时返回 rejected Promise，调用方的
 * `.catch` 分支才能接住。
 */
export function copyTextAndImages(
  text: string,
  imageDataUrls: string[],
): Promise<void> {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
    return Promise.reject(new Error("clipboard write unsupported"));
  }

  const html =
    `<p style="white-space:pre-wrap">${escapeHtml(text)}</p>` +
    imageDataUrls
      .map((d) => `<img src="${d}" style="max-width:100%"/>`)
      .join("");

  // 一次尝试一个载荷；前一种被拒再试下一种（tryWrite 里的同步构造不会
  // 拒——抛错也当 reject 接后走下一档）。
  const tryWrite = (
    items: Record<string, () => Blob | Promise<Blob>>,
  ): Promise<void> => {
    try {
      const built: Record<string, Blob | Promise<Blob>> = {};
      for (const [type, make] of Object.entries(items)) built[type] = make();
      return navigator.clipboard.write([new ClipboardItem(built)]);
    } catch (err) {
      return Promise.reject(
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  };

  const plain = () => new Blob([text], { type: "text/plain" });

  if (text && imageDataUrls.length > 0) {
    // 图文同现。Chromium 只禁止「图片 + 其他」同项，text/plain + text/html
    // 同项是允许的：这样粘到富文本目标（Word/邮件/微信）拿 html（图内联），
    // 粘到纯文本目标（记事本）拿 text/plain，不会因只给 html 而粘空。
    return tryWrite({
      "text/plain": plain,
      "text/html": () => new Blob([html], { type: "text/html" }),
    }).catch(() => tryWrite({ "text/plain": plain }));
  }
  if (text) {
    return tryWrite({ "text/plain": plain });
  }
  if (imageDataUrls.length > 0) {
    return tryWrite({
      "image/png": () => dataUrlToPngBlob(imageDataUrls[0]),
    }).catch(() =>
      tryWrite({
        "text/plain": () =>
          new Blob([imageDataUrls[0]], { type: "text/plain" }),
      }),
    );
  }
  return Promise.reject(new Error("nothing to copy"));
}

/**
 * 只复制一张图（image/png）。“消息里的图片想单独拷走”走这条：
 * 粘到画图 / 微信 / 聊天框都能直接出图。失败则抛错，调用方提提示。
 */
export async function copyImage(dataUrl: string): Promise<void> {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
    throw new Error("clipboard write unsupported");
  }
  const blob = await dataUrlToPngBlob(dataUrl); // 先编码，避开不支持 PNG 时白等
  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": new Blob([blob], { type: "image/png" }) }),
  ]);
}

export function canAddMoreImages(
  currentCount: number,
  newCount: number,
): boolean {
  return currentCount + newCount <= MAX_IMAGES_PER_MESSAGE;
}
