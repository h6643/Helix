"use client";

/**
 * 右侧栏「文档」面：侧边栏里直接看 PPT / DOCX / XLSX / PDF / 图片 / 音视频。
 *
 * 为什么单独一面而不是塞进「代码」编辑器：代码编辑器是 CodeMirror 的文本世界，
 * 而这里要渲染的是结构化文档和媒体。两者生命周期也不同 —— 文档页签按文件走，
 * 走右栏的 pages 模型（与浏览器页、终端页同级），所以能多开、能单独关。
 *
 * 版面还原用四个动态 import 的引擎（都按需加载、不进主包）：
 * PPTX=@aiden0z/pptx-renderer(ZCode 同款)、DOCX=docx-preview、XLSX=SheetJS、
 * PDF=pdf.js（WebView2 没有内置 PDF 查看器，`<embed>` 是灰块）。
 * `@/lib/doc-preview` 的 fflate 纯文本提取是最后一层兜底；再失败降级成
 * 「外部打开」按钮，绝不把界面卡死。
 *
 * PPTX 是三级渲染：本机 PowerPoint COM 逐页导出的 PNG（最接近 Office）→
 * @aiden0z/pptx-renderer 纯前端版面还原（ZCode 同款：形状/文本/图表/SmartArt
 * 按 HTML/SVG 重绘）→ doc-preview 的纯文本提取。每一级失败都静默降到下一级，
 * 预览只是锦上添花。
 */
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  Loader2,
  Presentation,
} from "lucide-react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  buildPreview,
  bytesFromBase64,
  previewKindOf,
  type DocPreview,
  type DocxBlock,
  type PptxSlide,
  type XlsxSheet,
} from "@/lib/doc-preview";
import {
  electronFS,
  electronShell,
  getElectronAPI,
} from "@/lib/electron-bridge";
import type { PptxViewer as PptxViewerInstance } from "@aiden0z/pptx-renderer";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
} from "pdfjs-dist";

interface DocPreviewPanelProps {
  /** 文件绝对路径（文件树给的就是绝对路径）。 */
  path: string;
  name: string;
  onClose: () => void;
}

type LoadState =
  | { status: "loading" }
  | { status: "ok"; preview: DocPreview; base64: string }
  | { status: "error"; message: string };

/** 单次预览允许的最大字节数。与 Rust `read_binary` 的 32MB 上限对齐，
 *  前端先拦一次，省得白传 30MB base64 再把 DOM 撑爆。 */
const MAX_BYTES = 32 * 1024 * 1024;

/** COM 导出等 PowerPoint 冷启动，给足 30s；超时静默降级到版面渲染。 */
const NATIVE_EXPORT_TIMEOUT_MS = 30_000;

/** 试一下本机 PowerPoint COM 逐页导 PNG。没有通道（非 Windows / 旧 preload）、
 *  没装 Office、失败、超时一律返回 null 让调用方降级 —— 预览降级必须无声。 */
async function exportSlidesNative(path: string): Promise<string[] | null> {
  const fn = getElectronAPI()?.fs.exportSlidesPng;
  if (!fn) return null;
  try {
    const res = await Promise.race([
      fn(path),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("PowerPoint 导出超时")), NATIVE_EXPORT_TIMEOUT_MS),
      ),
    ]);
    return res.slides?.length ? res.slides : null;
  } catch {
    return null;
  }
}

