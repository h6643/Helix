/**
 * Text processing utilities — extracted from agent-flow-panel.tsx.
 * Pure functions with no React dependency.
 */

const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/gi;

/**
 * Decode a base64 string into UTF-8 text (handles multi-byte characters).
 */
export function decodeBase64Utf8(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Parse ALL <think:ID>...</think:ID> tags from model output.
 * Returns the content outside the tags and concatenated reasoning.
 */
export function extractThinkTags(text: string): {
  content: string;
  reasoning: string | null;
} {
  const parts: string[] = [];
  let remaining = text;
  let hasMatch = false;
  const re = /<think:([a-zA-Z0-9_-]+)>([\s\S]*?)<\/think:\1>/;
  let match: RegExpMatchArray | null;
  while ((match = remaining.match(re)) !== null) {
    hasMatch = true;
    parts.push(match[2].trim());
    remaining = (
      remaining.slice(0, match.index) +
      remaining.slice((match.index || 0) + match[0].length)
    ).trimStart();
  }
  if (!hasMatch) return { content: text, reasoning: null };
  return { content: remaining, reasoning: parts.join("\n\n") || null };
}

/**
 * Normalize ACP content to plain text.
 * Handles string, array, object, and null/undefined inputs.
 */
export function normalizeAcpContent(
  content: unknown,
  opts?: { stripSystemReminder?: boolean },
): string {
  let text = "";
  if (typeof content === "string") text = content;
  else if (content === null || content === undefined) text = "";
  else if (Array.isArray(content))
    text = content
      .map((block: unknown) => normalizeAcpContent(block, opts))
      .join("");
  else if (typeof content === "object") {
    const obj = content as { text?: string; content?: string };
    if (typeof obj.text === "string") text = obj.text;
    else if (typeof obj.content === "string") text = obj.content;
    else text = JSON.stringify(obj);
  } else text = String(content);

  // Strip <system-reminder> tags only when requested — do NOT trim, because
  // Helix streams messages as word/token chunks and any trim() here would eat
  // the leading space of each chunk and glue words together ("I'llhelpyouexplore").
  const stripSystemReminder = opts?.stripSystemReminder ?? true;
  const cleaned = stripSystemReminder
    ? text.replace(SYSTEM_REMINDER_RE, "")
    : text;
  // Strip invisible transport control chars that overlap lines in pre-wrap
  // (lone CR = progress-bar carriage-return; ANSI CSI sequences).
  // Visible text, emoji and <system-reminder> are preserved.
  const sanitized = sanitizeControlChars(cleaned);
  // 剔掉泄进文本流的 chat-template 特殊 token（`<|...|>`）。这是传输层
  // 产物不是内容，正文与思考都不该显示（原始 bug：`</think>` 泄进可见
  // 转录）。普通渲染与 verbatim 展示都走这里，所以无条件剔。
  return stripSpecialTokens(sanitized);
}

/**
 * Flatten ACP content to a string for verbatim model-output display.
 * does NOT strip <system-reminder> tags and does NOT strip emoji.
 *
 * 一个例外：chat-template 特殊 token（`<|...|>`）**仍会被剔掉**。这类标记
 * 是传输层产物、不是内容，无论正文还是思考折叠都不该给用户看到（原始 bug
 * 就是 `</think>` 泄进可见转录；而转录的可见正文/思考都走本函数）。真正
 * 合法的 `<|XXX|>` 字面量（如展示模板语法）极少出现在模型回复里，两害相
 * 权取其轻：宁可漏展一个罕见模板示例，不可让用户天天看到脏 token。
 */
export function normalizeAcpContentRaw(content: unknown): string {
  return normalizeAcpContent(content, { stripSystemReminder: false });
}

// Remove control characters that cause line overlap in the webview:
//  - CR not followed by LF -> LF (prevents "carriage return to line start" overlap)
//  - ANSI CSI escape sequences (\x1b[...m / cursor moves) -> removed (rendered as garbage)
function sanitizeControlChars(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
// eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/**
 * 剩除泄进正文的模型**特殊 token**（chat-template 控制标记）。
 *
 * 背景：部分混合推理模型（DeepSeek-V3.2-think / V4 等）在思考段末尾会字面
 * 输出模板控制 token（如思考结束标记），本应是服务端的停止/分隔符。一旦上游
 * 没把它当结构分隔处理（不识别该 token、或思考/正文拼接逻辑把它当成普通内容），
 * 它就会以原文泄进文本流，在 UI 里变成一行「单独的 <think> 块」。Helix 不
 * 控制上游，只能在收口处剔掉这类标记。
 *
 * 只剔“确实是模板 token 形状”的子串：尖括号包裹、竖线界定、内部为
 * 字母数字下划线（大小写与词内位置不限，`think_END` 这类混合命名也能命中）。
 * 不会误删普通尖括号文本（markdown / HTML / 代码里 `<a|b>` 这种写法不常见，
 * 即便出现也只删一个孤立片段，不破坏结构）。
 */
const SPECIAL_TOKEN_RE = /<\|[A-Za-z0-9_]+\|>/g;
function stripSpecialTokens(s: string): string {
  // 快速门控：没有「<|」就不可能是模板 token，直接返回，避开正则开销。
  if (!s || !s.includes("<|")) return s;
  return s.replace(SPECIAL_TOKEN_RE, "");
}

const EMOJI_RE =
// eslint-disable-next-line no-misleading-character-class
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}\u{1F100}-\u{1F1FF}\u{1F200}-\u{1F2FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}\u{FE00}-\u{FE0F}\u{200D}]/gu;

