/**
 * 侧边栏文档预览：把 Office / PDF / 图片 / 音视频的「字节」变成右侧栏能渲染的
 * 结构。
 *
 * 为什么不用现成库：
 *   · PDF 真要渲染得引 pdf.js（~1MB worker + canvas 渲染管线）；
 *   · PPTX/DOCX/XLSX 真要还原版面得引 pptxgenjs / mammoth / SheetJS。
 * 这些对「侧栏里瞄一眼这个文件是什么」来说太重了。这里走**轻量结构化提取**：
 * OOXML 本质是 zip（fflate 解包）+ XML，所以：
 *     PPTX → 每页一个「标题 + 段落（带缩进层级）」列表；
 *     DOCX → 段落流（Heading1..6 / List / Quote 带样式）；
 *     XLSX → 每个 sheet 的二维网格（含共享字符串展开）。
 * 文本按 `<a:br/>` / `<w:br/>` 拆行、按 `<a:p>` / `<w:p>` 分段，**不丢内容**；
 * 丢的只是字体、颜色、图片这些版面信息 —— 预览本来就不承诺还原版面。
 *
 * 图片 / 音频 / 视频 / PDF 走 data URL 直出（PDF 用 <embed> 让系统/浏览器自己
 * 渲染），不解析内容。
 *
 * 边界：所有解析都包在 try/catch 里，失败一律降级成「用外部程序打开」——
 * 预览是锦上添花，绝不能因为它把文件树点开文件这件事卡死。
 */
import { strFromU8, unzipSync } from "fflate";

// ── 类型 ─────────────────────────────────────────────────────────────────────

/** 预览渲染器按这个联合类型分派。 */
export type DocPreview =
  | { kind: "pptx"; pages: PptxSlide[] }
  | { kind: "docx"; blocks: DocxBlock[] }
  | { kind: "xlsx"; sheets: XlsxSheet[] }
  | { kind: "text"; text: string; language: string }
  | { kind: "pdf"; dataUrl: string }
  | { kind: "image"; dataUrl: string; name: string }
  | { kind: "audio"; dataUrl: string; name: string }
  | { kind: "video"; dataUrl: string; name: string };

export interface PptxSlide {
  /** 1-based slide number（展示用）。 */
  index: number;
  title: string;
  paragraphs: PptxPara[];
  /** 备注页文本（演讲者备注）。 */
  notes?: string;
}

export interface PptxPara {
  text: string;
  /** 缩进层级（OOXML 的 lvl，0..8）。 */
  level: number;
  /** 是否来自标题占位符。 */
  heading: boolean;
}

export type DocxBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "para"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "table"; rows: string[][] };

export interface XlsxSheet {
  name: string;
  /** 行数组；每行是单元格字符串（空单元格用 "" 占位）。 */
  rows: string[][];
}

// ── 文件类型识别 ─────────────────────────────────────────────────────────────

/** 侧栏能内嵌预览的扩展名 → 预览器。不含的一律走外部程序打开。 */
export type PreviewKind =
  | "pptx"
  | "docx"
  | "xlsx"
  | "pdf"
  | "image"
  | "audio"
  | "video"
  | "text";

const EXT_KIND: Record<string, PreviewKind> = {
  // Office
  pptx: "pptx",
  docx: "docx",
  xlsx: "xlsx",
  // 老二进制格式（.ppt/.xls/.doc）不走解析，交给外部程序
  // PDF
  pdf: "pdf",
  // 图片
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  ico: "image",
  avif: "image",
  svg: "image",
  // 音频
  mp3: "audio",
  wav: "audio",
  flac: "audio",
  ogg: "audio",
  m4a: "audio",
  aac: "audio",
  opus: "audio",
  // 视频
  mp4: "video",
  webm: "video",
  mov: "video",
  mkv: "video",
  avi: "video",
};

const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  opus: "audio/opus",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  pdf: "application/pdf",
};

/** 侧栏可直接内嵌预览的扩展名集合（文件树用：命中就不当作文本编辑）。 */
export function previewKindOf(name: string): PreviewKind | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return EXT_KIND[name.slice(dot + 1).toLowerCase()] ?? null;
}

export function mimeForExt(ext: string): string {
  return EXT_MIME[ext.toLowerCase()] ?? "application/octet-stream";
}

// ── base64 → 字节 ────────────────────────────────────────────────────────────

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.includes(",") ? b64.slice(b64.indexOf(",") + 1) : b64;
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** base64 → 字节（预览面板把 readBinary 的结果喂给 pptx-preview 的 ArrayBuffer）。 */
export function bytesFromBase64(b64: string): Uint8Array {
  return base64ToBytes(b64);
}