export function DocPreviewPanel({ path, name, onClose }: DocPreviewPanelProps) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  // PPTX 原生渲染：null = 尚未拿到（走版面渲染），数组 = 每页 PNG base64
  // （PowerPoint 的本机渲染，优先级最高，到手后无缝替换版面视图）。
  const [nativeSlides, setNativeSlides] = useState<string[] | null>(null);
  const openExternal = useCallback(async () => {
      await electronShell.openPath(path);
  }, [path]);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    setNativeSlides(null);
    void (async () => {
      try {
        const base64 = await electronFS.readBinary(path);
        if (cancelled) return;
        // base64 长度 → 字节数：每 3 字节编码成 4 字符（含 padding）。
        const approxBytes = Math.floor((base64.length * 3) / 4);
        if (approxBytes > MAX_BYTES) {
          setState({
            status: "error",
            message: `文件约 ${(approxBytes / 1_048_576).toFixed(1)} MB，超过 32 MB 预览上限`,
          });
          return;
        }
        const preview = buildPreview(name, base64);
        if (cancelled) return;
        setState({ status: "ok", preview, base64 });
      } catch (e) {
        if (cancelled) return;
        setState({
          status: "error",
          message: (e as { message?: string })?.message || String(e),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, name]);

  // PPTX 额外起一条 PowerPoint COM 导出线（与解析并行）：先看到版面渲染，
  // COM 出图后无缝换成原生页面；失败/超时则一直停留在版面渲染。
  useEffect(() => {
    if (previewKindOf(name) !== "pptx") return;
    let cancelled = false;
    void (async () => {
      const slides = await exportSlidesNative(path);
      if (!cancelled && slides) setNativeSlides(slides);
    })();
    return () => {
      cancelled = true;
    };
  }, [path, name]);

  // 头部：文件图标 + 名称 + 外部打开 + 关闭。
  const header = (
    <div className="shrink-0 flex items-center gap-2 px-3 h-9 border-b border-border/20">
      <FileKindIcon kind={state.status === "ok" ? state.preview.kind : null} />
      <span className="min-w-0 flex-1 truncate text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/80" data-tip={path}>
        {name}
      </span>
      <button
        onClick={() => void openExternal()}
        className="p-1 rounded text-foreground/50 hover:text-foreground hover:bg-accent/50 transition-colors shrink-0"
        data-tip="用系统默认程序打开"
      >
        <ExternalLink className="size-3.5" />
      </button>
      <button
        onClick={onClose}
        className="p-1 rounded text-foreground/50 hover:text-foreground hover:bg-accent/50 transition-colors shrink-0"
        data-tip="关闭"
      >
        <ChevronLeft className="size-3.5 rotate-45" />
      </button>
    </div>
  );

  if (state.status === "loading") {
    return (
      <div className="flex-1 min-h-0 flex flex-col">
        {header}
        <div className="flex-1 flex items-center justify-center gap-2 text-muted-foreground/40">
          <Loader2 className="size-4 animate-spin" />
          <span className="text-[calc(var(--helix-transcript-size)*0.8571)]">
            正在解析…
          </span>
        </div>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="flex-1 min-h-0 flex flex-col">
        {header}
        <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
          <AlertTriangle className="size-8 text-amber-400/70" />
          <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/70">
            无法在侧栏预览这个文件
          </p>
          <p className="text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground/40 break-all">
            {state.message}
          </p>
          <button
            onClick={() => void openExternal()}
            className="mt-1 px-3 py-1.5 rounded-lg border border-border/60 text-[calc(var(--helix-transcript-size)*0.8571)] hover:bg-accent/50 transition-colors"
          >
            用系统默认程序打开
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {header}
      <PreviewBody
        preview={state.preview}
        base64={state.base64}
        nativeSlides={nativeSlides}
        path={path}
      />
    </div>
  );
}

function FileKindIcon({ kind }: { kind: DocPreview["kind"] | null }) {
  const cls = "size-3.5 shrink-0 text-foreground/50";
  if (kind === "pptx") return <Presentation className={cls} />;
  if (kind === "xlsx") return <FileSpreadsheet className={cls} />;
  if (kind === "docx") return <FileText className={cls} />;
  return <FileText className={cls} />;
}

function PreviewBody({
  preview,
  base64,
  nativeSlides,
  path,
}: {
  preview: DocPreview;
  base64: string;
  nativeSlides: string[] | null;
  path: string;
}) {
  if (preview.kind === "image") {
    return (
      <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center p-4 bg-muted/20">
        <img
          src={preview.dataUrl}
          alt={preview.name}
          className="max-w-full max-h-full object-contain rounded"
        />
      </div>
    );
  }
  if (preview.kind === "audio") {
    return (
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-4 p-6">
        <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/70 truncate max-w-full">
          {preview.name}
        </p>
        {/* controls 必填：没有它某些平台渲染成 0 高度的空条。 */}
        <audio src={preview.dataUrl} controls className="w-full max-w-[320px]" />
      </div>
    );
  }
  if (preview.kind === "video") {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center bg-black/40">
        <video src={preview.dataUrl} controls className="max-w-full max-h-full" />
      </div>
    );
  }
  if (preview.kind === "pdf") {
    return <PdfJsView base64={base64} dataUrl={preview.dataUrl} />;
  }
  if (preview.kind === "pptx") {
    if (nativeSlides) {
      return <PptxNativeView images={nativeSlides} />;
    }
    return <PptxLayoutView base64={base64} pages={preview.pages} />;
  }
  if (preview.kind === "docx") {
    return <DocxLayoutView base64={base64} blocks={preview.blocks} />;
  }
  if (preview.kind === "xlsx") {
    return <XlsxGridView base64={base64} sheets={preview.sheets} path={path} />;
  }
  // doc-preview 目前不会产出 text（纯文本走代码编辑器），兜底防漏判。
  return null;
}

// ── PPTX ────────────────────────────────────────────────────────────────────

/** 三级 PPTX 渲染共用的翻页条。 */
function SlidePager({
  index,
  total,
  setSlide,
}: {
  index: number;
  total: number;
  setSlide: (n: number) => void;
}) {
  return (
    <div className="shrink-0 flex items-center gap-1 px-2 py-1 border-b border-border/20">
      <button
        onClick={() => setSlide(index - 1)}
        disabled={index === 0}
        className="p-1 rounded text-foreground/60 hover:text-foreground hover:bg-accent/50 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
        data-tip="上一页"
      >
        <ChevronLeft className="size-3.5" />
      </button>
      <span className="text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground/70 tabular-nums">
        {index + 1} / {total}
      </span>
      <button
        onClick={() => setSlide(index + 1)}
        disabled={index >= total - 1}
        className="p-1 rounded text-foreground/60 hover:text-foreground hover:bg-accent/50 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
        data-tip="下一页"
      >
        <ChevronRight className="size-3.5" />
      </button>
    </div>
  );
}

/** 第一级：本机 PowerPoint（COM）导出的逐页 PNG —— 版式、字体、图表都是
 *  Office 自己的渲染结果。整册竖向滚动，和 Office 缩略流一致。 */
function PptxNativeView({ images }: { images: string[] }) {
  return (
    <div className="flex-1 min-h-0 overflow-auto bg-muted/30 p-3">
      <div className="flex flex-col items-center gap-3">
        {images.map((b64, i) => (
          <img
            key={i}
            src={`data:image/png;base64,${b64}`}
            alt={`第 ${i + 1} 页`}
            className="w-full max-w-[960px] object-contain bg-white shadow-sm"
          />
        ))}
      </div>
    </div>
  );
}

/** 第二级：@aiden0z/pptx-renderer 纯前端版面还原（ZCode 同款引擎），list 模式
 *  整册竖向滚动、窗口化挂载。库是动态 import 的（拖着 echarts，不能进主包）；
 *  加载或解析失败降到第三级的纯文本 PptxView。 */
function PptxLayoutView({
  base64,
  pages,
}: {
  base64: string;
  pages: PptxSlide[];
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let disposed = false;
    let viewer: PptxViewerInstance | null = null;
    void (async () => {
      try {
        const { PptxViewer, RECOMMENDED_ZIP_LIMITS } =
          await import("@aiden0z/pptx-renderer");
        const box = boxRef.current;
        if (!box || disposed) return;
        viewer = await PptxViewer.open(bytesFromBase64(base64), box, {
          fitMode: "contain",
          zipLimits: RECOMMENDED_ZIP_LIMITS,
          lazySlides: true,
          lazyMedia: true,
          renderMode: "list",
          listOptions: {
            windowed: true,
            initialSlides: 4,
            batchSize: 4,
          },
          scrollContainer: scrollRef.current ?? undefined,
        });
        if (disposed) {
          viewer.destroy();
          return;
        }
        setReady(true);
      } catch {
        if (!disposed) setFailed(true);
      }
    })();
    return () => {
      disposed = true;
      setReady(false);
      try {
        viewer?.destroy();
      } catch {
        /* destroy 清全局字体/图表缓存，重复调用可能抛，无所谓 */
      }
      if (boxRef.current) boxRef.current.innerHTML = "";
    };
  }, [base64]);

  if (failed) {
    return <PptxTextPager pages={pages} />;
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {!ready && (
        <div className="shrink-0 flex items-center justify-center gap-2 py-3 text-muted-foreground/40">
          <Loader2 className="size-4 animate-spin" />
          <span className="text-[calc(var(--helix-transcript-size)*0.8571)]">
            正在还原版面…
          </span>
        </div>
      )}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto">
        <div ref={boxRef} className="p-2" />
      </div>
    </div>
  );
}

/** 第三级入口：纯文本提取（doc-preview 的 fflate 解析结果）+ 翻页。 */
function PptxTextPager({ pages }: { pages: PptxSlide[] }) {
  const [slide, setSlide] = useState(0);
  return <PptxView pages={pages} slide={slide} setSlide={setSlide} />;
}

/** 第三级：纯文本提取（doc-preview 的 fflate 解析结果）。 */
function PptxView({
  pages,
  slide,
  setSlide,
}: {
  pages: PptxSlide[];
  slide: number;
  setSlide: (n: number) => void;
}) {
  const clamped = Math.max(0, Math.min(slide, pages.length - 1));
  const page = pages[clamped];
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <SlidePager index={clamped} total={pages.length} setSlide={setSlide} />
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
        <h3 className="text-[calc(var(--helix-transcript-size*0.95))] font-semibold text-foreground mb-2 break-words">
          {page.title}
        </h3>
        <div className="flex flex-col gap-1">
          {page.paragraphs.map((p, i) => (
            <p
              key={i}
              className={`text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/80 break-words ${
                p.heading ? "font-medium text-foreground" : ""
              }`}
              style={{ paddingLeft: `${p.level * 14}px` }}
            >
              {!p.heading && p.level > 0 && (
                <span className="text-muted-foreground/40 mr-1.5 select-none">
                  {p.level === 1 ? "•" : p.level === 2 ? "◦" : "▪"}
                </span>
              )}
              {p.text}
            </p>
          ))}
        </div>
        {page.notes && (
          <div className="mt-4 pt-3 border-t border-border/20">
            <p className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/40 mb-1">
              备注
            </p>
            <p className="text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground/60 whitespace-pre-wrap break-words">
              {page.notes}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── PDF ─────────────────────────────────────────────────────────────────────

/** pdf.js 逐页画到 canvas（WebView2 内核不带 Chrome 的 PDF 查看器，`<embed>`
 *  在 Tauri 里是灰块，所以必须自己渲）。窗口化渲染：IntersectionObserver 只画
 *  滚到附近的页，长文档不会一次性爆内存。cmaps/standard_fonts 放在 public/pdfjs/
 *  （非嵌入字体的中文 PDF 没有 cmaps 会整页空白）。pdf.js 失败退回 <embed>，
 *  万一某些平台内核自带查看器还能救一次。 */
function PdfJsView({
  base64,
  dataUrl,
}: {
  base64: string;
  dataUrl: string;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<{ w: number; h: number }[]>([]);
  const [failed, setFailed] = useState(false);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    setDoc(null);
    setSizes([]);
    setFailed(false);
    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        loadingTask = pdfjs.getDocument({
          data: bytesFromBase64(base64),
          cMapUrl: new URL("pdfjs/cmaps/", document.baseURI).toString(),
          cMapPacked: true,
          standardFontDataUrl: new URL(
            "pdfjs/standard_fonts/",
            document.baseURI,
          ).toString(),
        });
        const d = await loadingTask.promise;
        if (cancelled) {
          void loadingTask.destroy();
          return;
        }
        setDoc(d);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      // 换文件/关页签：整份文档（含 worker 里已缓存的页）一起释放
      void loadingTask?.destroy();
    };
  }, [base64]);

  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    void (async () => {
      const arr: { w: number; h: number }[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const v = page.getViewport({ scale: 1 });
        arr.push({ w: v.width, h: v.height });
      }
      if (!cancelled) setSizes(arr);
    })();
    return () => {
      cancelled = true;
    };
  }, [doc]);

  // 适配宽度缩放；拖拽右栏时只在比例变化明显时重算（重画所有可见页很贵）
  useEffect(() => {
    if (!sizes.length) return;
    const scroll = scrollRef.current;
    if (!scroll) return;
    const compute = () => {
      const next = Math.min(2, (scroll.clientWidth - 40) / sizes[0].w);
      setScale((prev) => (Math.abs(next - prev) > 0.02 ? next : prev));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(scroll);
    return () => ro.disconnect();
  }, [sizes]);

  if (failed) {
    return (
      <embed
        src={dataUrl}
        type="application/pdf"
        className="flex-1 min-h-0 w-full border-0"
      />
    );
  }

  return (
    <div
      ref={scrollRef}
      className="flex-1 min-h-0 overflow-auto bg-muted/30 py-2"
    >
      {!doc && !failed && (
        <div className="flex items-center justify-center gap-2 py-3 text-muted-foreground/40">
          <Loader2 className="size-4 animate-spin" />
          <span className="text-[calc(var(--helix-transcript-size)*0.8571)]">
            正在解析 PDF…
          </span>
        </div>
      )}
      {doc &&
        sizes.map((s, i) => (
          <PdfPageCanvas
            key={i}
            doc={doc}
            pageNumber={i + 1}
            size={s}
            scale={scale}
            scrollRoot={scrollRef.current}
          />
        ))}
    </div>
  );
}

function PdfPageCanvas({
  doc,
  pageNumber,
  size,
  scale,
  scrollRoot,
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  size: { w: number; h: number };
  scale: number;
  scrollRoot: HTMLDivElement | null;
}) {
  const holderRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = holderRef.current;
    if (!el || visible) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible(true);
      },
      { root: scrollRoot, rootMargin: "600px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible, scrollRoot]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!visible || !canvas) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    void (async () => {
      try {
        const page = await doc.getPage(pageNumber);
        if (cancelled) return;
        // pdf.js v6 的 render({canvas}) 不负责设缓冲区（beginDrawing 直接用
        // 现有 width/height）：不设就停在默认 300×150，只画进页面左上角那一
        // 小块，再被 CSS 拉满整页 ⇒ 又糊又只显示局部。缓冲区按 dpr 放大、
        // CSS 尺寸保持逻辑像素 ⇒ 物理像素 1:1。
        const dpr = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: scale * dpr });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        task = page.render({ canvas, viewport });
        await task.promise;
      } catch {
        /* 缩放重排会 cancel 旧渲染；单页失败留白，不打断整篇 */
      }
    })();
    return () => {
      cancelled = true;
      try {
        task?.cancel();
      } catch {
        /* 已完成的 task cancel 会抛，无所谓 */
      }
    };
  }, [visible, doc, pageNumber, scale]);

  return (
    <div ref={holderRef} className="flex justify-center px-2 py-2">
      <canvas
        ref={canvasRef}
        className="bg-white shadow-sm"
        style={{ width: size.w * scale, height: size.h * scale }}
      />
    </div>
  );
}

