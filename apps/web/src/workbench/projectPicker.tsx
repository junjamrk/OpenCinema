import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import axios from "axios";
import { z } from "zod";
import { IconArrowUp, IconFolder, IconFolderOpen, IconFolderPlus, IconLoader2 } from "@tabler/icons-react";
import { workspaceFileClient } from "@/lib/workspaceFileClient";

const folderSchema = z.object({ name: z.string(), path: z.string() });
const listingSchema = z.object({
  path: z.string(), parent: z.string().nullable(), truncated: z.boolean(), folders: z.array(folderSchema),
  shortcuts: z.array(z.object({ label: z.string(), path: z.string() })),
});
const api = { baseURL: "/api/workspaces" };

export default function ProjectPicker({ creating, initialDirectory, pending, onOpen, onToggleCreating, children }: { creating: boolean; initialDirectory: string; pending: boolean; onOpen: (directory: string) => Promise<unknown>; onToggleCreating: () => void; children?: ReactNode }) {
  const [path, setPath] = useState(initialDirectory);
  const [name, setName] = useState("");
  const [listing, setListing] = useState<z.infer<typeof listingSchema>>();
  const [restricted, setRestricted] = useState(false);
  const [error, setError] = useState("");
  const [restoring, setRestoring] = useState(false);
  const archiveInput = useRef<HTMLInputElement>(null);

  async function browse(target: string, signal?: AbortSignal) {
    setError("");
    try {
      const { data } = await workspaceFileClient.get("/browse", { ...api, params: { path: target }, signal });
      const value = listingSchema.parse(data.data);
      setListing(value); setPath(value.path);
      return true;
    } catch (value) {
      if (axios.isCancel(value)) return false;
      // 协作或服务器部署不开放本机目录，这里退回只填路径。
      if (axios.isAxiosError(value) && value.response?.status === 403) setRestricted(true);
      else setError(value instanceof Error ? value.message : String(value));
      return false;
    }
  }

  useEffect(() => {
    const operation = new AbortController();
    void browse(initialDirectory, operation.signal).then(found => { if (!found && initialDirectory && !operation.signal.aborted) void browse("", operation.signal); });
    return () => operation.abort();
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const target = path.trim();
    if (!target || pending) return;
    if (restricted) { await onOpen(target); return; }
    if (target !== listing?.path) { await browse(target); return; }
    if (!creating) { await onOpen(target); return; }
    setError("");
    try {
      const { data } = await workspaceFileClient.post("/createFolder", { parent: target, name }, api);
      await onOpen(z.object({ path: z.string() }).parse(data.data).path);
    } catch (value) { setError(value instanceof Error ? value.message : String(value)); }
  }

  async function restore(archive: File) {
    if (!listing) return;
    setError(""); setRestoring(true);
    try {
      const { data } = await workspaceFileClient.post("/restoreProject", archive, { ...api, params: { directory: listing.path, name: name.trim() || archive.name.replace(/\.zip$/i, "") }, headers: { "Content-Type": "application/zip" } });
      await onOpen(z.object({ directory: z.string() }).parse(data.data).directory);
    } catch (value) { setError(value instanceof Error ? value.message : String(value)); }
    finally { setRestoring(false); }
  }

  const ready = !!path.trim() && (!creating || restricted || !!name.trim());
  return <form className="projectForm projectPicker" onSubmit={event => void submit(event)}>
    {creating && !restricted && <><label htmlFor="projectName">工程名称</label><input id="projectName" autoFocus value={name} maxLength={200} onChange={event => setName(event.target.value)} placeholder="例如 第一部短片" autoComplete="off" disabled={pending} /></>}
    <label htmlFor="projectDirectory">{creating && !restricted ? "放在" : "文件夹"}</label>
    <div className="projectPath">
      {!restricted && <button type="button" aria-label="上一级文件夹" title="上一级文件夹" disabled={!listing?.parent || pending} onClick={() => listing?.parent && void browse(listing.parent)}><IconArrowUp aria-hidden="true" focusable="false" size={16} /></button>}
      <input id="projectDirectory" autoFocus={!creating} value={path} onChange={event => setPath(event.target.value)} onKeyDown={event => {
        // 路径改过时回车先进入该文件夹；提交按钮在未填工程名时禁用，不能依赖表单隐式提交。
        if (event.key !== "Enter" || event.nativeEvent.isComposing || restricted || path.trim() === listing?.path) return;
        event.preventDefault();
        void browse(path.trim());
      }} placeholder="例如 /Users/me/Movies/myFilm" autoComplete="off" spellCheck={false} disabled={pending} />
    </div>
    {!restricted && <>
      <div className="projectShortcuts" role="group" aria-label="常用位置">{listing?.shortcuts.map(shortcut => <button type="button" key={shortcut.path} aria-pressed={shortcut.path === listing.path} disabled={pending} onClick={() => void browse(shortcut.path)}>{shortcut.label}</button>)}</div>
      <div className="projectFolders" role="group" aria-label={`${path} 中的文件夹`}>
        {listing?.folders.map(folder => <button type="button" key={folder.path} title={folder.path} disabled={pending} onClick={() => void browse(folder.path)}><IconFolder aria-hidden="true" focusable="false" size={16} /><span>{folder.name}</span></button>)}
        {listing && !listing.folders.length && <p>这里没有子文件夹</p>}
        {listing?.truncated && <p>文件夹太多，只显示前 1000 个，可在上方直接输入路径</p>}
      </div>
    </>}
    <small>{restricted ? "填写已存在文件夹的绝对路径。" : creating ? "会在这里新建同名文件夹，并创建第一张画布。" : "画布和素材都保存在这个文件夹里；空文件夹会自动创建第一张画布。"}</small>
    {error && <p className="projectPickerError" role="alert">{error}</p>}
    {!restricted && <button type="button" className="projectPickerSwitch" disabled={pending || restoring} onClick={onToggleCreating}>{creating ? "打开已有工程" : "新建工程"}</button>}
    {creating && !restricted && <><button type="button" className="projectPickerSwitch" title="恢复“导出工程”生成的 ZIP，放到上方位置" disabled={pending || restoring || !listing} onClick={() => archiveInput.current?.click()}>{restoring ? "正在导入…" : "导入工程包"}</button><input ref={archiveInput} type="file" accept=".zip,application/zip" hidden aria-label="工程包" onChange={event => { const archive = event.target.files?.[0]; event.target.value = ""; if (archive) void restore(archive); }} /></>}
    <button type="submit" disabled={!ready || pending || restoring}>{pending ? <IconLoader2 aria-hidden="true" focusable="false" className="spin" size={17} /> : creating && !restricted ? <IconFolderPlus aria-hidden="true" focusable="false" size={17} /> : <IconFolderOpen aria-hidden="true" focusable="false" size={17} />}{creating && !restricted ? "创建并打开" : "打开此文件夹"}</button>
    {children}
  </form>;
}
