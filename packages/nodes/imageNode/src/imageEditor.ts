import { z } from "zod";
import type { NodeWorkbenchService } from "@toonflow/nodes-scaffold/workbenchServices";
import { editorSession } from "@toonflow/node-shared/editorSession";
import { lightingSettingsSchema, readLightingSettings } from "./imageLighting";
import { multiAngleSettingsSchema, readMultiAngleSettings } from "./imageMultiAngle";
import { panoramaSchema } from "./panoramaRenderer";

export const strokeSchema = z.strictObject({ tool: z.enum(["brush", "eraser", "rectangle", "circle", "text", "clear"]).optional(), text: z.string().max(2000).optional(), color: z.string().regex(/^#[\da-f]{6}$/i), width: z.number().finite().min(.1).max(200), points: z.array(z.strictObject({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1) })).max(20000) }).refine(stroke => stroke.tool === "clear" || stroke.points.length >= (stroke.tool === "rectangle" || stroke.tool === "circle" ? 2 : 1), "绘制操作缺少有效坐标").refine(stroke => stroke.tool !== "text" || !!stroke.text?.trim(), "文字标记不能为空");
export const strokesSchema = z.array(strokeSchema).max(500).refine(strokes => strokes.reduce((count, stroke) => count + stroke.points.length, 0) <= 100000, "一次编辑最多10万个笔画采样点");
export const cropSchema = z.strictObject({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) }).refine(value => value.x + value.width <= 1 && value.y + value.height <= 1, "裁剪不能超出归一化原图范围");
export const imageDraftSchema = z.strictObject({
  source: z.string(), sourceRevision: z.string().nullable().describe("源图片快照版本；来自getImageDraft.currentSourceRevision或图像感知sourceRevision，不能以内容SHA fileRevision替代；null表示尚未绑定"), open: z.boolean(), task: z.enum(["mark", "crop", "grid", "lighting", "angle", "panorama"]),
  strokes: strokesSchema, strokeCount: z.number().int().nonnegative().max(500), crop: cropSchema,
  rows: z.number().int().min(1).max(10), columns: z.number().int().min(1).max(10),
  lighting: lightingSettingsSchema, angle: multiAngleSettingsSchema, panorama: panoramaSchema,
});
export type ImageStroke = z.infer<typeof strokeSchema>;
type ImageDraft = z.output<typeof imageDraftSchema>;
const contentFields = ["strokes", "crop", "rows", "columns", "lighting", "angle", "panorama"] as const;
type ImagePatch = Partial<Pick<ImageDraft, typeof contentFields[number]>>;
type ImageHistoryEntry = { before: ImagePatch; after: ImagePatch; task: ImageDraft["task"]; label: string };
export const imageHistorySchema = z.strictObject({ canUndo: z.boolean(), canRedo: z.boolean(), undoLabel: z.string().nullable(), redoLabel: z.string().nullable(), gestureActive: z.boolean() });
const editors = new WeakMap<ReturnType<typeof editorSession<ImageDraft>>, ReturnType<typeof createImageEditor>>();

function sameContent(first: unknown, second: unknown): boolean {
  if (first === second) return true;
  if (!first || !second || typeof first !== "object" || typeof second !== "object") return false;
  if (Array.isArray(first) || Array.isArray(second)) return Array.isArray(first) && Array.isArray(second) && first.length === second.length && first.every((value, index) => sameContent(value, second[index]));
  const previous = first as Record<string, unknown>, next = second as Record<string, unknown>;
  const keys = Object.keys(previous);
  return keys.length === Object.keys(next).length && keys.every(key => Object.hasOwn(next, key) && sameContent(previous[key], next[key]));
}

function createImageEditor(session: ReturnType<typeof editorSession<ImageDraft>>) {
  const undoEntries: ImageHistoryEntry[] = [], redoEntries: ImageHistoryEntry[] = [];
  const listeners = new Set<() => void>();
  let gesture: { before: ImageDraft; label?: string } | undefined;
  let replacing = false;
  function history() {
    const before = gesture?.before, current = session.read().value;
    const pending = !!before && contentFields.some(key => {
      if (before[key] === current[key] && (key !== "strokes" || before.strokeCount === current.strokeCount)) return false;
      const first = key === "strokes" ? before.strokes.slice(0, before.strokeCount) : before[key];
      const second = key === "strokes" ? current.strokes.slice(0, current.strokeCount) : current[key];
      return !sameContent(first, second);
    });
    return { canUndo: pending || undoEntries.length > 0, canRedo: !pending && redoEntries.length > 0, undoLabel: pending ? gesture?.label?.trim() || "当前调整" : undoEntries.at(-1)?.label ?? null, redoLabel: pending ? null : redoEntries.at(-1)?.label ?? null, gestureActive: !!gesture };
  }
  let snapshot = { ...session.read(), history: history() };
  function publish() {
    const current = session.read(), nextHistory = history();
    if (snapshot.value === current.value && snapshot.revision === current.revision && JSON.stringify(snapshot.history) === JSON.stringify(nextHistory)) return;
    snapshot = { ...current, history: nextHistory };
    for (const listener of listeners) listener();
  }
  session.subscribe(() => { if (!replacing) publish(); });
  function requireRevision(expectedRevision?: number) {
    if (expectedRevision !== undefined && expectedRevision !== session.read().revision) throw Object.assign(new Error("编辑台草稿已变化，请重新读取后协调"), { code: "draftRevisionConflict", actualRevision: session.read().revision });
  }
  function changes(before: ImageDraft, after: ImageDraft, label?: string): ImageHistoryEntry | undefined {
    const previous: ImagePatch = {}, next: ImagePatch = {};
    const tasks = { strokes: "mark", crop: "crop", rows: "grid", columns: "grid", lighting: "lighting", angle: "angle", panorama: "panorama" } as const;
    const labels = { mark: "标记", crop: "裁剪", grid: "宫格", lighting: "灯光", angle: "机位", panorama: "全景" };
    let task: ImageDraft["task"] | undefined;
    for (const key of contentFields) {
      if (before[key] === after[key] && (key !== "strokes" || before.strokeCount === after.strokeCount)) continue;
      const first = key === "strokes" ? before.strokes.slice(0, before.strokeCount) : before[key];
      const second = key === "strokes" ? after.strokes.slice(0, after.strokeCount) : after[key];
      if (sameContent(first, second)) continue;
      Object.assign(previous, { [key]: structuredClone(first) }); Object.assign(next, { [key]: structuredClone(second) });
      if (!task || tasks[key] === after.task) task = tasks[key];
    }
    return task ? { before: previous, after: next, task, label: label?.trim() || labels[task] } : undefined;
  }
  function remember(entry: ImageHistoryEntry | undefined) {
    if (!entry) return;
    undoEntries.push(entry);
    if (undoEntries.length > 50) undoEntries.shift();
    redoEntries.length = 0;
  }
  function write(value: ImageDraft, expectedRevision?: number) {
    replacing = true;
    try { session.replace(value, expectedRevision); }
    finally { replacing = false; publish(); }
    return snapshot;
  }
  function endGesture() {
    const current = gesture;
    gesture = undefined;
    if (current) remember(changes(current.before, session.read().value, current.label));
    publish(); return snapshot;
  }
  function apply(patch: ImagePatch, task?: ImageDraft["task"]) {
    const current = session.read().value;
    return write({ ...current, ...structuredClone(patch), ...(patch.strokes ? { strokeCount: patch.strokes.length } : {}), ...(task ? { task } : {}) });
  }
  return {
    read: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    get history() { return snapshot.history; },
    replace(value: ImageDraft, expectedRevision?: number, label?: string) {
      requireRevision(expectedRevision);
      const previous = session.read().value;
      const next = { ...value, strokes: value.strokes.slice(0, value.strokeCount), strokeCount: Math.min(value.strokeCount, value.strokes.length) };
      if (previous.source !== next.source || previous.sourceRevision !== next.sourceRevision) { undoEntries.length = 0; redoEntries.length = 0; gesture = undefined; }
      else if (!gesture) remember(changes(previous, next, label));
      return write(next, expectedRevision);
    },
    beginGesture(label?: string) { if (!gesture) gesture = { before: session.read().value, label }; publish(); return snapshot; },
    endGesture,
    cancelGesture() {
      const current = gesture; gesture = undefined;
      if (!current) return snapshot;
      const entry = changes(current.before, session.read().value);
      if (entry) return apply(entry.before);
      publish(); return snapshot;
    },
    undo(expectedRevision?: number) {
      requireRevision(expectedRevision); endGesture();
      const entry = undoEntries.pop(); if (!entry) return snapshot;
      redoEntries.push(entry); return apply(entry.before, entry.task);
    },
    redo(expectedRevision?: number) {
      requireRevision(expectedRevision); endGesture();
      const entry = redoEntries.pop(); if (!entry) return snapshot;
      undoEntries.push(entry); return apply(entry.after, entry.task);
    },
  };
}

export function imageEditor(workbench: NodeWorkbenchService, source: string, data: Record<string, unknown> = {}) {
  const session = editorSession<ImageDraft>(workbench, "imageEditor", { source, sourceRevision: null, open: false, task: "mark", strokes: [], strokeCount: 0, crop: { x: 0, y: 0, width: 1, height: 1 }, rows: 2, columns: 2, lighting: readLightingSettings(data.lighting), angle: readMultiAngleSettings(data.multiAngle), panorama: { mode: "sphere", count: 4, yaw: 0, pitch: 0, fov: 60, layout: "separate" } });
  let editor = editors.get(session);
  if (!editor) { editor = createImageEditor(session); editors.set(session, editor); }
  return editor;
}
