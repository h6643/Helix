/**
 * 模型输入类型只允许「文字 + 可选图片」。
 *
 * pi 只检查 models.json 的 `input` 是否含 "image"：含则粘贴的图片原生透传，
 * 否则走视觉转述。旧配置可能残留 video/audio，读写边界统一归一化，避免
 * 「配置里只勾文字和图片」与落盘值不一致，也避免把遗留类型镜像到远端。
 */
export function normalizeModelInput(
  input?: readonly string[] | null,
): string[] {
  return input?.includes("image") ? ["text", "image"] : ["text"];
}

/** 缺省时保持缺省：写回 models.json 不该把已有的图片能力冲掉。 */
export function normalizeModelInputIfPresent(
  input?: readonly string[] | null,
): string[] | undefined {
  return input == null ? undefined : normalizeModelInput(input);
}
