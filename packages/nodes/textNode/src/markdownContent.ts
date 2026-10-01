import DOMPurify from "dompurify";
import { marked, Renderer } from "marked";

export interface MarkdownFiles {
  read(path: string): Promise<ArrayBuffer>;
  acquireUrl?(path: string, mimeType?: string): { url: Promise<string>; release(): void };
  mkdir?(path: string): Promise<void>;
  write?(path: string, content: string | Blob | ArrayBuffer, exclusive?: boolean, signal?: AbortSignal): Promise<void>;
}

export interface MarkdownProps {
  modelValue: string;
  path?: string;
  files?: MarkdownFiles;
  active?: boolean;
  readonly?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  openFile?: (path: string) => Promise<void>;
  writeClipboardText?: (text: string) => Promise<void>;
}
export function resolveMarkdownPath(source: string, documentPath = "") {
  if (/^(?:https?:|mailto:|#)/i.test(source)) return;
  if (/^(?:[a-z][a-z\d+.-]*:|[\\/])/i.test(source)) throw new Error("文件路径必须位于工作区内");
  const path = decodeURIComponent(source.split(/[?#]/)[0]!).replaceAll("\\", "/");
  if (!path || /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(path) || path.includes("\0")) throw new Error("文件路径无效");
  const parts = documentPath.replaceAll("\\", "/").split("/").slice(0, -1);
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) throw new Error("文件路径超出工作区");
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

function protectHtmlCode(text: string) {
  if (!/<pre\b/i.test(text)) return text;
  const source = text.replace(/\r\n?/g, "\n");
  const segments: string[] = [];
  const closing = /<\/pre\s*>/gi;
  let position = 0;
  let copied = 0;
  for (const token of marked.lexer(source, { gfm: true })) {
    const start = source.indexOf(token.raw, position);
    if (start < 0) continue;
    position = start + token.raw.length;
    if (token.type !== "html") continue;
    for (const opening of token.raw.matchAll(/<pre\b[^>]*>/gi)) {
      const from = start + opening.index;
      if (from < copied) continue;
      closing.lastIndex = from + opening[0].length;
      const end = closing.exec(source);
      if (!end) continue;
      const to = end.index + end[0].length;
      segments.push(source.slice(copied, from), source.slice(from, to).replaceAll("\n", "&#10;"));
      copied = to;
    }
  }
  // ACT: 只保护顶层 HTML token 内开始的 pre；代码围栏及引用代码中的字面 HTML 不参与转换。
  return segments.length ? segments.join("") + source.slice(copied) : text;
}

export function markdownDom(text: string) {
  const renderer = new Renderer();
  const renderCode = renderer.code;
  renderer.code = function(token) { return renderCode.call(this, token).replace("<pre>", `<pre data-markdown-trim="${!token.text.endsWith("\n")}">`); };
  const dom = DOMPurify.sanitize(marked.parse(protectHtmlCode(text), { async: false, gfm: true, renderer }), {
    RETURN_DOM: true, USE_PROFILES: { html: true }, FORBID_TAGS: ["style", "form"],
  }) as HTMLElement;
  for (const element of dom.querySelectorAll<HTMLElement>("[style]")) {
    const alignment = element.style.textAlign;
    element.removeAttribute("style");
    if (["left", "center", "right", "justify"].includes(alignment)) element.style.textAlign = alignment;
  }
  for (const link of dom.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    link.rel = "noopener noreferrer";
    if (/^https?:/i.test(link.getAttribute("href") || "")) link.target = "_blank";
  }
  return dom;
}

export function loadMarkdownImage(element: HTMLImageElement, source: string, path: string, files?: MarkdownFiles) {
  let cancelled = false;
  let release = () => {};
  element.removeAttribute("src");
  try {
    if (/^https?:\/\//i.test(source)) { element.src = source; return release; }
    const relative = resolveMarkdownPath(source, path);
    if (!relative || !files) throw new Error("当前宿主无法读取文档图片");
    const mimeTypes: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml", avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon" };
    const mime = mimeTypes[relative.split(".").at(-1)?.toLowerCase() || ""] || "application/octet-stream";
    const shared = files.acquireUrl?.(relative, mime);
    if (shared) release = shared.release;
    const pending = shared?.url ?? files.read(relative).then(bytes => {
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      if (cancelled) URL.revokeObjectURL(url);
      else release = () => URL.revokeObjectURL(url);
      return url;
    });
    void pending.then(url => { if (!cancelled) element.src = url; }, () => { if (!cancelled) element.title = "图片读取失败"; });
  } catch (error) { element.title = error instanceof Error ? error.message : "图片读取失败"; }
  return () => { cancelled = true; release(); };
}
