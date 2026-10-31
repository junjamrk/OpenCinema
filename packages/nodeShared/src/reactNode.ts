import { useEffect, useState } from "react";
import type { PluginActivationContext } from "@toonflow/nodes-scaffold/contracts";
import type { NodeDocumentService, ReactNodeViewProps } from "@toonflow/nodes-scaffold/react";
import type { NodeWorkbenchService, ReactNodeServices } from "@toonflow/nodes-scaffold/workbenchServices";
import type { NodeMediaValue } from "@toonflow/nodes-scaffold/values";
import { z } from "zod";
import { ToolExecutionError, type ToolErrorDetails } from "@toonflow/nodes-scaffold/toolErrors";
import { readVideoSources } from "./videoShot";

export type MediaType = "image" | "video" | "audio";
export type NodeViewProps = ReactNodeViewProps & { controller: ReactNodeViewProps["controller"] & ReactNodeServices };
export const relativePathSchema = z.string().min(1).max(4096).refine(path => !/^[\\/]|^[a-z][a-z0-9+.-]*:|[\x00-\x1f]/i.test(path) && !path.replaceAll("\\", "/").split("/").includes(".."), "仅支持工作区相对路径");
export const mediaValueSchema = z.strictObject({ url: relativePathSchema, mimeType: z.string().min(1).max(200) });

export function nodePreconditionError(workbench: NodeWorkbenchService, nodeId: string, message: string, code = "mediaSourceRequired", recovery?: ToolErrorDetails["recovery"]) {
  return new ToolExecutionError({ code, message, phase: "validation", executionState: "notDispatched", target: { directory: workbench.directory, canvasId: workbench.canvasId, nodeId }, recovery: recovery ?? { action: "readState", message: "用getCanvasNodes读取当前节点ports/outputs，再读取输入连线；选择或连接有效媒体源后重新调用。此前未启动媒体处理。", tool: "getCanvasNodes", args: { canvasId: workbench.canvasId, nodeIds: [nodeId], fields: ["ports", "outputs"] } } });
}

