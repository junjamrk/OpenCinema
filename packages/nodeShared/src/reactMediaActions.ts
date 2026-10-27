import { z } from "zod";
import type { PluginActivationContext } from "@toonflow/nodes-scaffold/contracts";
import type { BrowserFfmpegCommand, FfprobeData } from "@toonflow/ffmpeg/browser";
import type { NodeWorkbenchService } from "@toonflow/nodes-scaffold/workbenchServices";
import type { NodeDocumentService } from "@toonflow/nodes-scaffold/react";
import { isBrowserAudioAsrSupported, transcribeBrowserAudio } from "@toonflow/asr";
import { ToolExecutionError } from "@toonflow/nodes-scaffold/toolErrors";
import { isExecutionUnknown, mediaValueSchema, nodePreconditionError, pluginServices, readMedia, readNodeData, relativePathSchema, type MediaType } from "./reactNode";
import { mediaClipPosition, mediaDraftSchema, mediaEditor, mediaHistorySchema, mediaPlayer, mediaRangeSchema, mediaView, mediaViewSchema, readMediaSourceRevision } from "./mediaEditor";
import { compareVideoReviews, isGeneratedVideo, readVideoReviews, readVideoSources, videoReviewAllows, videoReviewSchema, type VideoSource } from "./videoShot";
import { compositionAudioStream, compositionSourceSchema, readVideoEditPlan, resolveCompositionClip, videoCompositionSchema, videoEditPlanOutputSchema, videoEditPlanSchema, type StoredVideoEditPlan, type VideoComposition, type VideoEditPlanSnapshot } from "./videoEditPlan";

export function runMediaCommand(command: BrowserFfmpegCommand, signal: AbortSignal) {
  signal.throwIfAborted();
  const cancel = () => command.kill();
  signal.addEventListener("abort", cancel, { once: true });
  return new Promise<void>((resolve, reject) => {
    command.on("error", error => reject(error && typeof error === "object" && "code" in error && error.code === "ffmpegTaskUnknown" ? error : signal.aborted ? signal.reason : error));
    command.on("end", () => signal.aborted ? reject(signal.reason) : resolve());
    command.run();
  }).finally(() => signal.removeEventListener("abort", cancel));
}

export async function createMediaDirectory(workbench: NodeWorkbenchService, id: string) {
  for (const path of ["assets", `assets/${id}`]) await workbench.files.mkdir(path).catch(error => {
    if (error?.response?.status === 409 && error.response.data?.data?.code === "EBUSY") throw new ToolExecutionError({ code: "EBUSY", message: error.response.data.message || "素材目录正在使用，请等待当前操作完成", phase: "execution", executionState: "failed", target: { directory: workbench.directory, canvasId: workbench.canvasId, path }, recovery: { action: "readState", message: "目录创建已被占用锁拒绝；等待原媒体或深度任务确认收尾，读取当前节点任务状态和素材版本后再发起新操作，保留已有素材" } });
    if (error?.response?.data?.data?.code !== "EEXIST") throw error;
  });
  return `assets/${id}`;
}

async function derivativeVideoSources(workbench: NodeWorkbenchService, paths: string[], resultPath: string, signal?: AbortSignal) {
  const sources = workbench.readNodes().flatMap(node => node.data ? readVideoSources(node.data) : []).filter(item => paths.includes(item.path));
  if (!sources.length) return [];
  return [...new Map(sources.map(source => [JSON.stringify(source), source])).values(), { path: resultPath, sourceRevision: (await readMediaSourceRevision(workbench.files, resultPath, undefined, signal)).revision, origin: "derived" as const, sources: sources.map(({ path, sourceRevision }) => ({ path, ...(sourceRevision === undefined ? {} : { sourceRevision }) })) }];
}

export async function createResultNode<T>(workbench: NodeWorkbenchService, document: NodeDocumentService, ownerId: string, type: MediaType | "text", value: T, label: string, id = crypto.randomUUID(), signal?: AbortSignal, videoSources?: VideoSource[], editPlan?: StoredVideoEditPlan) {
  document.readNode(ownerId);
  const layout = workbench.getLayout();
  const dataType = type === "text" ? "STRING" : type.toUpperCase();
  const owner = readNodeData(document, ownerId), original = readMedia(owner, "video");
  const media = mediaValueSchema.safeParse(value);
  const sourceHistory = type === "video" && media.success ? videoSources ?? await derivativeVideoSources(workbench, original ? [original.url] : [], media.data.url, signal) : [];
  await workbench.createNodes([{ id, type: `${type}Node`, position: { x: layout.position.x + 400, y: layout.position.y }, data: {
    label, handles: [...(type === "image" ? [{ id: "in", type: "target", dataType: "IMAGE", label: "来源图片" }] : []), { id: type, type: "source", dataType, label: "输出" }], outputs: { [type]: { dataType, value } }, origin: { nodeId: ownerId },
    ...(sourceHistory.length ? { videoSourceHistory: sourceHistory, shotReview: null } : {}),
    ...(editPlan ? { videoEditPlan: editPlan } : {}),
  } }], [], signal);
  await document.save();
  return { nodeId: id, value };
}

function atempo(speed: number) {
  const factors: number[] = [];
  let value = speed;
  while (value > 2) { factors.push(2); value /= 2; }
  while (value < .5) { factors.push(.5); value /= .5; }
  factors.push(value);
  return factors.map(factor => `atempo=${factor}`).join(",");
}

export function probeMedia(ffmpeg: Awaited<ReturnType<NodeWorkbenchService["ffmpeg"]>>, path: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const command = ffmpeg(path);
  const cancel = () => command.kill();
  signal.addEventListener("abort", cancel, { once: true });
  return new Promise<FfprobeData>((resolve, reject) => command.ffprobe((error, data) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ffmpegTaskUnknown") reject(error);
    else if (signal.aborted) reject(signal.reason);
    else if (error) reject(error);
    else resolve(data);
  })).finally(() => signal.removeEventListener("abort", cancel));
}

