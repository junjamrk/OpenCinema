import { z } from "zod";
import type { PluginActivationContext } from "@toonflow/nodes-scaffold/contracts";
import { createMediaAiClient, type NodeMediaModel, type NodeModelParameter, type NodeImageRequest, type NodeVideoRequest, type NodeAudioRequest, type NodeMediaPriceRequest } from "@toonflow/nodes-scaffold/nodeAiClient";
import type { NodeInputValue } from "@toonflow/nodes-scaffold/values";
import { isExecutionUnknown, errorText, mediaValueSchema, pluginServices, readMedia, readNodeData, registerMediaTools, setMedia, type MediaType } from "./reactNode";
import type { NodeWorkbenchService } from "@toonflow/nodes-scaffold/workbenchServices";
import { readReferences, registerReferenceTools } from "./reactReferences";
import { requestNodeHost } from "./reactHostRequest";
import { ToolExecutionError } from "@toonflow/nodes-scaffold/toolErrors";
import { activeVideoReferences, readReferenceRole, readShotBrief, readVideoSources, shotBriefSchema, videoCreativeFingerprint, videoShotPrompt, referenceRoleSchema } from "./videoShot";
import { readMediaSourceRevision } from "./mediaEditor";

const parameterValueSchema = z.union([z.string(), z.number(), z.boolean()]);
const configSchema = z.strictObject({
  providerId: z.string().min(1).optional(), modelId: z.string().min(1).optional(),
  ratio: z.string().max(100).optional(), size: z.string().max(100).optional(), resolution: z.string().max(100).optional(),
  duration: z.number().finite().positive().max(600).optional(), mode: z.union([z.string().max(100), z.array(z.string().max(100)).max(20)]).optional(), generateAudio: z.boolean().optional(),
  voice: z.string().max(200).optional(), speed: z.number().finite().min(.25).max(4).optional(),
  volume: z.number().finite().min(0).max(4).optional(), pitch: z.number().finite().min(-20).max(20).optional(),
  language: z.string().max(100).optional(), format: z.string().max(30).optional(), sampleRate: z.number().int().positive().optional(),
  parameters: z.record(z.string(), parameterValueSchema).optional().describe("模型专属参数，字段按 getConfig 返回的 models[].parameters 填写；传入时整体替换已保存的值"),
}).refine(value => (value.providerId === undefined) === (value.modelId === undefined), "providerId 与 modelId 须同时提供");
const generationStatusSchema = z.strictObject({ nodeId: z.string(), status: z.string(), taskId: z.string().optional(), requestId: z.string().optional(), executionSettled: z.boolean(), error: z.string().optional(), current: mediaValueSchema.optional(), revision: z.number().int().nonnegative(), providerId: z.string().optional(), modelId: z.string().optional(), providerJobId: z.string().optional(), phase: z.string().optional(), progress: z.number().optional(), cancelMode: z.string().optional(), sideEffectMayContinue: z.boolean().optional() });
const configOutputSchema = configSchema.safeExtend({ host: z.boolean() });
const videoConfigSchema = z.strictObject({ providerId: configSchema.shape.providerId, modelId: configSchema.shape.modelId, ratio: configSchema.shape.ratio, resolution: configSchema.shape.resolution, duration: configSchema.shape.duration, mode: configSchema.shape.mode, generateAudio: configSchema.shape.generateAudio, parameters: configSchema.shape.parameters }).refine(value => (value.providerId === undefined) === (value.modelId === undefined), "providerId 与 modelId 须同时提供");
const parameterSchema = z.strictObject({ type: z.enum(["string", "number", "integer", "boolean"]).optional(), title: z.string().optional(), default: parameterValueSchema.optional(), minimum: z.number().optional(), maximum: z.number().optional(), enum: z.array(parameterValueSchema).optional() });
const modelSchema = z.strictObject({ id: z.string().optional().describe("供应商模型目录保留的原始ID；modelId为规范化调用ID"), supportsPrice: z.boolean().optional(), providerId: z.string(), providerLabel: z.string(), modelId: z.string(), label: z.string(), type: z.enum(["image", "video", "audio"]), mode: z.array(z.union([z.string(), z.array(z.string())])).optional(), imageSizes: z.array(z.string()).optional(), imageRatios: z.array(z.string()).optional(), durationResolutionMap: z.array(z.strictObject({ duration: z.array(z.number()), resolution: z.array(z.string()) })).optional(), audio: z.union([z.boolean(), z.literal("optional")]).optional(), voices: z.array(z.strictObject({ title: z.string(), voice: z.string() })).optional(), video: z.strictObject({ inputMap: z.record(z.string(), z.string()).optional(), defaults: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(), stringFields: z.array(z.string()).optional() }).optional(), execution: z.strictObject({ protocol: z.string(), location: z.enum(["local", "remote", "platform"]), cancelMode: z.enum(["none", "request"]) }).optional(), parameters: z.strictObject({ type: z.literal("object"), properties: z.record(z.string(), parameterSchema) }).optional() });

export function getGenerationComposerState(data: Readonly<Record<string, unknown>>) {
  const generation = data.generation;
  const status = generation && typeof generation === "object" && "status" in generation ? String(generation.status) : "";
  const disabledReason = ({
    running: "此节点正在生成，请等待或取消当前任务",
    delegated: "此节点已交给宿主，等待实际产物，请勿重复提交",
    cancelRequested: "正在确认取消，请等待当前任务终止",
    unknown: "当前任务尚未确认终止，请先在节点确认任务状态",
    interrupted: "上次生成已中断，请先在节点确认任务终态",
    resultReady: "原视频任务已完成，请先采用生成结果",
  } as Record<string, string>)[status];
  return { requiresHost: !data.model, ...(disabledReason ? { disabledReason } : {}) };
}

function selectedModel(data: Record<string, unknown>, models: NodeMediaModel[], type: MediaType) {
  return models.find(model => model.type === type && JSON.stringify([model.providerId, model.modelId]) === data.model);
}