/**
 * Strip emoji from model output (plain text, no emoji).
 */
export function stripEmoji(text: string): string {
  return text.replace(EMOJI_RE, "");
}

// Matches kaomoji status lines like "(¬_¬) reasoning..." / "_( ˘˘) computing..." etc.
// These are single-line status indicators emitted by some models inside thinking content.
//
// 形状必须是「括号脸 + 一个短状态词 + 省略号」：`_? (脸) [装饰] word...` 且整行到此为止。
// 旧写法用 `[¬˘•○⊙＞≦´・_~xX ]{2,}` 当脸，而字符类里**含空格** ⇒ `^\s*` 会把缩进让给
// 字符类，于是任意缩进行 / `• ` / `x ` / `_` 开头、以 "..." 结尾的普通正文都算命中：
// 思考里一句「  byte 0: 0 = QColor (not invalid?)...」会被剥成状态顶到标题上（标题字号
// 是正文 +2 且 font-medium、不截断）→ 整句换行两行，用户看到的就是「思考中右边突然
// 一大坨字」；那一行还会被从正文里删掉。所以：脸必须真的长在括号里，状态词必须紧跟
// 着脸、且是**单个**短词（后面不许再接正文，否则「某句…后面还有半段话…」会被整行吞掉），
// 再由 looksLikeKaomojiFace() 复核（不含汉字、至少一个符号笔画）。
const KAOMOJI_STATUS_RE =
  /^\s*_?\s*[（(]\s*([^（()）\n]{1,16})\s*[)）][^\w\s]{0,4}\s+\S{1,16}\.{2,}\s*$/;

// 状态位只放 3~8 个字符的颜文字短语。normalize 后仍然这么长 ⇒ 是正文伪装成状态行
// （没被 STATUS_ZH 归一成「推理中...」），不认、原行留在正文里。正则之外的第二道网：
// 以后正文再出现新的"像状态行"的形状，也不会再把标题顶成长句。
const KAOMOJI_STATUS_MAX_LEN = 24;

// Matches inline kaomoji status markers such as:
//   "( •_•)> reflecting...The user is saying..."
//   "(°ロ°) contemplating...The project directory..."
// Group 1 = the parenthesised face, group 2 = the status word. The face must
// pass looksLikeKaomojiFace() and the word must be in STATUS_ZH before the
// match counts — the bare shape also matches ordinary prose like
// "(代码 Code Font): Description...", which then renders as stripped junk.
const KAOMOJI_INLINE_STATUS_RE =
  /\(([^)]{1,40})\)[^\s\w]*\s+([a-zA-Z]{3,})\.{2,}/g;

