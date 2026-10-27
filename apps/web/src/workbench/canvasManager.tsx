import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { IconCopy, IconFileText, IconFolder, IconFolderPlus, IconLoader2, IconPencil, IconPlus, IconSearch, IconTrash, IconX } from "@tabler/icons-react";
import type { FormEvent } from "react";
import type { CanvasManagementAction } from "@/lib/workspaceCanvasManager";
import type { WorkbenchController } from "./types";
import { createWorkspaceFiles } from "@/lib/workspaceFileClient";
import { MotionLayer } from "./uiMotion";
import "./managementPanels.scss";

type ManagementController = WorkbenchController & {
  manageCanvas(action: CanvasManagementAction): Promise<void>;
  renameProject(name: string): Promise<void>;
};
type Entry = { path: string; name: string; folder: boolean };

export default function CanvasManager({ controller, onClose }: { controller: ManagementController; onClose(): void }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const folders = (snapshot as typeof snapshot & { canvasFolders?: string[] }).canvasFolders ?? [];
  const [search, setSearch] = useState("");
  const [projectName, setProjectName] = useState(snapshot.projectName);
  const [selected, setSelected] = useState(snapshot.canvasId ?? "");
  const [action, setAction] = useState<CanvasManagementAction>();
  const [name, setName] = useState("");
  const [destination, setDestination] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const firstInput = useRef<HTMLInputElement>(null);
  const actionInput = useRef<HTMLInputElement>(null);
  const disabled = busy || snapshot.readOnly || snapshot.transitioning;
  const entries: Entry[] = [...folders.map(path => ({ path, name: path.split("/").at(-1)!, folder: true })), ...snapshot.canvasFiles.map(file => ({ ...file, folder: false }))];
  const parent = (path: string) => path.split("/").slice(0, -1).join("/");
  const selectedEntry = entries.find(entry => entry.path === selected);
  const currentFolder = selectedEntry?.folder ? selectedEntry.path : parent(selected);
  const query = search.trim().toLocaleLowerCase();
  const visible = entries.filter(entry => !query || entry.path.toLocaleLowerCase().includes(query)).sort((left, right) => left.path.localeCompare(right.path, "zh-CN", { numeric: true }));
  useEffect(() => { firstInput.current?.focus(); }, []);
  useEffect(() => { setProjectName(snapshot.projectName); }, [snapshot.projectName]);
  useEffect(() => { actionInput.current?.focus(); actionInput.current?.select(); }, [action]);

  async function perform(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError("");
    try { await operation(); }
    catch (value) { setError(value instanceof Error ? value.message : "文件操作失败"); }
    finally { setBusy(false); }
  }

  function begin(kind: CanvasManagementAction["kind"], entry?: Entry) {
    const source = entry?.path ?? currentFolder, directory = snapshot.directory;
    void perform(async () => {
      if (!directory) throw new Error("请先打开工程");
      const creating = kind === "createCanvas" || kind === "createFolder";
      if (!creating) await controller.save();
      const info = creating ? undefined : await createWorkspaceFiles(directory).stat(source);
      if (controller.getSnapshot().directory !== directory) throw new Error("工程已切换，请重新选择源文件");
      setAction({ kind, directory, path: source, ...(info ? { fileRevision: info.fileRevision } : {}) });
      setName(kind === "createCanvas" ? "新建画布" : kind === "createFolder" ? "新建文件夹" : entry?.name ?? "");
      setDestination(kind === "copy" ? [parent(source), `${entry?.name ?? "画布"} - 副本${entry?.folder ? "" : ".json"}`].filter(Boolean).join("/") : source);
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!action) return;
    await perform(async () => {
      await controller.manageCanvas(action.kind === "createCanvas" || action.kind === "createFolder" ? { ...action, name }
        : action.kind === "remove" ? action : { ...action, target: action.kind === "rename" ? [parent(action.path!), name.replace(/\.json$/i, "") + (folders.includes(action.path!) ? "" : ".json")].filter(Boolean).join("/") : destination });
      setAction(undefined);
    });
  }

  return <MotionLayer className="canvasManager managementPanel" role="dialog" aria-modal="true" aria-label="画布管理" onKeyDown={event => { event.stopPropagation(); if (event.key === "Escape" && !busy) { if (action) setAction(undefined); else onClose(); } }}>
    <header className="managementHeading"><strong>画布管理</strong><button type="button" aria-label="关闭画布管理" onClick={onClose} disabled={busy}><IconX aria-hidden="true" focusable="false" size={16} /></button></header>
    <form className="managementProjectName" onSubmit={event => { event.preventDefault(); void perform(() => controller.renameProject(projectName)); }}>
      <label>项目名称<input aria-label="项目名称" value={projectName} onChange={event => setProjectName(event.target.value)} disabled={disabled} maxLength={120} /></label>
      <button className="managementSecondary" type="submit" disabled={disabled || !projectName.trim() || projectName === snapshot.projectName}>保存名称</button>
    </form>
    <div className="managementToolbar"><label className="managementSearch"><IconSearch aria-hidden="true" focusable="false" size={14} /><input ref={firstInput} aria-label="搜索画布" placeholder="搜索画布和文件夹" value={search} onChange={event => setSearch(event.target.value)} /></label><button type="button" disabled={disabled} onClick={() => begin("createCanvas")}><IconPlus aria-hidden="true" focusable="false" size={14} />画布</button><button type="button" disabled={disabled} onClick={() => begin("createFolder")}><IconFolderPlus aria-hidden="true" focusable="false" size={14} />文件夹</button></div>
    <div className="managementLocation"><button type="button" aria-pressed={!selected} onClick={() => setSelected("")}>工程根目录</button>{currentFolder && <span>{currentFolder}</span>}</div>
    <div className="managementEntries" aria-label="画布和文件夹列表">
      {visible.map(entry => <div key={entry.path} className={`managementEntry${selected === entry.path ? " managementEntrySelected" : ""}`} style={{ paddingLeft: 8 + entry.path.split("/").length * 12 }}>
        <button type="button" className="managementEntryName" title={entry.path} aria-current={snapshot.canvasId === entry.path ? "page" : undefined} onClick={() => setSelected(entry.path)} onDoubleClick={() => { if (!entry.folder) void perform(async () => { await controller.switchCanvas(entry.path); onClose(); }); }}>
          {entry.folder ? <IconFolder aria-hidden="true" focusable="false" size={16} /> : <IconFileText aria-hidden="true" focusable="false" size={16} />}<span>{entry.name}</span>{snapshot.canvasId === entry.path && <small>当前</small>}
        </button>
        <div className="managementEntryActions"><button type="button" title={`重命名 ${entry.name}`} aria-label={`重命名 ${entry.name}`} disabled={disabled} onClick={() => { setSelected(entry.path); begin("rename", entry); }}><IconPencil aria-hidden="true" focusable="false" size={14} /></button><button type="button" title={`复制 ${entry.name}`} aria-label={`复制 ${entry.name}`} disabled={disabled} onClick={() => { setSelected(entry.path); begin("copy", entry); }}><IconCopy aria-hidden="true" focusable="false" size={14} /></button><button type="button" disabled={disabled} onClick={() => { setSelected(entry.path); begin("move", entry); }}>移动</button><button className="managementDanger" type="button" aria-label={`删除 ${entry.name}`} disabled={disabled} onClick={() => { setSelected(entry.path); begin("remove", entry); }}><IconTrash aria-hidden="true" focusable="false" size={14} /></button></div>
      </div>)}
    </div>
    {action && <form className="managementAction" onSubmit={event => void submit(event)}>
      <strong>{({ createCanvas: "新建画布", createFolder: "新建文件夹", rename: "重命名", copy: "创建独立副本", move: "移动", remove: "删除" })[action.kind]}</strong>
      {action.kind === "remove" ? <p>确定删除“{action.path}”？此操作不可撤销。节点素材将保留，文件夹必须为空。</p>
        : action.kind === "move" || action.kind === "copy" ? <><label>目标完整路径<input ref={actionInput} aria-label="目标完整路径" value={destination} onChange={event => setDestination(event.target.value)} disabled={busy} required /></label><label>移入文件夹<select aria-label="移入文件夹" value={parent(destination)} onChange={event => setDestination([event.target.value, destination.split("/").at(-1)].filter(Boolean).join("/"))}><option value="">工程根目录</option>{folders.filter(path => path !== action.path && !path.startsWith(action.path! + "/")).map(path => <option key={path} value={path}>{path}</option>)}</select></label></>
        : <label>{action.kind === "rename" ? "新名称" : `名称 · ${action.path || "工程根目录"}`}<input ref={actionInput} aria-label="画布或文件夹名称" value={name} onChange={event => setName(event.target.value)} disabled={busy} maxLength={120} required /></label>}
      <div className="managementActionButtons"><button type="button" disabled={busy} onClick={() => setAction(undefined)}>取消</button><button className={action.kind === "remove" ? "managementDanger" : "managementPrimary"} type="submit" disabled={busy}>{busy && <IconLoader2 aria-hidden="true" focusable="false" size={14} className="spin" />}{action.kind === "remove" ? "确认删除" : "保存"}</button></div>
    </form>}
    {error && <p className="managementError" role="alert">{error}</p>}
    <footer className="managementFooter"><span>{snapshot.canvasFiles.length} 张画布 · {folders.length} 个文件夹</span><button className="managementPrimary" type="button" disabled={busy || !selectedEntry || selectedEntry.folder || snapshot.canvasId === selected} onClick={() => void perform(async () => { await controller.switchCanvas(selected); onClose(); })}>打开画布</button></footer>
  </MotionLayer>;
}
