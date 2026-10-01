import { z } from "zod";
import { parseCanvasDocument } from "./canvasDocument";
import type { CanvasDocument, JsonObject } from "./canvasDocument";
import { applyDocumentCommand, parseDocumentCommand } from "./documentCommands";
import type { DocumentCommand } from "./documentCommands";

export type DocumentBinding = Readonly<{ directory: string; canvasId: string }>;
export type DocumentRuntimeUpdate = Readonly<{ id: string; data: Readonly<JsonObject> }>;
export type DocumentSaveContext = DocumentBinding & { readonly revision: number; readonly runtimeUpdates: readonly DocumentRuntimeUpdate[] };
export type DocumentSnapshot = Readonly<{
  directory: string;
  canvasId: string;
  document: CanvasDocument;
  revision: number;
  editRevision: number;
  savedRevision: number;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  readOnly: boolean;
  saving: boolean;
  saveError: string | null;
  disposed: boolean;
}>;
export type DocumentSessionOptions = DocumentBinding & {
  document: unknown;
  readOnly?: boolean;
  revision?: number;
  historyLimit?: number;
  save(document: CanvasDocument, context: DocumentSaveContext): Promise<void>;
};
export type DocumentSession = {
  getSnapshot(): DocumentSnapshot;
  getHistory(): { direction: "undo" | "redo"; steps: number; nodes: number; edges: number }[];
  subscribe(listener: () => void): () => void;
  execute(command: DocumentCommand): DocumentSnapshot;
  undo(options?: { expectedRevision?: number }): DocumentSnapshot;
  redo(options?: { expectedRevision?: number }): DocumentSnapshot;
  setReadOnly(readOnly: boolean): void;
  applyRemote(document: unknown, baseline?: unknown): DocumentSnapshot;
  flushSave(): Promise<void>;
  dispose(): void;
};

export class DocumentSessionError extends Error {
  constructor(public readonly code: "revisionConflict" | "readOnly" | "disposed", message: string, public readonly actualRevision?: number, public readonly expectedRevision?: number) {
    super(message);
    this.name = "DocumentSessionError";
  }
}

