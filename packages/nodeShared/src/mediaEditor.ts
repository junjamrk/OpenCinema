import { z } from "zod";
import type { NodeWorkbenchService } from "@toonflow/nodes-scaffold/workbenchServices";
import type { WorkspaceFiles } from "@toonflow/nodes-scaffold/nodeFiles";
import { editorSession } from "./editorSession";
import { ToolExecutionError } from "@toonflow/nodes-scaffold/toolErrors";

export const mediaRangeSchema = z.strictObject({ start: z.number().finite().nonnegative().describe("源素材秒数"), end: z.number().finite().positive().describe("源素材秒数，须晚于start") }).refine(value => value.end > value.start, "结束时间须晚于开始时间");
export const mediaDraftSchema = z.strictObject({
  source: z.string(), sourceRevision: z.string().nullable().describe("源文件快照版本；来自getMediaDraft.currentSourceRevision或图像感知sourceRevision，不能使用内容SHA fileRevision替代；null表示尚未绑定"), start: z.number().finite().nonnegative(), end: z.number().finite().positive(),
  groups: z.array(z.array(mediaRangeSchema).min(1).max(500)).max(500).refine(groups => groups.flat().length <= 500, "最多500个源片段"),
  selected: z.number().int().nonnegative(), playhead: z.number().finite().nonnegative(),
});
export type MediaDraft = z.infer<typeof mediaDraftSchema>;
export const mediaHistorySchema = z.strictObject({ canUndo: z.boolean(), canRedo: z.boolean(), undoLabel: z.string().nullable(), redoLabel: z.string().nullable() });
export const mediaViewSchema = z.strictObject({ open: z.boolean(), clipOpen: z.boolean() });
const editors = new WeakMap<NodeWorkbenchService, ReturnType<typeof createMediaEditor>>();

function createMediaEditor(session: ReturnType<typeof editorSession<MediaDraft>>) {
  const previous: { before: MediaDraft; after: MediaDraft; label: string }[] = [], future: typeof previous = [];
  const listeners = new Set<() => void>();
  const history = () => ({ canUndo: !!previous.length, canRedo: !!future.length, undoLabel: previous.at(-1)?.label ?? null, redoLabel: future.at(-1)?.label ?? null });
  let snapshot = { ...session.read(), history: history() };
  function publish() {
    const current = session.read(), nextHistory = history();
    if (snapshot.value === current.value && snapshot.revision === current.revision && JSON.stringify(snapshot.history) === JSON.stringify(nextHistory)) return;
    snapshot = { ...current, history: nextHistory };
    for (const listener of listeners) listener();
  }
  function requireRevision(expectedRevision?: number) {
    if (expectedRevision !== undefined && session.read().revision !== expectedRevision) throw Object.assign(new Error("媒体草稿已变化，请重新读取后协调"), { code: "draftRevisionConflict", actualRevision: session.read().revision });
  }
  function write(value: MediaDraft, expectedRevision?: number) {
    session.replace(value, expectedRevision); publish(); return snapshot;
  }
  return {
    read: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    get history() { return snapshot.history; },
    replace(value: MediaDraft, expectedRevision?: number, label: string | null = "编辑剪辑") {
      requireRevision(expectedRevision);
      const before = session.read().value;
      if (before.source !== value.source || before.sourceRevision !== value.sourceRevision) { previous.length = 0; future.length = 0; }
      else if (label !== null && (before.start !== value.start || before.end !== value.end || JSON.stringify(before.groups) !== JSON.stringify(value.groups))) {
        previous.push({ before: structuredClone(before), after: structuredClone(value), label });
        if (previous.length > 50) previous.shift();
        future.length = 0;
      }
      return write(value, expectedRevision);
    },
    undo(expectedRevision?: number) {
      requireRevision(expectedRevision);
      const entry = previous.pop(); if (!entry) return snapshot;
      future.push(entry); return write(entry.before);
    },
    redo(expectedRevision?: number) {
      requireRevision(expectedRevision);
      const entry = future.pop(); if (!entry) return snapshot;
      previous.push(entry); return write(entry.after);
    },
  };
}

