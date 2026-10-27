import { z } from "zod";
import type { PluginActivationContext } from "@toonflow/nodes-scaffold/contracts";
import { pluginServices, readNodeData, mediaValueSchema, nodePreconditionError } from "@toonflow/node-shared/reactNode";
import { createReferenceDepthClient } from "@toonflow/node-shared/useReferenceDepth";
import { referenceDepthBindingSchema, referenceDepthSettingsSchema, referenceDepthStatusSchema, referenceDepthResultSchema, referenceDepthModelStatusSchema, referenceDepthPreparationSchema } from "@toonflow/node-shared/referenceDepth";

const pendingSchema = z.strictObject({
  binding: referenceDepthBindingSchema, source: mediaValueSchema, sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  settings: referenceDepthSettingsSchema, fingerprint: z.string(), attempted: z.boolean(),
});
async function digest(bytes: ArrayBuffer) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
}
export function createVideoDepthData() {
  return { label: "视频深度白模", analysisSettings: { start: 0, end: 1, sampleFps: 6 }, outputs: {}, handles: [
    { id: "input", type: "target", dataType: "VIDEO", label: "原视频" },
    { id: "video", type: "source", dataType: "VIDEO", label: "深度参考" },
    { id: "manifest", type: "source", dataType: "FILE", label: "来源与编码" },
  ], historyFields: ["analysisSettings", "outputs", "depthResult"] };
}
export function createVideoDepthService(context: PluginActivationContext) {
  const { id, document, workbench } = pluginServices(context);
  let changing = false;
  async function mutate<T>(action: () => Promise<T>) {
    if (changing) throw new Error("节点正在处理另一项修改，请等待当前调用完成");
    changing = true;
    try { return await action(); } finally { changing = false; }
  }
  const data = () => readNodeData(document, id);
  const settings = () => referenceDepthSettingsSchema.parse(data().analysisSettings ?? { start: 0, end: 1, sampleFps: 6 });
  const pending = () => data().depthPending ? pendingSchema.parse(data().depthPending) : undefined;
  const source = () => {
    const inputs = workbench.getInputs("input");
    const value = inputs[0]?.value;
    if (inputs.length !== 1 || inputs[0]?.dataType !== "VIDEO" || !value || typeof value !== "object" || "controlType" in value) throw nodePreconditionError(workbench, id, "请连接一路原始 RGB 视频，不能把深度视频作为输入");
    const parsed = mediaValueSchema.parse({ url: (value as { url?: unknown }).url, mimeType: (value as { mimeType?: unknown }).mimeType });
    if (!parsed.mimeType.startsWith("video/")) throw nodePreconditionError(workbench, id, "输入不是有效视频");
    return parsed;
  };
  const fingerprint = () => JSON.stringify({ source: source(), settings: settings() });
  const foreignBinding = (binding: z.infer<typeof referenceDepthBindingSchema>) => binding.directory !== workbench.directory || binding.canvasId !== workbench.canvasId || binding.nodeId !== id;
  function client(value?: z.infer<typeof referenceDepthBindingSchema>) {
    const binding = value ?? { operationId: crypto.randomUUID(), directory: workbench.directory, canvasId: workbench.canvasId, nodeId: id };
    if (foreignBinding(binding)) throw new Error("深度任务属于原工程，不能在当前工程查询、取消或冒认原任务");
    return createReferenceDepthClient(binding);
  }
  async function verifyArtifacts(result: z.infer<typeof referenceDepthResultSchema>, signal?: AbortSignal) {
    for (const artifact of [result.manifest, ...result.artifacts]) {
      const bytes = await workbench.files.read(artifact.path, 100 * 1024 ** 2, signal);
      if (bytes.byteLength !== artifact.size || await digest(bytes) !== artifact.sha256) throw new Error("深度产物大小或摘要校验失败，旧输出保留");
    }
    const manifest = referenceDepthResultSchema.parse({ ...await workbench.files.readJson<Record<string, unknown>>(result.manifest.path), manifest: result.manifest });
    if (JSON.stringify(manifest) !== JSON.stringify(result)) throw new Error("深度清单与任务来源不一致");
  }
  async function importedResult(value: z.infer<typeof pendingSchema>) {
    const before = JSON.stringify({ pending: data().depthPending, result: data().depthResult, outputs: data().outputs });
    const result = referenceDepthResultSchema.parse(data().depthResult);
    const outputs = data().outputs as { video?: { value?: { url?: string; controlType?: string } }; manifest?: { value?: { url?: string } } } | undefined;
    const video = result.artifacts.find(artifact => artifact.kind === "depthControl");
    if (!value.attempted || value.binding.nodeId !== id || result.operationId !== value.binding.operationId || result.nodeId !== value.binding.nodeId || result.canvasId !== value.binding.canvasId
      || result.source.path !== value.source.url || result.source.contentSha256 !== value.sourceHash || JSON.stringify(result.settings) !== JSON.stringify(value.settings)
      || value.fingerprint !== JSON.stringify({ source: value.source, settings: value.settings }) || outputs?.video?.value?.url !== video?.path
      || outputs?.video?.value?.controlType !== "depth" || outputs?.manifest?.value?.url !== result.manifest.path) throw new Error("原工程任务没有与当前已采用结果一致的完成证据，保留原操作ID，不能重新派发");
    await verifyArtifacts(result);
    if (before !== JSON.stringify({ pending: data().depthPending, result: data().depthResult, outputs: data().outputs })) throw new Error("验证迁移结果期间节点已变化，请重新读取");
    return result;
  }
  async function savePending(value?: z.infer<typeof pendingSchema>) {
    const previous = pending();
    if (previous?.attempted && foreignBinding(previous.binding)) {
      await importedResult(previous);
      await document.updateRuntimeData({ depthPending: value ?? null, depthTaskOrigin: previous });
    } else await document.updateRuntimeData({ depthPending: value ?? null });
    await document.save();
  }
  const getStatus = async () => {
    const value = pending();
    if (value?.attempted && foreignBinding(value.binding)) {
      try {
        const result = await importedResult(value);
        return { settings: settings(), status: null, result, revision: document.getRevision(), importedOperation: { binding: value.binding, state: "adoptedResult" as const, artifactsVerified: true } };
      } catch (failure) {
        return { settings: settings(), status: { ...value.binding, state: "unknown" as const, executionSettled: false, cancelRequested: false, error: `原工程任务未确认收尾：${failure instanceof Error ? failure.message : String(failure)}` },
          result: data().depthResult ? referenceDepthResultSchema.parse(data().depthResult) : null, revision: document.getRevision(), importedOperation: { binding: value.binding, state: "unresolved" as const, artifactsVerified: false } };
      }
    }
    const status = value?.attempted ? await client(value.binding).status() : null;
    return { settings: settings(), status, result: data().depthResult ? referenceDepthResultSchema.parse(data().depthResult) : null, revision: document.getRevision() };
  };
  const statusOutput = z.strictObject({ settings: referenceDepthSettingsSchema, status: referenceDepthStatusSchema.nullable(), result: referenceDepthResultSchema.nullable(), revision: z.number().int().nonnegative(),
    importedOperation: z.strictObject({ binding: referenceDepthBindingSchema, state: z.enum(["adoptedResult", "unresolved"]), artifactsVerified: z.boolean() }).optional() });
  const readyToChange = async () => {
    workbench.assertWritable();
    const value = pending();
    if (value?.attempted) {
      if (foreignBinding(value.binding)) { await importedResult(value); return; }
      const status = await client(value.binding).status();
      if (!status.executionSettled || status.state === "unknown") throw new Error("原深度任务尚未确认收尾，请查询或取消原操作，不能重新派发");
    }
  };
  const run = async (signal: AbortSignal) => {
    await readyToChange();
    const input = source(), selectedSettings = settings(), expected = fingerprint();
    const bytes = await workbench.files.read(input.url, 256 * 1024 ** 2, signal);
    const sourceHash = await digest(bytes);
    signal.throwIfAborted();
    if (fingerprint() !== expected) throw new Error("输入或范围已变化，未开始推理");
    const value = pendingSchema.parse({ binding: { operationId: crypto.randomUUID(), directory: workbench.directory, canvasId: workbench.canvasId, nodeId: id }, source: input, sourceHash, settings: selectedSettings, fingerprint: expected, attempted: false });
    await savePending(value);
    signal.throwIfAborted();
    await savePending({ ...value, attempted: true });
    try {
      signal.throwIfAborted();
      if (fingerprint() !== expected) { await savePending(value); throw new Error("输入或范围在提交前变化，未运行推理"); }
    } catch (failure) { await savePending(value); throw failure; }
    try {
      return await client(value.binding).start({ sourcePath: input.url, contentSha256: sourceHash, settings: selectedSettings });
    } catch (failure) {
      const known = failure as { responseKnown?: boolean; status?: number };
      if (known.responseKnown && [400, 403, 404, 413, 424, 429].includes(known.status ?? 0) && pending()?.binding.operationId === value.binding.operationId) await savePending(value);
      throw failure;
    }
  };
  const apply = async (signal: AbortSignal) => {
    workbench.assertWritable();
    const value = pending();
    if (!value?.attempted) throw new Error("没有可以采用的深度任务");
    const status = await client(value.binding).status();
    if (status.state !== "succeeded" || !status.executionSettled || !status.result) throw new Error("深度任务尚未成功产出，请保留原操作ID并查询");
    const result = referenceDepthResultSchema.parse(status.result);
    if (result.schemaVersion !== 2 || result.model.id !== "videoDepthAnythingSmall") throw new Error("当前节点仅采用 Video Depth Anything Small 的时序深度结果");
    if (fingerprint() !== value.fingerprint || result.source.contentSha256 !== value.sourceHash) throw new Error("源片或范围已变化，旧结果保留，未覆盖当前输出");
    const sourceHash = await digest(await workbench.files.read(value.source.url, 256 * 1024 ** 2, signal));
    if (sourceHash !== value.sourceHash) throw new Error("源视频文件已变化，未采用旧结果");
    await verifyArtifacts(result, signal);
    signal.throwIfAborted();
    if (fingerprint() !== value.fingerprint) throw new Error("采用期间输入变化，产物保留");
    const video = result.artifacts.find(item => item.kind === "depthControl");
    if (!video) throw new Error("没有真实深度视频产物");
    await document.updateData({ depthResult: result, outputs: {
      video: { dataType: "VIDEO", value: { url: video.path, mimeType: video.mimeType, controlType: "depth" } },
      manifest: { dataType: "FILE", value: { url: result.manifest.path, mimeType: "application/json" } },
    } }, document.getRevision(), signal);
    await document.save();
    return { saved: true as const, result, revision: document.getRevision() };
  };
  context.registerTool({ name: "getDepthModel", description: "读取实际 Video Depth Anything Small 的依赖、权重准备与运行条件，不自动下载。", parameters: z.strictObject({}), outputSchema: referenceDepthModelStatusSchema, annotations: { readOnlyHint: true, openWorldHint: false }, execute: (_args, { signal }) => client().readModelStatus(signal) });
  context.registerTool({ name: "prepareDepthModel", description: "显式准备固定 Small 权重、代码和本地推理依赖；不上传视频、不运行推理。getDepthModel读取真实准备状态。", parameters: z.strictObject({}), outputSchema: referenceDepthPreparationSchema, annotations: { readOnlyHint: false, openWorldHint: true }, execute: () => client().prepareModel() });
  context.registerTool({ name: "cancelDepthModelPreparation", description: "请求停止正在准备的本地 Small 模型；查询准备状态核实收尾。", parameters: z.strictObject({}), outputSchema: referenceDepthPreparationSchema, annotations: { readOnlyHint: false, openWorldHint: false }, execute: () => client().cancelModelPreparation() });
  context.registerTool({ name: "getDepthStatus", description: "读取同一节点的范围、原operationId、真实任务状态与已采用结果；导入工程的已采用结果独立返回原绑定及产物校验，不冒认当前工程任务；unknown不重派。", parameters: z.strictObject({}), outputSchema: statusOutput, annotations: { readOnlyHint: true, openWorldHint: false }, execute: getStatus });
  context.registerTool({ name: "setDepthSettings", description: "设置原视频区间与采样率，不运行推理；使用节点修订防止覆盖。", parameters: referenceDepthSettingsSchema.safeExtend({ expectedRevision: z.number().int().nonnegative() }), outputSchema: z.strictObject({ settings: referenceDepthSettingsSchema, revision: z.number().int().nonnegative() }), annotations: { readOnlyHint: false, openWorldHint: false }, execute(args, { signal }) { return mutate(async () => {
    workbench.assertWritable(args.expectedRevision); await readyToChange();
    const { expectedRevision, ...selected } = args;
    await document.updateData({ analysisSettings: selected }, expectedRevision, signal);
    await savePending();
    return { settings: settings(), revision: document.getRevision() };
  }); } });
  context.registerTool({ name: "runDepth", description: "从一路RGB视频生成时序深度白模，固定源摘要及区间；返回已登记任务。完成后applyDepthResult采用；不会自动重派未知任务。", parameters: z.strictObject({}), outputSchema: referenceDepthStatusSchema, annotations: { readOnlyHint: false, openWorldHint: false }, execute: (_args, { signal }) => mutate(() => run(signal)) });
  context.registerTool({ name: "cancelDepth", description: "只取消当前工程原operationId对应的深度任务并等待确认；unknown保留原ID，导入的外部任务不能借当前工程取消。", parameters: z.strictObject({}), outputSchema: referenceDepthStatusSchema, annotations: { readOnlyHint: false, openWorldHint: false }, execute: async () => { const value = pending(); if (!value?.attempted) throw new Error("没有已派发的深度任务"); return client(value.binding).cancelAndWait(); } });
  context.registerTool({ name: "applyDepthResult", description: "核对成功任务、源SHA和磁盘产物后采用并保存深度参考，手工与Agent共用历史。", parameters: z.strictObject({}), outputSchema: z.strictObject({ saved: z.literal(true), result: referenceDepthResultSchema, revision: z.number().int().nonnegative() }), annotations: { readOnlyHint: false, openWorldHint: false }, execute: (_args, { signal }) => mutate(() => apply(signal)) });
  async function settle() {
    return mutate(async () => {
      const value = pending();
      if (!value?.attempted) return;
      if (foreignBinding(value.binding)) { await savePending(); return; }
      const current = await client(value.binding).status();
      if (current.executionSettled && current.state !== "unknown") return;
      try { await client(value.binding).cancelAndWait(); }
      catch (failure) {
        const state = (failure as { state?: z.infer<typeof referenceDepthStatusSchema> }).state;
        if (!state?.executionSettled || state.state === "unknown" || state.operationId !== value.binding.operationId
          || state.directory !== value.binding.directory || state.canvasId !== value.binding.canvasId || state.nodeId !== id) throw failure;
      }
    });
  }
  return { getStatus, source, beforeHistory: settle, beforeDelete: settle };
}