const bindingSchema = z.strictObject({
  directory: z.string().min(1).refine(value => !value.includes("\0") && (/^\//.test(value) || /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value)), "工作区目录必须是绝对路径"),
  canvasId: z.string().min(1).refine(value => !/[\\\0]/.test(value) && !/^(?:\/|[a-z][a-z\d+.-]*:)/i.test(value) && value.split("/").every(part => !!part && part !== "." && part !== ".."), "画布路径必须位于工作区内"),
});

export function createDocumentSession(options: DocumentSessionOptions): DocumentSession {
  const binding = Object.freeze(bindingSchema.parse({ directory: options.directory, canvasId: options.canvasId }));
  const save = options.save;
  const historyLimit = z.number().int().min(1).max(100).parse(options.historyLimit ?? 100);
  let document = freezeJson(parseCanvasDocument(options.document));
  let revision = z.number().int().nonnegative().parse(options.revision ?? 0);
  let editRevision = 0;
  let savedRevision = revision;
  let savedJson = JSON.stringify(document);
  let readOnly = z.boolean().parse(options.readOnly ?? false);
  let disposed = false;
  let saving = false;
  let saveError: string | null = null;
  let pendingSave: Promise<void> | undefined;
  const undoHistory: CanvasDocument[] = [];
  const redoHistory: CanvasDocument[] = [];
  const runtimeData = new Map<string, JsonObject>();
  const listeners = new Set<() => void>();
  let snapshot = makeSnapshot();

  function makeSnapshot(): DocumentSnapshot {
    return Object.freeze({ ...binding, document, revision, editRevision, savedRevision, dirty: JSON.stringify(document) !== savedJson,
      canUndo: !readOnly && !disposed && undoHistory.length > 0, canRedo: !readOnly && !disposed && redoHistory.length > 0,
      readOnly, saving, saveError, disposed });
  }
  function publish() {
    snapshot = makeSnapshot();
    for (const listener of listeners) listener();
  }
  function checkEditable(expectedRevision?: number) {
    if (disposed) throw new DocumentSessionError("disposed", "编辑会话已关闭");
    if (readOnly) throw new DocumentSessionError("readOnly", "当前画布只读");
    if (expectedRevision !== undefined) {
      z.number().int().nonnegative().parse(expectedRevision);
      if (expectedRevision !== revision) throw new DocumentSessionError("revisionConflict", "画布已变化，请读取最新修订后重新提交", revision, expectedRevision);
    }
  }
  function captureRuntimeData(value: CanvasDocument) {
    for (const node of value.nodes) {
      const previous = runtimeData.get(node.id);
      if (!previous) continue;
      runtimeData.set(node.id, Object.fromEntries(Object.entries(previous).map(([key, latest]) => [key,
        Object.hasOwn(node.data ?? {}, key) ? node.data![key]! : latest,
      ])));
    }
  }
  function changeHistory(source: CanvasDocument[], target: CanvasDocument[], expectedRevision?: number) {
    checkEditable(expectedRevision);
    const previous = source.pop();
    if (!previous) return snapshot;
    target.push(document);
    document = freezeJson({ ...previous, viewport: document.viewport });
    revision++;
    editRevision++;
    publish();
    return snapshot;
  }
  const session: DocumentSession = {
    getSnapshot: () => snapshot,
    getHistory: () => (["undo", "redo"] as const).flatMap(direction => [...(direction === "undo" ? undoHistory : redoHistory)].reverse().map((item, index) => ({ direction, steps: index + 1, nodes: item.nodes.length, edges: item.edges.length }))),
    subscribe(listener) {
      if (disposed) throw new DocumentSessionError("disposed", "编辑会话已关闭");
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    execute(input) {
      const command = parseDocumentCommand(input);
      checkEditable(command.expectedRevision);
      const next = applyDocumentCommand(document, command);
      for (const operation of command.name === "batch" ? command.args.commands : [command]) if (operation.name === "updateRuntimeData") {
        for (const update of operation.args.updates) runtimeData.set(update.id, { ...runtimeData.get(update.id), ...update.data });
      }
      if (JSON.stringify(next) === JSON.stringify(document)) return snapshot;
      // ACT: 最多保留 100 个纯 JSON 快照；大画布历史内存成为瓶颈时再升级为差量日志，不纳入外部媒体文件。
      // 视口保存为工程偏好，不占用正文与节点的创作撤销步骤。
      if (command.name !== "setViewport" && command.name !== "updateRuntimeData") {
        editRevision++;
        undoHistory.push(document);
        if (undoHistory.length > historyLimit) undoHistory.shift();
        redoHistory.length = 0;
      }
      // 任务回执属于当前运行状态；持久化并同步到已有历史，撤销创作时不能复活旧任务或丢失操作ID。
      for (const operation of command.name === "batch" ? command.args.commands : [command]) if (operation.name === "updateRuntimeData") {
        for (const history of [undoHistory, redoHistory]) for (let index = 0; index < history.length; index++) {
          const frame = history[index]!, ids = new Set(frame.nodes.map(node => node.id));
          const updates = operation.args.updates.filter(update => ids.has(update.id));
          if (updates.length) history[index] = freezeJson(applyDocumentCommand(frame, { name: "updateRuntimeData", args: { updates } }));
        }
      }
      document = freezeJson(next);
      revision++;
      publish();
      return snapshot;
    },
    undo: options => changeHistory(undoHistory, redoHistory, options?.expectedRevision),
    redo: options => changeHistory(redoHistory, undoHistory, options?.expectedRevision),
    setReadOnly(value) {
      if (disposed) throw new DocumentSessionError("disposed", "编辑会话已关闭");
      readOnly = z.boolean().parse(value);
      publish();
    },
    applyRemote(input, baseline = input) {
      if (disposed) throw new DocumentSessionError("disposed", "编辑会话已关闭");
      const next = freezeJson(parseCanvasDocument(input));
      const saved = parseCanvasDocument(baseline);
      captureRuntimeData(next);
      undoHistory.length = 0;
      redoHistory.length = 0;
      if (JSON.stringify(next) !== JSON.stringify(document)) { document = next; revision++; editRevision++; }
      savedJson = JSON.stringify(saved);
      savedRevision = revision;
      saveError = null;
      publish();
      return snapshot;
    },
    flushSave() {
      if (pendingSave) return pendingSave;
      if (disposed) return Promise.reject(new DocumentSessionError("disposed", "编辑会话已关闭"));
      pendingSave = Promise.resolve().then(async () => {
        while (snapshot.dirty) {
          checkEditable();
          const submitted = document;
          const submittedRevision = revision;
          captureRuntimeData(submitted);
          // 运行字段声明跨保存保留；节点已删除时仍发送最后回执，防止协作重做恢复旧任务。
          const runtimeUpdates = freezeJson(JSON.parse(JSON.stringify([...runtimeData].map(([id, data]) => ({ id, data })))) as DocumentRuntimeUpdate[]);
          saving = true;
          saveError = null;
          publish();
          try {
            await save(parseCanvasDocument(submitted), Object.freeze({ ...binding, revision: submittedRevision, runtimeUpdates }));
            savedJson = JSON.stringify(submitted);
            savedRevision = submittedRevision;
          } catch (error) {
            saveError = error instanceof Error ? error.message : String(error);
            throw error;
          } finally {
            saving = false;
            publish();
          }
          if (disposed) break;
        }
      }).finally(() => { pendingSave = undefined; });
      return pendingSave;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      publish();
      listeners.clear();
      undoHistory.length = 0;
      redoHistory.length = 0;
    },
  };
  return session;
}

function freezeJson<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freezeJson(item);
    Object.freeze(value);
  }
  return value;
}