// 汉字（含扩展 A 区与兼容表意文字）。假名不算：颜文字真会用到「°ロ°」。
const HAN_RE = /[㐀-䶿一-鿿豈-﫿]/;

/** 括号里到底是不是张脸：得有一个符号字符（¬ ˘ • ° ロ …），且不含汉字。 */
function looksLikeKaomojiFace(inner: string): boolean {
  if (!inner || HAN_RE.test(inner)) return false;
  // \w 只覆盖 ASCII，所以「非单词非空白」正好挑出颜文字那些符号笔画；
  // 纯「汉字 + 英文 + 空格」的括号注解过不了这一关（汉字那条也已经先拦掉）。
  return /[^\w\s]/.test(inner);
}

/**
 * Extract the last kaomoji status line from thinking content.
 * Returns { status, body } where `status` is the kaomoji line (or null)
 * and `body` is the remaining thinking text with the status line removed.
 *
 * Also detects inline status markers (e.g. model emits them mid-paragraph).
 * For inline markers the body is left unchanged and only the latest marker
 * is surfaced as the status.
 */
// 常见英文状态词 → 中文（用于去掉 kaomoji 后统一显示）
const STATUS_ZH: Record<string, string> = {
  reasoning: "推理中",
  thinking: "思考中",
  computing: "计算中",
  reflecting: "反思中",
  contemplating: "沉思中",
  analyzing: "分析中",
  searching: "搜索中",
  planning: "规划中",
  loading: "加载中",
  processing: "处理中",
  reading: "读取中",
  writing: "写入中",
  executing: "执行中",
  generating: "生成中",
  summarizing: "总结中",
};

// 去掉 kaomoji 前缀，并将英文状态词映射为中文
function normalizeKaomojiStatus(raw: string): string {
  if (!raw) return raw;
  const wordMatch = raw.match(/([a-zA-Z]{3,})/);
  if (wordMatch) {
    const word = wordMatch[1].toLowerCase();
    const zh = STATUS_ZH[word];
    if (zh) return zh + "...";
  }
// eslint-disable-next-line no-control-regex
  const ascii = raw.replace(/[^\x00-\x7F]/g, "").trim();
  const cleaned = ascii.replace(/^\s*[^A-Za-z0-9\s]+/, "").trim();
  return cleaned || raw;
}
export function extractKaomojiStatus(thinking: string): {
  status: string | null;
  body: string;
} {
  if (!thinking) return { status: null, body: "" };

  // 1) Stand-alone status line at the end of a line.
  // 命中还不够：括号里得真是张脸、且归一化之后仍是短状态词。两道都不放行的行
  // 原样留在正文里（也继续往上找更早的一行），不剥、不删。
  const lines = thinking.split("\n");
  let statusLine: string | null = null;
  let statusIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    const face = trimmed.match(KAOMOJI_STATUS_RE)?.[1];
    if (!face || !looksLikeKaomojiFace(face)) continue;
    const normalized = normalizeKaomojiStatus(trimmed);
    if (normalized.length > KAOMOJI_STATUS_MAX_LEN) continue;
    statusLine = normalized;
    statusIdx = i;
    break;
  }
  if (statusLine !== null) {
    const bodyLines = lines
      .slice(0, statusIdx)
      .concat(lines.slice(statusIdx + 1));
    return {
      status: statusLine,
      body: bodyLines.join("\n").trim(),
    };
  }

  // 2) Inline markers (no newline separation); return the latest one and keep the body intact.
  // 只认「括号里是脸 + 状态词在 STATUS_ZH 里」，两边都过不了就当没有状态 ——
  // 宁可不显示，也不要把正文里的括号注解剥成乱码标题。
  let inlineStatus: string | null = null;
  for (const m of thinking.matchAll(KAOMOJI_INLINE_STATUS_RE)) {
    const zh = STATUS_ZH[m[2].toLowerCase()];
    if (!zh || !looksLikeKaomojiFace(m[1])) continue;
    inlineStatus = zh + "...";
  }
  if (inlineStatus) {
    return { status: inlineStatus, body: thinking };
  }

  return { status: null, body: thinking };
}
