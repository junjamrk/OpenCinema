import { z } from "zod";
import { blockoutView, blockoutViewSchema } from "./editorView";
import type { PluginActivationContext } from "@toonflow/nodes-scaffold/contracts";
import type { NodeDocumentService } from "@toonflow/nodes-scaffold/react";
import type { NodeWorkbenchService } from "@toonflow/nodes-scaffold/workbenchServices";
import { cloneProject, projectSchema, readProject } from "./document";
import { applyBlockoutCommands, blockoutCommand, getShot, preserveConfirmedTakes } from "./editing";
import { createProject, createEntity, serializeProject } from "./nativeBlockout/schema";
import { ShotEvaluator } from "./nativeBlockout/evaluate";
import { ASSET_CATALOG } from "./nativeBlockout/assets";
import { cameraMovePresets } from "./blockout/cameraMoves";
import { motionPresets } from "./nativeBlockout/motions";
import { actionPresets } from "./nativeBlockout/actionPresets";
import { sequenceStyles } from "./nativeBlockout/sequences";
import { choreoEndings, choreoFormations, choreoStyles } from "./nativeBlockout/choreography";
import { personJoints, personPoses } from "./entityPose";
import { prepareModel, loadModel, disposeModel, maximumModelBytes } from "./model";
import { inspectScan, maximumScanBytes, scanFormat, validateScanContent } from "./scanResources";
import {
  inspectReference,
  maximumReferenceBytes,
  referenceKind,
  referenceSettings,
  workspaceVideoPath,
} from "./referenceVideo";
import { createStagePreset } from "./stagePresets";
import {
  listStagePresets,
  loadStagePreset,
  removeStagePreset,
  saveStagePreset,
} from "./stagePresetLibrary";
import { exportVideo, videoExportSchema, animaticExportSchema } from "./exportVideo";
import {
  exportImages,
  stillExportSchema,
  contactSheetSchema,
  topDownExportSchema,
} from "./exportImages";
import { exportScene, sceneExportSchema } from "./exportScene";
import { createBlockoutViewport } from "./reactViewportEngine";
import type { ProjectDoc, ScanRef } from "./nativeBlockout/types";
import type { RecordPrecision } from "./recording";
import { readMediaSourceRevision, readMediaSourceSnapshot } from "@toonflow/node-shared/mediaEditor";