export function cloneMediaNodeData(data: Record<string, unknown>) {
  const copy = structuredClone(data);
  const videoSources = readVideoSources(data);
  if (videoSources.length) copy.videoSourceHistory = videoSources;
  delete copy.textGeneration;
  delete copy.mediaOperation;
  for (const key of ["generation", "analysisProgress", "mediaInfoStatus"]) {
    const value = copy[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const state = value as Record<string, unknown>;
    if (["running", "delegated", "unknown", "interrupted", "cancelRequested"].includes(String(state.status))) delete copy[key];
    else { delete state.taskId; delete state.requestId; delete state.cost; }
  }
  return copy;
}

export function readNodeData(document: NodeDocumentService, id: string) {
  const node = document.readNode(id) as { data?: Record<string, unknown> } | undefined;
  if (!node) throw new ToolExecutionError({ code: "nodeNotFound", message: "节点已不存在", phase: "target", executionState: "notDispatched", target: { nodeId: id }, recovery: { action: "readState", message: "重新读取当前画布节点并固定仍存在的目标", tool: "getCanvasNodes", args: { nodeIds: [id] } } });
  return node.data ?? {};
}

export function readMedia(data: Record<string, unknown> | undefined, type: MediaType): NodeMediaValue | undefined {
  const outputs = data?.outputs as Record<string, unknown> | undefined;
  const output = outputs?.[type] as { dataType?: unknown; value?: unknown } | undefined;
  const reference = output?.value && typeof output.value === "object" ? output.value as Record<string, unknown> : undefined;
  const value = mediaValueSchema.safeParse({ url: reference?.url, mimeType: reference?.mimeType });
  return value.success && value.data.mimeType.startsWith(`${type}/`) ? value.data : undefined;
}

export function pluginServices(context: PluginActivationContext) {
  if (!context.nodeId) throw new Error("节点插件未绑定编辑会话");
  return {
    id: context.nodeId,
    document: context.getService<NodeDocumentService>("document"),
    workbench: context.getService<NodeWorkbenchService>("workbench"),
  };
}

export function mediaByteLimit(type: MediaType) { return (type === "video" ? 2 * 1024 : 100) * 1024 ** 2; }

export async function setMedia(context: PluginActivationContext, type: MediaType, value: NodeMediaValue, signal: AbortSignal, expectedRevision?: number, taskId?: string) {
  const { id, document, workbench } = pluginServices(context);
  const source = mediaValueSchema.parse(value);
  if (!source.mimeType.startsWith(`${type}/`)) throw new Error(`请选择${type}媒体文件`);
  const revision = expectedRevision ?? document.getRevision();
  const head = workbench.files.readRange ? await workbench.files.readRange(source.url, 0, 1, undefined, signal) : undefined;
  if (head && !head.size) throw new Error("媒体文件不能为空");
  if (head && head.size > mediaByteLimit(type)) throw new Error(type === "video" ? "视频须为 2 GiB 以内" : "媒体文件须为 100 MiB 以内");
  signal.throwIfAborted();
  const data = readNodeData(document, id);
  if (!taskId && ["running", "delegated", "unknown", "cancelRequested"].includes(String((data.generation as { status?: string } | undefined)?.status))) throw new Error("生成任务仍在等待终态；提交实际产物时须提供原taskId");
  if (taskId && (!data.generation || typeof data.generation !== "object" || !("taskId" in data.generation) || data.generation.taskId !== taskId)) throw new Error("生成任务标识已变化，请勿提交旧任务的结果");
  const videoSources = type === "video" ? readVideoSources(data) : [];
  if (type === "video" && taskId && !videoSources.some(value => value.path === source.url && value.sourceRevision === head?.revision)) videoSources.push({ path: source.url, ...(head ? { sourceRevision: head.revision } : {}), taskId, origin: "generated" });
  await workbench.updateData({ outputs: { ...(data.outputs as object ?? {}), [type]: { dataType: type.toUpperCase(), value: source } }, ...(type === "video" ? { shotReview: null, videoSourceHistory: videoSources } : {}) }, revision, signal);
  if (data.generation && typeof data.generation === "object" && (taskId || !("status" in data.generation && data.generation.status === "unknown"))) {
    const { error: _error, ...previous } = data.generation as Record<string, unknown>;
    const output = taskId ? source : previous.output ?? readMedia(data, type);
    await workbench.updateRuntimeData({ generation: { ...previous, ...(output ? { output } : {}), status: "completed", finishedAt: new Date().toISOString() } }, signal);
  }
  await document.save();
  return { nodeId: id, ...source, revision: document.getRevision() };
}

const mimeTypes: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", avif: "image/avif", apng: "image/apng", bmp: "image/bmp", svg: "image/svg+xml", ico: "image/x-icon", tif: "image/tiff", tiff: "image/tiff",
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska", avi: "video/x-msvideo", ogv: "video/ogg", ts: "video/mp2t",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", flac: "audio/flac", opus: "audio/opus", aif: "audio/aiff", aiff: "audio/aiff", au: "audio/basic", caf: "audio/x-caf",
};

export function mediaFileType(file: File, type: MediaType) {
  const mimeType = file.type.startsWith(`${type}/`) ? file.type : mimeTypes[file.name.split(".").at(-1)?.toLowerCase() ?? ""];
  return mimeType?.startsWith(`${type}/`) ? mimeType : undefined;
}

export function mediaAccept(type: MediaType) {
  return [`${type}/*`, ...Object.keys(mimeTypes).filter(extension => mimeTypes[extension]!.startsWith(`${type}/`)).map(extension => `.${extension}`)].join(",");
}

