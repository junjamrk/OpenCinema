import { z } from "zod";
import type { PluginActivationContext } from "@toonflow/nodes-scaffold/contracts";
import type { NodeDocumentService } from "@toonflow/nodes-scaffold/react";
import type { NodeWorkbenchService } from "@toonflow/nodes-scaffold/workbenchServices";
import { uploadNodeFile } from "@toonflow/nodes-scaffold/nodeFiles";
import type { NodeMediaValue } from "@toonflow/nodes-scaffold/values";
import { mediaValueSchema, nodePreconditionError } from "@toonflow/node-shared/reactNode";
import { productionPlanSchema, type ProductionPlan } from "@toonflow/node-shared/motionProduction";
import {
  referenceDepthBindingSchema,
  referenceDepthStatusSchema,
  type ReferenceDepthBinding,
  type ReferenceDepthResult,
  type ReferenceDepthStatus,
} from "@toonflow/node-shared/referenceDepth";
import { createReferenceDepthClient } from "@toonflow/node-shared/useReferenceDepth";
import engineDefinition, { analysisSettingsSchema, type AnalysisSettings } from "./reactEngine";
import { createMotionResources } from "./reactResources";
import { fileSha256, readMotionDepth, validateMotionDepth } from "./motion/depthResult";
import { motionReportSchema } from "./motion/exportMotion";
import { motionView, motionViewSchema, motionPlanDraftSchema, motionSettingsDraftSchema, readProductionPlan } from "./editorView";

export type MotionPreviewBinding = {
  read(): { ready: boolean; reportPath: string; duration: number; sourceStart: number; paused: boolean; error: string };
  apply(value: { time?: number; playing?: boolean }, signal: AbortSignal): Promise<void>;
};