export function createBlockoutService(context: PluginActivationContext) {
  const document = context.getService<NodeDocumentService>("document");
  const workbench = context.getService<NodeWorkbenchService>("workbench");
  const files = workbench.files,
    id = context.nodeId!;
  if (!id || /[\\/\u0000-\u001f]/.test(id) || [".", ".."].includes(id))
    throw new Error("Blockout 节点 ID 无效");
  const directory = `assets/${id}`;
  const initial = createProject("Blockout");
  const view = blockoutView(workbench);
  let recording: { read(): { phase: string; kind: string; start: number; end: number; marks: number; precision: RecordPrecision } | null; isPreparing(): boolean; start(kind: "camera" | "actor", signal: AbortSignal, precision?: RecordPrecision): Promise<void>; stop(): void; discard(): void; apply(signal?: AbortSignal): Promise<void> } | undefined;
  let recordingStart: AbortController | undefined, recordingTask: Promise<void> | undefined;
  let operation: AbortController | undefined;
  let busy = false,
    phase = "",
    progress = 0,
    error = "";
  let exportTask: Promise<unknown> | undefined,
    jobId = "",
    jobState = "idle",
    jobResult: unknown;
  let activeTask: Promise<unknown> | undefined;
  const pluginState = context.getService<Map<string, unknown>>("state");
  const unsettledKey = `blockout:${workbench.canvasId}:${id}:unsettledExport`;
  let unsettledFailure = pluginState.get(unsettledKey) as Error | undefined;
  if (unsettledFailure) {
    jobState = "unknown";
    error = unsettledFailure.message;
  }
  const data = () => (document.readNode(id) as { data?: Record<string, any> }).data ?? {};
  const revision = () => String(data().blockoutPath ?? data().blockoutSnapshot?.id ?? initial.id);
  const signalFor = (signal?: AbortSignal) =>
    AbortSignal.any([context.signal, ...(signal ? [signal] : [])]);
  function writable() {
    (workbench as NodeWorkbenchService & { assertWritable?(): void }).assertWritable?.();
    context.signal.throwIfAborted();
  }
  async function ensureDirectory() {
    for (const path of ["assets", directory])
      await files.mkdir(path).catch((failure: any) => {
        if (failure?.response?.data?.data?.code !== "EEXIST") throw failure;
      });
  }
  async function read() {
    const before = revision(),
      value = data();
    if (
      value.blockoutPath &&
      (!value.blockoutPath.startsWith(`${directory}/`) ||
        !/^blockout[0-9a-f]{32}\.json$/.test(value.blockoutPath.slice(directory.length + 1)))
    )
      throw new Error("Blockout 文件路径无效");
    const project = readProject(
      value.blockoutSnapshot ??
        (value.blockoutPath ? await files.readJson(value.blockoutPath) : initial),
    );
    context.signal.throwIfAborted();
    if (before !== revision()) throw new Error("Blockout 项目在读取期间已变化，请重新读取");
    return { project, revision: before };
  }
  async function write(value: unknown, expectedRevision: string, signal?: AbortSignal) {
    writable();
    signal?.throwIfAborted();
    const previous = await read();
    if (expectedRevision !== previous.revision)
      throw new Error("Blockout 项目已更新，请重新读取后再修改");
    const project = readProject(value);
    preserveConfirmedTakes(previous.project, project);
    const check = () => {
      writable();
      signal?.throwIfAborted();
      if (revision() !== expectedRevision)
        throw new Error("Blockout 版本已变化，原文件和当前草稿均保留");
    };
    check();
    await ensureDirectory();
    check();
    const path = `${directory}/blockout${crypto.randomUUID().replaceAll("-", "")}.json`;
    await files.write(path, serializeProject(project), true);
    check();
    await document.updateData(
      { blockoutPath: path, blockoutSnapshot: null, outputs: {} },
      document.getRevision(),
      signal,
    );
    await document.save();
    return { project: cloneProject(project), revision: path };
  }
  async function run<T>(callback: (signal: AbortSignal) => Promise<T>, callSignal?: AbortSignal) {
    if (unsettledFailure) throw unsettledFailure;
    if (busy) throw new Error("Blockout 正在处理其他操作，请完成或取消后重试");
    writable();
    busy = true;
    error = "";
    operation = new AbortController();
    const signal = signalFor(
      callSignal ? AbortSignal.any([callSignal, operation.signal]) : operation.signal,
    );
    const task = Promise.resolve().then(() => callback(signal));
    activeTask = task;
    try {
      return await task;
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
      throw failure;
    } finally {
      busy = false;
      operation = undefined;
      if (activeTask === task) activeTask = undefined;
    }
  }
  async function cancel() {
    if (unsettledFailure) throw unsettledFailure;
    const cancelRequested = !!operation || !!recordingTask || recording?.read()?.phase === "recording";
    recordingStart?.abort(new DOMException("用户取消录制准备", "AbortError"));
    recording?.stop();
    await recordingTask?.catch(() => {});
    operation?.abort(new DOMException("用户取消 Blockout 操作", "AbortError"));
    for (const task of [activeTask, exportTask]) {
      await task?.catch((failure) => {
        if (failure instanceof AggregateError || failure?.ffmpegSettled === false) throw failure;
      });
    }
    if (unsettledFailure) throw unsettledFailure;
    return { cancelRequested, busy, executionSettled: !activeTask && !exportTask };
  }
  const readOnlyTools = new Set(["getBlockoutProject", "getBlockoutStatus", "getBlockoutLegacyDocument", "getBlockoutCommandSchema", "listBlockoutAssets", "listBlockoutCameraMoves", "listBlockoutMotions", "listBlockoutActions", "listBlockoutSequences", "listBlockoutRoutines", "listBlockoutVideoInputs", "sampleBlockoutShot", "listBlockoutStagePresets"]);
  const projectOutputSchema = z.strictObject({ project: projectSchema, revision: z.string() });
  const namedItemSchema = z.strictObject({ id: z.string(), name: z.string() });
  const presetSummarySchema = namedItemSchema.extend({ savedAt: z.string(), entityCount: z.number().int().nonnegative(), takeCount: z.number().int().nonnegative(), modelCount: z.number().int().nonnegative() });
  const queuedSchema = z.strictObject({ status: z.string(), jobId: z.string(), executionSettled: z.boolean() });
  const vectorSchema = z.strictObject({ x: z.number(), y: z.number(), z: z.number() });
  const outputSchemas = new Map<string, z.ZodType>([
    ["getBlockoutProject", projectOutputSchema], ["setBlockoutProject", projectOutputSchema],
    ["freezeBlockoutReference", z.strictObject({ nodes: z.array(z.strictObject({ nodeId: z.string(), label: z.string(), path: z.string(), sourceRevision: z.string(), layer: z.enum(["rgb", "depth"]) })), manifestPath: z.string(), revision: z.string() })],
    ["getBlockoutStatus", z.strictObject({ busy: z.boolean(), phase: z.string(), progress: z.number(), error: z.string(), jobId: z.string(), state: z.string(), result: z.strictObject({ directory: z.string().optional(), videoPath: z.string().optional(), archivePath: z.string().optional(), manifestPath: z.string().optional() }).optional(), executionSettled: z.boolean(), revision: z.string() })],
    ["cancelBlockout", z.strictObject({ cancelRequested: z.boolean(), busy: z.boolean(), executionSettled: z.boolean() })],
    ["getBlockoutLegacyDocument", z.strictObject({ document: z.json().nullable(), path: z.string().nullable().optional() })],
    ["getBlockoutCommandSchema", z.union([z.strictObject({ types: z.array(z.string()) }), z.record(z.string(), z.json()).describe("单个Blockout命令的真实JSON Schema")])],
    ["editBlockoutProject", projectOutputSchema.extend({ changes: z.array(z.looseObject({ type: z.string(), sceneId: z.string() }).describe("按实际命令返回shotId/entityId/takeId等变更引用；完整命令参数由getBlockoutCommandSchema发现")) })],
    ["listBlockoutAssets", z.strictObject({ assets: z.array(z.strictObject({ id: z.string(), name: z.string(), category: z.string(), height: z.number(), footprint: z.number(), speedScale: z.number(), motion: z.string(), promptNoun: z.string() })), total: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative().nullable() })],
    ["listBlockoutCameraMoves", z.strictObject({ presets: z.array(namedItemSchema.extend({ category: z.string(), description: z.string(), track: z.boolean() })) })],
    ["listBlockoutMotions", z.strictObject({ personJoints: z.array(z.strictObject({ key: z.string(), name: z.string(), rangeDegrees: z.number() })), personPoses: z.array(namedItemSchema), presets: z.array(namedItemSchema.extend({ category: z.string(), duration: z.number(), loop: z.boolean(), keyframeCount: z.number().int(), hasRootMotion: z.boolean() })) })],
    ["listBlockoutActions", z.strictObject({ presets: z.array(namedItemSchema.extend({ category: z.string(), description: z.string(), suggestedAssets: z.array(z.string()) })) })],
    ["listBlockoutSequences", z.strictObject({ types: z.array(z.strictObject({ id: z.string(), styles: z.array(namedItemSchema) })) })],
    ["listBlockoutRoutines", z.strictObject({ kinds: z.array(z.strictObject({ id: z.string(), styles: z.array(namedItemSchema), endings: z.array(namedItemSchema) })), formations: z.array(namedItemSchema) })],
    ["listBlockoutVideoInputs", z.strictObject({ inputs: z.array(z.strictObject({ source: z.string(), sourceHandle: z.string(), dataType: z.literal("VIDEO"), value: z.strictObject({ url: z.string(), mimeType: z.string() }).optional() })) })],
    ["sampleBlockoutShot", z.strictObject({ revision: z.string(), time: z.number(), camera: z.strictObject({ position: vectorSchema, pan: z.number(), tilt: z.number(), roll: z.number(), focalLength: z.number(), focusDistance: z.number().optional(), trackEntityId: z.string().optional(), vfov: z.number() }), entities: z.array(z.strictObject({ entityId: z.string(), position: vectorSchema, heading: z.number(), gait: z.string(), distanceTravelled: z.number(), speed: z.number(), joints: z.record(z.string(), z.number()).optional() })), warnings: z.array(z.strictObject({ entityId: z.string(), entityName: z.string(), fromMarkId: z.string(), toMarkId: z.string(), legIndex: z.number().int(), gait: z.string(), verdict: z.union([z.strictObject({ ok: z.literal(true) }), z.strictObject({ ok: z.literal(false), kind: z.enum(["tooFast", "tooSlow"]), impliedSpeed: z.number(), suggestion: z.string() })]) })) })],
    ["importBlockoutReference", projectOutputSchema], ["importBlockoutModel", projectOutputSchema.extend({ entityId: z.string() })], ["importBlockoutScan", projectOutputSchema.extend({ splatCount: z.number().int().nonnegative() })], ["applyBlockoutStagePreset", projectOutputSchema],
    ["listBlockoutStagePresets", z.strictObject({ presets: z.array(presetSummarySchema), errors: z.array(z.strictObject({ path: z.string(), message: z.string() })) })], ["saveBlockoutStagePreset", presetSummarySchema], ["removeBlockoutStagePreset", z.strictObject({ removed: z.boolean(), id: z.string() })],
    ...["exportBlockoutVideo", "exportBlockoutAnimatic", "exportBlockoutStills", "exportBlockoutContactSheet", "exportBlockoutTopDown", "exportBlockoutScene"].map(name => [name, queuedSchema] as const),
  ]);
  const tool = <T extends z.ZodType>(
    name: string,
    description: string,
    parameters: T,
    execute: (args: z.output<T>, signal: AbortSignal) => unknown,
  ) =>
    context.registerTool({
      name,
      description,
      parameters,
      outputSchema: outputSchemas.get(name),
      annotations: { readOnlyHint: readOnlyTools.has(name), destructiveHint: name === "removeBlockoutStagePreset", idempotentHint: readOnlyTools.has(name), openWorldHint: name === "requestDirectorPlan" },
      execute: (args, call) => execute(args, signalFor(call.signal)),
    });
  const expected = { expectedRevision: z.string().min(1).max(4096) };
  const viewOutput = z.strictObject({ view: blockoutViewSchema, viewRevision: z.number().int().nonnegative(), resourceRevision: z.string(), recording: z.strictObject({ phase: z.string(), kind: z.string(), start: z.number(), end: z.number(), marks: z.number().int(), precision: z.enum(["precise", "normal", "fast"]) }).nullable(), persistence: z.literal("memory") });
  const readView = () => ({ view: view.read().value, viewRevision: view.read().revision, resourceRevision: revision(), recording: recording?.read() ?? null, persistence: "memory" as const });
  context.registerTool({ name: "getBlockoutView", description: "读取真实Blockout编辑台当前scene/shot、对象多选、标记、播放头(秒)、scene/take编辑范围和未采用录制摘要。此视图仅在runtime内存保留。空sceneId/shotId表示界面回退至项目首项。", parameters: z.strictObject({}), outputSchema: viewOutput, annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }, execute: readView });
  context.registerTool({ name: "setBlockoutView", description: "修改同一Blockout编辑台视图，不修改作品。须携带项目和视图修订；录制草稿存在时先停止/采用/丢弃。time单位为镜头秒数。", parameters: blockoutViewSchema.partial().extend({ expectedRevision: z.string().min(1), expectedViewRevision: z.number().int().nonnegative() }), outputSchema: viewOutput, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, async execute(args) {
    writable(); const current = await read(); if (current.revision !== args.expectedRevision) throw new Error("Blockout项目已变化，请重新读取");
    if (recording?.read() || recording?.isPreparing()) throw new Error("录制正在准备或草稿仍存在，请先停止并采用或丢弃");
    const { expectedRevision, expectedViewRevision, ...patch } = args; const next = blockoutViewSchema.parse({ ...view.read().value, ...patch });
    const scene = current.project.scenes.find(value => value.id === next.sceneId) ?? (!next.sceneId ? current.project.scenes[0] : undefined);
    if (!scene) throw new Error("场景不存在");
    const shot = [...scene.shots, ...(scene.drafts ?? [])].find(value => value.id === next.shotId) ?? (!next.shotId ? scene.shots[0] : undefined);
    if (!shot || next.time > shot.duration) throw new Error("镜头不存在或播放头超出镜头时长");
    if ([next.selected, ...next.selectedIds].filter(value => value && value !== "camera").some(value => !scene.entities.some(entity => entity.id === value))) throw new Error("所选对象不属于当前场景");
    if (next.editScope === "take" && next.mode === "scale") throw new Error("Take范围不支持缩放，请使用scene范围");
    view.replace(next, expectedViewRevision); return readView();
  } });
  context.registerTool({ name: "controlBlockoutRecording", description: "对真实编辑台已有录制执行stop/discard/apply。apply复用现有录制采用流程并保存，失败保留草稿；不伪造无界面的录制。", parameters: z.strictObject({ action: z.enum(["stop", "discard", "apply"]) }), outputSchema: viewOutput, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }, async execute(args, { signal }) {
    signal.throwIfAborted();
    writable(); if (!recording?.read()) throw new Error("没有真实编辑台录制草稿");
    if (args.action === "apply") await recording.apply(signalFor(signal)); else recording[args.action]();
    return readView();
  } });
  context.registerTool({ name: "startBlockoutRecording", description: "在已打开且拥有焦点的真实Blockout编辑台开始录制当前自由相机或所选角色操演；复用当前场景/镜头/播放头，precision不传沿用UI。先getBlockoutView固定作品和视图修订；未就绪、失焦、只读或已有草稿时明确失败。返回实际录制状态，不代表已保存；随后stop/apply或discard。", parameters: z.strictObject({ kind: z.enum(["camera", "actor"]), precision: z.enum(["precise", "normal", "fast"]).optional(), expectedRevision: z.string().min(1), expectedViewRevision: z.number().int().nonnegative() }), outputSchema: viewOutput, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, async execute(args, { signal }) {
    writable();
    const current = await read();
    if (current.revision !== args.expectedRevision) throw new Error("Blockout项目已变化，请重新读取");
    if (view.read().revision !== args.expectedViewRevision) throw Object.assign(new Error("Blockout视图已变化，请重新读取"), { code: "draftRevisionConflict", actualRevision: view.read().revision });
    if (!view.read().value.open || !recording) throw new Error("请先打开Blockout编辑台，等待真实三维视口就绪");
    if (busy || unsettledFailure || recordingTask) throw new Error("Blockout当前操作尚未收尾，不能开始录制");
    const start = new AbortController(); recordingStart = start;
    const task = recording.start(args.kind, signalFor(AbortSignal.any([signal, start.signal])), args.precision); recordingTask = task;
    try {
      await task;
      if (recording.read()?.phase !== "recording") throw new Error("编辑台没有进入实际录制状态");
      return readView();
    } finally { if (recordingTask === task) { recordingTask = undefined; recordingStart = undefined; } }
  } });
  tool(
    "getBlockoutProject",
    "读取完整 Blockout 项目与版本。包含场景、主镜、备选、机位、Take、静态姿态和扫描；修改必须带回 revision。",
    z.strictObject({}),
    async () => read(),
  );
  tool(
    "freezeBlockoutReference",
    "把当前单镜已导出的RGB/Depth固定为独立视频参考节点，不复制或覆盖媒体、不自动改已有连线。核项目/镜头/清单与源版本；下一镜导出不改变这些参考。旧版本须显式保留或重新导出。",
    z.strictObject({ expectedRevision: z.string().min(1), sceneId: z.string().min(1), shotId: z.string().min(1), layers: z.array(z.enum(["rgb", "depth"])).min(1).max(2).refine(value => new Set(value).size === value.length, "参考层不能重复"), position: z.strictObject({ x: z.number().finite(), y: z.number().finite() }).optional() }),
    (args, signal) => run(async signal => {
      const current = await read();
      if (current.revision !== args.expectedRevision) throw new Error("白模版本已变化，请读取当前项目后重新导出");
      const outputs = data().outputs ?? {}, before = JSON.stringify(outputs), manifestPath = outputs.exportManifest?.value?.url;
      if (typeof manifestPath !== "string" || !manifestPath.startsWith(`${directory}/`)) throw new Error("当前版本没有单镜导出清单，请先导出该镜头");
      const snapshot = await readMediaSourceSnapshot(files, manifestPath, 4 * 1024 ** 2, signal);
      const manifest = z.object({ schema: z.literal("openCinema-blockout-rgb-v1"), source: z.object({ projectId: z.string(), revision: z.string(), sceneId: z.string(), shotId: z.string() }), video: z.object({ path: z.literal("video.mp4") }), protocol: z.object({ controlLayers: z.array(z.object({ type: z.enum(["depth", "normal"]), path: z.enum(["depth.mp4", "normal.mp4"]) })) }) }).parse(JSON.parse(new TextDecoder().decode(snapshot.content)));
      if (manifest.source.projectId !== current.project.id || manifest.source.revision !== current.revision.split("/").at(-1) || manifest.source.sceneId !== args.sceneId || manifest.source.shotId !== args.shotId) throw new Error("当前导出属于其他镜头或旧白模版本，请重新导出所选镜头");
      const { shot } = getShot(current.project, args.sceneId, args.shotId), layout = workbench.getLayout(), position = args.position ?? { x: layout.position.x + 400, y: layout.position.y };
      const nodes = [];
      for (const [index, layer] of args.layers.entries()) {
        const value = outputs[layer === "rgb" ? "video" : "depth"]?.value;
        const member = layer === "rgb" ? manifest.video.path : manifest.protocol.controlLayers.find(item => item.type === "depth")?.path;
        if (!member || !value || value.mimeType !== "video/mp4" || value.url !== `${manifestPath.slice(0, manifestPath.lastIndexOf("/"))}/${member}` || layer === "depth" && member !== "depth.mp4") throw new Error("所选层未在同一镜头导出中发布，请重新导出完整RGB/Depth组");
        const source = await readMediaSourceRevision(files, value.url, undefined, signal);
        nodes.push({ nodeId: crypto.randomUUID(), label: `${shot.name} · ${layer === "rgb" ? "RGB" : "Depth"}固定参考`, path: value.url, sourceRevision: source.revision, layer, position: { x: position.x, y: position.y + index * 300 } });
      }
      await readMediaSourceRevision(files, manifestPath, snapshot.revision, signal);
      for (const item of nodes) await readMediaSourceRevision(files, item.path, item.sourceRevision, signal);
      if (revision() !== current.revision || JSON.stringify(data().outputs ?? {}) !== before) throw new Error("固定参考期间项目或导出已变化，未创建节点");
      writable(); signal.throwIfAborted();
      await workbench.createNodes(nodes.map(item => ({ id: item.nodeId, type: "videoNode", position: item.position, data: { label: item.label, handles: [{ id: "video", type: "source", dataType: "VIDEO", label: item.layer === "depth" ? "Depth参考" : "RGB参考" }], outputs: { video: { dataType: "VIDEO", value: { url: item.path, mimeType: "video/mp4", ...(item.layer === "depth" ? { controlType: "depth" } : {}) } } }, referenceSnapshot: { path: item.path, sourceRevision: item.sourceRevision, manifestPath, manifestRevision: snapshot.revision, originNodeId: id, resourceRevision: current.revision, sceneId: args.sceneId, shotId: args.shotId, layer: item.layer, description: item.label } } })), [], signal);
      await document.save();
      return { nodes: nodes.map(({ position: _position, ...item }) => item), manifestPath, revision: current.revision };
    }, signal),
  );
  tool(
    "getBlockoutStatus",
    "读取本节点真实任务阶段、进度、错误与执行收尾状态。",
    z.strictObject({}),
    () => ({
      busy,
      phase,
      progress,
      error,
      jobId,
      state: jobState,
      result: jobResult,
      executionSettled: !activeTask && !exportTask && !unsettledFailure,
      revision: revision(),
    }),
  );
  tool(
    "getBlockoutLegacyDocument",
    "只读返回本节点保留的旧导演台草稿；不会转换、覆盖或替代独立 Blockout 场景。",
    z.strictObject({}),
    async () => {
      const current = data();
      if (!current.modelSnapshot && !current.modelPath) return { document: null };
      if (
        current.modelPath &&
        current.modelPath !== `${directory}/model.json` &&
        (!current.modelPath.startsWith(`${directory}/`) ||
          !/^model[0-9a-f]{32}\.json$/.test(current.modelPath.slice(directory.length + 1)))
      )
        throw new Error("旧导演台草稿路径无效");
      const value = z
        .json()
        .parse(current.modelSnapshot ?? (await files.readJson(current.modelPath)));
      context.signal.throwIfAborted();
      return { document: value, path: current.modelPath ?? null };
    },
  );
  tool(
    "getBlockoutCommandSchema",
    "先列出可用命令名称，再按type读取单个命令JSON Schema，避免整库注入上下文。",
    z.strictObject({ type: z.string().optional() }),
    (args) => {
      const schemas = blockoutCommand.options;
      if (!args.type) return { types: schemas.map((schema) => schema.shape.type.value) };
      const schema = schemas.find((schema) => schema.shape.type.value === args.type);
      if (!schema) throw new Error("Blockout命令不存在");
      return z.toJSONSchema(schema);
    },
  );
  tool(
    "setBlockoutProject",
    "保存完整项目的新不可变版本，保护确认 Take，并进入统一画布历史。",
    z.strictObject({ ...expected, project: projectSchema }),
    (args, signal) => run((signal) => write(args.project, args.expectedRevision, signal), signal),
  );
  tool(
    "editBlockoutProject",
    "按稳定 ID 原子批量编辑场景/走位/动作/机位/Take/备选/群组/扫描；任何非法命令整批拒绝。",
    z.strictObject({ ...expected, commands: z.array(blockoutCommand).min(1).max(100) }),
    (args, signal) =>
      run(async (signal) => {
        const current = await read();
        if (current.revision !== args.expectedRevision) throw new Error("项目已更新，请重新读取");
        const next = applyBlockoutCommands(current.project, args.commands);
        return {
          ...(await write(next.project, args.expectedRevision, signal)),
          changes: next.changes,
        };
      }, signal),
  );
  tool(
    "listBlockoutAssets",
    "分页发现真实内置素材 ID、尺寸和分类，不猜素材 ID。",
    z.strictObject({
      category: z.string().optional(),
      query: z.string().max(200).optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    (value) => {
      const assets = ASSET_CATALOG.filter(
          (asset) =>
            (!value.category || asset.category === value.category) &&
            (!value.query ||
              `${asset.id} ${asset.name}`.toLowerCase().includes(value.query.toLowerCase())),
        ),
        offset = value.offset ?? 0,
        limit = value.limit ?? 50;
      return {
        assets: assets.slice(offset, offset + limit),
        total: assets.length,
        nextOffset: offset + limit < assets.length ? offset + limit : null,
      };
    },
  );
  tool(
    "listBlockoutCameraMoves",
    "发现全部真实运镜预设，返回 ID 与摄影意图。",
    z.strictObject({}),
    () => ({
      presets: cameraMovePresets.map(({ id, name, category, description, track }) => ({
        id,
        name,
        category,
        description,
        track,
      })),
    }),
  );
  tool(
    "listBlockoutMotions",
    "发现全部内置关节动作及静态姿态/关节范围，持久化关节单位为弧度。",
    z.strictObject({}),
    () => ({
      personJoints,
      personPoses,
      presets: motionPresets.map(({ id, name, category, duration, loop, keyframes }) => ({
        id,
        name,
        category,
        duration,
        loop,
        keyframeCount: keyframes.length,
        hasRootMotion: keyframes.some((frame) => frame.move),
      })),
    }),
  );
  tool("listBlockoutActions", "发现真实根走位预设。", z.strictObject({}), () => ({
    presets: actionPresets.map(({ id, name, category, description, suggestedAssets }) => ({
      id,
      name,
      category,
      description,
      suggestedAssets,
    })),
  }));
  tool(
    "listBlockoutSequences",
    "发现群舞、打斗、追逐与车辆追逐的全部真实风格。",
    z.strictObject({}),
    () => ({
      types: (["dance", "fight", "footChase", "carChase"] as const).map((id) => ({
        id,
        styles: sequenceStyles(id),
      })),
    }),
  );
  tool(
    "listBlockoutRoutines",
    "发现确定性群体例程的风格、结尾与队形。",
    z.strictObject({}),
    () => ({
      kinds: (["dance", "fight", "chase"] as const).map((id) => ({
        id,
        styles: choreoStyles(id),
        endings: choreoEndings(id),
      })),
      formations: choreoFormations(),
    }),
  );
  tool(
    "cancelBlockout",
    "请求取消当前任务；busy 为 false 后才已收尾。",
    z.strictObject({}),
    cancel,
  );
  async function readModel(path: string) {
    if (!/^model[0-9a-f]{32}\.glb$/.test(path)) throw new Error("模型引用不属于此节点");
    return files.read(`${directory}/${path}`, maximumModelBytes, context.signal);
  }
  async function readScan(scan: ScanRef, signal?: AbortSignal) {
    const bytes = await files.read(
      `${directory}/${scan.file}`,
      maximumScanBytes,
      signalFor(signal),
    );
    await validateScanContent(scan, bytes, signal);
    return bytes;
  }
  async function importModel(file: File, sceneId: string, resources: File[] = []) {
    return run(async (signal) => {
      const current = await read(),
        selected = new Map(
          resources.map((value) => [value.webkitRelativePath || value.name, value]),
        );
      const source = file.webkitRelativePath || file.name,
        prefix = source.slice(0, source.lastIndexOf("/") + 1);
      const content = await prepareModel(
        file,
        async (relative) => {
          const value = selected.get(`${prefix}${relative}`);
          if (!value) throw new Error(`未选择模型资源：${relative}`);
          return value.arrayBuffer();
        },
        signal,
      );
      const model = await loadModel(content),
        height = model.height,
        dimensions = model.dimensions;
      disposeModel(model.group);
      const scene = current.project.scenes.find((item) => item.id === sceneId);
      if (!scene) throw new Error("场景不存在");
      const suffix = crypto.randomUUID().replaceAll("-", ""),
        sourceFile = `model${suffix}.glb`;
      const entity = createEntity(`custom.${suffix}`, file.name, { x: 0, y: 0, z: 0 });
      entity.sourceFile = sourceFile;
      entity.params = { height: height / 1.7, width: dimensions.x, depth: dimensions.z };
      scene.entities.push(entity);
      readProject(current.project);
      await ensureDirectory();
      signal.throwIfAborted();
      await files.write(`${directory}/${sourceFile}`, content, true);
      return { ...(await write(current.project, current.revision, signal)), entityId: entity.id };
    });
  }
  async function importScan(file: File, sceneId: string) {
    return run(async (signal) => {
      if (file.size > maximumScanBytes) throw new Error("扫描超过100 MiB");
      const current = await read(),
        format = scanFormat(file.name),
        bytes = await file.arrayBuffer();
      const { metadata, splatCount } = await inspectScan(bytes, format, signal);
      const name = `scan${crypto.randomUUID().replaceAll("-", "")}.${format}`;
      const next = applyBlockoutCommands(current.project, [
        { type: "addScan", sceneId, name: file.name, file: name, metadata },
      ]);
      await ensureDirectory();
      signal.throwIfAborted();
      await files.write(`${directory}/${name}`, bytes, true);
      return { ...(await write(next.project, current.revision, signal)), splatCount };
    });
  }
  type CaptureEntry = {
    viewport: ReturnType<typeof createBlockoutViewport>;
    container: HTMLDivElement;
  };
  async function capture(
    project: ProjectDoc,
    sceneId: string,
    shotId: string,
    callback: (viewport: ReturnType<typeof createBlockoutViewport>) => Promise<any>,
    cache: Map<string, CaptureEntry>,
  ) {
    const key = `${sceneId}:${shotId}`;
    let entry = cache.get(key);
    if (!entry) {
      const { scene, shot } = getShot(project, sceneId, shotId);
      const container = window.document.createElement("div"),
        canvas = window.document.createElement("canvas");
      container.style.cssText =
        "position:fixed;left:-20000px;top:0;width:1280px;height:720px;pointer-events:none";
      container.append(canvas);
      window.document.body.append(container);
      const viewport = createBlockoutViewport(container, canvas, {
        scene,
        shot,
        time: 0,
        selected: "",
        markId: "",
        mode: "translate",
        cameraView: true,
        disabled: true,
        readModel,
        readScan,
      });
      entry = { viewport, container };
      cache.set(key, entry);
    }
    await entry.viewport.ready();
    return callback(entry.viewport);
  }
  async function deliver(
    kind: "video" | "animatic" | "stills" | "contactSheet" | "topDown" | "scene",
    input: any,
    expectedRevision: string,
    callSignal?: AbortSignal,
  ) {
    return run(async (signal) => {
      const current = await read();
      if (current.revision !== expectedRevision) throw new Error("项目已更新，请重新读取后导出");
      if (!data().blockoutPath) throw new Error("请先保存一次场景再导出");
      const originalOutputs = JSON.stringify(data().outputs ?? {});
      const check = () => {
        writable();
        signal.throwIfAborted();
        if (
          revision() !== expectedRevision ||
          JSON.stringify(data().outputs ?? {}) !== originalOutputs
        )
          throw new Error("版本或输出已变化，旧输出保留");
      };
      check();
      await ensureDirectory();
      check();
      progress = 0;
      const options = {
        files,
        directory: `${directory}/${kind === "scene" ? "sceneExport" : kind === "video" || kind === "animatic" ? "videoExport" : "imageExport"}${crypto.randomUUID().replaceAll("-", "")}`,
        ...current,
        input,
        signal,
        check,
        progress: (value: string, percent: number) => {
          phase = value;
          progress = percent;
        },
      };
      let result: any,
        published = false;
      const captures = new Map<string, CaptureEntry>();
      try {
        if (kind === "scene") result = await exportScene(options);
        else if (kind === "video" || kind === "animatic")
          result = await exportVideo({
            ...options,
            ffmpeg: await workbench.ffmpeg(signal),
            capture: (shotId, time, width, pass) =>
              capture(
                current.project,
                input.sceneId,
                shotId,
                (viewport) => viewport.capture(time, width, pass),
                captures,
              ),
          });
        else
          result = await exportImages({
            ...options,
            input: { ...input, type: kind },
            capture: (sceneId, shotId, time, width) =>
              capture(
                current.project,
                sceneId,
                shotId,
                (viewport) => viewport.capture(time, width),
                captures,
              ),
            captureTopDown: (sceneId, shotId) =>
              capture(
                current.project,
                sceneId,
                shotId,
                (viewport) => viewport.captureTopDown(),
                captures,
              ),
          });
        check();
        const outputs = { ...data().outputs };
        // 同一镜的RGB与控制层必须来自一次导出；未选层不能沿用上一个镜头。
        if (kind === "video") for (const name of ["video", "depth", "normal", "exportManifest"]) delete outputs[name];
        const output = (
          name: string,
          path: string,
          mimeType: string,
          dataType: string = "FILE",
          extra = {},
        ) => {
          outputs[name] = { dataType, value: { url: path, mimeType, ...extra } };
        };
        if (kind === "video" || kind === "animatic") {
          output(kind === "video" ? "video" : "animatic", result.videoPath, "video/mp4", "VIDEO");
          output(
            kind === "video" ? "exportManifest" : "animaticManifest",
            result.manifestPath,
            "application/json",
          );
          for (const layer of result.controlLayers)
            output(
              layer.type,
              layer.path,
              layer.mimeType,
              layer.type === "depth" ? "VIDEO" : "FILE",
              layer.type === "depth" ? { controlType: "depth" } : {},
            );
        } else if (kind === "scene") {
          output("scenePackage", result.archivePath, "application/zip");
          output("sceneGlb", result.scenePath, "model/gltf-binary");
          output("sceneCamera", result.cameraPath, "application/json");
          output("sceneManifest", result.manifestPath, "application/json");
        } else {
          const names = {
            stills: ["stillPackage", "stillPreview"],
            contactSheet: ["contactPackage", "contactSheet"],
            topDown: ["topDownPackage", "topDown"],
          }[kind];
          output(names[0]!, result.archivePath, "application/zip");
          output(names[1]!, result.previewPath, "image/png", "IMAGE");
          output("imageManifest", result.manifestPath, "application/json");
        }
        await document.updateData({ outputs }, document.getRevision(), signal);
        await document.save();
        published = true;
        progress = 100;
        phase = "导出已保存";
        return result;
      } catch (failure) {
        if (result && !published)
          await files.remove(result.directory, true).catch((cleanup) => {
            throw new AggregateError([failure, cleanup], "导出未发布且清理失败");
          });
        throw failure;
      } finally {
        for (const { viewport, container } of captures.values()) {
          await viewport.disposeScans();
          viewport.dispose();
          container.remove();
        }
      }
    }, callSignal);
  }
  function queueDelivery(
    kind: Parameters<typeof deliver>[0],
    input: any,
    expectedRevision: string,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    if (unsettledFailure) throw unsettledFailure;
    if (busy || exportTask) throw new Error("Blockout 已有任务，请等待或取消");
    jobId = crypto.randomUUID();
    jobState = "queued";
    jobResult = undefined;
    jobState = "running";
    const task = deliver(kind, input, expectedRevision);
    exportTask = task;
    void task
      .then(
        (value) => {
          jobState = "succeeded";
          jobResult = {
            directory: value.directory,
            videoPath: value.videoPath,
            archivePath: value.archivePath,
            manifestPath: value.manifestPath,
          };
        },
        (failure) => {
          if (
            failure instanceof AggregateError ||
            (failure as { ffmpegSettled?: boolean })?.ffmpegSettled === false
          )
            unsettledFailure = failure;
          if (unsettledFailure) pluginState.set(unsettledKey, unsettledFailure);
          jobState = unsettledFailure
            ? "unknown"
            : failure instanceof DOMException && failure.name === "AbortError"
              ? "cancelled"
              : "failed";
          phase = unsettledFailure
            ? "执行收尾未确认"
            : jobState === "cancelled"
              ? "导出已取消"
              : "导出失败";
        },
      )
      .finally(() => {
        if (exportTask === task) exportTask = undefined;
      });
    return { status: "queued", jobId, executionSettled: false };
  }
  for (const [name, kind, schema] of [
    ["exportBlockoutVideo", "video", videoExportSchema],
    ["exportBlockoutAnimatic", "animatic", animaticExportSchema],
    ["exportBlockoutStills", "stills", stillExportSchema],
    ["exportBlockoutContactSheet", "contactSheet", contactSheetSchema],
    ["exportBlockoutTopDown", "topDown", topDownExportSchema],
    ["exportBlockoutScene", "scene", sceneExportSchema],
  ] as const) {
    tool(
      name,
      "导出已保存版本的真实媒体/场景交付；与sampleBlockoutShot共用ShotEvaluator，wheeled路径首尾显式arriveHeading可表达独立车头漂移；保留SHA来源清单，不调用生成模型。",
      schema.safeExtend(expected),
      (args, signal) => {
        const { expectedRevision, ...input } = args;
        return queueDelivery(kind, input, expectedRevision, signal);
      },
    );
  }
  tool("listBlockoutVideoInputs", "发现当前已连接的真实视频产物。", z.strictObject({}), () => ({
    inputs: workbench.getInputs("in").filter((value) => value.dataType === "VIDEO"),
  }));
  async function importReference(
    source: File | string,
    args: {
      sceneId: string;
      shotId: string;
      expectedRevision: string;
      kind: "rgb" | "pose" | "depth";
      mode?: "ghost" | "pip";
      opacity?: number;
      timeOffset?: number;
    },
    callSignal?: AbortSignal,
  ) {
    return run(async (signal) => {
      const current = await read();
      if (current.revision !== args.expectedRevision) throw new Error("项目已变化");
      if (source instanceof File && (!source.size || source.size > maximumReferenceBytes))
        throw new Error("参考视频须大于0且不超过256 MiB");
      const content =
        typeof source === "string"
          ? await files.read(workspaceVideoPath.parse(source), maximumReferenceBytes, signal)
          : await source.arrayBuffer();
      const metadata = await inspectReference(content, signal);
      const path = `reference${crypto.randomUUID().replaceAll("-", "")}.${metadata.mimeType === "video/webm" ? "webm" : "mp4"}`;
      getShot(current.project, args.sceneId, args.shotId).shot.referenceVideo = {
        path,
        ...metadata,
        kind: referenceKind.parse(args.kind),
        ...referenceSettings.parse({
          mode: args.mode ?? "ghost",
          opacity: args.opacity ?? 0.5,
          timeOffset: args.timeOffset ?? 0,
        }),
      };
      await ensureDirectory();
      signal.throwIfAborted();
      writable();
      await files.write(`${directory}/${path}`, content, true);
      return write(current.project, current.revision, signal);
    }, callSignal);
  }
  tool(
    "importBlockoutReference",
    "明确复制一路视频参考到本节点；参考仅供ghost/PiP监看，不烧入渲染。",
    z.strictObject({
      ...expected,
      sceneId: z.string(),
      shotId: z.string(),
      path: workspaceVideoPath,
      kind: referenceKind,
      ...referenceSettings.partial().shape,
    }),
    (args, signal) => importReference(args.path, args, signal),
  );
  tool(
    "sampleBlockoutShot",
    "只读求值真实场景在指定时间的世界位置、弧度朝向、机位和速度警告，与监看/媒体导出共用ShotEvaluator。wheeled路径首尾都显式arriveHeading时车头独立插值，可核对漂移；未填写沿路径朝向，不修改场景。",
    z.strictObject({
      sceneId: z.string(),
      shotId: z.string(),
      time: z.number().finite().min(0).max(300),
    }),
    async (args) => {
      const current = await read(),
        { scene, shot } = getShot(current.project, args.sceneId, args.shotId);
      if (args.time > shot.duration) throw new Error("采样时间超出镜尾");
      const evaluator = new ShotEvaluator(scene, shot);
      return {
        revision: current.revision,
        ...evaluator.evaluate(args.time),
        warnings: evaluator.warnings(),
      };
    },
  );
  tool(
    "importBlockoutModel",
    "将工作区GLB/glTF与明确资源文件导入为节点自有资源，保留旧引用与历史。",
    z.strictObject({
      path: z.string().min(1),
      sceneId: z.string(),
      resources: z.array(z.string()).max(256).optional(),
    }),
    async (args, signal) => {
      signal.throwIfAborted();
      const content = await files.read(args.path, maximumModelBytes, signal),
        file = new File([content], args.path.split("/").at(-1)!);
      const resources = await Promise.all(
        (args.resources ?? []).map(
          async (path) =>
            new File([await files.read(path, maximumModelBytes, signal)], path.split("/").at(-1)!),
        ),
      );
      return importModel(file, args.sceneId, resources);
    },
  );
  tool(
    "importBlockoutScan",
    "校验并导入工作区Gaussian扫描，保留全部源字节与SHA，不上传或抽稀。",
    z.strictObject({ path: z.string().min(1), sceneId: z.string() }),
    async (args, signal) => {
      const content = await files.read(args.path, maximumScanBytes, signal);
      return importScan(new File([content], args.path.split("/").at(-1)!), args.sceneId);
    },
  );
  tool(
    "listBlockoutStagePresets",
    "列出实际保存的布景预设。",
    z.strictObject({}),
    (_args, signal) => listStagePresets(signal),
  );
  tool(
    "saveBlockoutStagePreset",
    "保存所选场景的布景/走位及GLB闭包。",
    z.strictObject({ sceneId: z.string(), name: z.string().min(1) }),
    (args, signal) =>
      run(async (signal) => {
        const current = await read(),
          scene = current.project.scenes.find((value) => value.id === args.sceneId);
        if (!scene) throw new Error("场景不存在");
        return saveStagePreset(createStagePreset(scene, args.name), readModel, signal, writable);
      }, signal),
  );
  tool(
    "applyBlockoutStagePreset",
    "复制真实布景预设为新场景，重新分配物体/Take引用。",
    z.strictObject({ ...expected, id: z.string() }),
    (args, signal) =>
      run(async (signal) => {
        const current = await read();
        if (current.revision !== args.expectedRevision) throw new Error("项目已变化");
        const payload = await loadStagePreset(
          args.id,
          async (bytes) => {
            await ensureDirectory();
            const name = `model${crypto.randomUUID().replaceAll("-", "")}.glb`;
            await files.write(`${directory}/${name}`, bytes, true);
            return name;
          },
          signal,
        );
        return write(
          applyBlockoutCommands(current.project, [
            { type: "applyStagePreset", payload: z.json().parse(payload.preset) },
          ]).project,
          current.revision,
          signal,
        );
      }, signal),
  );
  tool(
    "removeBlockoutStagePreset",
    "删除明确选择的布景预设；不删除项目已复制的资源。",
    z.strictObject({ id: z.string() }),
    (args, signal) => run(async (signal) => { await removeStagePreset(args.id, signal, writable); return { removed: true, id: args.id }; }, signal),
  );
  context.onDispose(async () => {
    recordingStart?.abort(new Error("Blockout 插件已停止"));
    recording?.stop();
    operation?.abort(new Error("Blockout 插件已停止"));
    await Promise.allSettled([activeTask, exportTask, recordingTask].filter(Boolean));
  });
  return {
    bindRecording(value: typeof recording) { recording = value; return () => { if (recording === value) recording = undefined; }; },
    read,
    write,
    importModel,
    importScan,
    importReference,
    readModel,
    readScan,
    deliver,
    beforeHistory: cancel,
    beforeDelete: cancel,
    state: () => ({
      busy,
      phase,
      progress,
      error,
      jobId,
      state: jobState,
      executionSettled: !activeTask && !exportTask && !unsettledFailure,
    }),
  };
}
export type BlockoutService = ReturnType<typeof createBlockoutService>;
