import { useEffect, useRef, useState, useMemo } from "react";
import { Editor } from "@tiptap/core";
import type { WorkspaceFiles } from "@toonflow/nodes-scaffold/nodeFiles";
import { errorText, type NodeViewProps } from "@toonflow/node-shared/reactNode";
import ReferenceList from "@toonflow/node-shared/reactReferencesView";
import NodeIcon from "@toonflow/node-shared/reactIcon";
import { editorSession } from "@toonflow/node-shared/editorSession";
import { markdownDom, loadMarkdownImage } from "./markdownContent";
import markdownExtensions, { parseMarkdownContent, serializeMarkdown } from "./markdownExtensions";
import "@toonflow/node-shared/nodeControls";
import "./reactStyles.scss";

function MarkdownPreview({ text, files, path }: { text: string; files: WorkspaceFiles; path: string }) {
  const element = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const target = element.current; if (!target) return;
    const releases: (() => void)[] = [];
    try {
      const content = markdownDom(text);
      for (const checkbox of content.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) checkbox.disabled = true;
      for (const image of content.querySelectorAll<HTMLImageElement>("img")) releases.push(loadMarkdownImage(image, image.getAttribute("src") ?? "", path, files));
      target.replaceChildren(...content.childNodes); setError("");
    } catch (reason) { setError(errorText(reason)); }
    return () => { releases.forEach(release => release()); target.replaceChildren(); };
  }, [text, files, path]);
  return <><div ref={element} className="nodeMarkdownContent" onClick={event => {
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (link && !/^(?:https?:|mailto:|#)/i.test(link.getAttribute("href") ?? "")) { event.preventDefault(); setError("工作区链接请使用文件面板打开"); }
  }} />{error && <p role="alert" className="nodeError">{error}</p>}</>;
}

function RichEditor({ text, files, path, readOnly, onChange, onBlur, onSelection }: { text: string; files: WorkspaceFiles; path: string; readOnly?: boolean; onChange(text: string): void; onBlur(): void; onSelection(value: { from: number; to: number; text: string; coordinates: "proseMirrorDocument" } | null): void }) {
  const target = useRef<HTMLDivElement>(null);
  const editor = useRef<Editor | undefined>(undefined);
  const latest = useRef(text);
  const callbacks = useRef({ onChange, onBlur, onSelection }); callbacks.current = { onChange, onBlur, onSelection };
  const [error, setError] = useState("");
  useEffect(() => {
    if (!target.current) return;
    try {
      const instance: Editor = new Editor({ element: target.current, extensions: markdownExtensions({ files, resource: { path } }), content: parseMarkdownContent(text), editable: !readOnly,
        editorProps: { attributes: { class: "nodeMarkdownContent", "aria-label": "编辑文本内容", role: "textbox", "aria-multiline": "true" }, transformPastedHTML: parseMarkdownContent,
          handlePaste(_view, event): boolean { const clipboard = event.clipboardData; if (instance.isActive("codeBlock") || clipboard?.getData("text/html")) return false; const source = clipboard?.getData("text/markdown") || clipboard?.getData("text/plain"); return source ? instance.commands.insertContent(parseMarkdownContent(source)) : false; } },
        onUpdate({ editor: current }) { latest.current = serializeMarkdown(current); callbacks.current.onChange(latest.current); },
        onSelectionUpdate({ editor: current }) { const { from, to } = current.state.selection; callbacks.current.onSelection(from === to ? null : { from, to, text: current.state.doc.textBetween(from, to, "\n"), coordinates: "proseMirrorDocument" }); },
        onBlur() { callbacks.current.onBlur(); },
      });
      editor.current = instance; latest.current = text; setError("");
    } catch (reason) { setError(errorText(reason)); }
    return () => { editor.current?.destroy(); editor.current = undefined; callbacks.current.onSelection(null); };
  }, [files, path]);
  useEffect(() => { editor.current?.setEditable(!readOnly, false); }, [readOnly]);
  useEffect(() => { if (editor.current && text !== latest.current) { editor.current.commands.setContent(parseMarkdownContent(text), { emitUpdate: false }); latest.current = text; } }, [text]);
  function run(action: string) {
    const chain = editor.current?.chain().focus(); if (!chain || readOnly) return;
    if (action === "heading") chain.toggleHeading({ level: 2 }).run();
    else if (action === "bold") chain.toggleBold().run();
    else if (action === "italic") chain.toggleItalic().run();
    else if (action === "list") chain.toggleBulletList().run();
    else if (action === "undo") chain.undo().run();
    else chain.redo().run();
  }
  return <><div className="nodeActions" role="toolbar" aria-label="Markdown编辑工具">{([['heading','标题'],['bold','加粗'],['italic','斜体'],['list','列表'],['undo','撤销'],['redo','重做']] as const).map(([action,label]) => <button type="button" key={action} disabled={readOnly} onMouseDown={event => event.preventDefault()} title={label} aria-label={label} onClick={() => run(action)}><NodeIcon name={action} /></button>)}</div><div ref={target} className="nodeRichEditor" />{error && <p className="nodeError" role="alert">{error}</p>}</>;
}

export default function TextNodeView({ node, controller, readOnly }: NodeViewProps) {
  const selection = editorSession<{ from: number; to: number; text: string; coordinates: "proseMirrorDocument" | "markdownCharacters" } | null>(controller.getNodeService(node.id), "textSelection", null);
  const [text, setText] = useState("");
  const prompt = String(node.data?.prompt ?? "");
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [textError, setTextError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = node.data?.textGeneration as { status?: string; error?: string } | undefined;
  const waiting = ["running", "delegated", "unknown"].includes(generation?.status ?? "");
  const locked = readOnly || busy || waiting;
  const [mode, setMode] = useState("preview");
  const [fullscreen, setFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const files = useMemo(() => controller.getNodeService(node.id).files, [node.id, controller]);
  const outputs = node.data?.outputs as { text?: { value?: unknown } } | undefined;
  const inlineText = outputs?.text?.value ?? node.data?.text;
  const latest = useRef(text); latest.current = text;
  const path = String(node.data?.textPath ?? `assets/${node.id}/content.md`);
  useEffect(() => {
    let active = true;
    void controller.readNodeText(node.id).then(value => { if (active) { setText(value); setTextError(""); setReady(true); if (!value.trim()) setMode(current => current === "preview" ? "rich" : current); } }).catch(reason => { if (active) setTextError(errorText(reason)); });
    return () => { active = false; };
  }, [controller, node.id, node.data?.textPath, inlineText]);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1600); return () => clearTimeout(timer); }, [copied]);
  useEffect(() => { if (fullscreen && !dialog.current?.open) dialog.current?.showModal(); else if (!fullscreen && dialog.current?.open) dialog.current.close(); }, [fullscreen]);
  function change(value: string) { try { controller.stageNodeText(node.id, value); setText(value); setTextError(""); } catch (reason) { setTextError(errorText(reason)); } }
  function save() { if (ready && !locked) void controller.writeNodeText(node.id, latest.current).then(() => setTextError("")).catch(reason => setTextError(errorText(reason))); }
  async function reload() {
    if (locked || !window.confirm("重新读取会放弃未保存的正文修改，请先复制需要保留的内容。继续读取磁盘正文？")) return;
    setBusy(true); setTextError("");
    try { setText(await controller.reloadNodeText(node.id)); setReady(true); }
    catch (reason) { setTextError(errorText(reason)); }
    finally { setBusy(false); }
  }
  function compose(insertText?: string) {
    try { controller.getNodeService(node.id).focusComposer(insertText ? { insertText } : {}); }
    catch (reason) { setError(errorText(reason)); }
  }
  const body = <div className="nodeTextBody">{mode === "preview" ? <MarkdownPreview text={text} files={files} path={path} /> : mode === "source" ? <textarea className="nodeTextSource" aria-label="节点正文" spellCheck={false} value={text} disabled={!ready} readOnly={locked} onChange={event => change(event.target.value)} onSelect={event => { const element = event.currentTarget; selection.replace(element.selectionStart === element.selectionEnd ? null : { from: element.selectionStart, to: element.selectionEnd, text: element.value.slice(element.selectionStart, element.selectionEnd), coordinates: "markdownCharacters" }); }} onBlur={save} /> : <RichEditor text={text} files={files} path={path} readOnly={locked || !ready} onChange={change} onBlur={save} onSelection={value => selection.replace(value)} />}</div>;
  return <div className="nodeControls nodeTextView nodrag nopan nowheel">
    <div className="nodeTextToolbar"><div className="nodeTextTabs" role="tablist" aria-label="正文视图">{([['preview','预览'],['rich','富文本'],['source','原文']] as const).map(([value,label],index) => <button type="button" role="tab" key={value} aria-selected={mode === value} tabIndex={mode === value ? 0 : -1} onClick={() => { save(); setMode(value); }} onKeyDown={event => { if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? 2 : (index + (event.key === "ArrowLeft" ? 2 : 1)) % 3; save(); setMode(["preview", "rich", "source"][next]!); (event.currentTarget.parentElement?.querySelectorAll("button")[next] as HTMLButtonElement | undefined)?.focus(); }}>{label}</button>)}</div><div className="nodeTextTools"><button type="button" title="展开正文" aria-label="展开" onClick={() => { save(); setFullscreen(true); }}><NodeIcon name="expand" /></button><button type="button" title={copied ? "正文已复制" : "复制正文"} aria-label={copied ? "正文已复制" : "复制正文"} onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true)).catch(reason => setError(errorText(reason)))}><NodeIcon name={copied ? "check" : "copy"} /></button><button type="button" title="下载 Markdown" aria-label="下载" onClick={() => { const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" })); const link = document.createElement("a"); link.href = url; link.download = `${String(node.data?.label ?? "文本")}.md`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}><NodeIcon name="download" /></button></div></div>
    {textError && <button type="button" disabled={locked} onClick={() => void reload()}>重新读取磁盘正文</button>}
    {!fullscreen && body}
    <dialog ref={dialog} className="nodeTextDialog" onClose={() => { save(); setFullscreen(false); }}><div className="nodeControls"><div className="nodeActions"><strong>{String(node.data?.label ?? "文本")}</strong><button type="button" onClick={() => { save(); setFullscreen(false); }}><NodeIcon name="collapse" />收起</button></div>{fullscreen && body}</div></dialog>
    <ReferenceList node={node} controller={controller} readOnly={locked} onMention={compose} />
    <div className="nodeActions"><button type="button" className="nodeComposerAction" disabled={locked} onClick={() => { save(); compose(); }}><NodeIcon name="generate" />交给 Agent 修改</button>{waiting && <button type="button" disabled={readOnly} onClick={() => void controller.callNodeTool(node.id, "cancelGeneration", {}).catch(reason => setError(errorText(reason)))}>{generation?.status === "unknown" ? "确认任务终态" : "取消"}</button>}{generation?.status && generation.status !== "idle" && <span className="nodeStatus" data-state={generation.status} role="status">{({ running: "等待宿主创作", delegated: "已交给宿主，等待正文", completed: "正文已保存", unknown: "宿主任务终态尚未确认", failed: "正文创作失败", cancelled: "已取消" } as Record<string,string>)[generation.status] ?? generation.status}</span>}</div>
    {prompt && <details className="nodeDetails"><summary>创作指令</summary><p className="nodeSavedInstruction">{prompt}</p></details>}
    {(textError || error || generation?.error) && <p className="nodeError" role="alert">{textError || error || generation?.error}</p>}
  </div>;
}
