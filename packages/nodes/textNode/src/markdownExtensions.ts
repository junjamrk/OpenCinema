import type { Editor, JSONContent } from "@tiptap/core";
import { DOMSerializer } from "@tiptap/pm/model";
import { StarterKit } from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { Image } from "@tiptap/extension-image";
import { Highlight } from "@tiptap/extension-highlight";
import { Superscript } from "@tiptap/extension-superscript";
import { Subscript } from "@tiptap/extension-subscript";
import { TextAlign } from "@tiptap/extension-text-align";
import { FindAndReplace } from "@tiptap/extension-find-and-replace";
import { loadMarkdownImage, markdownDom, resolveMarkdownPath, type MarkdownFiles } from "./markdownContent";

export const resolveDocumentPath = resolveMarkdownPath;

// 兼容已保存的富文本 HTML 和普通 Markdown，始终保留原始图片 src。
export function parseMarkdownContent(text: string): string {
  const dom = markdownDom(text);
  for (const pre of dom.querySelectorAll<HTMLElement>("pre")) {
    const code = pre.querySelector("code");
    if (!code) continue;
    if (pre.dataset.language && !code.className) code.className = "language-" + pre.dataset.language;
    if (pre.dataset.markdownTrim === "true" && code.textContent?.endsWith("\n")) code.textContent = code.textContent.slice(0, -1);
    pre.removeAttribute("data-markdown-trim");
  }
  for (const item of Array.from(dom.querySelectorAll<HTMLElement>("li")).reverse()) {
    const checkbox = item.querySelector<HTMLInputElement>(':scope > input[type="checkbox"], :scope > p > input[type="checkbox"], :scope > label > input[type="checkbox"]');
    if (item.dataset.type !== "taskItem" && item.dataset.itemType !== "task" && !checkbox) continue;
    item.dataset.type = "taskItem";
    item.dataset.checked = String(checkbox ? checkbox.checked : item.dataset.checked === "true" || item.dataset.checked === "");
    if (checkbox?.parentElement?.tagName === "LABEL") checkbox.parentElement.remove();
    else checkbox?.remove();
    // TaskItem 的解析器查找 div；明确直属容器，避免误取嵌套任务的内容。
    if (!item.querySelector(":scope > div")) {
      const content = document.createElement("div");
      content.append(...item.childNodes);
      item.append(content);
    }
  }
  for (const list of Array.from(dom.querySelectorAll<HTMLElement>("ul,ol")).reverse()) {
    const items = Array.from(list.children).filter((item): item is HTMLElement => item instanceof HTMLElement && item.tagName === "LI");
    if (!items.some(item => item.dataset.type === "taskItem")) continue;
    let previousTask: boolean | undefined;
    let group: HTMLElement | undefined;
    for (const [index, item] of items.entries()) {
      const task = item.dataset.type === "taskItem";
      if (task !== previousTask) {
        group = document.createElement(task ? "ul" : list.tagName.toLowerCase());
        if (task) group.dataset.type = "taskList";
        else if (list.tagName === "OL") group.setAttribute("start", String(Number(list.getAttribute("start") || 1) + index));
        list.before(group);
        previousTask = task;
      }
      group!.append(item);
    }
    list.remove();
  }
  return dom.innerHTML;
}

export default function markdownExtensions(context: { files?: MarkdownFiles; resource: { path: string } }) {
  const workspaceImage = Image.configure({ inline: true }).extend({
    addNodeView() {
      return ({ node }) => {
        const element = document.createElement("img");
        let release = () => {};
        let source: string | undefined;
        const render = (current: typeof node) => {
          element.alt = current.attrs.alt || "";
          element.title = current.attrs.title || "";
          if (source === current.attrs.src) return;
          source = current.attrs.src;
          release();
          release = loadMarkdownImage(element, source || "", context.resource.path, context.files);
        };
        render(node);
        return {
          dom: element,
          update(current) { if (current.type !== node.type) return false; render(current); return true; },
          destroy() { release(); },
        };
      };
    },
  });
  return [
    StarterKit.configure({ link: { openOnClick: false } }),
    Markdown.configure({ markedOptions: { gfm: true } }),
    TaskList, TaskItem.configure({ nested: true }), TableKit, workspaceImage,
    Highlight, Superscript, Subscript, TextAlign.configure({ types: ["heading", "paragraph"] }), FindAndReplace,
  ];
}

function needsHtml(node: JSONContent): boolean {
  // Markdown 无法表达跨行/跨列、多个单元格段落或非首行表头，保留为可编辑 HTML。
  if (node.type === "table") {
    const rows = node.content || [];
    const width = rows[0]?.content?.length;
    if (rows.some((row, rowIndex) => row.content?.length !== width || row.content?.some((cell, index) =>
      cell.type !== (rowIndex === 0 ? "tableHeader" : "tableCell") || cell.attrs?.colspan > 1 || cell.attrs?.rowspan > 1 || cell.attrs?.colwidth ||
      cell.content?.length !== 1 || cell.content[0]?.type !== "paragraph" || (cell.attrs?.align || null) !== (rows[0]?.content?.[index]?.attrs?.align || null)
    ))) return true;
  }
  return !!(
    (node.attrs?.textAlign && node.attrs.textAlign !== "left") ||
    node.marks?.some(mark => ["underline", "highlight", "superscript", "subscript"].includes(mark.type)) ||
    node.content?.some(needsHtml)
  );
}

export function serializeMarkdown(editor: Editor): string {
  const snapshot = editor.getJSON();
  const content = snapshot.content || [];
  if (!content.some(needsHtml)) return editor.markdown!.serialize(snapshot);
  const serializer = DOMSerializer.fromSchema(editor.schema);
  return content.map(node => {
    if (!needsHtml(node)) return editor.markdown!.serialize({ type: "doc", content: [node] });
    const element = document.createElement("div");
    element.append(serializer.serializeNode(editor.schema.nodeFromJSON(node)));
    return element.innerHTML.replaceAll("\n", "&#10;");
  }).join("\n\n");
}