export async function listMediaHistory(workbench: NodeWorkbenchService, nodeId: string, type: MediaType, current?: NodeMediaValue) {
  const entries = await workbench.files.list(`assets/${nodeId}`).catch(error => {
    if (error?.response?.data?.data?.code !== "ENOENT") throw error;
    return { entries: [] };
  });
  const values = new Map<string, NodeMediaValue>();
  for (const entry of entries.entries) {
    const mimeType = mimeTypes[entry.name.split(".").at(-1)?.toLowerCase() ?? ""];
    if (entry.type === "file" && mimeType?.startsWith(`${type}/`)) values.set(entry.path, { url: entry.path, mimeType });
  }
  if (current) values.set(current.url, current);
  return [...values.values()].sort((left, right) => right.url.localeCompare(left.url, "zh-CN", { numeric: true }));
}

export function registerMediaTools(context: PluginActivationContext, type: MediaType, transform?: (value: NodeMediaValue, signal: AbortSignal, taskId?: string) => Promise<NodeMediaValue>) {
  const { id, document, workbench } = pluginServices(context);
  const title = type[0]!.toUpperCase() + type.slice(1);
  context.registerTool({ name: `set${title}`, description: `使用已有工作区${type}媒体作为当前输出；保留历史文件并纳入统一撤销。`,
    outputSchema: mediaValueSchema.extend({ nodeId: z.string(), revision: z.number().int().nonnegative() }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    parameters: z.strictObject({ path: relativePathSchema, mimeType: z.string().regex(new RegExp(`^${type}/[a-zA-Z0-9.+-]+$`)), expectedRevision: z.number().int().nonnegative().optional(), taskId: z.uuid().optional().describe("宿主完成生成任务时提供原taskId；必须匹配当前任务，确认该任务已完成。") }),
    async execute(args, { signal }) {
      workbench.assertWritable(args.expectedRevision);
      const value = { url: args.path, mimeType: args.mimeType };
      return setMedia(context, type, transform ? await transform(value, signal, args.taskId) : value, signal, args.expectedRevision, args.taskId);
    } });
  context.registerTool({ name: "getMedia", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, description: "读取当前媒体引用、节点修订和分页媒体历史，不读取媒体内容。", parameters: z.strictObject({ history: z.boolean().optional(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional() }), outputSchema: z.strictObject({ current: mediaValueSchema.optional(), history: z.array(mediaValueSchema).optional(), total: z.number().int().nonnegative().optional(), nextOffset: z.number().int().nonnegative().nullable().optional(), revision: z.number().int().nonnegative() }),
    async execute(args, { signal }) {
      const current = readMedia(readNodeData(document, id), type);
      const history = args.history ? await listMediaHistory(workbench, id, type, current) : undefined;
      signal.throwIfAborted();
      const offset = args.offset ?? 0; const limit = args.limit ?? 20;
      return { current, ...(history ? { history: history.slice(offset, offset + limit), total: history.length, nextOffset: offset + limit < history.length ? offset + limit : null } : {}), revision: document.getRevision() };
    } });
}

export function useMediaUrl(controller: ReactNodeViewProps["controller"], value?: NodeMediaValue) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    let release: (() => void) | undefined;
    setUrl(""); setError("");
    if (value) void controller.acquireMedia(value.url, value.mimeType).then(media => {
      if (!active) { media.release(); return; }
      release = media.release; setUrl(media.url);
    }).catch(reason => { if (active) setError(errorText(reason)); });
    return () => { active = false; release?.(); };
  }, [controller, value?.url, value?.mimeType, attempt]);
  return { url, error, retry: () => setAttempt(current => current + 1) };
}

export function errorText(error: unknown) {
  if (error instanceof z.ZodError) return error.issues.map(issue => issue.message).join("；");
  return error instanceof Error ? error.message : String(error);
}

export function isExecutionUnknown(error: unknown): error is object {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; executionState?: unknown; details?: { code?: unknown; executionState?: unknown } };
  return value.executionState === "unknown" || value.details?.executionState === "unknown" || ["hostRequestUnknown", "mediaTaskUnknown", "ffmpegTaskUnknown"].includes(String(value.code ?? value.details?.code));
}
