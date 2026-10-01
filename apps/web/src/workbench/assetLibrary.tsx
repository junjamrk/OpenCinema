import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { IconDownload, IconFile, IconFolder, IconFolderPlus, IconLayoutGrid, IconLoader2, IconMusic, IconPhoto, IconSearch, IconTrash, IconVideo, IconX } from "@tabler/icons-react";
import { assetDragType, assetLibraryClient, assetMediaKind } from "@/lib/assetLibraryClient";
import { createWorkspaceFiles } from "@/lib/workspaceFileClient";
import { isNodeOutput } from "@toonflow/nodes-scaffold/values";
import type { AssetLibraryEntry } from "@/lib/assetLibraryClient";
import type { FormEvent } from "react";
import type { NodeOutput } from "@toonflow/nodes-scaffold/values";
import type { WorkbenchController } from "./types";
import { MotionLayer } from "./uiMotion";
import "./managementPanels.scss";

type AssetAction = "createFolder" | "rename" | "move" | "remove" | "save";

function AssetVisual({ entry }: { entry: AssetLibraryEntry }) {
  const [url, setUrl] = useState("");
  const kind = assetMediaKind(entry.name);
  useEffect(() => {
    const request = new AbortController();
    let objectUrl = "";
    setUrl("");
    if (entry.type === "file" && kind === "image") void assetLibraryClient.read(entry.path, request.signal).then(blob => {
      request.signal.throwIfAborted();
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
    }).catch(() => {});
    return () => { request.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [entry.path, entry.type, kind]);
  return <span className="assetVisual">{url ? <img src={url} alt="" loading="lazy" draggable={false} /> : entry.type === "directory" ? <IconFolder aria-hidden="true" focusable="false" size={36} /> : kind === "image" ? <IconPhoto aria-hidden="true" focusable="false" size={32} /> : kind === "video" ? <IconVideo aria-hidden="true" focusable="false" size={32} /> : kind === "audio" ? <IconMusic aria-hidden="true" focusable="false" size={32} /> : <IconFile aria-hidden="true" focusable="false" size={32} />}</span>;
}

export default function AssetLibrary({ controller, onClose, onImport }: { controller: WorkbenchController; onClose(): void; onImport(files: File[]): Promise<void> }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [entries, setEntries] = useState<AssetLibraryEntry[]>([]);
  const [folder, setFolder] = useState(".");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [selected, setSelected] = useState("");
  const [preview, setPreview] = useState<{ entry: AssetLibraryEntry; url: string }>();
  const [previewError, setPreviewError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [action, setAction] = useState<AssetAction>();
  const [actionPath, setActionPath] = useState("");
  const [actionRevision, setActionRevision] = useState("");
  const [name, setName] = useState("");
  const [destination, setDestination] = useState(".");
  const [outputKey, setOutputKey] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const operation = useRef(0);
  const previewRequest = useRef(0);
  const previewUrl = useRef("");
  const mounted = useRef(true);
  const all: AssetLibraryEntry[] = [];
  function flatten(items: AssetLibraryEntry[]) { for (const entry of items) { all.push(entry); if (entry.children) flatten(entry.children); } }
  flatten(entries);
  const folders = all.filter(entry => entry.type === "directory");
  const selectedEntry = all.find(entry => entry.path === selected);
  const currentDirectory = folders.find(entry => entry.path === folder);
  const scope = folder === "." ? all.filter(entry => entry.type === "file") : currentDirectory?.children ?? [];
  const visible = scope.filter(entry => (!query.trim() || entry.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) && (kind === "all" || entry.type === "file" && (assetMediaKind(entry.name) ?? "other") === kind));
  const outputs: { key: string; label: string; nodeId: string; output: NodeOutput }[] = [];
  for (const node of snapshot.document?.nodes ?? []) if (snapshot.selectedIds.includes(node.id) && node.data?.outputs && typeof node.data.outputs === "object") {
    for (const [key, output] of Object.entries(node.data.outputs)) if (isNodeOutput(output)) outputs.push({ key: `${node.id}:${key}`, label: `${String(node.data.label ?? node.id)} · ${key}`, nodeId: node.id, output });
  }
  const chosenOutput = outputs.find(output => output.key === outputKey) ?? outputs[0];
  function outputFileName(output: (typeof outputs)[number] | undefined) {
    if (!output) return "";
    const extension = typeof output.output.value === "object" ? output.output.value.url.match(/\.[^./\\?]+(?:\?|$)/)?.[0].replace(/\?$/, "") ?? "" : output.output.dataType === "STRING" ? ".txt" : ".json";
    const label = output.label.replace(/[\\/:*?"<>|]/g, " ");
    return extension && !label.toLowerCase().endsWith(extension.toLowerCase()) ? label + extension : label;
  }
  const locked = busy || snapshot.transitioning || snapshot.readOnly;
  const parentPath = (path: string) => path.split("/").slice(0, -1).join("/") || ".";
  const joinPath = (directory: string, name: string) => directory === "." ? name : `${directory}/${name}`;

  async function refresh() {
    const requested = ++operation.current;
    setLoading(true);
    try { const result = await assetLibraryClient.list(); if (mounted.current && requested === operation.current) setEntries(result); }
    finally { if (mounted.current && requested === operation.current) setLoading(false); }
  }
  useEffect(() => {
    mounted.current = true; searchRef.current?.focus();
    void refresh().catch(value => { if (mounted.current) setError(value instanceof Error ? value.message : "素材读取失败"); });
    return () => { mounted.current = false; operation.current++; previewRequest.current++; if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); };
  }, []);

  async function perform(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(""); setStatus("");
    try { await task(); }
    catch (value) { if (mounted.current) setError(value instanceof Error ? value.message : "素材操作失败"); }
    finally { if (mounted.current) setBusy(false); }
  }
  function closePreview() { previewRequest.current++; if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); previewUrl.current = ""; setPreview(undefined); setPreviewError(""); }
  async function openPreview(entry: AssetLibraryEntry) {
    if (!assetMediaKind(entry.name)) return;
    const requested = ++previewRequest.current;
    const blob = await assetLibraryClient.read(entry.path);
    if (!mounted.current || requested !== previewRequest.current) return;
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = URL.createObjectURL(blob); setPreviewError(""); setPreview({ entry, url: previewUrl.current });
  }
  function begin(next: AssetAction) {
    const path = selectedEntry?.path ?? folder, selectedName = selectedEntry?.name ?? "";
    void perform(async () => {
      const info = next === "rename" || next === "move" || next === "remove" ? await assetLibraryClient.stat(path) : undefined;
      setActionRevision(info?.fileRevision ?? ""); setAction(next); setActionPath(path);
      setName(next === "createFolder" ? "新建文件夹" : next === "save" ? outputFileName(chosenOutput) : selectedName);
      setDestination(next === "save" || next === "createFolder" ? folder : parentPath(path));
    });
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    await perform(async () => {
      const normalized = name.trim();
      if (action !== "remove" && (!normalized || /[\\/:*?"<>|\0]/.test(normalized) || [".", ".."].includes(normalized))) throw new Error("请输入有效名称");
      const path = joinPath(destination, normalized);
      if (action === "createFolder") await assetLibraryClient.mkdir(path);
      if (action === "rename" || action === "move") { await assetLibraryClient.rename(actionPath, path, actionRevision); if (folder === actionPath || folder.startsWith(actionPath + "/")) setFolder(path + folder.slice(actionPath.length)); setSelected(path); closePreview(); }
      if (action === "remove") { await assetLibraryClient.remove(actionPath, actionRevision); setSelected(""); closePreview(); }
      if (action === "save") {
        if (!chosenOutput) throw new Error("请先选择有输出的画布节点");
        const directory = snapshot.directory, canvasId = snapshot.canvasId;
        if (!directory) throw new Error("请先打开工程");
        if (!snapshot.readOnly) await controller.save();
        const current = controller.getSnapshot();
        if (current.directory !== directory || current.canvasId !== canvasId) throw new Error("画布已切换，请重新选择节点输出");
        const node = current.document?.nodes.find(node => node.id === chosenOutput.nodeId);
        const handle = chosenOutput.key.slice(chosenOutput.nodeId.length + 1);
        const output = node?.data?.outputs && typeof node.data.outputs === "object" ? Reflect.get(node.data.outputs, handle) : undefined;
        if (!isNodeOutput(output)) throw new Error("节点输出已变化，请重新选择");
        const content = typeof output.value === "object" ? await createWorkspaceFiles(directory).read(output.value.url) : new Blob([String(output.value)]);
        await assetLibraryClient.save(path, content);
        setStatus("已保存到素材库");
      }
      setAction(undefined); await refresh();
    });
  }
  async function importSelection() {
    const directory = snapshot.directory, canvasId = snapshot.canvasId;
    if (!selectedEntry || selectedEntry.type !== "file") return;
    const info = await assetLibraryClient.stat(selectedEntry.path);
    const file = await assetLibraryClient.readFile(selectedEntry.path, undefined, info.fileRevision);
    const current = controller.getSnapshot();
    if (current.directory !== directory || current.canvasId !== canvasId) throw new Error("画布已切换，请重新导入素材");
    await onImport([file]); setStatus("已导入当前画布");
  }
  async function downloadSelection() {
    if (!selectedEntry || selectedEntry.type !== "file") return;
    const content = await assetLibraryClient.read(selectedEntry.path);
    if (window.openCinemaTransport) { await window.openCinemaTransport.downloadFile(content, selectedEntry.name); return; }
    const url = URL.createObjectURL(content); const link = document.createElement("a"); link.href = url; link.download = selectedEntry.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <MotionLayer className="assetLibrary managementPanel" role="dialog" aria-modal="false" aria-label="素材库" onKeyDown={event => { event.stopPropagation(); if (event.key === "Escape" && !busy) { if (action) setAction(undefined); else if (preview) closePreview(); else onClose(); } }}>
    <header className="managementHeading"><strong>素材库</strong><button type="button" onClick={onClose} disabled={busy} aria-label="关闭素材库"><IconX aria-hidden="true" focusable="false" size={16} /></button></header>
    <div className="managementToolbar"><label className="managementSearch"><IconSearch aria-hidden="true" focusable="false" size={14} /><input ref={searchRef} aria-label="搜索素材" placeholder="搜索素材" value={query} onChange={event => setQuery(event.target.value)} /></label><button type="button" onClick={() => begin("createFolder")} disabled={busy}><IconFolderPlus aria-hidden="true" focusable="false" size={14} />新建文件夹</button><button type="button" onClick={() => begin("save")} disabled={busy || !outputs.length}>保存节点输出</button><button type="button" onClick={() => void perform(refresh)} disabled={busy || loading}>{loading ? <IconLoader2 aria-hidden="true" focusable="false" size={14} className="spin" /> : "刷新"}</button></div>
    <div className="assetLibraryBody"><aside className="assetDirectories" aria-label="素材文件夹"><button type="button" aria-current={folder === "." ? "page" : undefined} onClick={() => { setFolder("."); setKind("all"); }}><IconLayoutGrid aria-hidden="true" focusable="false" size={14} />全部素材</button>{folders.map(entry => <button key={entry.path} type="button" title={entry.path} aria-current={folder === entry.path ? "page" : undefined} onClick={() => { setFolder(entry.path); setSelected(entry.path); setKind("all"); }}><IconFolder aria-hidden="true" focusable="false" size={14} /><span>{entry.path}</span></button>)}</aside>
      <main className="assetLibraryMain"><div className="managementLocation">{folder === "." ? "全部素材" : folder}</div><div className="assetKindFilters" role="group" aria-label="素材类型">{[{ id: "all", label: "全部" }, { id: "image", label: "图片" }, { id: "video", label: "视频" }, { id: "audio", label: "音频" }, { id: "other", label: "其他" }].map(item => <button key={item.id} type="button" aria-pressed={kind === item.id} onClick={() => setKind(item.id)}>{item.label}</button>)}</div>
        <div className="assetGrid" aria-label="素材列表">{visible.map(entry => <article key={entry.path} className="assetCard" aria-selected={selected === entry.path} draggable={entry.type === "file" && !locked} onDragStart={event => { event.dataTransfer.setData(assetDragType, entry.path); event.dataTransfer.effectAllowed = "copy"; }}><button className="assetOpen" type="button" title={entry.path} onClick={() => setSelected(entry.path)} onDoubleClick={() => { if (entry.type === "directory") setFolder(entry.path); else void perform(() => openPreview(entry)); }}><AssetVisual entry={entry} /><span className="assetName">{entry.name}</span></button></article>)}</div>
        {!loading && !visible.length && <p className="assetEmpty">{query.trim() ? "没有找到匹配的素材" : "暂无素材"}</p>}
      </main></div>
    {preview && <div className="assetPreview"><div className="assetPreviewHeader"><strong>{preview.entry.name}</strong><button type="button" onClick={closePreview} aria-label="关闭素材预览"><IconX aria-hidden="true" focusable="false" size={14} /></button></div>{previewError ? <p role="alert" className="managementError">{previewError}</p> : assetMediaKind(preview.entry.name) === "image" ? <img src={preview.url} alt={preview.entry.name} onError={() => setPreviewError("图片无法显示，请检查文件编码或内容")} /> : assetMediaKind(preview.entry.name) === "video" ? <video src={preview.url} controls playsInline preload="metadata" onError={() => setPreviewError("视频无法播放，文件可能损坏或浏览器不支持其编码")} /> : <audio src={preview.url} controls preload="metadata" onError={() => setPreviewError("音频无法播放，文件可能损坏或浏览器不支持其编码")} />}</div>}
    {selectedEntry && <div className="managementToolbar"><span>{selectedEntry.name}</span><button type="button" disabled={busy || !assetMediaKind(selectedEntry.name)} onClick={() => void perform(() => openPreview(selectedEntry))}>预览</button><button type="button" disabled={busy || selectedEntry.type !== "file"} onClick={() => void perform(downloadSelection)}><IconDownload aria-hidden="true" focusable="false" size={14} />下载</button><button type="button" disabled={busy} onClick={() => begin("rename")}>重命名</button><button type="button" disabled={busy} onClick={() => begin("move")}>移动</button><button className="managementDanger" type="button" aria-label="删除素材" disabled={busy || !!selectedEntry.children?.length} onClick={() => begin("remove")}><IconTrash aria-hidden="true" focusable="false" size={14} /></button></div>}
    {action && <form className="managementAction" onSubmit={event => void submit(event)}><strong>{({ createFolder: "新建素材文件夹", rename: "重命名素材", move: "移动素材", remove: "删除素材", save: "保存节点输出到素材库" })[action]}</strong>{action === "remove" ? <p>确定删除“{actionPath}”？此操作不可撤销。</p> : <>{action === "save" && <label>节点输出<select aria-label="保存的节点输出" value={chosenOutput?.key ?? ""} onChange={event => { setOutputKey(event.target.value); setName(outputFileName(outputs.find(output => output.key === event.target.value))); }}>{outputs.map(output => <option key={output.key} value={output.key}>{output.label}</option>)}</select></label>}<label>名称<input aria-label="素材名称" value={name} onChange={event => setName(event.target.value)} required disabled={busy} /></label>{action !== "rename" && <label>目标文件夹<select aria-label="素材目标文件夹" value={destination} onChange={event => setDestination(event.target.value)} disabled={busy}><option value=".">素材库根目录</option>{folders.filter(entry => action !== "move" || entry.path !== actionPath && !entry.path.startsWith(actionPath + "/")).map(entry => <option key={entry.path} value={entry.path}>{entry.path}</option>)}</select></label>}</>}<div className="managementActionButtons"><button type="button" disabled={busy} onClick={() => setAction(undefined)}>取消</button><button className={action === "remove" ? "managementDanger" : "managementPrimary"} type="submit" disabled={busy}>{action === "remove" ? "确认删除" : "保存"}</button></div></form>}
    {error && <p className="managementError" role="alert">{error}</p>}{status && <p className="managementLocation" role="status">{status}</p>}
    <footer className="managementFooter"><span>{all.filter(entry => entry.type === "file").length} 个素材</span><button className="managementPrimary" type="button" disabled={locked || selectedEntry?.type !== "file"} onClick={() => void perform(importSelection)}>导入当前画布</button></footer>
  </MotionLayer>;
}