function dataUrl(kind: string, ext: string, b64: string): string {
  return `data:${mimeForExt(ext)};base64,${b64}`;
}

// ── XML 小工具（不用 DOMParser：侧栏预览要在 worker 外同步跑，且 XML 结构极简单，
//    正则足够；DOMParser 在 SSR/测试环境还得兜底） ──────────────────────────────

/** XML 实体解码（&amp; &lt; &gt; &quot; &apos; &#xNN; &#NN;）。 */
function unescapeXml(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ent: string) => {
    if (ent[0] === "#") {
      const code =
        ent[1] === "x" || ent[1] === "X"
          ? parseInt(ent.slice(2), 16)
          : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    switch (ent) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        return m;
    }
  });
}

/** 取一段 XML 里所有 <tag ...>…</tag> / 自闭合的 <tag .../>。
 *  自闭合标签（如 <p:sldId r:id="rId7"/>）inner 为空串。
 *
 *  命名空间前缀必须可选：OOXML 的标签几乎都带前缀（<p:sldId>、<w:p>、<a:t>），
 *  少数内部件（.rels 的 <Relationship>）不带。写死 <tag 会什么都匹配不到。 */
function allTags(xml: string, tag: string): Array<{ attrs: string; inner: string }> {
  const out: Array<{ attrs: string; inner: string }> = [];
  // `String.raw` 是必须的：普通模板字符串里 `\\s` 会被 JS 转义成 `s`（单个字母），
  // 拼出的正则语义完全错（表现就是 allTags 恒返回空，解析不出任何东西）。
  const re = new RegExp(
    String.raw`<(?:[A-Za-z0-9_]+:)?${tag}(\s[^>]*?)?(?:/>|>([\s\S]*?)</(?:[A-Za-z0-9_]+:)?${tag}>)`,
    "g",
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push({ attrs: m[1] ?? "", inner: m[2] ?? "" });
  return out;
}

/** 一段 XML 里的纯文本：丢掉所有标签，但保留 <a:br>/<w:br> 为换行。 */
function textOf(xml: string): string {
  const withBreaks = xml.replace(/<(?:a|w):br\s*\/?>/g, "\u0000BR\u0000");
  const stripped = withBreaks.replace(/<[^>]*>/g, "");
  return unescapeXml(stripped)
    .split("\u0000BR\u0000")
    .join("\n")
    .replace(/\r\n?/g, "\n")
    .trim();
}

/** 读属性值：attrs=" id="256" lvl="1"" + name="lvl" → "1"。 */
function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`));
  return m ? m[1] : null;
}

/** 数值属性，缺省/非法给 fallback。 */
function attrNum(attrs: string, name: string, fallback: number): number {
  const v = attr(attrs, name);
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// ── PPTX ────────────────────────────────────────────────────────────────────

/**
 * 解析 PPTX：`ppt/presentation.xml` 的 `<p:sldIdLst>` 决定页序，每条
 * `<p:sldId r:id="rIdN"/>` 经 `ppt/_rels/presentation.xml.rels` 找到
 * `ppt/slides/slideN.xml`。**不能**直接按 slide1..slideN 文件名排序：
 * 用户删过页时文件名与展示顺序会错位（PowerPoint 复用文件名）。
 */
function parsePptx(files: Record<string, Uint8Array>): DocPreview {
  const presRaw = files["ppt/presentation.xml"];
  const relsRaw = files["ppt/_rels/presentation.xml.rels"];
  if (!presRaw || !relsRaw) throw new Error("不是有效的 PPTX（缺 presentation.xml）");

  // rId → slide 部件路径。Target 是相对 ppt/ 的相对路径（如 slides/slide1.xml）。
  const ridToTarget = new Map<string, string>();
  for (const r of allTags(strFromU8(relsRaw), "Relationship")) {
    const type = attr(r.attrs, "Type") ?? "";
    if (!type.endsWith("/slide")) continue;
    const id = attr(r.attrs, "Id");
    const target = attr(r.attrs, "Target");
    if (!id || !target) continue;
    // 少数文件带 ../ 或绝对化路径（见 normalizePart）。
    ridToTarget.set(id, normalizePart(target, "ppt"));
  }

  const sldIds = allTags(strFromU8(presRaw), "sldId");
  const pages: PptxSlide[] = [];
  for (const sld of sldIds) {
    const rid = attr(sld.attrs, "r:id") ?? attr(sld.attrs, "id");
    const part = rid ? ridToTarget.get(rid) : undefined;
    if (!part || !files[part]) continue;
    const xml = strFromU8(files[part]);
    const slide = parseSlideXml(xml, pages.length + 1);
    // 备注：ppt/notesSlides/notesSlideN.xml，按 rels 找（slide 自己的 rels 里
    // 有一条 notesSlide 关系）。找不到就跳过，不影响正文。
    const relPart = part.replace(/([^/]+)$/, "_rels/$1.rels");
    const slideRels = files[relPart] ? strFromU8(files[relPart]) : "";
    const noteRel = slideRels
      ? allTags(slideRels, "Relationship").find((r) =>
          (attr(r.attrs, "Type") ?? "").endsWith("/notesSlide"),
        )
      : undefined;
    const noteTarget = noteRel ? attr(noteRel.attrs, "Target") : null;
    if (noteTarget) {
      const notePart = normalizePart(noteTarget, "ppt");
      if (files[notePart]) {
        // 备注页里 <p:ph type="body"/> 是正文，sldNum 是页码占位符 —— 取 body。
        const noteXml = strFromU8(files[notePart]);
        const bodies = allTags(noteXml, "sp").filter((sp) => {
          const ph = allTags(sp.inner, "ph")[0];
          const t = ph ? attr(ph.attrs, "type") : null;
          return t == null || t === "body";
        });
        const noteText = bodies.map((sp) => textOf(sp.inner)).filter(Boolean).join("\n");
        if (noteText) slide.notes = noteText;
      }
    }
    pages.push(slide);
  }
  if (pages.length === 0) throw new Error("PPTX 里没有可解析的幻灯片");
  return { kind: "pptx", pages };
}

/** 一页幻灯片 → 标题 + 段落列表。 */
function parseSlideXml(xml: string, index: number): PptxSlide {
  const paragraphs: PptxPara[] = [];
  let title = "";
  // 表格在 <p:graphicFrame> 里（<a:tbl>），不在 <p:sp> 里 —— python-pptx 的
  // add_table / PowerPoint 的「插入表格」都走 graphicFrame。所以表格要单独扫一遍，
  // 否则整张表格在预览里彻底消失。
  for (const tbl of allTags(xml, "tbl")) {
    for (const tr of allTags(tbl.inner, "tr")) {
      const cells = allTags(tr.inner, "tc").map((tc) => {
        const txBody = allTags(tc.inner, "txBody")[0];
        return textOf(txBody ? txBody.inner : tc.inner);
      });
      const rowText = cells.filter(Boolean).join(" | ");
      if (rowText) paragraphs.push({ text: rowText, level: 0, heading: false });
    }
  }
  for (const sp of allTags(xml, "sp")) {
    const ph = allTags(sp.inner, "ph")[0];
    const phType = ph ? attr(ph.attrs, "type") : null;
    const isTitle = phType === "title" || phType === "ctrTitle";
    for (const txBody of allTags(sp.inner, "txBody")) {
      for (const p of allTags(txBody.inner, "p")) {
        const pPr = allTags(p.inner, "pPr")[0];
        const level = pPr ? attrNum(pPr.attrs, "lvl", 0) : 0;
        const text = textOf(p.inner);
        if (!text) continue;
        if (isTitle && !title) title = text;
        paragraphs.push({ text, level, heading: isTitle });
      }
    }
  }
  if (!title) {
    // 没有标题占位符：拿第一段当标题（WPS/Keynote 导出的文件常见）。
    title = paragraphs[0]?.text ?? `第 ${index} 页`;
  }
  return { index, title, paragraphs };
}

// ── DOCX ────────────────────────────────────────────────────────────────────

/**
 * 解析 DOCX：`word/document.xml` 的主体 `<w:body>`。按 `<w:p>` 分段，
 * 样式名决定标题层级（Heading1..6）；连续的 `<w:p>` 带 `<w:numPr>` 合成一个
 * 列表块；`<w:tbl>` 按行展开。
 */
function parseDocx(files: Record<string, Uint8Array>): DocPreview {
  const raw = files["word/document.xml"];
  if (!raw) throw new Error("不是有效的 DOCX（缺 word/document.xml）");
  const bodyMatch = /<w:body[^>]*>([\s\S]*?)<\/w:body>/.exec(strFromU8(raw));
  const body = bodyMatch ? bodyMatch[1] : "";
  const blocks: DocxBlock[] = [];
  // 按顶层块切：p / tbl（table 里也可能有 p，但那属于表格自己的行）。
  const blockRe = /<w:(p|tbl)(\s[^>]*)?>([\s\S]*?)<\/w:\1>/g;
  let m: RegExpExecArray | null;
  let listBuffer: { ordered: boolean; items: string[] } | null = null;
  const flushList = () => {
    if (listBuffer && listBuffer.items.length > 0) {
      blocks.push({
        kind: "list",
        ordered: listBuffer.ordered,
        items: listBuffer.items,
      });
    }
    listBuffer = null;
  };

  while ((m = blockRe.exec(body))) {
    const tag = m[1];
    const inner = m[3] ?? "";
    if (tag === "tbl") {
      flushList();
      const rows = allTags(inner, "tr").map((tr) =>
        allTags(tr.inner, "tc").map((tc) => {
          const cellText = allTags(tc.inner, "p")
            .map((p) => textOf(p.inner))
            .filter(Boolean)
            .join(" ");
          return cellText;
        }),
      );
      if (rows.length > 0) blocks.push({ kind: "table", rows });
      continue;
    }
    // <w:p>
    const text = textOf(inner);
    const style = /<w:pStyle\s+w:val="([^"]*)"/.exec(inner)?.[1] ?? "";
    const headingLevel = headingLevelFromStyle(style);
    if (headingLevel) {
      flushList();
      if (text) blocks.push({ kind: "heading", level: headingLevel, text });
      continue;
    }
    // 列表：两种标记方式都要认 ——
    //   1. `<w:numPr>`（Word 直接引用编号定义，LibreOffice/WPS 常用）；
    //   2. `<w:pStyle w:val="ListBullet|ListNumber…">`（python-docx 的
    //      List Bullet / List Number 样式，只写样式名不带 numPr）。
    // 只认第一种时这类文件的列表会全部掉成普通段落（层级全丢）。
    const numPrMatch = /<w:numPr[\s>/]/.exec(inner);
    const listStyle = /^(ListBullet|ListNumber|ListParagraph\d*)$/i.exec(style.trim());
    const isList = !!numPrMatch || !!listStyle;
    if (isList) {
      // ListNumber 是十进制；ListBullet / ListParagraph 一律当无序（Word 的
      // 「项目符号」样式名下也可能是多级符号，预览只承诺「看得出是列表」）。
      const ordered =
        (numPrMatch && /<w:numFmt\s+w:val="decimal"/.test(inner)) ||
        /^ListNumber/i.test(style.trim());
      if (!listBuffer || listBuffer.ordered !== ordered) {
        flushList();
        listBuffer = { ordered, items: [] };
      }
      if (text) listBuffer.items.push(text);
      continue;
    }
    flushList();
    if (text) blocks.push({ kind: "para", text });
  }
  flushList();
  if (blocks.length === 0) throw new Error("DOCX 里没有可解析的文本");
  return { kind: "docx", blocks };
}

function headingLevelFromStyle(style: string): number | null {
  const m = /^heading\s*([1-9])$/i.exec(style.trim());
  if (m) return Number(m[1]);
  // 中文样式名（Word 的「标题 1」）
  const zh = /^标题\s*([1-9])$/.exec(style.trim());
  if (zh) return Number(zh[1]);
  if (/^(title)$/i.test(style.trim())) return 1;
  return null;
}

// ── XLSX ────────────────────────────────────────────────────────────────────

/**
 * 把 .rels 里的 Target 归一成 zip 内的部件路径。
 *
 * OOXML 的 Target 有三种写法：
 *   · `worksheets/sheet1.xml`   —— 相对当前部件所在目录（最常见）；
 *   · `/xl/worksheets/sheet1.xml` —— 包内绝对路径（openpyxl / Excel 常用）；
 *   · `../slides/slide1.xml`     —— 相对但带 `..`。
 * 直接字符串拼接会把后两种拼成 `xl//xl/…` 这种查不到的路径，
 * 所以先判绝对、再归一切掉前导 `/`。
 */
function normalizePart(target: string, baseDir: string): string {
  let t = target.replace(/\\/g, "/");
  if (t.startsWith("/")) return t.slice(1);
  t = t.replace(/^\.\//, "");
  while (t.startsWith("../")) t = t.slice(3);
  return `${baseDir}/${t}`;
}

/**
 * 解析 XLSX：
 *   · `xl/workbook.xml` 的 `<sheet name=… r:id=…>` → 经 workbook.xml.rels 找到
 *     `xl/worksheets/sheetN.xml`；
 *   · 单元格字符串存在 `xl/sharedStrings.xml`（`<si>` 里的 `<t>`，可能多个 run），
 *     引用时 `<c t="s"><v>idx</v></c>`；
 *   · 数字直接读 `<v>`，布尔读 `t="b"`，公式读 `<f>` 后的 `<v>`（缓存值）。
 */
function parseXlsx(files: Record<string, Uint8Array>): DocPreview {
  const wbRaw = files["xl/workbook.xml"];
  if (!wbRaw) throw new Error("不是有效的 XLSX（缺 xl/workbook.xml）");
  const relsRaw = files["xl/_rels/workbook.xml.rels"];

  const ridToTarget = new Map<string, string>();
  if (relsRaw) {
    for (const r of allTags(strFromU8(relsRaw), "Relationship")) {
      const id = attr(r.attrs, "Id");
      const target = attr(r.attrs, "Target");
      if (id && target) {
        ridToTarget.set(id, normalizePart(target, "xl"));
      }
    }
  }

  const shared: string[] = [];
  const ssRaw = files["xl/sharedStrings.xml"];
  if (ssRaw) {
    for (const si of allTags(strFromU8(ssRaw), "si")) {
      // <si><t>a</t><r><t>b</t></r></si> —— 富文本 run 拼接。
      shared.push(textOf(si.inner).replace(/\n/g, " "));
    }
  }

  const sheets: XlsxSheet[] = [];
  const wb = strFromU8(wbRaw);
  for (const sh of allTags(wb, "sheet")) {
    const name = attr(sh.attrs, "name") ?? `Sheet${sheets.length + 1}`;
    const rid = attr(sh.attrs, "r:id") ?? attr(sh.attrs, "id");
    const part = rid ? ridToTarget.get(rid) : undefined;
    if (!part || !files[part]) continue;
    const xml = strFromU8(files[part]);
    const rows: string[][] = [];
    for (const tr of allTags(xml, "row")) {
      const cells: string[] = [];
      for (const c of allTags(tr.inner, "c")) {
        const t = attr(c.attrs, "t");
        const r = attr(c.attrs, "r") ?? "";
        // 列号 → 0-based 下标，空单元格要补位（Excel 允许跳列）。
        const colIdx = colFromRef(r);
        while (cells.length < colIdx) cells.push("");
        const v = allTags(c.inner, "v")[0];
        if (t === "s") {
          const idx = v ? Number(textOf(v.inner)) : NaN;
          cells.push(Number.isFinite(idx) ? (shared[idx] ?? "") : "");
        } else if (t === "inlineStr") {
          cells.push(textOf(c.inner));
        } else if (t === "b") {
          cells.push(v && textOf(v.inner) === "1" ? "TRUE" : "FALSE");
        } else {
          cells.push(v ? textOf(v.inner) : "");
        }
      }
      rows.push(cells);
    }
    sheets.push({ name, rows });
  }
  if (sheets.length === 0) throw new Error("XLSX 里没有可解析的工作表");
  return { kind: "xlsx", sheets };
}

/** "C7" → 2（0-based 列下标）。 */
function colFromRef(ref: string): number {
  const m = /^([A-Z]+)/.exec(ref.toUpperCase());
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// ── 文本类（.md/.csv/.json… 仍是代码编辑器的事，这里只兜底真正的大段文本） ────

// ── 入口 ────────────────────────────────────────────────────────────────────

/**
 * 把文件字节变成预览结构。
 *
 * @param name    文件名（用来判扩展名）
 * @param base64  文件内容（`fs.readBinary` 的返回值）
 */
export function buildPreview(name: string, base64: string): DocPreview {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  const kind = EXT_KIND[ext];
  if (!kind) throw new Error(`不支持预览的文件类型：.${ext}`);

  if (kind === "image") return { kind: "image", dataUrl: dataUrl("image", ext, base64), name };
  if (kind === "audio") return { kind: "audio", dataUrl: dataUrl("audio", ext, base64), name };
  if (kind === "video") return { kind: "video", dataUrl: dataUrl("video", ext, base64), name };
  if (kind === "pdf") return { kind: "pdf", dataUrl: dataUrl("pdf", ext, base64) };

  // OOXML：zip 解包后按部件解析。解包失败说明文件不是真 zip（改扩展名的
  // 二进制、损坏文件）→ 抛错由调用方降级成外部打开。
  const files = unzipSync(base64ToBytes(base64)) as Record<string, Uint8Array>;
  if (kind === "pptx") return parsePptx(files);
  if (kind === "docx") return parseDocx(files);
  if (kind === "xlsx") return parseXlsx(files);
  throw new Error(`未实现的预览类型：${kind}`);
}