export function registerMediaEditingTools(context: PluginActivationContext, type: "video" | "audio") {
  const { id, document, workbench } = pluginServices(context);
  let operation: AbortController | undefined;
  let job: Promise<unknown> | undefined;
  let unknown: Error | undefined;
  context.onDispose(async () => { operation?.abort(new Error("节点已卸载")); await job?.catch(() => {}); });
  context.onBeforeChange(async () => {
    operation?.abort(new Error("节点即将变更")); await job?.catch(() => {});
    if (unknown) throw unknown;
    if (["running", "unknown", "delegated"].includes((readNodeData(document, id).mediaOperation as { status?: string } | undefined)?.status ?? "")) throw new Error("此前媒体任务尚未确认终止，请先确认服务端终态");
  });
  const source = () => {
    const value = readMedia(readNodeData(document, id), type);
    if (!value) throw nodePreconditionError(workbench, id, "当前节点没有媒体输出；请先选择或生成有效媒体");
    return value;
  };
  const draft = mediaEditor(workbench);
  const view = mediaView(workbench);
  const viewOutputSchema = z.strictObject({ view: mediaViewSchema, viewRevision: z.number().int().nonnegative(), source: z.string(), currentSourceRevision: z.string(), clip: z.strictObject({ mounted: z.boolean(), ready: z.boolean() }), persistence: z.literal("memory") });
  async function readView(signal?: AbortSignal) {
    const currentSource = source(), head = await readMediaSourceRevision(workbench.files, currentSource.url, undefined, signal);
    if (source().url !== currentSource.url) throw nodePreconditionError(workbench, id, "源媒体在读取视图期间变化，请重新读取", "draftSourceChanged");
    const snapshot = view.read(), player = mediaPlayer(workbench, "clip");
    return { view: snapshot.value, viewRevision: snapshot.revision, source: currentSource.url, currentSourceRevision: head.revision, clip: { mounted: !!player, ready: !!player && player.readyState >= 1 && Number.isFinite(player.duration) }, persistence: "memory" as const };
  }
  context.registerTool({ name: "getMediaView", description: "读取与手工媒体编辑、音频波形剪辑共用的开关和viewRevision、源文件版本及真实试听播放器就绪状态；视图只保留于当前runtime。", parameters: z.strictObject({}), outputSchema: viewOutputSchema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, execute: (_args, { signal }) => readView(signal) });
  context.registerTool({ name: "setMediaView", description: "打开/关闭同一媒体编辑区与音频波形剪辑。clipOpen=true同时打开媒体编辑区并挂载真实试听播放器；open=false同时关闭试听。先getMediaView取得source/currentSourceRevision/viewRevision；打开后等clip.ready再setMediaPlayback(view=clip)。不导出、不保存素材或修改剪辑历史。", parameters: mediaViewSchema.partial().extend({ source: z.string().min(1), sourceRevision: z.string().min(1), expectedViewRevision: z.number().int().nonnegative() }).refine(args => args.open !== undefined || args.clipOpen !== undefined, "请提供媒体编辑或波形剪辑开关").refine(args => args.open !== false || args.clipOpen !== true, "关闭媒体编辑时不能打开波形剪辑"), outputSchema: viewOutputSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, async execute(args, { signal }) {
    if (args.clipOpen && type !== "audio") throw new Error("波形剪辑仅适用于音频");
    if (source().url !== args.source) throw nodePreconditionError(workbench, id, "源媒体已变化，未修改编辑台视图", "draftSourceChanged");
    await readMediaSourceRevision(workbench.files, args.source, args.sourceRevision, signal);
    if (source().url !== args.source) throw nodePreconditionError(workbench, id, "源媒体已变化，未修改编辑台视图", "draftSourceChanged");
    const { expectedViewRevision, source: _source, sourceRevision: _sourceRevision, ...patch } = args;
    const next = { ...view.read().value, ...patch, ...(args.clipOpen ? { open: true } : {}), ...(args.open === false ? { clipOpen: false } : {}) };
    view.replace(next, expectedViewRevision);
    if (!next.open || !next.clipOpen) mediaPlayer(workbench, "clip")?.pause();
    return readView(signal);
  } });
  async function readDraft() {
    const value = draft.read();
    const currentSource = source(), current = await readMediaSourceRevision(workbench.files, currentSource.url, undefined, context.signal);
    if (draft.read().revision !== value.revision) throw Object.assign(new Error("媒体草稿在读取期间变化，请重新读取"), { code: "draftRevisionConflict", actualRevision: draft.read().revision });
    return { ...value.value, draftRevision: value.revision, currentSourceRevision: current.revision, sourceCurrent: value.value.source === currentSource.url && (value.value.sourceRevision === null || value.value.sourceRevision === current.revision), history: value.history, persistence: "memory" as const, saved: false as const };
  }
  const draftOutputSchema = mediaDraftSchema.extend({ draftRevision: z.number().int().nonnegative(), currentSourceRevision: z.string(), sourceCurrent: z.boolean(), history: mediaHistorySchema, persistence: z.literal("memory"), saved: z.literal(false) });
  context.registerTool({ name: "getMediaDraft", description: "读取与手工媒体编辑台共用的未采用剪辑草稿、sourceRevision/currentSourceRevision及最多50步局部撤销历史。start/end为源素材秒数；groups按顺序拼接，playhead为剪辑时间线秒数；游标/播放不入内容历史。草稿仅在当前runtime内存保留。", parameters: z.strictObject({}), outputSchema: draftOutputSchema, annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }, execute: readDraft });
  context.registerTool({ name: "setMediaDraft", description: "修改同一媒体编辑台未保存范围、音频拼接分组和游标；不执行FFmpeg。音频groups非空时采用拼接分组，start/end仍用于单段操作；仅改groups或playhead不受未采用单段范围影响，显式修改start/end仍校验源时长。须带回草稿版本、源路径及currentSourceRevision。换源版本时清除旧范围/分段，只采用显式提供的新草稿。", parameters: mediaDraftSchema.omit({ source: true }).partial().extend({ expectedDraftRevision: z.number().int().nonnegative(), source: z.string().min(1), sourceRevision: z.string().min(1).describe("getMediaDraft.currentSourceRevision；不能使用内容SHA fileRevision") }), outputSchema: draftOutputSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, async execute(args, { signal }) {
    workbench.assertWritable();
    const rejectDraft = (message: string, code: string) => nodePreconditionError(workbench, id, message, code, { action: "readState", message: "重新发现并读取同一节点的getMediaDraft，采用最新源版本和draftRevision后协调；本次未修改草稿", tool: "getNodeTools", args: { canvasId: workbench.canvasId, nodeIds: [id], names: ["node:getMediaDraft"] } });
    if (source().url !== args.source) throw rejectDraft("源媒体已变化，请重新读取媒体和草稿", "draftSourceChanged");
    await readMediaSourceRevision(workbench.files, args.source, args.sourceRevision, signal);
    if (source().url !== args.source) throw rejectDraft("源媒体已变化，请重新读取媒体和草稿", "draftSourceChanged");
    const { expectedDraftRevision, ...patch } = args;
    if (draft.read().revision !== expectedDraftRevision) throw rejectDraft("剪辑草稿已变化，请重新读取", "draftRevisionConflict");
    const stored = draft.read().value;
    const previous = stored.source === args.source && stored.sourceRevision === args.sourceRevision ? stored : { source: args.source, sourceRevision: args.sourceRevision, start: 0, end: 5, groups: [], selected: 0, playhead: 0 };
    const next = mediaDraftSchema.parse({ ...previous, ...patch });
    if (next.end <= next.start) throw rejectDraft("结束时间须晚于开始时间", "draftRangeInvalid");
    if (type === "video" && next.groups.length) throw rejectDraft("视频剪辑请使用start/end；分组拼接仅适用于音频", "draftRangeInvalid");
    const duration = mediaPlayer(workbench)?.duration;
    const validateRange = type === "video" || !next.groups.length || args.start !== undefined || args.end !== undefined;
    if (duration && Number.isFinite(duration) && (validateRange && next.end > duration || next.groups.flat().some(range => range.end > duration))) throw rejectDraft("剪辑范围超过源素材时长", "draftRangeInvalid");
    if (next.groups.length && next.selected >= next.groups.length) throw rejectDraft("选中片段超出分组数量", "draftRangeInvalid");
    const position = mediaClipPosition(next.groups, next.playhead);
    if (next.groups.length && next.playhead > position.duration) throw rejectDraft("剪辑游标超出拼接时间线时长", "draftRangeInvalid");
    const clipPlayer = mediaPlayer(workbench, "clip");
    if (clipPlayer) { clipPlayer.pause(); if (next.groups.length) clipPlayer.currentTime = position.sourceTime; }
    draft.replace(next, expectedDraftRevision, "Agent 修改剪辑"); return readDraft();
  } });
  for (const direction of ["undo", "redo"] as const) context.registerTool({ name: direction === "undo" ? "undoMediaDraft" : "redoMediaDraft", description: `${direction === "undo" ? "撤销" : "重做"}最近一步媒体剪辑，与手工波形编辑共用同一历史。先getMediaDraft取得source、已绑定sourceRevision及draftRevision；源变化或修订不符时不执行。不采用草稿、不创建文件或操作画布历史。`, parameters: z.strictObject({ source: z.string().min(1), sourceRevision: z.string().min(1), expectedDraftRevision: z.number().int().nonnegative() }), outputSchema: draftOutputSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, async execute(args, { signal }) {
    workbench.assertWritable();
    function requireCurrent() {
      const current = draft.read();
      if (current.revision !== args.expectedDraftRevision) throw nodePreconditionError(workbench, id, "媒体草稿已变化，未操作局部历史", "draftRevisionConflict");
      if (source().url !== args.source || current.value.source !== args.source || current.value.sourceRevision !== args.sourceRevision) throw nodePreconditionError(workbench, id, "源媒体或草稿绑定版本已变化，未操作历史", "draftSourceChanged");
      const data = readNodeData(document, id);
      if (job || unknown || [data.generation, data.mediaOperation].some(value => value && typeof value === "object" && "status" in value && ["running", "delegated", "cancelRequested", "unknown"].includes(String(value.status)))) throw nodePreconditionError(workbench, id, "媒体任务尚未收尾，请先确认任务终态", "mediaOperationBusy");
    }
    requireCurrent(); await readMediaSourceRevision(workbench.files, args.source, args.sourceRevision, signal); requireCurrent();
    mediaPlayer(workbench, "clip")?.pause(); draft[direction](args.expectedDraftRevision); return readDraft();
  } });
  const playbackView = z.enum(["source", "clip"]);
  const playbackSchema = z.strictObject({ view: playbackView, coordinates: z.enum(["sourceSeconds", "clipSeconds"]), draftRevision: z.number().int().nonnegative().optional(), mounted: z.boolean(), currentTime: z.number().nonnegative(), duration: z.number().nonnegative().nullable(), paused: z.boolean(), playbackRate: z.number().positive(), volume: z.number().min(0).max(1), muted: z.boolean() });
  function playback(view: "source" | "clip" = "source") { const player = mediaPlayer(workbench, view), stored = draft.read(); return { view, coordinates: view === "clip" ? "clipSeconds" as const : "sourceSeconds" as const, ...(view === "clip" ? { draftRevision: stored.revision } : {}), mounted: !!player, currentTime: view === "clip" ? stored.value.playhead : Math.max(0, player?.currentTime ?? 0), duration: view === "clip" ? mediaClipPosition(stored.value.groups, 0).duration : player && Number.isFinite(player.duration) ? player.duration : null, paused: player?.paused ?? true, playbackRate: player?.playbackRate ?? 1, volume: player?.volume ?? 1, muted: player?.muted ?? false }; }
  context.registerTool({ name: "getMediaPlayback", description: "读取真实播放器；view=source为原素材，clip为已打开的音频波形剪辑试听。currentTime/duration分别采用源秒数或拼接时间线秒数；mounted=false不可播放。", parameters: z.strictObject({ view: playbackView.optional() }), outputSchema: playbackSchema, annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }, execute: args => playback(args.view) });
  context.registerTool({ name: "setMediaPlayback", description: "控制真实原素材或音频剪辑试听。view=clip时currentTime采用拼接时间线秒数，定位须带expectedDraftRevision；剪掉的区间不会被播放。不修改或导出素材；浏览器拒绝播放会报错。", parameters: z.strictObject({ view: playbackView.optional(), expectedDraftRevision: z.number().int().nonnegative().optional(), currentTime: z.number().finite().nonnegative().optional(), paused: z.boolean().optional(), playbackRate: z.number().finite().min(.1).max(4).optional(), volume: z.number().min(0).max(1).optional(), muted: z.boolean().optional() }).refine(args => args.view !== "clip" || args.currentTime === undefined || args.expectedDraftRevision !== undefined, "定位剪辑试听须提供expectedDraftRevision"), outputSchema: playbackSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async execute(args, { signal }) {
    const operationSignal = AbortSignal.any([context.signal, signal]); operationSignal.throwIfAborted();
    const view = args.view ?? "source", player = mediaPlayer(workbench, view); if (!player) throw nodePreconditionError(workbench, id, view === "clip" ? "请先打开音频波形剪辑，等待试听播放器就绪" : "请先打开节点媒体预览，等待播放器元数据就绪", "mediaPlayerUnavailable");
    if (view === "clip" && type !== "audio") throw new Error("剪辑试听仅适用于音频");
    if (args.currentTime !== undefined) {
      if (view === "clip") {
        const stored = draft.read(), position = mediaClipPosition(stored.value.groups, args.currentTime);
        if (!stored.value.groups.length || args.currentTime > position.duration) throw new Error("播放头须在音频拼接时间线内");
        if (stored.revision !== args.expectedDraftRevision) throw Object.assign(new Error("剪辑草稿已变化，请重新读取"), { code: "draftRevisionConflict", actualRevision: stored.revision });
        player.pause(); player.currentTime = position.sourceTime;
        draft.replace({ ...stored.value, selected: position.selected, playhead: args.currentTime }, stored.revision);
      } else { if (!Number.isFinite(player.duration) || args.currentTime > player.duration) throw new Error("播放头须在已加载的素材时长范围内"); player.currentTime = args.currentTime; }
    }
    if (args.playbackRate !== undefined) player.playbackRate = args.playbackRate;
    if (args.volume !== undefined) player.volume = args.volume;
    if (args.muted !== undefined) player.muted = args.muted;
    if (args.paused === true) player.pause();
    else if (args.paused === false) {
      const cancel = () => player.pause(); operationSignal.addEventListener("abort", cancel, { once: true });
      try { await player.play(); operationSignal.throwIfAborted(); }
      finally { operationSignal.removeEventListener("abort", cancel); }
    }
    operationSignal.throwIfAborted();
    if (args.paused === false && player.paused) throw new Error("播放器未开始实际试听，请检查编辑权限或浏览器播放限制");
    return playback(view);
  } });
  async function run<T>(name: string, signal: AbortSignal, action: (signal: AbortSignal, path: string, sourceRevision: string) => Promise<T>, expectedSourceRevision?: string, sourcePath?: string): Promise<T> {
    if (job) throw new Error("此节点正在处理媒体，请完成或取消后再试");
    if (unknown) throw unknown;
    if (["running", "unknown", "delegated"].includes((readNodeData(document, id).mediaOperation as { status?: string } | undefined)?.status ?? "")) throw new Error("此前媒体任务尚未确认终止");
    workbench.assertWritable(); signal.throwIfAborted();
    if (["running", "delegated", "cancelRequested", "unknown"].includes(String((readNodeData(document, id).generation as { status?: string } | undefined)?.status))) throw new Error("生成任务尚未完成，请先完成或取消生成");
    const initial = sourcePath ?? source().url;
    operation = new AbortController();
    const combined = AbortSignal.any([signal, context.signal, operation.signal]);
    const task = (async () => {
      const head = await readMediaSourceRevision(workbench.files, initial, expectedSourceRevision, combined);
      await workbench.updateRuntimeData({ mediaOperation: { operation: name, status: "running", taskId: crypto.randomUUID(), source: initial, sourceRevision: head.revision, startedAt: new Date().toISOString() } }, combined);
      const result = await action(combined, initial, head.revision);
      const saved = readNodeData(document, id).mediaOperation as Record<string, unknown> | undefined;
      if (!["delegated", "unknown"].includes(String(saved?.status))) {
        const value = result && typeof result === "object" ? result as { nodeId?: unknown; nodeIds?: unknown; nodes?: { nodeId?: unknown }[] } : undefined;
        const resultNodeIds = [...new Set([value?.nodeId, ...(Array.isArray(value?.nodeIds) ? value.nodeIds : []), ...(Array.isArray(value?.nodes) ? value.nodes.map(node => node.nodeId) : []), saved?.resultNodeId].filter((value): value is string => typeof value === "string"))];
        await workbench.updateRuntimeData({ mediaOperation: { ...saved, status: "completed", finishedAt: new Date().toISOString(), resultNodeIds } }, combined);
        await document.save();
      }
      return result;
    })(); job = task;
    try { return await task; }
    catch (error) {
      if (isExecutionUnknown(error)) {
        unknown = error instanceof Error ? error : new Error("媒体任务尚未确认终止");
        const requestId = "requestId" in error && typeof error.requestId === "string" ? error.requestId : "";
        const saved = readNodeData(document, id).mediaOperation as object | undefined;
        await workbench.updateRuntimeData({ mediaOperation: { ...saved, status: "unknown", requestId, error: unknown.message } }).then(() => document.save()).catch(() => {});
      } else {
        const saved = readNodeData(document, id).mediaOperation as { status?: string } | undefined;
        if (saved?.status === "running" && !context.signal.aborted) await workbench.updateRuntimeData({ mediaOperation: { ...saved, status: combined.aborted ? "cancelled" : "failed", finishedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) } }).then(() => document.save()).catch(() => {});
      }
      throw error;
    }
    finally { operation = undefined; job = undefined; }
  }
  type MediaOperation = { operation?: string; status?: string; taskId?: string; requestId?: string; source?: string; sourceRevision?: string; resultNodeId?: string; resultNodeIds?: string[]; error?: string; startedAt?: string; finishedAt?: string };
  const operationStatusSchema = z.strictObject({ operation: z.string().optional(), status: z.string(), executionSettled: z.boolean(), taskId: z.string().optional(), requestId: z.string().optional(), source: z.string().optional(), sourceRevision: z.string().optional(), resultNodeIds: z.array(z.string()), error: z.string().optional(), startedAt: z.string().optional(), finishedAt: z.string().optional() });
  function operationStatus() {
    const saved = readNodeData(document, id).mediaOperation as MediaOperation | undefined;
    const status = job ? "running" : unknown ? "unknown" : saved?.status === "running" ? "interrupted" : saved?.status ?? "idle";
    return { operation: saved?.operation, status, executionSettled: ["idle", "completed", "failed", "cancelled"].includes(status), taskId: saved?.taskId, requestId: saved?.requestId, source: saved?.source, sourceRevision: saved?.sourceRevision, resultNodeIds: [...new Set([...(saved?.resultNodeIds ?? []), ...(saved?.resultNodeId ? [saved.resultNodeId] : [])])], error: saved?.error, startedAt: saved?.startedAt, finishedAt: saved?.finishedAt };
  }
  context.registerTool({ name: "cancelMediaOperation", outputSchema: operationStatusSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, description: "取消此节点正在进行的本地媒体处理或转写；宿主未确认远端终止时保留unknown。返回原taskId、终态及产物引用，不自动重发任务。", parameters: z.strictObject({}), async execute() {
    operation?.abort(new Error("用户取消操作")); await job?.catch(() => {});
    const saved = readNodeData(document, id).mediaOperation as { status?: string } | undefined;
    if (saved?.status === "delegated") { await workbench.updateRuntimeData({ mediaOperation: { ...saved, status: "unknown", error: "宿主尚未确认转写终止，等待原任务实际产物" } }); await document.save(); }
    return operationStatus();
  } });
  context.registerTool({ name: "getMediaOperationStatus", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, description: "读取媒体处理/宿主转写的真实状态、原taskId/requestId、源版本、executionSettled、错误及resultNodeIds。断线后先查询原操作与此状态；产物须继续读取结果节点和工作区文件，不因completed文字认定已观察媒体。", parameters: z.strictObject({}), outputSchema: operationStatusSchema, execute: operationStatus });
  context.registerTool({ name: "setTranscription", outputSchema: z.strictObject({ nodeId: z.string(), value: z.string() }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, description: "保存原宿主转写任务的真实正文为新文本节点，taskId必须匹配，不覆盖原媒体。", parameters: z.strictObject({ taskId: z.uuid(), text: z.string().trim().min(1).max(1000000) }), async execute(args, { signal }) {
    workbench.assertWritable(); const saved = readNodeData(document, id).mediaOperation as MediaOperation | undefined;
    if (saved?.taskId !== args.taskId || saved.source !== source().url || saved.status === "completed" || saved.operation && saved.operation !== "transcribeAudio") throw new Error("原转写任务不匹配、已完成或输入已变化，请勿提交旧正文");
    const result = await createResultNode(workbench, document, id, "text", args.text, `${String(readNodeData(document, id).label ?? "媒体")} · 转写`, undefined, signal);
    unknown = undefined; await workbench.updateRuntimeData({ mediaOperation: { ...saved, status: "completed", finishedAt: new Date().toISOString(), resultNodeId: result.nodeId } }, signal); await document.save(); return result;
  } });
  const clipParameters = type === "audio" ? z.strictObject({ start: z.number().finite().nonnegative().optional(), end: z.number().finite().positive().optional(), segments: z.array(mediaRangeSchema).min(1).max(500).optional(), sourceRevision: z.string().min(1).describe("getMediaDraft.currentSourceRevision；不能使用内容SHA fileRevision").optional() }).refine(value => value.segments ? value.start === undefined && value.end === undefined : value.start !== undefined && value.end !== undefined && value.end > value.start, "请仅提供有效start/end，或segments数组") : mediaRangeSchema.safeExtend({ sourceRevision: z.string().min(1).describe("getMediaDraft.currentSourceRevision；不能使用内容SHA fileRevision").optional() });
  const clipMedia = (args: z.output<typeof clipParameters>, signal: AbortSignal) => run("clipMedia", signal, async (current, path, sourceRevision) => {
      const childId = crypto.randomUUID();
      const directory = await createMediaDirectory(workbench, childId);
      const ffmpeg = await workbench.ffmpeg(current);
      const probe = await probeMedia(ffmpeg, path, current);
      const stream = probe.streams.find(stream => stream.codec_type === type && !stream.disposition?.attached_pic);
      if (!stream) throw new Error(type === "video" ? "文件不包含视频画面" : "文件不包含音轨");
      const duration = Number(probe.format.duration ?? stream.duration);
      const segments = "segments" in args && args.segments ? args.segments : [{ start: args.start!, end: args.end! }];
      if (!Number.isFinite(duration) || duration <= 0 || segments.some(segment => segment.end > duration)) throw new Error("截取范围不能超过素材时长");
      const target = `${directory}/clip.${type === "video" ? "mp4" : "m4a"}`;
      const command = ffmpeg(path);
      if (type === "video") command.seekInput(segments[0].start).duration(segments[0].end - segments[0].start).videoCodec("libx264").audioCodec("aac").videoFilters("pad=ceil(iw/2)*2:ceil(ih/2)*2").outputOptions("-map", `0:${stream.index}`, "-map", "0:a:0?", "-pix_fmt", "yuv420p", "-movflags", "+faststart");
      else {
        const filters = segments.map((segment, index) => `[0:${stream.index}]atrim=start=${segment.start}:end=${segment.end},asetpts=PTS-STARTPTS[part${index}]`);
        filters.push(`${segments.map((_segment, index) => `[part${index}]`).join("")}concat=n=${segments.length}:v=0:a=1[result]`);
        command.noVideo().audioCodec("aac").audioBitrate(192).complexFilter(filters).outputOptions("-map", "[result]", "-movflags", "+faststart");
      }
      await runMediaCommand(command.output(target), current);
      current.throwIfAborted();
      if (source().url !== path) throw new Error("原媒体已变化，截取文件保留，未创建结果节点");
      await readMediaSourceRevision(workbench.files, path, sourceRevision, current, "failed");
      const label = segments.length > 1 ? `${segments.length} 段拼接` : `${segments[0].start}–${segments[0].end}s`;
      return createResultNode(workbench, document, id, type, { url: target, mimeType: type === "video" ? "video/mp4" : "audio/mp4" }, `${String(readNodeData(document, id).label ?? "素材")} · ${label}`, childId, current);
    }, args.sourceRevision);
  context.registerTool({ name: "clipMedia", description: type === "audio" ? "本地截取一段音频，或按segments顺序截取并拼接多段音频，生成新节点并保留原文件。" : "本地截取指定时间段并生成新的素材节点，保留原文件。", parameters: clipParameters, outputSchema: z.strictObject({ nodeId: z.string(), value: z.strictObject({ url: z.string(), mimeType: z.string() }) }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, execute(args, { signal }) { return clipMedia(args, signal); } });
  context.registerTool({ name: "applyMediaDraft", description: "明确采用当前剪辑草稿，通过同一clipMedia业务执行真实FFmpeg并创建保存新节点，保留原媒体。须带回草稿版本；音频groups非空时按组顺序拼接。", parameters: z.strictObject({ expectedDraftRevision: z.number().int().nonnegative() }), outputSchema: z.strictObject({ nodeId: z.string(), value: z.strictObject({ url: z.string(), mimeType: z.string() }) }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, execute(args, { signal }) {
    const snapshot = draft.read(); if (snapshot.revision !== args.expectedDraftRevision) throw Object.assign(new Error("剪辑草稿已变化，请重新读取"), { code: "draftRevisionConflict", actualRevision: snapshot.revision });
    if (snapshot.value.source !== source().url) throw Object.assign(new Error("源媒体已变化，未采用旧草稿"), { code: "draftSourceChanged" });
    if (!snapshot.value.sourceRevision) throw Object.assign(new Error("草稿尚未绑定素材版本，请先读取currentSourceRevision并明确建立草稿"), { code: "draftSourceRevisionRequired" });
    return clipMedia(clipParameters.parse({ ...(type === "audio" && snapshot.value.groups.length ? { segments: snapshot.value.groups.flat() } : { start: snapshot.value.start, end: snapshot.value.end }), sourceRevision: snapshot.value.sourceRevision }), signal);
  } });
  context.registerTool({ name: "changeSpeed", outputSchema: z.strictObject({ nodeId: z.string(), value: z.strictObject({ url: z.string(), mimeType: z.string() }) }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, description: "使用本地 FFmpeg 生成变速副本；保留原媒体，不更改播放器速度。", parameters: z.strictObject({ speed: z.number().finite().min(type === "audio" ? .1 : .25).max(4) }),
    execute(args, { signal }) { return run("changeSpeed", signal, async (current, path) => {
      const childId = crypto.randomUUID(); const directory = await createMediaDirectory(workbench, childId); const ffmpeg = await workbench.ffmpeg(current);
      const probe = await probeMedia(ffmpeg, path, current);
      current.throwIfAborted();
      const target = `${directory}/speed.${type === "video" ? "mp4" : "m4a"}`;
      const command = ffmpeg(path);
      if (type === "video") command.videoFilters(`setpts=PTS/${args.speed}`).videoCodec("libx264").outputOptions("-movflags", "+faststart");
      else command.noVideo();
      if (probe.streams.some(stream => stream.codec_type === "audio")) command.audioFilters(atempo(args.speed)).audioCodec("aac");
      else command.noAudio();
      await runMediaCommand(command.output(target), current);
      current.throwIfAborted();
      if (source().url !== path) throw new Error("原媒体已变化，变速文件保留，未创建结果节点");
      return createResultNode(workbench, document, id, type, { url: target, mimeType: type === "video" ? "video/mp4" : "audio/mp4" }, `${String(readNodeData(document, id).label ?? "素材")} · ${args.speed}×`, childId, current);
    }); } });
  if (type === "video") {
    const reviewOutputSchema = z.strictObject({ current: mediaValueSchema.optional(), sourceRevision: z.string().optional(), duration: z.number().positive().optional(), status: z.enum(["none", "pending", "approved", "rejected"]), review: videoReviewSchema.nullable() });
    async function readReview(signal: AbortSignal) {
      const data = readNodeData(document, id), current = readMedia(data, "video");
      if (!current) return { status: "none" as const, review: null };
      const head = await readMediaSourceRevision(workbench.files, current.url, undefined, signal);
      const probe = await probeMedia(await workbench.ffmpeg(signal), current.url, signal);
      const stream = probe.streams.find(value => value.codec_type === "video" && !value.disposition?.attached_pic);
      const duration = Number(stream?.duration ?? probe.format.duration);
      if (!stream || !Number.isFinite(duration) || duration <= 0) throw new Error("当前文件没有可审阅的视频画面");
      await readMediaSourceRevision(workbench.files, current.url, head.revision, signal);
      if (readMedia(readNodeData(document, id), "video")?.url !== current.url) throw new Error("读取期间节点视频已变化，请重新读取审片状态");
      const review = workbench.readNodes().flatMap(node => node.data ? readVideoReviews(node.data) : []).filter(value => value.source === current.url && value.sourceRevision === head.revision).sort(compareVideoReviews)[0];
      return { current, sourceRevision: head.revision, duration, status: review?.status ?? "pending" as const, review: review ?? null };
    }
    context.registerTool({ name: "getVideoReview", description: "读取实际当前视频、源快照版本、真实时长及独立审片状态。completed只代表已产生媒体；pending未审不能合成。审片不是工具自动视觉判断，需播放并观察内容。", parameters: z.strictObject({}), outputSchema: reviewOutputSchema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, execute: (_args, { signal }) => readReview(signal) });
    context.registerTool({ name: "reviewVideo", description: "记录操作者或Agent实际播放审阅后的结论，不自动判断好坏。须绑定getVideoReview返回的源版本和明确采用区间；approved要求方向/动作/身份/连续性/切镜/形变全部pass或notApplicable，notes写观察证据。rejected保留原片并禁止进入成片。失败范围可裁掉后重新观察所选范围再通过。", parameters: videoReviewSchema.omit({ taskId: true, reviewedAt: true, revision: true }), outputSchema: reviewOutputSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async execute(args, { signal }) {
      workbench.assertWritable();
      const revision = document.getRevision();
      const before = await readReview(signal);
      if (before.current?.url !== args.source || before.sourceRevision !== args.sourceRevision) throw new Error("审阅视频或源版本已变化，请重新读取getVideoReview");
      if (args.end <= args.start || args.end > before.duration!) throw new Error("采用范围须在真实视频画面时长内");
      if (args.status === "approved" && Object.values(args.checks).some(value => !["pass", "notApplicable"].includes(value))) throw new Error("尚有未审或未通过项，不能标为采用");
      const data = readNodeData(document, id), generation = data.generation as { taskId?: string; status?: string } | undefined;
      if (["running", "delegated", "unknown", "cancelRequested"].includes(generation?.status ?? "")) throw new Error("当前生成尚未确认终止，请先读取原任务状态");
      const sources = readVideoSources(data);
      const sourceIndex = sources.findIndex(value => value.path === args.source && (!value.sourceRevision || value.sourceRevision === args.sourceRevision));
      const sharedSource = workbench.readNodes().flatMap(node => node.data ? readVideoSources(node.data) : []).find(value => value.path === args.source && (!value.sourceRevision || value.sourceRevision === args.sourceRevision) && value.taskId);
      const source: VideoSource = sharedSource ?? sources[sourceIndex] ?? { path: args.source, sourceRevision: args.sourceRevision, origin: "imported" };
      await readMediaSourceRevision(workbench.files, args.source, args.sourceRevision, signal);
      const reviewRevision = Math.max(0, ...workbench.readNodes().flatMap(node => node.data ? readVideoReviews(node.data) : []).filter(value => value.source === args.source && value.sourceRevision === args.sourceRevision).map(value => value.revision ?? 0)) + 1;
      const review = { ...args, ...(source?.taskId ? { taskId: source.taskId } : {}), reviewedAt: new Date().toISOString(), revision: reviewRevision };
      source.sourceRevision = args.sourceRevision; source.review = review;
      if (sourceIndex >= 0) sources[sourceIndex] = source; else sources.push(source);
      await workbench.updateData({ shotReview: review, videoSourceHistory: sources }, revision, signal); await document.save();
      return readReview(signal);
    } });
    const compositionOutputSchema = z.strictObject({ nodeId: z.string(), value: z.strictObject({ url: z.string(), mimeType: z.literal("video/mp4") }), duration: z.number().positive(), width: z.number().int().positive(), height: z.number().int().positive(), fps: z.number().positive(), size: z.number().int().positive(), clipCount: z.number().int().positive(), audioMode: z.enum(["original", "mix", "replace"]), sources: z.array(compositionSourceSchema), planRevision: z.number().int().positive() });
    const editPlanRecovery = { action: "readState" as const, message: "在同一节点调用getVideoEditPlan读取最新planRevision、完整plan和源版本状态，协调改动后使用最新expectedPlanRevision；本次冲突未改写计划。", tool: "node:getVideoEditPlan", args: {} };
    function inspectClipReview(value: VideoComposition["clips"][number], start: number, end: number, nodes = workbench.readNodes()) {
      const owners = nodes.filter(node => node.data && isGeneratedVideo(node.data, value.path));
      const review = nodes.flatMap(node => node.data ? readVideoReviews(node.data) : []).filter(item => item.source === value.path && item.sourceRevision === value.sourceRevision).sort(compareVideoReviews)[0] ?? null;
      const source = owners.flatMap(node => readVideoSources(node.data!)).find(item => item.path === value.path && (!item.sourceRevision || item.sourceRevision === value.sourceRevision));
      const node = nodes.find(item => readMedia(item.data, "video")?.url === value.path) ?? owners[0] ?? nodes.find(item => item.data && readVideoReviews(item.data).some(item => item.source === value.path && item.sourceRevision === value.sourceRevision));
      const required = !!owners.length || !!review, allowsRange = !required || videoReviewAllows(review, value.path, value.sourceRevision, start, end, source?.taskId);
      return { node, review, required, allowsRange };
    }
    function composeVideo(args: VideoComposition, signal: AbortSignal, planRevision?: number) {
      const ownerSource = readMedia(readNodeData(document, id), type);
      const originalOutput = JSON.stringify(ownerSource ?? null);
      const boundPlan = planRevision === undefined ? null : readVideoEditPlan(readNodeData(document, id));
      if (planRevision !== undefined && boundPlan?.revision !== planRevision) throw nodePreconditionError(workbench, id, "剪辑计划修订已变化，请重新读取", "editPlanRevisionConflict", editPlanRecovery);
      if (planRevision === undefined && ownerSource && args.clips[0].path !== ownerSource.url) throw nodePreconditionError(workbench, id, "clips首项须为当前节点的视频，请重新读取媒体后固定目标", "compositionSourceMismatch");
      return run("composeVideo", signal, async current => {
        const rejectComposition = (message: string, code = "videoCompositionInvalid", phase: "validation" | "result" = "validation") => new ToolExecutionError({ code, message, phase, executionState: "failed", target: { directory: workbench.directory, canvasId: workbench.canvasId, nodeId: id }, recovery: code === "editPlanRevisionConflict" ? { ...editPlanRecovery, message: "先查询原getOperation确认渲染终态，再在同一节点调用getVideoEditPlan读取最新planRevision、完整plan和源版本；协调后再操作，保留原视频与本次已写出的文件。" } : { action: "readState", message: "读取原getMediaOperationStatus和输入文件版本，确认素材与参数后再发起新操作；失败时保留原视频与已写出的文件", tool: "getNodeTools", args: { canvasId: workbench.canvasId, nodeIds: [id], names: ["node:getMediaOperationStatus"] } } });
        const sources = new Map<string, { path: string; sourceRevision: string; probe: FfprobeData }>();
        const originalOutputRevision = ownerSource ? (await readMediaSourceRevision(workbench.files, ownerSource.url, undefined, current, "failed")).revision : undefined;
        const ffmpeg = await workbench.ffmpeg(current);
        let totalBytes = 0;
        for (const value of [...args.clips, ...(args.audio ? [args.audio] : [])]) {
          const previous = sources.get(value.path);
          if (previous) {
            if (previous.sourceRevision !== value.sourceRevision) throw rejectComposition("同一输入路径不能绑定不同源版本");
            continue;
          }
          const head = await readMediaSourceRevision(workbench.files, value.path, value.sourceRevision, current, "failed");
          totalBytes += head.size;
          if (head.size > 256 * 1024 ** 2 || totalBytes > 2 * 1024 ** 3) throw rejectComposition("输入须满足单文件256MiB、唯一输入合计2GiB以内");
          const probe = await probeMedia(ffmpeg, value.path, current);
          sources.set(value.path, { path: value.path, sourceRevision: head.revision, probe });
        }
        const clips = args.clips.map(value => {
          try { return resolveCompositionClip(value, sources.get(value.path)!.probe, args.fps); }
          catch (reason) { throw rejectComposition(reason instanceof Error ? reason.message : String(reason)); }
        });
        const duration = clips.reduce((sum, clip) => sum + clip.frames, 0) / args.fps;
        if (duration > 120) throw rejectComposition("成片总时长不能超过120秒");
        let backgroundAudio: FfprobeData["streams"][number] | undefined;
        if (args.audio) try { backgroundAudio = compositionAudioStream(sources.get(args.audio.path)!.probe); }
        catch (reason) { throw rejectComposition(reason instanceof Error ? reason.message : String(reason)); }
        async function requireSources() {
          if (JSON.stringify(readMedia(readNodeData(document, id), type) ?? null) !== originalOutput) throw rejectComposition("当前节点视频已变化，未采用本次合成", "compositionSourceChanged");
          if (ownerSource && originalOutputRevision) await readMediaSourceRevision(workbench.files, ownerSource.url, originalOutputRevision, current, "failed");
          if (planRevision !== undefined) {
            const latest = readVideoEditPlan(readNodeData(document, id));
            if (latest?.revision !== planRevision || JSON.stringify(latest.plan) !== JSON.stringify(boundPlan!.plan)) throw rejectComposition("剪辑计划已变化，本次文件保留但未创建结果节点", "editPlanRevisionConflict");
          }
          for (const value of sources.values()) await readMediaSourceRevision(workbench.files, value.path, value.sourceRevision, current, "failed");
          const nodes = workbench.readNodes();
          args.clips.forEach((value, index) => {
            const { node: reviewNode, allowsRange } = inspectClipReview(value, clips[index]!.start, clips[index]!.end, nodes);
            if (!allowsRange) {
              throw new ToolExecutionError({ code: "videoReviewRequired", message: `镜头${index + 1}「${String(reviewNode?.data?.label ?? reviewNode?.id ?? value.path)}」尚未通过此源版本与采用区间的审片`, phase: "validation", executionState: "failed", target: { directory: workbench.directory, canvasId: workbench.canvasId, nodeId: reviewNode?.id ?? id, path: value.path }, recovery: { action: "readState", tool: "node:getVideoReview", args: {}, message: "在target.nodeId所指源节点调用getVideoReview，确认当前视频与target.path及计划源版本一致；若已切换结果，先明确选择该历史源。实际播放计划采用区间后，再按观察调用reviewVideo；不要自动批准。未通过时替换或修复该镜头，再更新剪辑计划。" } });
            }
          });
          current.throwIfAborted();
        }
        await requireSources();
        const [width, height] = args.resolution.split("x").map(Number), childId = crypto.randomUUID(), directory = await createMediaDirectory(workbench, childId), target = `${directory}/composition.mp4`;
        const command = ffmpeg({ timeout: 90 });
        args.clips.forEach(clip => command.input(clip.path));
        if (args.audio) command.input(args.audio.path);
        const filters: string[] = [], preserveAudio = args.audio?.mode !== "replace";
        clips.forEach((clip, index) => {
          filters.push(`[${index}:${clip.video.index}]trim=start=${clip.start}:duration=${clip.duration},setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=fps=${args.fps}:round=up,tpad=stop_mode=clone:stop_duration=${2 / args.fps},trim=end_frame=${clip.frames},setpts=PTS-STARTPTS,format=yuv420p[v${index}]`);
          if (preserveAudio) filters.push(clip.audio ? `[${index}:${clip.audio.index}]atrim=start=${clip.start}:duration=${clip.duration},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${clip.duration}[a${index}]` : `anullsrc=r=48000:cl=stereo,atrim=duration=${clip.duration}[a${index}]`);
        });
        filters.push(`${clips.map((_clip, index) => `[v${index}]${preserveAudio ? `[a${index}]` : ""}`).join("")}concat=n=${clips.length}:v=1:a=${preserveAudio ? 1 : 0}[video]${preserveAudio ? args.audio ? "[original]" : "[audio]" : ""}`);
        if (args.audio && backgroundAudio) {
          filters.push(`[${clips.length}:${backgroundAudio.index}]atrim=duration=${duration},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${args.audio.volume ?? 1},apad,atrim=duration=${duration}[${args.audio.mode === "mix" ? "background" : "audio"}]`);
          if (args.audio.mode === "mix") filters.push("[original][background]amix=inputs=2:duration=first:dropout_transition=0:normalize=1[audio]");
        }
        command.complexFilter(filters).videoCodec("libx264").audioCodec("aac").audioFrequency(48000).audioChannels(2).audioBitrate(192).duration(duration).outputOptions("-map", "[video]", "-map", "[audio]", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-preset", "veryfast", "-crf", "20", "-map_metadata", "-1", "-map_chapters", "-1", "-threads", "2", "-filter_complex_threads", "1");
        await runMediaCommand(command.output(target), current);
        const output = await readMediaSourceRevision(workbench.files, target, undefined, current, "failed");
        if (output.size > 512 * 1024 ** 2) throw rejectComposition(`成片超过512MiB上限，${target}保留但未创建结果节点`, "compositionOutputTooLarge", "result");
        const probe = await probeMedia(ffmpeg, target, current), video = probe.streams.find(stream => stream.codec_type === "video"), audio = probe.streams.find(stream => stream.codec_type === "audio");
        const [rateNumerator, rateDenominator = 1] = String(video?.r_frame_rate ?? "0").split("/").map(Number), actualFps = rateNumerator / rateDenominator, streamDuration = Number(video?.duration), actualDuration = Number.isFinite(streamDuration) && streamDuration > 0 ? streamDuration : Number(probe.format.duration);
        if (!video || video.codec_name !== "h264" || video.pix_fmt !== "yuv420p" || video.width !== width || video.height !== height || !audio || audio.codec_name !== "aac" || Number(audio.channels) !== 2 || Number(audio.sample_rate) !== 48000 || !Number.isFinite(actualFps) || Math.abs(actualFps - args.fps) > .001 || !Number.isFinite(actualDuration) || Math.abs(actualDuration - duration) > 2 / args.fps) throw rejectComposition(`成片轨道、尺寸、帧率或时长与合成计划不符，${target}保留但未创建结果节点`, "compositionOutputInvalid", "result");
        await requireSources();
        await readMediaSourceRevision(workbench.files, target, output.revision, current, "failed");
        workbench.assertWritable();
        const normalizedPlan = videoEditPlanSchema.parse({ version: 1, ...args, clips: args.clips.map((clip, index) => ({ ...clip, start: clips[index]!.start, end: clips[index]!.end })) });
        const editPlan: StoredVideoEditPlan = { revision: planRevision ?? 1, plan: normalizedPlan, rendered: { planRevision: planRevision ?? 1, path: target, sourceRevision: output.revision, duration: actualDuration, width, height, fps: actualFps } };
        const lineage = await derivativeVideoSources(workbench, args.clips.map(clip => clip.path), target, current);
        await requireSources();
        const result = await createResultNode(workbench, document, id, "video", { url: target, mimeType: "video/mp4" as const }, `${String(readNodeData(document, id).label ?? "视频")} · ${clips.length}镜头成片`, childId, current, lineage, editPlan);
        return { ...result, duration: actualDuration, width, height, fps: actualFps, size: output.size, clipCount: clips.length, audioMode: args.audio?.mode ?? "original" as const, sources: [...sources.values()].map(({ path, sourceRevision }) => ({ path, sourceRevision })), planRevision: editPlan.revision };
      }, args.clips[0].sourceRevision, args.clips[0].path);
    }
    context.registerTool({ name: "composeVideo", description: "将2–16个真实工作区视频按clips顺序硬切拼接为新MP4节点，保留全部源。节点已有视频时首项须为当前视频；空节点可直接按显式clips合成。每项须带源快照版本，可选源秒数start/end。单文件<=256MiB、所有唯一输入合计<=2GiB、每源<=600秒、成片<=120秒；源画面<=4096×2160像素。按目标fps向下对齐整帧，不足一帧拒绝；等比letterbox到指定分辨率。默认保留原音轨，缺音轨片段补静音；可选一条audio从0秒混合或替换，短音轨补静音、长音轨裁齐，不循环。mix归一化混合，volume仅调整外部音轨。输出真实H.264/yuv420p、AAC立体声48kHz、faststart；90秒编码超时会取消。本工具等待真实产物完成；运行中查询或取消使用外层getOperation/cancelOperation和原operationId，同一连接不要并发派发节点工具。调用收尾后可读getMediaOperationStatus；未知先查原操作，不重复派发。", parameters: videoCompositionSchema, outputSchema: compositionOutputSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, execute: (args, { signal }) => composeVideo(args, signal) });
    async function readEditPlan(signal: AbortSignal): Promise<VideoEditPlanSnapshot> {
      const stored = readVideoEditPlan(readNodeData(document, id));
      if (!stored) return { planRevision: 0, plan: null, rendered: null, status: "none", persistence: "document", sources: [], clips: [], totalFrames: 0, totalDuration: 0, canRender: false, blockers: [{ code: "editPlanMissing", message: "尚未保存剪辑计划" }] };
      const snapshot = JSON.stringify(stored), ownerSource = readMedia(readNodeData(document, id), "video"), originalOutput = JSON.stringify(ownerSource ?? null);
      const sources: VideoEditPlanSnapshot["sources"] = [], blockers: VideoEditPlanSnapshot["blockers"] = [];
      const values = new Map([...stored.plan.clips, ...(stored.plan.audio ? [stored.plan.audio] : [])].map(value => [JSON.stringify([value.path, value.sourceRevision]), value]));
      const inspected = new Map<string, { head?: { revision: string; size: number }; probe?: FfprobeData; error?: string }>();
      let ffmpeg: ReturnType<NodeWorkbenchService["ffmpeg"]> | undefined, totalBytes = 0;
      for (const value of values.values()) {
        if (inspected.has(value.path)) continue;
        const input: { head?: { revision: string; size: number }; probe?: FfprobeData; error?: string } = {};
        inspected.set(value.path, input);
        try {
          input.head = await readMediaSourceRevision(workbench.files, value.path, undefined, signal);
          totalBytes += input.head.size;
          if (input.head.size > 256 * 1024 ** 2) throw new Error("单文件须在256MiB以内");
          if ([...values.values()].some(item => item.path === value.path && item.sourceRevision === input.head!.revision)) {
            ffmpeg ??= workbench.ffmpeg(signal);
            input.probe = await probeMedia(await ffmpeg, value.path, signal);
          }
        } catch (reason) {
          signal.throwIfAborted();
          if (isExecutionUnknown(reason)) throw reason;
          input.error = reason instanceof Error ? reason.message : String(reason);
        }
      }
      for (const [path, input] of inspected) {
        if (!input.head) continue;
        try {
          const head = await readMediaSourceRevision(workbench.files, path, undefined, signal);
          if (head.revision !== input.head.revision) { input.head = head; delete input.probe; input.error = "读取期间源文件版本变化，请刷新后重新协调计划"; }
        } catch (reason) { signal.throwIfAborted(); if (isExecutionUnknown(reason)) throw reason; input.error = reason instanceof Error ? reason.message : String(reason); }
      }
      for (const value of values.values()) {
        const input = inspected.get(value.path)!;
        sources.push({ path: value.path, expectedRevision: value.sourceRevision, ...(input.head ? { currentRevision: input.head.revision } : {}), status: input.error ? "unavailable" : input.head?.revision === value.sourceRevision ? "ready" : "stale", ...(input.error ? { message: input.error } : {}) });
      }
      if (totalBytes > 2 * 1024 ** 3) blockers.push({ code: "compositionInputLimit", message: "所有唯一输入合计须在2GiB以内" });
      if (inspected.size !== values.size) blockers.push({ code: "compositionSourceRevisionConflict", message: "同一输入路径不能绑定不同源版本" });
      let outputCurrent = !!stored.rendered && ownerSource?.url === stored.rendered.path;
      if (ownerSource) try { const head = await readMediaSourceRevision(workbench.files, ownerSource.url, undefined, signal); outputCurrent &&= head.revision === stored.rendered?.sourceRevision; }
      catch (reason) { signal.throwIfAborted(); if (isExecutionUnknown(reason)) throw reason; outputCurrent = false; blockers.push({ code: "compositionOwnerUnavailable", message: `当前节点原片不可读：${reason instanceof Error ? reason.message : String(reason)}` }); }
      const nodes = workbench.readNodes();
      let timelineFrames: number | null = 0;
      const clips = stored.plan.clips.map((value, index): VideoEditPlanSnapshot["clips"][number] => {
        const input = inspected.get(value.path)!, source = sources.find(item => item.path === value.path && item.expectedRevision === value.sourceRevision)!;
        const clipBlockers: VideoEditPlanSnapshot["blockers"] = [];
        let resolved: ReturnType<typeof resolveCompositionClip> | undefined;
        if (source.status !== "ready") clipBlockers.push({ code: source.status === "stale" ? "sourceRevisionConflict" : "compositionSourceUnavailable", message: source.message ?? "源文件版本与计划不符，请明确选择版本后重新审片" });
        else if (input.probe) try { resolved = resolveCompositionClip(value, input.probe, stored.plan.fps); }
        catch (reason) { clipBlockers.push({ code: "compositionClipInvalid", message: reason instanceof Error ? reason.message : String(reason) }); }
        else clipBlockers.push({ code: "compositionSourceUnavailable", message: "尚未取得此源版本的有效媒体探测结果" });
        const review = inspectClipReview(value, resolved?.start ?? value.start ?? 0, resolved?.end ?? value.end ?? Number.POSITIVE_INFINITY, nodes);
        if (!review.allowsRange) clipBlockers.push({ code: "videoReviewRequired", message: review.review?.status === "rejected" ? "此源版本已拒收；须修复或替换镜头，不能直接进入成片" : review.review ? "当前采用区间或任务身份未被最新审片通过覆盖" : "此生成或衍生源尚未审片，需实际播放采用区间并记录结论" });
        const timelineStart = timelineFrames === null ? null : timelineFrames / stored.plan.fps;
        timelineFrames = resolved && timelineFrames !== null ? timelineFrames + resolved.frames : null;
        return { index, label: value.label ?? String(review.node?.data?.label ?? value.path.split("/").at(-1) ?? value.path), ...(review.node ? { nodeId: review.node.id } : {}), path: value.path, sourceRevision: value.sourceRevision, sourceStatus: source.status, start: resolved?.start ?? value.start ?? 0, end: resolved?.end ?? value.end ?? null, sourceDuration: resolved?.sourceDuration ?? null, frames: resolved?.frames ?? null, duration: resolved?.duration ?? null, timelineStart, timelineEnd: timelineFrames === null ? null : timelineFrames / stored.plan.fps, reviewRequired: review.required, reviewStatus: review.required ? review.review?.status ?? "pending" : "notRequired", reviewAllowsRange: review.allowsRange, review: review.review, blockers: clipBlockers };
      });
      if (timelineFrames !== null && timelineFrames / stored.plan.fps > 120) blockers.push({ code: "compositionDurationLimit", message: "成片总时长不能超过120秒" });
      if (stored.plan.audio) {
        const source = sources.find(item => item.path === stored.plan.audio!.path && item.expectedRevision === stored.plan.audio!.sourceRevision)!, input = inspected.get(source.path)!;
        if (source.status !== "ready") blockers.push({ code: "compositionAudioUnavailable", message: `外部音轨：${source.message ?? "源版本与计划不符"}` });
        else if (input.probe) try { compositionAudioStream(input.probe); }
        catch (reason) { blockers.push({ code: "compositionAudioInvalid", message: reason instanceof Error ? reason.message : String(reason) }); }
        else blockers.push({ code: "compositionAudioUnavailable", message: "尚未取得外部音轨的有效媒体探测结果" });
      }
      if (JSON.stringify(readVideoEditPlan(readNodeData(document, id))) !== snapshot) throw nodePreconditionError(workbench, id, "读取期间剪辑计划变化，请重新读取", "editPlanRevisionConflict", editPlanRecovery);
      if (JSON.stringify(readMedia(readNodeData(document, id), "video") ?? null) !== originalOutput) throw nodePreconditionError(workbench, id, "读取期间当前节点视频变化，请重新读取计划", "compositionSourceChanged", editPlanRecovery);
      const status = sources.some(source => source.status !== "ready") ? "sourceChanged" as const : !stored.rendered ? "unrendered" as const : stored.rendered.planRevision !== stored.revision ? "modified" as const : !outputCurrent ? "outputChanged" as const : "current" as const;
      return { planRevision: stored.revision, plan: stored.plan, rendered: stored.rendered ?? null, status, persistence: "document", sources, clips, totalFrames: timelineFrames, totalDuration: timelineFrames === null ? null : timelineFrames / stored.plan.fps, canRender: !blockers.length && clips.every(clip => clip.frames !== null && !clip.blockers.length), blockers };
    }
    context.registerTool({ name: "getVideoEditPlan", description: "读取持久剪辑计划、planRevision和逐镜标签/源节点/版本/整帧采用范围/成片时段、全画布最新审片与阻塞原因、总帧数/总时长及canRender。每个唯一源只读探测，不编码不建目录；canRender仅是当前技术与已审范围预检，不自动判断镜间视觉连续性或成片质量，渲染仍重复核版本与审片。旧成片无计划返回none，不从lineage猜入出点。", parameters: z.strictObject({}), outputSchema: videoEditPlanOutputSchema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, execute: (_args, { signal }) => readEditPlan(signal) });
    context.registerTool({ name: "setVideoEditPlan", description: "完整保存2–16镜剪辑计划并纳入同一画布撤销与保存，不编码、不替换原片。先getVideoEditPlan取得planRevision；替换一镜时读完整plan只改对应clips项，保留label与其他镜头，携带新源真实sourceRevision并明确采用区间；不静默裁切越界范围。返回逐镜技术/审片预检，保存不代表已生成新成片；render仍执行实际时长与审片校验。", parameters: z.strictObject({ expectedPlanRevision: z.number().int().nonnegative(), plan: videoEditPlanSchema }), outputSchema: videoEditPlanOutputSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, async execute(args, { signal }) {
      workbench.assertWritable();
      const previous = readVideoEditPlan(readNodeData(document, id));
      if ((previous?.revision ?? 0) !== args.expectedPlanRevision) throw nodePreconditionError(workbench, id, "剪辑计划修订已变化，未保存旧计划", "editPlanRevisionConflict", editPlanRecovery);
      const next: StoredVideoEditPlan = { revision: args.expectedPlanRevision + 1, plan: args.plan, ...(previous?.rendered ? { rendered: previous.rendered } : {}) };
      await workbench.updateData({ videoEditPlan: next }, document.getRevision(), signal); await document.save();
      return readEditPlan(signal);
    } });
    context.registerTool({ name: "renderVideoEditPlan", description: "按此节点当前已保存planRevision重新渲染为新视频节点，旧成片保留。复用composeVideo的帧对齐、输入版本、已审范围、编码与未知任务恢复。仅此入口可从原成片保存的分镜重编；不要求clips首项等于成片自身。渲染前及结果采用前均核计划、原输出与源版本；新节点保存完整实际整帧计划。未知先getOperation，不重派。", parameters: z.strictObject({ expectedPlanRevision: z.number().int().positive() }), outputSchema: compositionOutputSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, execute(args, { signal }) {
      const stored = readVideoEditPlan(readNodeData(document, id));
      if (!stored || stored.revision !== args.expectedPlanRevision) throw nodePreconditionError(workbench, id, "计划不存在或修订已变化，未渲染", "editPlanRevisionConflict", editPlanRecovery);
      const { version: _version, ...composition } = stored.plan;
      return composeVideo(composition, signal, args.expectedPlanRevision);
    } });
    context.registerTool({ name: "createFrameAnalysis", outputSchema: z.strictObject({ nodeId: z.string() }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, description: "为当前视频创建逐帧拉片节点并连接原视频，不自动运行分析。", parameters: z.strictObject({}),
      execute(_args, { signal }) { return run("createFrameAnalysis", signal, async (current, path) => {
        const childId = crypto.randomUUID();
        const layout = workbench.getLayout();
        const data = readNodeData(document, id);
        const handles = data.handles as { id: string; type: string; dataType: unknown }[] | undefined;
        const outputs = data.outputs as Record<string, { value?: { url?: string } }> | undefined;
        const output = handles?.find(handle => handle.type === "source" && handle.dataType === "VIDEO" && outputs?.[handle.id]?.value?.url === path);
        if (!output) throw new Error("原节点缺少视频输出端口");
        await workbench.createNodes([{ id: childId, type: "frameAnalysisNode", position: { x: layout.position.x + 400, y: layout.position.y }, data: { label: `${String(data.label ?? "视频")} · 逐帧拉片`, handles: [{ id: "in", type: "target", dataType: "VIDEO", label: "视频素材" }], outputs: {} } }], [{ id: crypto.randomUUID(), source: id, sourceHandle: output.id, target: childId, targetHandle: "in" }], current);
        await document.save(); return { nodeId: childId };
      }); } });
    context.registerTool({ name: "separateMedia", outputSchema: z.strictObject({ nodes: z.array(z.strictObject({ nodeId: z.string(), type: z.string(), url: z.string(), mimeType: z.string(), label: z.string() })) }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, description: "本地分离音视频，生成静音视频和原音轨两个节点，保留原视频。", parameters: z.strictObject({}),
      execute(_args, { signal }) { return run("separateMedia", signal, async (current, path) => {
        const videoId = crypto.randomUUID(); const audioId = crypto.randomUUID();
        const directory = await createMediaDirectory(workbench, videoId); const ffmpeg = await workbench.ffmpeg(current);
        const probe = await probeMedia(ffmpeg, path, current);
        const video = probe.streams.find(stream => stream.codec_type === "video" && !stream.disposition?.attached_pic);
        if (!video || !probe.streams.some(stream => stream.codec_type === "audio")) throw new Error(!video ? "文件不包含视频画面" : "该视频没有音轨");
        const videoPath = `${directory}/silent.mp4`; const audioPath = `${directory}/audio.m4a`;
        const command = ffmpeg(path);
        command.output(audioPath).noVideo().audioCodec("aac").audioBitrate(192).outputOptions("-map", "0:a:0", "-movflags", "+faststart");
        command.output(videoPath).noAudio().videoCodec("libx264").videoFilters("pad=ceil(iw/2)*2:ceil(ih/2)*2").outputOptions("-map", `0:${video.index}`, "-pix_fmt", "yuv420p", "-movflags", "+faststart");
        await runMediaCommand(command, current); current.throwIfAborted();
        if (source().url !== path) throw new Error("原视频已变化，分离文件保留，未创建结果节点");
        const layout = workbench.getLayout();
        const label = String(readNodeData(document, id).label ?? "视频");
        const results = [{ nodeId: videoId, type: "video", url: videoPath, mimeType: "video/mp4", label: `${label} · 静音视频` }, { nodeId: audioId, type: "audio", url: audioPath, mimeType: "audio/mp4", label: `${label} · 原音轨` }];
        const videoSources = await derivativeVideoSources(workbench, [path], videoPath, current);
        await workbench.createNodes(results.map((item, index) => ({ id: item.nodeId, type: `${item.type}Node`, position: { x: layout.position.x + 400, y: layout.position.y + index * 320 }, data: { label: item.label, handles: [{ id: item.type, type: "source", dataType: item.type.toUpperCase(), label: "输出" }], outputs: { [item.type]: { dataType: item.type.toUpperCase(), value: { url: item.url, mimeType: item.mimeType } } }, origin: { nodeId: id }, ...(item.type === "video" && videoSources.length ? { videoSourceHistory: videoSources, shotReview: null } : {}) } })), [], current);
        await document.save(); return { nodes: results };
      }); } });
    context.registerTool({ name: "captureFrame", outputSchema: z.strictObject({ nodeId: z.string(), value: z.strictObject({ url: z.string(), mimeType: z.string() }) }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, description: "本地提取指定秒数、首帧或尾帧，创建图片节点并保留原视频。", parameters: z.strictObject({ time: z.number().finite().nonnegative().optional(), position: z.enum(["first", "last"]).optional() }).refine(value => (value.time === undefined) !== (value.position === undefined), "time与position须且仅提供一个"),
      execute(args, { signal }) { return run("captureFrame", signal, async (current, path) => {
        const childId = crypto.randomUUID(); const directory = await createMediaDirectory(workbench, childId); const target = `${directory}/frame.png`; const ffmpeg = await workbench.ffmpeg(current);
        const probe = await probeMedia(ffmpeg, path, current);
        const video = probe.streams.find(stream => stream.codec_type === "video" && !stream.disposition?.attached_pic);
        const videoDuration = Number(video?.duration);
        const duration = Number.isFinite(videoDuration) && videoDuration > 0 ? videoDuration : Number(probe.format.duration);
        if (!video || !Number.isFinite(duration) || duration <= 0 || args.time !== undefined && args.time >= duration) throw new Error("视频帧时间须在有效视频时长内");
        const command = ffmpeg(path).noAudio().outputOptions("-map", `0:${video.index}`);
        if (args.time !== undefined) command.seekInput(args.time);
        else if (args.position === "last") {
          // ACT: 只反转末尾一秒的解码帧，精确取最后一帧，避免缓存整段视频。
          command.seekInput(Math.max(0, duration - 1)).videoFilters("reverse");
        }
        await runMediaCommand(command.frames(1).output(target), current);
        current.throwIfAborted();
        if (source().url !== path) throw new Error("原视频已变化，截图保留，未创建结果节点");
        const head = await workbench.files.readRange?.(target, 0, 1, undefined, current);
        if (head && !head.size) throw new Error("未提取到有效视频帧");
        return createResultNode(workbench, document, id, "image", { url: target, mimeType: "image/png" }, `${String(readNodeData(document, id).label ?? "视频")} · ${args.time !== undefined ? `${args.time}s` : args.position === "first" ? "首帧" : "尾帧"}`, childId, current);
      }); } });
    context.registerTool({ name: "extractAudio", outputSchema: z.strictObject({ nodeId: z.string(), value: z.strictObject({ url: z.string(), mimeType: z.string() }) }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, description: "本地提取完整音轨并创建音频节点。", parameters: z.strictObject({}),
      execute(_args, { signal }) { return run("extractAudio", signal, async (current, path) => {
        const childId = crypto.randomUUID(); const directory = await createMediaDirectory(workbench, childId); const target = `${directory}/audio.m4a`; const ffmpeg = await workbench.ffmpeg(current);
        await runMediaCommand(ffmpeg(path).noVideo().audioCodec("aac").output(target), current);
        current.throwIfAborted();
        return createResultNode(workbench, document, id, "audio", { url: target, mimeType: "audio/mp4" }, `${String(readNodeData(document, id).label ?? "视频")} · 音轨`, childId, current);
      }); } });
  }
  context.registerTool({ name: "transcribeAudio", outputSchema: z.union([z.strictObject({ nodeId: z.string(), value: z.string() }), z.strictObject({ status: z.string(), taskId: z.string(), nodeId: z.string().optional(), value: z.string().optional() })]), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }, description: "将媒体语音转写交给宿主 Agent，保留原素材。只有显式useBrowserSpeechService=true才调用浏览器语音服务；该服务可能在线处理媒体。", parameters: z.strictObject({ language: z.string().max(50).optional(), useBrowserSpeechService: z.boolean().optional().describe("显式允许浏览器语音识别；浏览器可能使用在线服务。默认false，交给宿主Agent。") }),
    execute(args, { signal }) { return run("transcribeAudio", signal, async (current, path) => {
      if (!args.useBrowserSpeechService) {
        const original = readNodeData(document, id).mediaOperation as MediaOperation | undefined;
        const taskId = original?.taskId ?? crypto.randomUUID(); await workbench.updateRuntimeData({ mediaOperation: { ...original, status: "running", taskId, source: path } }, current); await document.save();
        const response = await workbench.hostRequest({ kind: "edit", prompt: `请转写节点 ${id} 的媒体中的语音，保留原媒体，用该节点setTranscription工具保存实际正文，携带taskId ${taskId}；也可以返回完整正文。${args.language ? `语言：${args.language}` : ""}`, references: [{ dataType: type.toUpperCase(), value: source() }], metadata: { nodeId: id, operation: "transcribe", taskId } }, current);
        current.throwIfAborted(); const saved = readNodeData(document, id).mediaOperation as { status?: string } | undefined;
        if (saved?.status === "completed") return { status: "completed", taskId };
        let result;
        if (response.status === "completed" && response.text?.trim()) { if (source().url !== path) throw new Error("原媒体已变化，未创建转写结果"); result = await createResultNode(workbench, document, id, "text", response.text, `${String(readNodeData(document, id).label ?? "媒体")} · 转写`, undefined, current); }
        const status = result ? "completed" : "delegated"; await workbench.updateRuntimeData({ mediaOperation: { ...original, status, taskId, source: path, ...(result ? { resultNodeId: result.nodeId } : {}) } }, current); await document.save(); return { status, taskId, ...(result ? result : {}) };
      }
      if (!isBrowserAudioAsrSupported()) throw new Error("当前浏览器不支持语音识别服务，请使用宿主转写");
      const content = await workbench.files.read(path, undefined, current);
      if (!content.byteLength || content.byteLength > 100 * 1024 ** 2) throw new Error("浏览器转写素材须为100MiB以内的非空文件");
      const url = URL.createObjectURL(new Blob([content], { type: source().mimeType }));
      try {
        const text = await transcribeBrowserAudio(url, { signal: current, lang: args.language });
        current.throwIfAborted();
        if (!text.trim()) throw new Error("媒体中未识别到文本");
        if (source().url !== path) throw new Error("原媒体已变化，未创建转写结果");
        return createResultNode(workbench, document, id, "text", text, `${String(readNodeData(document, id).label ?? "媒体")} · 转写`, undefined, current);
      } finally { URL.revokeObjectURL(url); }
    }); } });
}