type DepthPending = {
  binding: ReferenceDepthBinding;
  source: NodeMediaValue;
  settings: AnalysisSettings;
  analysisInput: string;
  contentSha256: string;
  attempted: boolean;
  registered: boolean;
  settled: boolean;
  reportPath?: string;
  summary?: string;
  finalReportPath?: string;
  saveConfirmed?: boolean;
  outcome?: string;
};
export function createMotionService(context: PluginActivationContext) {
  const document = context.getService<NodeDocumentService>("document"),
    workbench = context.getService<NodeWorkbenchService>("workbench"),
    id = context.nodeId!,
    files = workbench.files;
  const engine = engineDefinition.activate({
    signal: context.signal,
    getFiles: () => files,
    resources: createMotionResources(context.signal),
  }).service;
  const pluginState = context.getService<Map<string, unknown>>("state");
  const view = motionView(workbench);
  let preview: MotionPreviewBinding | undefined;
  const unsettledKey = `motion:${workbench.canvasId}:${id}:unsettledExport`;
  const draftKey = `motion:${workbench.canvasId}:${id}:localDraft`;
  const pendingKey = `motion:${workbench.canvasId}:${id}:depthOperation`;
  const baselineSchema = z.strictObject({ persisted: z.string(), local: z.string() });
  const draftSchema = z.strictObject({ settings: motionSettingsDraftSchema, plan: motionPlanDraftSchema, settingsBaseline: baselineSchema, planBaseline: baselineSchema });
  let draftRevision = 0;
  const draftListeners = new Set<() => void>();
  const getDraft = () => pluginState.get(draftKey) as z.output<typeof draftSchema> | undefined;
  function setDraft(value: unknown) {
    context.signal.throwIfAborted();
    const next = value ? draftSchema.parse(value) : undefined;
    if (JSON.stringify(getDraft()) === JSON.stringify(next)) return;
    if (next) pluginState.set(draftKey, structuredClone(next)); else pluginState.delete(draftKey);
    draftRevision++;
    for (const listener of draftListeners) listener();
  }
  let controller: AbortController | undefined,
    task: Promise<unknown> | undefined,
    jobId = "",
    state = "idle",
    progress = 0,
    error = "",
    result: unknown,
    depthStatus: ReferenceDepthStatus | undefined,
    exportFailure = pluginState.get(unsettledKey) as Error | undefined;
  const data = () => (document.readNode(id) as { data?: Record<string, any> }).data ?? {};
  const settings = () =>
    analysisSettingsSchema.parse(data().analysisSettings ?? { start: 0, end: 1, sampleFps: 6 });
  function reference() {
    const values = workbench.getInputs("input");
    if (values.length !== 1 || values[0]?.dataType !== "VIDEO")
      throw nodePreconditionError(workbench, id, "请连接一路有效的视频参考", values.length > 1 ? "mediaSourceAmbiguous" : "mediaSourceRequired");
    const source = values[0]!.value as NodeMediaValue & { controlType?: string };
    const parsed = mediaValueSchema.safeParse({ url: source?.url, mimeType: source?.mimeType });
    if (!parsed.success || !parsed.data.mimeType.startsWith("video/") || source.controlType)
      throw nodePreconditionError(workbench, id, "Motion 需要真实 RGB 视频参考，不能把Pose/Depth控制板作为源片");
    return parsed.data;
  }
  const fingerprint = () => JSON.stringify({ reference: reference(), settings: settings() });
  const pending = () => {
    const value = pluginState.get(pendingKey) as DepthPending | undefined;
    if (value) return value;
    const stored = data().motionDepthPending as DepthPending | undefined;
    if (stored) pluginState.set(pendingKey, structuredClone(stored));
    return stored;
  };
  function check(expected?: string) {
    workbench.assertWritable();
    context.signal.throwIfAborted();
    if (expected && fingerprint() !== expected)
      throw new Error("输入或分析设置已变化，原草稿与产物保留");
  }
  async function update(patch: Record<string, unknown>, signal?: AbortSignal) {
    check();
    await document.updateData(patch, document.getRevision(), signal);
    await document.save();
  }
  async function storePending(value: DepthPending) {
    const snapshot = JSON.parse(JSON.stringify(value)) as DepthPending;
    pluginState.set(pendingKey, snapshot);
    await document.updateRuntimeData({ motionDepthPending: snapshot });
    await document.save();
  }
  function client(value: DepthPending | ReferenceDepthBinding, signal?: AbortSignal) {
    const binding = "binding" in value ? value.binding : value;
    if (
      binding.directory !== workbench.directory ||
      binding.canvasId !== workbench.canvasId ||
      binding.nodeId !== id
    )
      throw new Error("Depth 记录不属于当前画布与节点");
    return createReferenceDepthClient(binding, { signal, check: () => check() });
  }
  async function completeDepth(
    value: DepthPending,
    depth: ReferenceDepthResult,
    signal: AbortSignal,
  ) {
    check(value.analysisInput);
    signal.throwIfAborted();
    if (!value.reportPath) throw new Error("Depth Camera/Pose 原稿不存在");
    const original = await files.readJson<Record<string, any>>(value.reportPath),
      report = motionReportSchema.parse(original),
      content = await readMotionDepth(files, depth, signal);
    validateMotionDepth(content, report.source, report.settings);
    if (
      report.source.url !== value.source.url ||
      report.source.contentSha256 !== value.contentSha256 ||
      (await fileSha256(await files.read(value.source.url, 256 * 1024 ** 2, signal))) !==
        value.contentSha256
    )
      throw new Error("Depth 与原视频摘要不一致，未发布新结果");
    const merged = {
      ...original,
      settings: { ...original.settings, depth: true },
      depth: content,
      models: { ...original.models, depth: { provenance: depth.model, runtime: depth.runtime } },
    };
    motionReportSchema.parse(merged);
    const path = await uploadNodeFile(
      files,
      id,
      new File([JSON.stringify(merged)], "motion.json", { type: "application/json" }),
    );
    check(value.analysisInput);
    signal.throwIfAborted();
    const control = depth.artifacts.find((artifact) => artifact.kind === "depthControl")!;
    const summary = `${value.summary ?? "二维图像运动分析"} 相对深度：${content.frames.length} 个模型采样帧，无米制尺度。`;
    const completed: DepthPending = {
      ...value,
      registered: true,
      settled: true,
      outcome: "succeeded",
      finalReportPath: path,
      saveConfirmed: false,
    };
    await storePending(completed);
    await update(
      {
        outputs: {
          analysis: { dataType: "FILE", value: { url: path, mimeType: "application/json" } },
          summary: { dataType: "STRING", value: summary },
          depth: {
            dataType: "VIDEO",
            value: { url: control.path, mimeType: control.mimeType, controlType: "depth" },
          },
        },
        analysisInput: value.analysisInput,
      },
      signal,
    );
    await storePending({
      ...completed,
      saveConfirmed: true,
    });
    return { path, summary, operationId: value.binding.operationId, saved: true };
  }
  async function analyze(signal: AbortSignal) {
    const source = reference(),
      input = settings(),
      expected = fingerprint();
    check(expected);
    if (input.depth) {
      const previous = pending();
      if (previous && !previous.settled)
        throw new Error(
          `Depth 操作尚未确认收尾：${previous.binding.operationId}，请查询或取消原操作`,
        );
      const binding = referenceDepthBindingSchema.parse({
          operationId: jobId,
          directory: workbench.directory,
          canvasId: workbench.canvasId,
          nodeId: id,
        }),
        api = client(binding, signal);
      state = "checkingModel";
      const model = await api.readModelStatus();
      check(expected);
      if (!model.available)
        throw new Error(`${model.message}；${model.preparation.entry}。未启动推理或自动下载。`);
      const bytes = await files.read(source.url, 256 * 1024 ** 2, signal),
        contentSha256 = await fileSha256(bytes);
      check(expected);
      let value: DepthPending = {
        binding,
        source,
        settings: input,
        analysisInput: expected,
        contentSha256,
        attempted: false,
        registered: false,
        settled: false,
      };
      await storePending(value);
      try {
        state = "analyzingLocal";
        const local = await engine.analyze(
          id,
          source,
          { ...input, depth: false },
          signal,
          (value) => {
            progress = value;
          },
          { files, contentSha256 },
        );
        check(expected);
        value = { ...value, reportPath: local.path, summary: local.summary, attempted: true };
        await storePending(value);
        signal.throwIfAborted();
        state = "registeringDepth";
        depthStatus = await api.start({
          sourcePath: source.url,
          contentSha256,
          settings: { start: input.start, end: input.end, sampleFps: input.sampleFps },
        });
        value = { ...value, registered: true };
        await storePending(value);
        state = "runningDepth";
        const depth = await api.wait({
          signal,
          onStatus: (status) => {
            depthStatus = status;
          },
        });
        check(expected);
        state = "publishing";
        return completeDepth(value, depth, signal);
      } catch (failure) {
        if (value.attempted) {
          let settled: ReferenceDepthStatus;
          try {
            settled = await settleDepth(value);
          } catch (settlement) {
            throw new AggregateError(
              [failure, settlement],
              `Depth 终态未确认，保留操作ID ${binding.operationId} 与原稿 ${value.reportPath ?? ""}`,
            );
          }
          depthStatus = settled;
          await storePending({
            ...(pending() ?? value),
            registered: true,
            settled: settled.executionSettled,
            outcome: settled.state,
          });
        } else
          await storePending({
            ...value,
            settled: true,
            outcome: signal.aborted ? "cancelled" : "failed",
          });
        throw failure;
      }
    }
    state = "analyzingLocal";
    const value = await engine.analyze(id, source, input, signal, (value) => {
      progress = value;
    });
    check(expected);
    signal.throwIfAborted();
    await update(
      {
        outputs: {
          analysis: { dataType: "FILE", value: { url: value.path, mimeType: "application/json" } },
          summary: { dataType: "STRING", value: value.summary },
        },
        analysisInput: expected,
      },
      signal,
    );
    return value;
  }
  async function settleDepth(value: DepthPending) {
    try {
      return await client(value).cancelAndWait();
    } catch (failure) {
      const known = (failure as { state?: ReferenceDepthStatus })?.state;
      if (
        known?.executionSettled &&
        known.operationId === value.binding.operationId &&
        known.directory === value.binding.directory &&
        known.canvasId === value.binding.canvasId &&
        known.nodeId === value.binding.nodeId
      )
        return known;
      throw failure;
    }
  }
  async function exportResult(signal: AbortSignal, plan?: ProductionPlan) {
    const current = data(),
      path = current.outputs?.analysis?.value?.url;
    if (!path) throw new Error("请先完成参考视频分析");
    const expected = fingerprint();
    if (plan && current.analysisInput !== expected)
      throw new Error("输入已变化，请完成当前分析后再导出生产包");
    state = "exporting";
    const value = await engine.exportResult(id, path, workbench.ffmpeg, signal, plan);
    check();
    signal.throwIfAborted();
    if (data().outputs?.analysis?.value?.url !== path || (plan && fingerprint() !== expected))
      throw new Error("报告或输入已变化，本次产物保留，原输出未覆盖");
    const outputs = { ...data().outputs },
      media = (name: string, path: string | undefined, mimeType: string, dataType = "FILE") => {
        if (path) outputs[name] = { dataType, value: { url: path, mimeType } };
        else delete outputs[name];
      };
    media("video", value.videoPath, "video/mp4", "VIDEO");
    media("openPose", value.openPosePath, "application/json");
    media("poseControl", value.posePath, "video/mp4");
    media("cameraMotion", value.cameraPath, "application/json");
    media("edges", value.edgesPath, "video/mp4");
    media("lineart", value.lineartPath, "video/mp4");
    media("contactSheet", value.contactSheetPath, "image/jpeg");
    media("frameDifferenceMask", value.frameDifferenceMaskPath, "video/mp4");
    media("normalsProxy", value.normalsProxyPath, "video/mp4");
    media("combinedReview", value.combinedReviewPath, "video/mp4");
    media("productionPack", value.productionPackPath, "application/zip");
    media("shotPlan", value.planPath, "application/json");
    media("exportManifest", value.manifestPath, "application/json");
    await update({ outputs }, signal);
    return value;
  }
  function queue(kind: "analyze" | "export" | "productionPack", plan?: ProductionPlan) {
    check();
    if (task) throw new Error("此节点已有任务，请等待或取消");
    if (exportFailure) throw exportFailure;
    jobId = crypto.randomUUID();
    controller = new AbortController();
    const signal = AbortSignal.any([context.signal, controller.signal]);
    state = "queued";
    error = "";
    result = undefined;
    progress = 0;
    const current: Promise<unknown> = (async () => {
      if (kind === "analyze") return analyze(signal);
      return exportResult(signal, plan);
    })();
    task = current;
    void current
      .then(
        (value) => {
          result = value;
          state = "succeeded";
          progress = 100;
        },
        (failure) => {
          error = failure instanceof Error ? failure.message : String(failure);
          state = signal.aborted ? "cancelled" : "failed";
          if (kind !== "analyze" && failure instanceof AggregateError) {
            exportFailure = failure;
            pluginState.set(unsettledKey, failure);
          }
        },
      )
      .finally(() => {
        if (task === current) {
          task = undefined;
          controller = undefined;
        }
      });
    return { status: "queued", jobId, state, backendRegistered: false };
  }
  async function cancel() {
    if (exportFailure) throw exportFailure;
    const current = task;
    controller?.abort(new DOMException("Motion 任务已取消", "AbortError"));
    if (current)
      await current.catch((failure) => {
        if (failure instanceof AggregateError && !pending()?.attempted) throw failure;
      });
    const value = pending();
    if (value && !value.settled) {
      if (value.attempted) {
        const settled = await settleDepth(value);
        depthStatus = settled;
        await storePending({
          ...value,
          registered: true,
          settled: settled.executionSettled,
          outcome: settled.state,
        });
      } else await storePending({ ...value, settled: true, outcome: "cancelled" });
    }
    return getStatus();
  }
  function getStatus() {
    const value = pending();
    return {
      jobId,
      state: exportFailure
        ? "unknown"
        : !task && value && !value.settled
          ? (depthStatus?.state ?? "unknown")
          : state,
      running: !!task,
      phase: engine.phase.value || state,
      progress,
      error: exportFailure?.message ?? error,
      result,
      resourceState: engine.resourceState.value,
      operationId: value?.binding.operationId,
      backendRegistered: value?.registered ?? false,
      executionSettled: !exportFailure && !task && (!value || value.settled),
      depthStatus,
      analysisSettingsRevision: JSON.stringify(
        data().analysisSettings ?? { start: 0, end: 1, sampleFps: 6 },
      ),
      productionPlanRevision: JSON.stringify(data().productionPlan ?? null),
      reportPath: value?.reportPath,
      finalReportPath: value?.finalReportPath,
    };
  }
  const readOnlyTools = new Set(["getMotionStatus"]);
  const motionStatusSchema = z.strictObject({ jobId: z.string(), state: z.string(), running: z.boolean(), phase: z.string(), progress: z.number(), error: z.string(), result: z.unknown().optional(), resourceState: z.string(), operationId: z.string().optional(), backendRegistered: z.boolean(), executionSettled: z.boolean(), depthStatus: referenceDepthStatusSchema.optional(), analysisSettingsRevision: z.string(), productionPlanRevision: z.string(), reportPath: z.string().optional(), finalReportPath: z.string().optional() });
  const queuedSchema = z.strictObject({ status: z.string(), jobId: z.string(), state: z.string(), backendRegistered: z.boolean() });
  const outputSchemas = new Map<string, z.ZodType>([
    ["setAnalysisSettings", analysisSettingsSchema], ["getMotionStatus", motionStatusSchema], ["cancelMotion", motionStatusSchema], ["setProductionPlan", productionPlanSchema],
    ...["analyzeMotion", "exportMotion", "exportProductionPack"].map(name => [name, queuedSchema] as const),
    ["resumeMotionDepth", z.union([referenceDepthStatusSchema, z.strictObject({ path: z.string(), summary: z.string(), operationId: z.string(), saved: z.boolean() })])],
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
      execute: (args, call) => execute(args, AbortSignal.any([context.signal, call.signal])),
    });
  const draftOutput = z.strictObject({ draft: draftSchema.nullable(), draftRevision: z.number().int().nonnegative(), saved: z.literal(false), persistence: z.literal("memory") });
  const previewSchema = z.strictObject({ mounted: z.boolean(), ready: z.boolean(), reportPath: z.string(), duration: z.number().nonnegative(), sourceStart: z.number().nonnegative(), paused: z.boolean(), error: z.string() });
  const viewOutput = z.strictObject({ view: motionViewSchema, viewRevision: z.number().int().nonnegative(), currentReportPath: z.string(), preview: previewSchema, persistence: z.literal("memory") });
  const currentReportPath = () => String(data().outputs?.analysis?.value?.url ?? "");
  const readView = () => ({ view: view.read().value, viewRevision: view.read().revision, currentReportPath: currentReportPath(), preview: { mounted: !!preview, ...(preview?.read() ?? { ready: false, reportPath: "", duration: 0, sourceStart: 0, paused: true, error: "" }) }, persistence: "memory" as const });
  context.registerTool({ name: "getMotionView", description: "读取Motion当前页、冻结报告预览相对播放头、骨架/原片开关和关节置信阈值，以及真实播放器就绪/暂停状态；视图只在runtime内存中保留。", parameters: z.strictObject({}), outputSchema: viewOutput, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, execute: readView });
  context.registerTool({ name: "setMotionView", description: "修改与手工Motion预览共用的视图。先tab=preview并等待getMotionView.preview.ready，再定位或播放；time是报告区间相对秒数。须带expectedViewRevision和currentReportPath作为expectedReportPath；不分析、不导出、不保存作品。真实播放失败明确报错。", parameters: motionViewSchema.omit({ reportPath: true }).partial().extend({ expectedViewRevision: z.number().int().nonnegative(), expectedReportPath: z.string() }), outputSchema: viewOutput, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, async execute(args, { signal }) {
    workbench.assertWritable();
    const operationSignal = AbortSignal.any([context.signal, signal]); operationSignal.throwIfAborted();
    const { expectedViewRevision, expectedReportPath, ...patch } = args;
    const current = view.read(), reportPath = currentReportPath();
    if (reportPath !== expectedReportPath) throw Object.assign(new Error("Motion报告已变化，请重新读取视图"), { code: "draftSourceChanged" });
    if (current.revision !== expectedViewRevision) throw Object.assign(new Error("Motion视图已变化，请重新读取"), { code: "draftRevisionConflict", actualRevision: current.revision });
    const next = motionViewSchema.parse({ ...current.value, ...(current.value.reportPath !== reportPath ? { time: 0, playing: false } : {}), ...patch, ...(patch.tab && patch.tab !== "preview" ? { playing: false } : {}), reportPath });
    const playback = patch.time !== undefined || patch.playing !== undefined;
    if (playback) {
      const actual = preview?.read();
      if (next.tab !== "preview" || !actual?.ready || actual.reportPath !== reportPath) throw nodePreconditionError(workbench, id, "请先打开Motion预览并等待报告及原片校验完成", "mediaPlayerUnavailable");
      if (next.time > actual.duration) throw new Error("播放头超出冻结报告区间");
    }
    view.replace(next, expectedViewRevision);
    if (playback) {
      try {
        await preview!.apply({ time: patch.time, playing: patch.playing }, operationSignal);
        if (currentReportPath() !== reportPath) throw Object.assign(new Error("Motion报告在预览期间变化，请重新读取"), { code: "draftSourceChanged" });
      }
      catch (failure) { view.replace({ ...view.read().value, playing: !(preview?.read().paused ?? true) }); throw failure; }
    }
    return readView();
  } });
  const readDraft = () => ({ draft: getDraft() ?? null, draftRevision, saved: false as const, persistence: "memory" as const });
  context.registerTool({ name: "getMotionDraft", description: "读取与Motion编辑台共用的未保存分析范围与生产计划，以及草稿修订。null表示没有本地草稿；正式配置由getMotionStatus读取。草稿仅存在当前runtime内存。", parameters: z.strictObject({}), outputSchema: draftOutput, annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }, execute: readDraft });
  context.registerTool({ name: "setMotionDraft", description: "修改同一Motion编辑台草稿，不保存、不分析、不导出。草稿允许空标题、未选导出层和编辑中的无效范围，applyMotionDraft采用时才校验正式配置。必须带回草稿修订；首次修改基于当前正式配置建立冲突基线。", parameters: z.strictObject({ expectedDraftRevision: z.number().int().nonnegative(), settings: motionSettingsDraftSchema.optional(), plan: motionPlanDraftSchema.optional() }).refine(value => value.settings || value.plan, "请提供分析设置或生产计划"), outputSchema: draftOutput, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, execute(args) {
    check(); if (task) throw new Error("请先等待Motion任务完成");
    if (args.expectedDraftRevision !== draftRevision) throw Object.assign(new Error("Motion草稿已变化，请重新读取"), { code: "draftRevisionConflict", actualRevision: draftRevision });
    const previous = getDraft();
    const currentSettings = settings(), currentPlan = readProductionPlan(data().productionPlan, data().label);
    setDraft({ settings: args.settings ?? previous?.settings ?? currentSettings, plan: args.plan ?? previous?.plan ?? currentPlan, settingsBaseline: previous?.settingsBaseline ?? { persisted: JSON.stringify(currentSettings), local: JSON.stringify(currentSettings) }, planBaseline: previous?.planBaseline ?? { persisted: JSON.stringify(data().productionPlan ?? null), local: JSON.stringify(currentPlan) } }); return readDraft();
  } });
  context.registerTool({ name: "applyMotionDraft", description: "采用当前Motion草稿，通过现有共享编辑会话保存分析配置和生产计划，不开始分析或导出。正式配置或草稿冲突时保留草稿。", parameters: z.strictObject({ expectedDraftRevision: z.number().int().nonnegative() }), outputSchema: z.strictObject({ saved: z.literal(true), documentRevision: z.number().int().nonnegative(), draftRevision: z.number().int().nonnegative() }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, async execute(args, { signal }) {
    check(); if (task) throw new Error("请先等待Motion任务完成");
    if (args.expectedDraftRevision !== draftRevision) throw Object.assign(new Error("Motion草稿已变化，请重新读取"), { code: "draftRevisionConflict", actualRevision: draftRevision });
    const value = getDraft(); if (!value) throw new Error("没有可采用的Motion草稿");
    if (value.settingsBaseline.persisted !== JSON.stringify(settings()) || value.planBaseline.persisted !== JSON.stringify(data().productionPlan ?? null)) throw Object.assign(new Error("正式Motion配置已变化，本地草稿保留，请协调后重试"), { code: "draftBaselineConflict" });
    const parsedSettings = analysisSettingsSchema.safeParse(value.settings), parsedPlan = productionPlanSchema.safeParse(value.plan);
    if (!parsedSettings.success || !parsedPlan.success) throw nodePreconditionError(workbench, id, [...(!parsedSettings.success ? parsedSettings.error.issues : []), ...(!parsedPlan.success ? parsedPlan.error.issues : [])].map(issue => `${issue.path.join(".")}: ${issue.message}`).join("；"), "draftInvalid", { action: "correctInput", message: "读取getMotionDraft，补齐镜头标题、导出层或有效分析范围，再带回当前草稿修订明确采用；原草稿保留，尚未写入作品。" });
    await update({ analysisSettings: parsedSettings.data, productionPlan: parsedPlan.data }, signal);
    setDraft(undefined); return { saved: true as const, documentRevision: document.getRevision(), draftRevision };
  } });
  tool(
    "setAnalysisSettings",
    "保存范围、采样率和可选姿态/相对深度配置，不开始分析。",
    analysisSettingsSchema.safeExtend({ expectedCurrent: z.string().max(4096).optional() }),
    async (args, signal) => {
      if (task) throw new Error("请先完成或停止分析");
      const { expectedCurrent, ...settings } = args;
      if (
        expectedCurrent !== undefined &&
        expectedCurrent !==
          JSON.stringify(data().analysisSettings ?? { start: 0, end: 1, sampleFps: 6 })
      )
        throw new Error("分析设置已被其他操作修改，本地草稿保留，请重新读取后协调");
      await update({ analysisSettings: settings }, signal);
      return settings;
    },
  );
  tool(
    "analyzeMotion",
    "排队执行本地 Camera/Pose 与可选固定本机CPU Depth，不上传、不调用付费模型。getMotionStatus查询真实进度。",
    z.strictObject({}),
    () => queue("analyze"),
  );
  tool(
    "getMotionStatus",
    "查询真实本地任务与固定Depth操作状态，明确backendRegistered/executionSettled；不会重跑推理。",
    z.strictObject({}),
    async () => {
      const value = pending();
      if (value?.attempted && !value.settled && !task) {
        depthStatus = await client(value).status();
        if (depthStatus.executionSettled)
          pluginState.set(pendingKey, {
            ...value,
            registered: depthStatus.state !== "unknown",
            settled: true,
            outcome: depthStatus.state,
          });
      }
      return getStatus();
    },
  );
  tool(
    "cancelMotion",
    "取消并等待任务实际收尾；未知终态保留操作ID、草稿及旧输出。",
    z.strictObject({}),
    cancel,
  );
  tool(
    "resumeMotionDepth",
    "重新读取原Depth操作；仅在真实成功且冻结输入一致时发布原分析草稿，不创建新操作。",
    z.strictObject({}),
    async (_args, signal) => {
      check();
      if (task) throw new Error("请等待当前任务");
      const value = pending();
      if (!value?.attempted) throw new Error("没有可恢复的Depth操作");
      const status = await client(value).status();
      depthStatus = status;
      if (status.state !== "succeeded" || !status.result || !status.executionSettled) return status;
      return completeDepth(value, status.result, signal);
    },
  );
  tool(
    "exportMotion",
    "排队导出已存在的RGB、OpenPose和姿态控制，不重新推理。",
    z.strictObject({}),
    () => queue("export"),
  );
  tool(
    "setProductionPlan",
    "保存镜头计划、参考意图与显式导出层，不开始分析或导出。",
    productionPlanSchema.safeExtend({ expectedCurrent: z.string().max(20000).optional() }),
    async (args, signal) => {
      if (task) throw new Error("请先等待当前任务完成");
      const { expectedCurrent, ...plan } = args;
      if (
        expectedCurrent !== undefined &&
        expectedCurrent !== JSON.stringify(data().productionPlan ?? null)
      )
        throw new Error("镜头计划已被其他操作修改，本地草稿保留，请重新读取后协调");
      await update({ productionPlan: plan }, signal);
      return plan;
    },
  );
  tool(
    "exportProductionPack",
    "按明确layers排队导出真实生产ZIP，包含可用Camera/Pose/Depth/Edges/Lineart等。Normals proxy为亮度梯度，不冒充真实XYZ法线。",
    productionPlanSchema,
    (args) => queue("productionPack", args),
  );
  context.onDispose(async () => {
    controller?.abort(new Error("Motion 插件已停止"));
    await task?.catch(() => {});
  });
  return {
    bindPreview(value: MotionPreviewBinding) { preview = value; return () => { if (preview === value) preview = undefined; }; },
    getStatus,
    cancel,
    beforeHistory: cancel,
    beforeDelete: cancel,
    getDraft,
    setDraft,
    subscribeDraft(listener: () => void) { draftListeners.add(listener); return () => { draftListeners.delete(listener); }; },
  };
}
export type MotionService = ReturnType<typeof createMotionService>;