// ── DOCX ────────────────────────────────────────────────────────────────────

/** docx-preview 版式还原（ZCode 同路线，Apache-2.0 的 docx.js）：白底分页、
 *  页边距、字体样式都是 Word 语义。侧栏窄，渲染完按容器宽等比缩放。失败降级
 *  到下面的纯文本 DocxView。 */
function DocxLayoutView({
  base64,
  blocks,
}: {
  base64: string;
  blocks: DocxBlock[];
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const { renderAsync } = await import("docx-preview");
        const dom = boxRef.current;
        if (!dom || disposed) return;
        dom.innerHTML = "";
        await renderAsync(bytesFromBase64(base64), dom, dom, {
          inWrapper: true,
          breakPages: true,
        });
        if (!disposed) setReady(true);
      } catch {
        if (!disposed) setFailed(true);
      }
    })();
    return () => {
      disposed = true;
      setReady(false);
    };
  }, [base64]);

  // Word 页面是固定 px 页宽，侧栏放不下：zoom 整体缩到容器宽（连滚动区域一起
  // 重排，比 transform:scale 少一层定位坑）。
  // 页宽必须直接量 section.docx —— docx-wrapper 是 flex 居中，溢出被均分到两侧，
  // 容器的 scrollWidth 只包含右侧溢出，拿它算缩放比会算大、左边被裁。
  useEffect(() => {
    if (!ready) return;
    const box = boxRef.current;
    const scroll = scrollRef.current;
    if (!box || !scroll) return;
    const compute = () => {
      const page = box.querySelector("section.docx") as HTMLElement | null;
      const natural = page ? page.offsetWidth + 60 : 0;
      if (natural > 0) {
        setScale(Math.min(1, (scroll.clientWidth - 16) / natural));
      }
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(scroll);
    return () => ro.disconnect();
  }, [ready]);

  if (failed) return <DocxView blocks={blocks} />;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {!ready && (
        <div className="shrink-0 flex items-center justify-center gap-2 py-3 text-muted-foreground/40">
          <Loader2 className="size-4 animate-spin" />
          <span className="text-[calc(var(--helix-transcript-size)*0.8571)]">
            正在还原版面…
          </span>
        </div>
      )}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto bg-muted/20">
        <div ref={boxRef} style={{ zoom: scale }} />
      </div>
    </div>
  );
}