export function mediaEditor(workbench: NodeWorkbenchService) {
  let editor = editors.get(workbench);
  if (!editor) {
    editor = createMediaEditor(editorSession<MediaDraft>(workbench, "mediaEditor", { source: "", sourceRevision: null, start: 0, end: 5, groups: [], selected: 0, playhead: 0 }));
    editors.set(workbench, editor);
  }
  return editor;
}
export function mediaView(workbench: NodeWorkbenchService) { return editorSession(workbench, "mediaView", { open: false, clipOpen: false }); }
function sourceRevisionConflict(path: string, expectedRevision: string, actualRevision: string, executionState: "notDispatched" | "failed" = "notDispatched") {
  const message = "源素材文件已变化，旧草稿保留；请重新观察当前素材并明确重建选区";
  return Object.assign(new Error(message), { code: "draftSourceRevisionConflict", expectedRevision, actualRevision, details: { code: "draftSourceRevisionConflict", message, phase: executionState === "notDispatched" ? "validation" : "execution", executionState, target: { path }, recovery: { action: "readState", message: "重新读取媒体与getImageDraft/getMediaDraft，使用currentSourceRevision明确建立新选区；不要重试旧草稿" }, expectedRevision, actualRevision } });
}
export async function readMediaSourceRevision(files: WorkspaceFiles, path: string, expectedRevision?: string, signal?: AbortSignal, executionState: "notDispatched" | "failed" = "notDispatched") {
  if (!files.readRange) throw new ToolExecutionError({ code: "mediaRevisionUnavailable", message: "当前runtime未提供素材版本读取，请更新或重新连接工作台", phase: "validation", executionState, target: { path }, recovery: { action: "rediscoverTools", message: "读取getAppState确认React runtime和文件读取能力后重新发现工具", tool: "getAppState" } });
  const head = await files.readRange(path, 0, 1, undefined, signal).catch(error => {
    const status = error?.response?.status;
    if (![400, 403, 404, 416].includes(status)) throw error;
    throw new ToolExecutionError({ code: status === 403 ? "mediaSourceDenied" : "mediaSourceUnavailable", message: status === 403 ? "当前工作区无权读取源素材" : "源素材不存在、为空或不是可读取的媒体文件", phase: status === 403 ? "authorization" : "validation", executionState, target: { path }, recovery: { action: "readState", message: "先用workspaceFiles stat检查源文件，再选择或连接实际存在的媒体；终态以executionState为准", tool: "workspaceFiles", args: { action: "stat", path } } });
  });
  if (expectedRevision !== undefined && head.revision !== expectedRevision) throw sourceRevisionConflict(path, expectedRevision, head.revision, executionState);
  return head;
}
export async function readMediaSourceSnapshot(files: WorkspaceFiles, path: string, maximumBytes: number, signal: AbortSignal, expectedRevision?: string) {
  const head = await readMediaSourceRevision(files, path, expectedRevision, signal);
  if (!head.size || head.size > maximumBytes) throw new Error("源素材超过本次读取大小上限或为空");
  const content = new Uint8Array(head.size);
  for (let offset = 0; offset < head.size;) {
    signal.throwIfAborted();
    const chunk = await files.readRange!(path, offset, Math.min(8 * 1024 ** 2, head.size - offset), head.revision, signal).catch(async error => {
      if (error?.response?.status === 409) await readMediaSourceRevision(files, path, head.revision, signal);
      throw error;
    });
    if (chunk.revision !== head.revision || chunk.size !== head.size || !chunk.content.byteLength) throw sourceRevisionConflict(path, head.revision, chunk.revision);
    content.set(new Uint8Array(chunk.content), offset); offset += chunk.content.byteLength;
  }
  await readMediaSourceRevision(files, path, head.revision, signal);
  return { content: content.buffer, revision: head.revision };
}
export function mediaClipPosition(groups: MediaDraft["groups"], time: number) {
  let duration = 0, selected = 0, sourceTime = 0, found = false;
  groups.forEach((ranges, index) => ranges.forEach(range => {
    const length = range.end - range.start;
    if (!found) {
      selected = index;
      sourceTime = range.start + Math.min(length, Math.max(0, time - duration));
      found = time < duration + length;
    }
    duration += length;
  }));
  return { duration, selected, sourceTime };
}
const players = new WeakMap<NodeWorkbenchService, Map<"source" | "clip", HTMLMediaElement>>();
export function mediaPlayer(workbench: NodeWorkbenchService, view: "source" | "clip" = "source") { return players.get(workbench)?.get(view); }
export function attachMediaPlayer(workbench: NodeWorkbenchService, player: HTMLMediaElement, view: "source" | "clip" = "source") {
  let entries = players.get(workbench);
  if (!entries) { entries = new Map(); players.set(workbench, entries); }
  entries.set(view, player);
  return () => { if (entries.get(view) === player) entries.delete(view); };
}