export function matchingVideoModes(model: NodeMediaModel, inputs: NodeInputValue[]) {
  const counts = { image: inputs.filter(input => input.dataType === "IMAGE").length, video: inputs.filter(input => input.dataType === "VIDEO").length, audio: inputs.filter(input => input.dataType === "AUDIO").length };
  return (model.mode ?? []).filter(mode => {
    if (Array.isArray(mode)) return counts.image + counts.video + counts.audio > 0 && Object.entries(counts).every(([type, count]) => count <= Number(mode.find(value => value.startsWith(`${type}Reference:`))?.split(":")[1] ?? 0));
    if (mode === "text") return counts.image + counts.video + counts.audio === 0;
    if (counts.video || counts.audio) return false;
    if (mode === "singleImage") return counts.image === 1;
    if (mode === "startEndRequired") return counts.image === 2;
    return ["endFrameOptional", "startFrameOptional"].includes(mode) && counts.image >= 1 && counts.image <= 2;
  });
}

export function parameterIssue(schema: NodeModelParameter, value: unknown) {
  const matches = schema.type === "string" ? typeof value === "string" : schema.type === "boolean" ? typeof value === "boolean" : schema.type === "integer" ? Number.isSafeInteger(value) : schema.type ? Number.isFinite(value) : ["string", "number", "boolean"].includes(typeof value);
  if (!matches) return `须为${schema.type ? { string: "文本", number: "数字", integer: "整数", boolean: "开关值" }[schema.type] : "可选值"}`;
  if (schema.enum && !schema.enum.includes(value as string)) return `须为 ${schema.enum.join("、")} 之一`;
  if (typeof value === "number" && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return `须在 ${schema.minimum ?? "不限"} 至 ${schema.maximum ?? "不限"} 之间`;
  return undefined;
}

// 目录是权威：未声明的字段丢弃，不合法的退回默认值，所以换模型不会把旧模型的值带过去。
export function normalizeParameters(data: Readonly<Record<string, unknown>>, choice: NodeMediaModel) {
  const saved = (data.parameters ?? {}) as NonNullable<NodeImageRequest["parameters"]>;
  return Object.fromEntries(Object.entries(choice.parameters?.properties ?? {}).flatMap(([key, schema]) => {
    const value = saved[key] === undefined || parameterIssue(schema, saved[key]) ? schema.default : saved[key];
    return value === undefined ? [] : [[key, value] as const];
  }));
}

function normalizeConfig(data: Record<string, unknown>, choice: NodeMediaModel, type: MediaType, inputs: NodeInputValue[]): Record<string, unknown> {
  if (choice.parameters || data.parameters) data = { ...data, parameters: normalizeParameters(data, choice) };
  if (type === "image") {
    const sizes = choice.imageSizes?.length ? choice.imageSizes : ["2K"]; const ratios = choice.imageRatios?.length ? choice.imageRatios : ["16:9"];
    return { ...data, size: sizes.includes(String(data.size)) ? data.size : sizes[0], ratio: ratios.includes(String(data.ratio)) ? data.ratio : ratios[0] };
  }
  if (type === "audio") return { ...data, language: data.language ?? "zh-CN", sampleRate: data.sampleRate ?? 24000, format: data.format ?? "wav" };
  const durations = [...new Set(choice.durationResolutionMap?.flatMap(value => value.duration))].sort((a, b) => a - b);
  const duration = durations.includes(Number(data.duration)) ? Number(data.duration) : durations[0];
  const resolutions = [...new Set(choice.durationResolutionMap?.filter(value => value.duration.includes(duration ?? 0)).flatMap(value => value.resolution))].sort((a, b) => (parseFloat(a) || Infinity) - (parseFloat(b) || Infinity));
  const modes = matchingVideoModes(choice, inputs);
  const mode = modes.find(value => JSON.stringify(value) === data.mode) ?? modes.find(Array.isArray) ?? modes[0];
  const declaredRatios = choice.imageRatios?.filter(value => /^\d+:\d+$/.test(value));
  const ratios = declaredRatios?.length ? declaredRatios : ["16:9", "9:16", "1:1", "4:3", "3:4"];
  return { ...data, duration, resolution: resolutions.includes(String(data.resolution)) ? data.resolution : resolutions[0], ratio: ratios.includes(String(data.ratio)) ? data.ratio : ratios[0], mode: mode === undefined ? "" : JSON.stringify(mode), generateAudio: choice.audio === "optional" ? !!data.generateAudio : choice.audio === true };
}

function generationRequest(data: Record<string, unknown>, choice: NodeMediaModel, type: MediaType, inputs: NodeInputValue[], directory: string, id: string) {
  const allInputs = inputs;
  if (type === "video") inputs = activeVideoReferences(data, inputs);
  const normalized = normalizeConfig(data, choice, type, inputs);
  if (type === "image" && inputs.some(input => typeof input.dataType !== "string" || !["STRING", "IMAGE"].includes(input.dataType))) throw new Error("此图片专项模型只接受文本和图片参考；视频或音频理解请交给宿主 Agent");
  if (type === "audio" && inputs.some(input => typeof input.dataType !== "string" || !["STRING", "IMAGE", "AUDIO"].includes(input.dataType))) throw new Error("此音频专项模型只接受文本、图片或音频参考；视频理解请交给宿主 Agent");
  const media = (kind: string) => inputs.flatMap(item => item.dataType === kind && item.value && typeof item.value === "object" && "url" in item.value && "mimeType" in item.value ? [{ path: String(item.value.url), mimeType: String(item.value.mimeType) }] : []);
  if (type === "audio" && media("IMAGE").length + media("AUDIO").length > 1) throw new Error("音频生成最多接受一个图片或音频参考");
  let prompt = type === "video" ? videoShotPrompt(data, allInputs) : [String(data.prompt ?? "").trim(), ...inputs.flatMap((item, index) => item.dataType === "STRING" && typeof item.value === "string" ? [`参考 ${index + 1}：\n${item.value}`] : [])].filter(Boolean).join("\n\n");
  const inpaint = data.inpaint as { source?: string; images?: unknown[] } | undefined;
  if (type === "image" && inpaint) {
    let imageIndex = 3 + (inpaint.images?.length ?? 0);
    const mapping = inputs.flatMap((item, index) => item.dataType === "IMAGE" && item.value ? [`参考 ${index + 1} / {{ref ${index + 1}}} 对应第 ${item.value.url === inpaint.source ? 1 : imageIndex++} 张图`] : []);
    if (mapping.length) prompt += `\n当前节点参考编号对应关系：${mapping.join("；")}。`;
  }
  const allowed = type === "image" ? ["size", "ratio"] : type === "audio" ? ["voice", "speed", "volume", "pitch", "language", "format", "sampleRate"] : ["ratio", "duration", "resolution", "generateAudio"];
  const fields = Object.fromEntries(allowed.filter(key => normalized[key] !== undefined).map(key => [key, normalized[key]]));
  const parameters = normalized.parameters as NodeImageRequest["parameters"];
  const common = { ...fields, ...(parameters && Object.keys(parameters).length ? { parameters } : {}), directory, providerId: choice.providerId, modelId: choice.modelId, prompt, outputDirectory: `assets/${id}` };
  if (type === "image") return { ...common, images: media("IMAGE").filter(image => !inpaint || image.path !== inpaint.source) };
  if (type === "audio") return { ...common, images: media("IMAGE"), audios: media("AUDIO") };
  let mode: NodeVideoRequest["mode"];
  if (type === "video") {
    if (choice.mode?.length && !matchingVideoModes(choice, inputs).length) throw new Error("当前连线参考不满足模型的任何生成模式");
    mode = normalized.mode ? JSON.parse(String(normalized.mode)) : undefined;
  }
  const frameMode = ["startEndRequired", "endFrameOptional", "startFrameOptional"].includes(String(mode)); const images = media("IMAGE");
  const firstFrame = frameMode && (mode !== "startFrameOptional" || images.length > 1) ? images[0] : undefined;
  const lastFrame = frameMode ? images[mode === "startFrameOptional" && images.length === 1 ? 0 : 1] : undefined;
  return { ...common, ...(mode === undefined ? {} : { mode }), ...(frameMode ? {} : { images }), ...(firstFrame ? { firstFrame } : {}), ...(lastFrame ? { lastFrame } : {}), videos: media("VIDEO"), audios: media("AUDIO") };
}

export function registerGenerationTools(context: PluginActivationContext, type: MediaType, transforms?: {
  prompt?(prompt: string, data: Record<string, unknown>): string;
  prepare?(input: Record<string, unknown>, data: Record<string, unknown>): Record<string, unknown>;
  result?(workbench: NodeWorkbenchService, nodeId: string, data: Record<string, unknown>, result: { path: string; mimeType: string }, signal: AbortSignal): Promise<{ path: string; mimeType: string }>;
}) {
  const { id, document, workbench } = pluginServices(context);
  registerReferenceTools(context, "in", type === "video");
  const currentReferences = () => readReferences(workbench, readNodeData(document, id));
  const effectiveReferences = () => type === "video" ? activeVideoReferences(readNodeData(document, id), currentReferences()) : currentReferences();
  async function readReferenceVersions(inputs: NodeInputValue[], signal: AbortSignal) {
    const nodes = workbench.readNodes();
    const paths = [...new Set(inputs.flatMap(input => { const value = mediaValueSchema.safeParse(input.value); return value.success ? [value.data.url] : []; }))];
    return Object.fromEntries(await Promise.all(paths.map(async path => {
      const expected = inputs.filter(input => input.value && typeof input.value === "object" && input.value.url === path).flatMap(input => {
        const snapshot = nodes.find(node => node.id === input.source)?.data?.referenceSnapshot as { path?: unknown; sourceRevision?: unknown } | undefined;
        return snapshot?.path === path && typeof snapshot.sourceRevision === "string" ? [snapshot.sourceRevision] : [];
      });
      if (new Set(expected).size > 1) throw new Error("同一路径的固定参考版本相互冲突，请重新读取并选择参考");
      return [path, (await readMediaSourceRevision(workbench.files, path, expected[0], signal)).revision];
    })));
  }
  async function requireReferenceVersions(versions: Record<string, string> | undefined, signal: AbortSignal) {
    for (const [path, revision] of Object.entries(versions ?? {})) await readMediaSourceRevision(workbench.files, path, revision, signal);
  }
  registerMediaTools(context, type, transforms?.result || type === "video" ? async (value, signal, taskId) => {
    const data = readNodeData(document, id), saved = data.generation as { creativeFingerprint?: string; referenceVersions?: Record<string, string> } | undefined;
    if (type === "video" && taskId && saved?.creativeFingerprint && saved.creativeFingerprint !== videoCreativeFingerprint(data, currentReferences())) throw new Error("生成期间创作指令、镜头计划或参考已变化；未覆盖当前视频，请保留原任务产物并协调后采用");
    if (type === "video" && taskId) await requireReferenceVersions(saved?.referenceVersions, signal);
    if (!transforms?.result) return value;
    const result = await transforms.result(workbench, id, data, { path: value.url, mimeType: value.mimeType }, signal);
    return { url: result.path, mimeType: result.mimeType };
  } : undefined);
  const ai = createMediaAiClient(context.signal);
  let task: { id: string; controller: AbortController; promise: Promise<void>; state: string; error?: string } | undefined;
  function assertIdle() {
    if (task?.state === "running") throw new Error("请先完成或取消生成");
    const saved = readNodeData(document, id).generation as { status?: string } | undefined;
    if (saved?.status === "completed" && task && ["delegated", "unknown"].includes(task.state)) task.state = "completed";
    if (task?.state === "delegated" || saved?.status === "delegated") throw new Error("已交给宿主，等待实际产物，请勿重复提交");
    if (task?.state === "unknown" || saved?.status === "unknown" || (!task && saved?.status === "running")) throw new Error("上次生成任务尚未确认终止，请先取消并确认终态");
    if (task?.state === "resultReady" || saved?.status === "resultReady") throw new Error("原视频任务已完成，请先采用生成结果");
  }
  async function stop() {
    task?.controller.abort(new Error("节点即将变更")); await task?.promise;
    assertIdle();
  }
  const status = () => {
    const data = readNodeData(document, id); const saved = data.generation as { status?: string; error?: string; taskId?: string; requestId?: string } | undefined;
    const state = task?.state === "running" ? "running" : saved?.status === "running" && !task ? "interrupted" : saved?.status ?? task?.state ?? "idle";
    const error = task && saved?.taskId === task.id && saved.status === "completed" ? saved.error : task?.error ?? saved?.error;
    return { nodeId: id, status: state, taskId: saved?.taskId ?? task?.id, requestId: saved?.requestId, executionSettled: ["idle", "completed", "failed", "cancelled", "resultReady"].includes(state), error, current: readMedia(data, type), revision: document.getRevision() };
  };
  context.onDispose(async () => { task?.controller.abort(new Error("节点插件已卸载")); await task?.promise; });
  context.onBeforeChange(stop);

  async function models(signal: AbortSignal) { return (await ai.getMediaModels(signal)).filter(model => model.type === type); }
  context.registerTool({ name: "getConfig", outputSchema: z.strictObject({ config: configOutputSchema, models: z.array(modelSchema) }), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, description: "读取节点专项媒体模型与参数能力，不返回密钥；图片和音频默认交给宿主 Agent。", parameters: z.strictObject({}),
    async execute(_args, { signal }) {
      const available = await models(signal).catch(reason => {
        if (reason instanceof ToolExecutionError) throw reason;
        throw new ToolExecutionError({ code: "modelCatalogUnavailable", message: `模型目录读取失败：${errorText(reason)}`, phase: "transport", executionState: "notDispatched", target: { directory: workbench.directory, canvasId: workbench.canvasId, nodeId: id }, recovery: { action: "readState", message: "读取getAppState确认Go和React provider已连接，再重新读取模型目录；未启动生成", tool: "getAppState" } });
      });
      const data = readNodeData(document, id);
      const choice = selectedModel(data, available, type);
      let mode = data.mode === "" ? undefined : data.mode;
      if (typeof mode === "string" && mode) { try { mode = JSON.parse(mode); } catch { /* 保留旧版原始模式字符串，交由真实配置 Schema 校验。 */ } }
      const config = configOutputSchema.safeParse({ ...Object.fromEntries(Object.keys(configSchema.shape).filter(key => key in data).map(key => [key, data[key]])), providerId: choice?.providerId, modelId: choice?.modelId, mode, parameters: choice?.parameters ? normalizeParameters(data, choice) : undefined, host: !choice });
      if (!config.success) throw new ToolExecutionError({ code: "nodeConfigurationInvalid", message: `保存的节点配置需要协调：${errorText(config.error)}`, phase: "validation", executionState: "notDispatched", target: { directory: workbench.directory, canvasId: workbench.canvasId, nodeId: id }, recovery: { action: "readState", message: "用getCanvasNodes读取保留的原配置，再按setConfig已公布字段明确修正；配置未被覆盖", tool: "getCanvasNodes", args: { canvasId: workbench.canvasId, nodeIds: [id], fields: ["data"], dataKeys: ["model", ...Object.keys(configSchema.shape)] } } });
      const catalog = z.array(modelSchema).safeParse(available);
      if (!catalog.success) throw new ToolExecutionError({ code: "modelCatalogInvalid", message: `模型目录不符合已公布契约：${errorText(catalog.error)}`, phase: "validation", executionState: "notDispatched", target: { nodeId: id }, recovery: { action: "rediscoverTools", message: "复核供应商扩展和模型目录字段后重新发现当前节点工具；未过滤或丢弃原目录字段", tool: "getNodeTools", args: { nodeIds: [id] } } });
      return { config: config.data, models: catalog.data };
    } });
  async function configure(args: z.infer<typeof configSchema>, signal: AbortSignal) {
      const invalid = (message: string): never => { throw new ToolExecutionError({ code: "unsupportedModelParameter", message, phase: "validation", executionState: "notDispatched", target: { nodeId: id }, recovery: { action: "correctInput", message: "按 getConfig 返回的模型能力修正参数；配置和生成均未执行", tool: "node:getConfig" } }); };
      workbench.assertWritable();
      assertIdle();
      const available = await models(signal);
      workbench.assertWritable();
      assertIdle();
      const data = readNodeData(document, id);
      const choice = args.modelId ? available.find(model => model.providerId === args.providerId && model.modelId === args.modelId) : selectedModel(data, available, type);
      if (args.modelId && !choice) invalid("请选择 getConfig 返回的专项模型");
      const fields = args as Record<string, unknown>;
      if (choice) {
        if (type === "video" && args.resolution !== undefined && choice.durationResolutionMap?.length && !choice.durationResolutionMap.some(item => item.resolution.length)) invalid("当前模型不提供分辨率选项");
        const capabilities: [string, unknown][] = [["ratio", choice.imageRatios], ["size", choice.imageSizes], ["resolution", choice.durationResolutionMap?.filter(item => item.duration.includes(args.duration ?? Number(data.duration))).flatMap(item => item.resolution)], ["duration", choice.durationResolutionMap?.flatMap(item => item.duration)]];
        for (const [key, allowed] of capabilities) if (fields[key] !== undefined && Array.isArray(allowed) && allowed.length && !allowed.includes(fields[key])) invalid(`当前模型不支持${key}=${fields[key]}`);
      }
      for (const [key, value] of Object.entries(args.parameters ?? {})) {
        const schema = choice?.parameters?.properties[key];
        const issue = schema ? parameterIssue(schema, value) : "未在当前模型声明";
        if (issue) invalid(`参数 ${schema?.title ?? key} ${issue}`);
      }
      if (args.mode !== undefined && choice && !matchingVideoModes(choice, effectiveReferences()).some(mode => JSON.stringify(mode) === JSON.stringify(args.mode))) invalid("所选模式不匹配当前连线参考");
      if (args.generateAudio !== undefined && choice?.audio !== "optional" && args.generateAudio !== (choice?.audio === true)) invalid("当前模型不支持切换生成声音");
      const changes: Record<string, unknown> = { ...data, ...fields, ...(args.mode === undefined ? {} : { mode: JSON.stringify(args.mode) }), ...(choice ? { model: JSON.stringify([choice.providerId, choice.modelId]) } : {}) };
      const normalized = choice ? normalizeConfig(changes, choice, type, effectiveReferences()) : changes;
      const configuration = Object.fromEntries(["model", ...Object.keys(configSchema.shape)].filter(key => normalized[key] !== undefined).map(key => [key, normalized[key]]));
      await workbench.updateData(configuration, document.getRevision(), signal);
      await document.save();
      return { configured: true, revision: document.getRevision() };
  }
  context.registerTool({ name: "setConfig", outputSchema: z.strictObject({ configured: z.boolean(), revision: z.number().int().nonnegative() }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, description: "修改节点专项媒体模型与参数；不发送生成请求。", parameters: type === "video" ? videoConfigSchema : configSchema, execute: (args, { signal }) => configure(args, signal) });
  context.registerTool({ name: "useHost", outputSchema: z.strictObject({ host: z.boolean() }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, description: "让此节点交给启动工作台的宿主 Agent 生成，不设置平台通用模型。", parameters: z.strictObject({}),
    async execute(_args, { signal }) { assertIdle(); await workbench.updateData({ model: "" }, undefined, signal); await document.save(); return { host: true }; } });
  context.registerTool({ name: "setPrompt", outputSchema: z.strictObject({ prompt: z.string() }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, description: "保存生成提示词，支持 {{ref 1}} 等连线引用；不会启动生成。", parameters: z.strictObject({ prompt: z.string().max(100000) }),
    async execute(args, { signal }) { await workbench.updateData({ prompt: args.prompt, promptModel: args.prompt.split("\n").map(text => [{ type: "Write", text }]) }, undefined, signal); await document.save(); return { prompt: args.prompt }; } });
  if (type === "video") {
    context.registerTool({ name: "getShotBrief", description: "读取此镜独立创作计划。subjectDirection描述相对地面和车身的运动，screenDirection描述画面方向，cameraMotion单独描述摄影机；这些是创作指令，不是模型硬控制。", parameters: z.strictObject({}), outputSchema: z.strictObject({ brief: shotBriefSchema.nullable() }), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, execute: () => ({ brief: readShotBrief(readNodeData(document, id)) }) });
    context.registerTool({ name: "setShotBrief", description: "完整保存或清除此镜创作计划，不生成。建议一次镜头只有一个主要动作；continuousShot默认true明确要求不自发切镜。旧提示词和连线不自动丢弃，请显式用setReferenceRoles排除无关全片指令。", parameters: z.strictObject({ brief: shotBriefSchema.nullable() }), outputSchema: z.strictObject({ brief: shotBriefSchema.nullable() }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async execute(args, { signal }) {
      workbench.assertWritable();
      await workbench.updateData({ shotBrief: args.brief }, document.getRevision(), signal); await document.save();
      return { brief: readShotBrief(readNodeData(document, id)) };
    } });
    context.registerTool({ name: "getGenerationPlan", description: "不付费预览下一次真正有效的生成请求：完整最终prompt、字符数、模型实际目录参数、每条参考职责与是否送入、软控制边界。与专项模型/宿主调用共用提示词与参考过滤。旧内容不自动删除；身份/构图/运动角色只转成提示词，不伪装供应商控制参数。", parameters: z.strictObject({}), outputSchema: z.strictObject({
      prompt: z.string(), characterCount: z.number().int().nonnegative(), documentRevision: z.number().int().nonnegative(), host: z.boolean(), providerId: z.string().optional(), modelId: z.string().optional(), brief: shotBriefSchema.nullable(),
      parameters: z.record(z.string(), z.unknown()), generationModes: z.array(z.union([z.string(), z.array(z.string())])), videoReferenceControl: z.enum(["softReference", "notDeclared"]), depthControl: z.literal("notDeclared"),
      references: z.array(z.strictObject({ source: z.string(), sourceHandle: z.string(), index: z.number().int().positive(), dataType: z.union([z.string(), z.array(z.string())]), role: referenceRoleSchema, active: z.boolean(), available: z.boolean(), mediaIndex: z.number().int().positive().optional(), path: z.string().optional(), mimeType: z.string().optional(), sourceRevision: z.string().optional(), requestSlot: z.enum(["firstFrame", "lastFrame", "images", "videos", "audios", "references"]).optional(), requestIndex: z.number().int().positive().optional(), providerRole: z.string().optional() })), warnings: z.array(z.string()),
    }), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }, async execute(_args, { signal }) {
      const data = readNodeData(document, id), inputs = currentReferences(), documentRevision = document.getRevision();
      const choice = data.model ? selectedModel(data, await models(signal), type) : undefined;
      if (data.model && !choice) throw new Error("配置的专项模型当前不可用，请重新选择");
      const input = choice ? generationRequest(data, choice, type, inputs, workbench.directory, id) : { prompt: videoShotPrompt(data, inputs) };
      const prompt = input.prompt;
      const characterCount = Array.from(prompt).length;
      const active = activeVideoReferences(data, inputs);
      const versions = await readReferenceVersions(active, signal), counts: Record<string, number> = {};
      if (document.getRevision() !== documentRevision || videoCreativeFingerprint(data, inputs) !== videoCreativeFingerprint(readNodeData(document, id), currentReferences())) throw new Error("请求预览期间镜头、参考或配置已变化，请重新读取实际计划");
      const frameMode = ["startEndRequired", "endFrameOptional", "startFrameOptional"].includes(String((input as Record<string, unknown>).mode));
      const warnings = [
        !readShotBrief(data) && "未设置独立镜头计划；当前仍会使用原提示词和全部未排除的连线文本。",
        choice?.providerId === "ark" && characterCount > 500 && "实际提示词超过500字符。方舟建议中文提示词不超过500字；当前计数也包含英文和标点，仅作输入过载提示，不会自动截断。请检查全片文本是否带入本镜无关动作。",
        frameMode && active.some(value => readReferenceRole(data, value) === "identity") && "首帧／首尾帧模式会沿用图片构图；主体身份职责只是文字要求，不能让首帧图片只影响外观。",
        active.some(value => value.dataType === "VIDEO") && "当前视频仅作普通视觉参考，未声明专用Depth Control或精确运动锁定；必须对照原参考审片。",
        active.some(value => value.value === undefined) && "有效参考中存在暂无内容的节点，生成前须补齐。",
      ].filter((value): value is string => !!value);
      return { prompt, characterCount, documentRevision, host: !choice, providerId: choice?.providerId, modelId: choice?.modelId, brief: readShotBrief(data), parameters: Object.fromEntries(["ratio", "duration", "resolution", "generateAudio", "mode", "parameters"].filter(key => key in input).map(key => [key, (input as Record<string, unknown>)[key]])), generationModes: choice?.mode ?? [], videoReferenceControl: choice?.providerId === "ark" ? "softReference" as const : "notDeclared" as const, depthControl: "notDeclared" as const, references: inputs.map((value, index) => {
        const media = mediaValueSchema.safeParse(value.value), role = readReferenceRole(data, value);
        const isActive = role !== "exclude";
        if (isActive && media.success) counts[String(value.dataType)] = (counts[String(value.dataType)] ?? 0) + 1;
        const mediaIndex = counts[String(value.dataType)];
        let requestSlot: "firstFrame" | "lastFrame" | "images" | "videos" | "audios" | "references" | undefined;
        if (isActive && media.success) {
          if (!choice) requestSlot = "references";
          else if (value.dataType === "IMAGE") requestSlot = frameMode ? "firstFrame" in input && mediaIndex === 1 ? "firstFrame" : "lastFrame" : "images";
          else if (value.dataType === "VIDEO") requestSlot = "videos";
          else if (value.dataType === "AUDIO") requestSlot = "audios";
        }
        const requestIndex = requestSlot === "firstFrame" || requestSlot === "lastFrame" ? 1 : requestSlot === "references" ? active.indexOf(value) + 1 : mediaIndex;
        let providerRole: string | undefined;
        if (choice?.providerId === "ark" && requestSlot) {
          providerRole = ({ firstFrame: "first_frame", lastFrame: "last_frame", videos: "reference_video", audios: "reference_audio" } as Record<string, string>)[requestSlot];
          if (requestSlot === "images") providerRole = !Array.isArray((input as Record<string, unknown>).mode) && active.filter(item => item.dataType === "IMAGE").length === 1 && !active.some(item => item.dataType === "VIDEO") ? "first_frame" : "reference_image";
        }
        return { source: value.source, sourceHandle: value.sourceHandle, index: index + 1, dataType: value.dataType, role, active: isActive, available: value.value !== undefined, ...(media.success ? { path: media.data.url, mimeType: media.data.mimeType, ...(isActive ? { mediaIndex, sourceRevision: versions[media.data.url] } : {}) } : {}), ...(requestSlot ? { requestSlot, requestIndex, ...(providerRole ? { providerRole } : {}) } : {}) };
      }), warnings };
    } });

  }
  async function remoteStatus(signal: AbortSignal) {
    const current = status();
    const data = readNodeData(document, id);
    if (type !== "video" || !data.model || !current.taskId || !["running", "interrupted", "unknown", "cancelRequested", "resultReady", "failed"].includes(current.status)) return current;
    if (current.status === "failed" && (data.generation as { model?: unknown } | undefined)?.model !== data.model) return current;
    const observedTask = task;
    const generation = JSON.stringify(data.generation);
    const output = JSON.stringify(readMedia(data, type) ?? null);
    const remote = await ai.getMediaTask(workbench.directory, current.taskId, signal);
    signal.throwIfAborted();
    const latest = readNodeData(document, id);
    const saved = latest.generation as { taskId?: string; model?: unknown; originalOutput?: string } | undefined;
    if (task !== observedTask || saved?.taskId !== current.taskId || JSON.stringify(latest.generation) !== generation || latest.model !== data.model || JSON.stringify(readMedia(latest, type) ?? null) !== output) return status();
    // ACT: 后端状态读取会恢复原产物下载；失败后的回收保持显式检查，避免持续失败时自动轮询反复重开下载。
    if (current.status === "failed" && (!remote.providerJobId || remote.status !== "completed")) return { ...current, providerId: remote.providerId, modelId: remote.modelId, providerJobId: remote.providerJobId, phase: remote.phase, progress: remote.progress, cancelMode: remote.cancelMode, sideEffectMayContinue: remote.sideEffectMayContinue };
    if (task?.state !== "running" && current.status !== remote.status && remote.executionSettled && !remote.sideEffectMayContinue && ["failed", "cancelled"].includes(remote.status) && saved.model === latest.model && saved.originalOutput === output) {
      workbench.assertWritable();
      const { error: _error, ...previous } = latest.generation as Record<string, unknown>;
      await workbench.updateRuntimeData({ generation: { ...previous, status: remote.status, ...(remote.status === "failed" && remote.result?.message ? { error: remote.result.message } : {}), finishedAt: new Date().toISOString() } }, signal);
      if (task?.id === current.taskId) { task.state = remote.status; task.error = remote.status === "failed" ? remote.result?.message : undefined; }
      await document.save();
      if (status().taskId !== current.taskId) return status();
    }
    const latestStatus = status();
    const ready = remote.status === "completed" && task?.state !== "running";
    return { ...latestStatus, status: ready ? "resultReady" : task?.state === "running" ? latestStatus.status : remote.status, executionSettled: remote.executionSettled, error: current.status === "failed" ? latestStatus.error ?? remote.result?.message : remote.result?.code !== 200 ? remote.result?.message : latestStatus.error, providerId: remote.providerId, modelId: remote.modelId, providerJobId: remote.providerJobId, phase: remote.phase, progress: remote.progress, cancelMode: remote.cancelMode, sideEffectMayContinue: remote.sideEffectMayContinue };
  }
  context.registerTool({ name: "getGenerationStatus", outputSchema: generationStatusSchema, annotations: { readOnlyHint: type !== "video", destructiveHint: false, idempotentHint: true, openWorldHint: type === "video" }, description: "读取真实生成任务、远端任务 ID、进度和当前输出。视频断线后仅恢复原任务观察和产物回收，不再次生成；resultReady 时用 applyGenerationResult 采用。delegated 尚无产物。", parameters: z.strictObject({}), execute: (_args, { signal }) => remoteStatus(signal) });
  if (type === "video") context.registerTool({ name: "applyGenerationResult", outputSchema: generationStatusSchema, parameters: z.strictObject({}), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, description: "采用断线期间已完成的原视频任务产物；核对原模型、参考和当前输出，复用统一节点保存与历史。不会重新生成。", async execute(_args, { signal }) {
    workbench.assertWritable();
    if (task?.state === "running") throw new Error("当前生成仍在观察并自动采用，请等待");
    const data = readNodeData(document, id);
    const saved = data.generation as { taskId?: string; status?: string; inputFingerprint?: string; creativeFingerprint?: string; referenceVersions?: Record<string, string>; originalOutput?: string; model?: unknown } | undefined;
    if (!saved?.taskId || !data.model) throw new Error("此节点没有可恢复的视频任务");
    const observedTask = task;
    const generation = JSON.stringify(data.generation);
    const references = JSON.stringify(currentReferences());
    const output = JSON.stringify(readMedia(data, type) ?? null);
    const remote = await ai.getMediaTask(workbench.directory, saved.taskId, signal);
    signal.throwIfAborted();
    const latest = readNodeData(document, id);
    const latestSaved = latest.generation as typeof saved;
    if (task !== observedTask || latestSaved?.taskId !== saved.taskId || JSON.stringify(latest.generation) !== generation || latest.model !== data.model || JSON.stringify(currentReferences()) !== references || JSON.stringify(readMedia(latest, type) ?? null) !== output) throw new Error("查询期间节点任务、模型、参考或输出已变化；原产物保留，未覆盖当前结果");
    const result = remote.result?.code === 200 ? remote.result.data?.[0] : undefined;
    if (remote.status !== "completed" || !remote.executionSettled || remote.sideEffectMayContinue || !result) throw new Error("原任务尚未确认完成并产生可采用的视频");
    if (saved.status === "completed" && readMedia(latest, type)?.url === result.path) return status();
    if (saved.model !== latest.model || saved.inputFingerprint !== references || saved.creativeFingerprint && saved.creativeFingerprint !== videoCreativeFingerprint(latest, currentReferences()) || saved.originalOutput !== output) throw new Error("节点提示词、镜头计划、模型、参考或输出已变化；原产物保留在工程中，未覆盖当前结果");
    await requireReferenceVersions(saved.referenceVersions, signal);
    await setMedia(context, type, { url: result.path, mimeType: result.mimeType }, signal, document.getRevision(), saved.taskId);
    if (task?.id === saved.taskId) task.state = "completed";
    return status();
  } });
  context.registerTool({ name: "getPrice", outputSchema: z.union([z.null(), z.strictObject({ price: z.null(), host: z.boolean() }), z.strictObject({ price: z.null(), supported: z.boolean() }), z.strictObject({ price: z.string(), tips: z.string() })]), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }, description: "读取当前专项媒体模型的实际价格报价；不提交生成。宿主执行的费用由宿主负责。", parameters: z.strictObject({}),
    async execute(_args, { signal }) {
      const data = readNodeData(document, id); const choice = selectedModel(data, await models(signal), type);
      if (!choice) return { price: null, host: true };
      if (!choice.supportsPrice) return { price: null, supported: false };
      const prompt = String(data.prompt ?? "").trim();
      const request = generationRequest({ ...data, prompt: transforms?.prompt ? transforms.prompt(prompt, data) : prompt }, choice, type, currentReferences(), workbench.directory, id);
      const input = transforms?.prepare ? transforms.prepare(request, data) : request;
      return ai.getMediaPrice({ ...input, mediaType: type } as NodeMediaPriceRequest, signal);
    } });
  context.registerTool({ name: "cancelGeneration", outputSchema: generationStatusSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }, description: "取消此节点正在执行的生成请求；保留已有结果。", parameters: z.strictObject({}),
    async execute() {
      task?.controller.abort(new Error("用户取消生成")); await task?.promise;
      const data = readNodeData(document, id); const saved = data.generation as { taskId?: string; status?: string } | undefined;
      if (saved?.status === "delegated" && !data.model) {
        if (task) task.state = "unknown";
        await workbench.updateRuntimeData({ generation: { ...saved, status: "unknown", error: "宿主已受理请求，但当前适配器未确认远端终止；保留原任务，等待实际产物或宿主终态。" } });
        await document.save();
      }
      if (saved?.taskId && data.model && ["unknown", "running"].includes(saved.status ?? "")) {
        const observedTask = task;
        const generation = JSON.stringify(data.generation);
        const output = JSON.stringify(readMedia(data, type) ?? null);
        const settled = await ai.cancelMediaTask(workbench.directory, saved.taskId);
        const latest = readNodeData(document, id);
        if (task !== observedTask || JSON.stringify(latest.generation) !== generation || latest.model !== data.model || JSON.stringify(readMedia(latest, type) ?? null) !== output) return status();
        workbench.assertWritable();
        const state = type === "video" && settled.status === "completed" ? "resultReady" : settled.status;
        if (task?.id === saved.taskId) { task.state = state; task.error = undefined; }
        const { error: _error, ...previous } = latest.generation as Record<string, unknown>;
        await workbench.updateRuntimeData({ generation: { ...previous, status: state, finishedAt: new Date().toISOString() } });
        await document.save();
      }
      return status();
    } });
  const name = `generate${type[0]!.toUpperCase()}${type.slice(1)}`;
  context.registerTool({ name, description: `统一启动${type}生成并立即返回任务标识。视频可在同次调用提供providerId、modelId及模型参数，也可沿用setConfig。用getConfig发现能力，getGenerationStatus查询、cancelGeneration请求取消；受理与实际产物分开报告。`, parameters: type === "video" ? videoConfigSchema.safeExtend({ prompt: z.string().max(100000).optional() }) : z.strictObject({ prompt: z.string().max(100000).optional() }), outputSchema: z.strictObject({ taskId: z.string(), status: z.string() }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async execute(args, { signal }) {
      workbench.assertWritable(); signal.throwIfAborted();
      assertIdle();
      if (type === "video") {
        const { prompt: _prompt, ...fields } = args;
        if (Object.keys(fields).length) await configure(fields, signal);
      }
      const initial: Record<string, unknown> = { ...readNodeData(document, id), ...(args.prompt !== undefined ? { prompt: args.prompt } : {}) };
      const prompt = typeof initial.prompt === "string" ? initial.prompt.trim() : "";
      const generationPrompt = transforms?.prompt ? transforms.prompt(prompt, initial) : prompt;
      const inputs = currentReferences();
      const activeInputs = type === "video" ? activeVideoReferences(initial, inputs) : inputs;
      if (!prompt && !activeInputs.some(input => input.dataType === "STRING" && typeof input.value === "string" && input.value.trim()) && !(type === "video" && readShotBrief(initial)?.action.trim())) throw new Error("请输入生成提示词、镜头动作或连接文本参考");
      if (activeInputs.some(input => input.value === undefined)) throw new Error("参考节点暂无内容，请先补充引用内容");
      const references = activeInputs.map(input => structuredClone(input));
      const inputFingerprint = JSON.stringify(inputs);
      const creativeFingerprint = type === "video" ? videoCreativeFingerprint(initial, inputs) : undefined;
      const referenceVersions = type === "video" ? await readReferenceVersions(activeInputs, signal) : undefined;
      if (type === "video" && creativeFingerprint !== videoCreativeFingerprint({ ...readNodeData(document, id), ...(args.prompt !== undefined ? { prompt: args.prompt } : {}) }, currentReferences())) throw new Error("准备期间创作计划或参考已变化，未提交生成，请重新读取");
      const originalOutput = JSON.stringify(readMedia(initial, type) ?? null);
      const controller = new AbortController();
      const combined = AbortSignal.any([context.signal, controller.signal]);
      const operation = { id: crypto.randomUUID(), controller, promise: Promise.resolve(), state: "running", error: undefined as string | undefined };
      task = operation;
      try {
        if (args.prompt !== undefined || type === "video") await workbench.updateData({ ...(args.prompt === undefined ? {} : { prompt: args.prompt, promptModel: args.prompt.split("\n").map(text => [{ type: "Write", text }]) }), ...(type === "video" ? { videoSourceHistory: readVideoSources(initial) } : {}) }, undefined, signal);
        combined.throwIfAborted();
        await workbench.updateRuntimeData({ generation: { taskId: operation.id, status: "running", startedAt: new Date().toISOString(), inputFingerprint, ...(creativeFingerprint ? { creativeFingerprint, referenceVersions } : {}), originalOutput, model: String(initial.model ?? "") } }, signal);
        await document.save();
      }
      catch (error) { task = undefined; throw error; }
      operation.promise = (async () => {
        try {
          let result: { path: string; mimeType: string } | undefined;
          if (!initial.model) {
            const inpaint = initial.inpaint as { original?: string; guide?: string } | undefined;
            const imageReferences = inpaint ? [inpaint.original, inpaint.guide].filter(Boolean).map(url => ({ dataType: "IMAGE", value: { url, mimeType: "image/png" } })) : [];
            // 模型参数只对专项模型有效，换成宿主后保留的旧值不进创作参数。
            const config = Object.fromEntries(Object.keys(configSchema.shape).filter(key => key !== "parameters" && initial[key] !== undefined).map(key => [key, initial[key]]));
            const effectivePrompt = type === "video" ? videoShotPrompt({ ...initial, prompt: generationPrompt }, inputs) : generationPrompt;
            if (type === "video") { await workbench.updateRuntimeData({ generation: { ...(readNodeData(document, id).generation as object), request: { prompt: effectivePrompt, references, config, brief: readShotBrief(initial), referenceRoles: initial.referenceRoles ?? {} } } }, combined); await document.save(); }
            if (type === "video") await requireReferenceVersions(referenceVersions, combined);
            const response = await requestNodeHost(workbench, id, { kind: "edit", prompt: `请为节点 ${id} 生成${type === "image" ? "图片" : type === "audio" ? "音频" : "视频"}。\n${inpaint ? "这是局部重绘：前两张参考为原图和红色选区引导，只修改红色选区并输出完整图片。\n" : ""}${effectivePrompt}\n创作参数：${JSON.stringify(config)}。\n请使用你的媒体能力，并用此节点的 set${type[0]!.toUpperCase()}${type.slice(1)} 工具写入工作区产物，并携带taskId ${operation.id} 确认这项任务已实际完成。不要仅返回描述，不要将受理声明为完成。`, references: [...imageReferences, ...references], metadata: { nodeId: id, mediaType: type, taskId: operation.id, config } }, combined);
            combined.throwIfAborted();
            const latest = readNodeData(document, id); const receipt = latest.generation as { taskId?: string; status?: string } | undefined;
            operation.state = receipt?.taskId === operation.id && receipt.status === "completed" || response.status === "completed" && JSON.stringify(readMedia(latest, type) ?? null) !== originalOutput ? "completed" : "delegated";
          } else {
            const available = await models(combined);
            const choice = selectedModel(initial, available, type);
            if (!choice) throw new Error("配置的专项模型当前不可用，请重新选择");
            const rawInput = generationRequest({ ...initial, prompt: generationPrompt }, choice, type, inputs, workbench.directory, id);
            const input = transforms?.prepare ? transforms.prepare(rawInput, initial) : rawInput;
            if (type === "video") { await workbench.updateRuntimeData({ generation: { ...(readNodeData(document, id).generation as object), request: { ...input, brief: readShotBrief(initial), referenceRoles: initial.referenceRoles ?? {} } } }, combined); await document.save(); }
            workbench.assertWritable(); combined.throwIfAborted();
            if (type === "video") await requireReferenceVersions(referenceVersions, combined);
            const results = type === "image" ? await ai.generateImage(input as NodeImageRequest, combined, operation.id) : type === "video" ? await ai.generateVideo(input as NodeVideoRequest, combined, operation.id) : await ai.generateAudio(input as NodeAudioRequest, combined, operation.id);
            result = results[0];
            if (!result) throw new Error("专项模型未返回媒体产物");
            if (transforms?.result) result = await transforms.result(workbench, id, initial, result, combined);
            combined.throwIfAborted();
            if (inputFingerprint !== JSON.stringify(currentReferences()) || creativeFingerprint && creativeFingerprint !== videoCreativeFingerprint(readNodeData(document, id), currentReferences()) || JSON.stringify(readMedia(readNodeData(document, id), type) ?? null) !== originalOutput) throw new Error("节点提示词、镜头计划、参考或结果已变化，本次产物保留在历史目录，未覆盖当前结果");
            if (type === "video") await requireReferenceVersions(referenceVersions, combined);
            await setMedia(context, type, { url: result.path, mimeType: result.mimeType }, combined, undefined, operation.id);
            operation.state = "completed";
          }
        } catch (error) {
          operation.state = isExecutionUnknown(error) ? "unknown" : combined.aborted ? "cancelled" : "failed";
          operation.error = operation.state === "cancelled" ? undefined : errorText(error);
        } finally {
          if (!context.signal.aborted) {
            const saved = readNodeData(document, id).generation;
            const { error: _error, ...previous } = saved && typeof saved === "object" ? saved as Record<string, unknown> : {};
            await workbench.updateRuntimeData({ generation: { ...previous, taskId: operation.id, status: operation.state, ...(operation.error ? { error: operation.error } : {}), finishedAt: new Date().toISOString() } }).then(() => document.save()).catch(error => { operation.error = `${operation.error ? `${operation.error}；` : ""}任务状态保存失败：${errorText(error)}`; });
          }
        }
      })();
      return { taskId: operation.id, status: "running" };
    } });
}