function DocxView({ blocks }: { blocks: DocxBlock[] }) {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 flex flex-col gap-2">
      {blocks.map((b, i) => {
        if (b.kind === "heading") {
          const size =
            b.level <= 1
              ? "calc(var(--helix-transcript-size)*1)"
              : b.level <= 3
                ? "calc(var(--helix-transcript-size)*0.9286)"
                : "calc(var(--helix-transcript-size)*0.8571)";
          return (
            <h3
              key={i}
              className="font-semibold text-foreground break-words"
              style={{ fontSize: size }}
            >
              {b.text}
            </h3>
          );
        }
        if (b.kind === "para") {
          return (
            <p
              key={i}
              className="text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/80 break-words leading-relaxed"
            >
              {b.text}
            </p>
          );
        }
        if (b.kind === "list") {
          return (
            <div key={i} className="flex flex-col gap-0.5 pl-1">
              {b.items.map((it, j) => (
                <div
                  key={j}
                  className="flex gap-2 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/80"
                >
                  <span className="shrink-0 text-muted-foreground/40 select-none w-4 text-right">
                    {b.ordered ? `${j + 1}.` : "•"}
                  </span>
                  <span className="min-w-0 break-words">{it}</span>
                </div>
              ))}
            </div>
          );
        }
        if (b.kind === "quote") {
          return (
            <blockquote
              key={i}
              className="border-l-2 border-border/60 pl-3 text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/70 italic break-words"
            >
              {b.text}
            </blockquote>
          );
        }
        return (
          <div key={i} className="overflow-x-auto rounded border border-border/40">
            <table className="w-full border-collapse text-[calc(var(--helix-transcript-size)*0.7857)]">
              <tbody>
                {b.rows.map((row, r) => (
                  <tr key={r} className={r === 0 ? "bg-muted/40" : undefined}>
                    {row.map((cell, c) => (
                      <td
                        key={c}
                        className="border border-border/30 px-2 py-1 text-foreground/80 break-words"
                      >
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

// ── XLSX ────────────────────────────────────────────────────────────────────

type SheetGrid = XlsxSheet & { widths?: number[] };

/** SheetJS 解析真实表格：格式化后的数值/日期（cell.w）、公式缓存结果、列宽。
 *  解析失败就退回 doc-preview 的文本网格，不报错。 */
function XlsxGridView({
  base64,
  sheets,
  path,
}: {
  base64: string;
  sheets: XlsxSheet[];
  path: string;
}) {
  const [grid, setGrid] = useState<SheetGrid[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const XLSX = await import("xlsx");
        const wb = XLSX.read(bytesFromBase64(base64), {
          type: "array",
          cellDates: true,
        });
        const out: SheetGrid[] = wb.SheetNames.map((name) => {
          const ws = wb.Sheets[name];
          const rows: string[][] = [];
          let widths: number[] | undefined;
          const ref = ws?.["!ref"];
          if (ws && ref) {
            const range = XLSX.utils.decode_range(ref);
            const maxR = Math.min(range.e.r, 499);
            const maxC = Math.min(range.e.c, 99);
            for (let R = range.s.r; R <= maxR; R++) {
              const line: string[] = [];
              for (let C = range.s.c; C <= maxC; C++) {
                const cell = ws[XLSX.utils.encode_cell({ r: R, c: C })];
                line.push(cell == null ? "" : String(cell.w ?? cell.v ?? ""));
              }
              rows.push(line);
            }
            const cols = ws["!cols"];
            if (cols && cols.length) {
              widths = cols
                .slice(range.s.c, maxC + 1)
                .map((c) =>
                  Math.max(
                    48,
                    Math.min(480, Math.round(c.wpx ?? (c.wch ?? 10) * 7 + 5)),
                  ),
                );
            }
          }
          return { name, rows, widths };
        });
        if (!cancelled && out.length) setGrid(out);
      } catch {
        /* 解析失败 → grid 保持 null，走文本网格 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base64]);

  return <XlsxView sheets={grid ?? sheets} path={path} />;
}

function XlsxView({
  sheets,
  path,
}: {
  sheets: SheetGrid[];
  path: string;
}) {
  const [active, setActive] = useState(0);
  const idx = Math.max(0, Math.min(active, sheets.length - 1));
  const sheet = sheets[idx];
  const rows = useMemo(() => sheet.rows.slice(0, 500), [sheet]);
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {sheets.length > 1 && (
        <div className="shrink-0 flex items-center gap-1 px-2 py-1 border-b border-border/20 overflow-x-auto">
          {sheets.map((s, i) => (
            <button
              key={s.name}
              onClick={() => setActive(i)}
              className={`shrink-0 px-2 py-0.5 rounded text-[calc(var(--helix-transcript-size)*0.7857)] transition-colors ${
                i === idx
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground/70 hover:bg-accent/50"
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-auto">
        <table className="border-collapse text-[calc(var(--helix-transcript-size)*0.7857)]">
          <tbody>
            {rows.map((row, r) => (
              <tr key={r} className={r === 0 ? "bg-muted/40 font-medium" : undefined}>
                {/* 行号列：读大表时定位用 */}
                <td className="sticky left-0 z-10 border border-border/20 bg-card px-1.5 py-0.5 text-right text-muted-foreground/40 tabular-nums select-none">
                  {r + 1}
                </td>
                {row.map((cell, c) => (
                  <td
                    key={c}
                    className="border border-border/20 px-2 py-0.5 text-foreground/80 whitespace-pre max-w-[280px] truncate"
                    style={
                      sheet.widths?.[c]
                        ? { width: sheet.widths[c] }
                        : undefined
                    }
                    data-tip={cell}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sheet.rows.length > rows.length && (
        <div className="shrink-0 px-3 py-1 border-t border-border/20 text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/40">
          仅显示前 {rows.length} 行（共 {sheet.rows.length} 行）·{" "}
          <button
            className="underline hover:text-foreground/60"
            onClick={() => void electronShell.openPath(path)}
          >
            打开完整表格
          </button>
        </div>
      )}
    </div>
  );
}
