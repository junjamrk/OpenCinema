import { z } from "zod";
import type { PluginActivationContext } from "@toonflow/nodes-scaffold/contracts";
import type { NodeDocumentService } from "@toonflow/nodes-scaffold/react";
import type { NodeWorkbenchService } from "@toonflow/nodes-scaffold/workbenchServices";
import { uploadNodeFile } from "@toonflow/nodes-scaffold/nodeFiles";
import { createDirectorDraft, readSchema, editSchema } from "./agentTools";
import {
  createEmptyScene,
  createMannequinObject,
  sceneSchema,
  getSceneLighting,
  type LightingSettings,
  type SceneSettings,
} from "./scene";
import { directorPlanSchema, type DirectorPlan } from "./sceneAnimation";
import { anchorSchema } from "./motion";
import { renderImage, renderVideo, samplePlanCamera } from "./renderMedia";
import { directorPrompt } from "./agentPrompt";
import { isExecutionUnknown, nodePreconditionError } from "@toonflow/node-shared/reactNode";
import { directorView, directorViewSchema } from "./editorView";
import { cameraViewSchema, type CameraView } from "@toonflow/node-shared/director/schema";

export const modelDocumentSchema = z.strictObject({
  version: z.literal(1),
  scene: sceneSchema,
  plans: z
    .array(
      directorPlanSchema.safeExtend({ id: z.string().min(1), instruction: z.string().optional() }),
    )
    .max(100),
});
export type DirectorDocument = z.infer<typeof modelDocumentSchema>;
export function createDirectorService(context: PluginActivationContext) {
  const document = context.getService<NodeDocumentService>("document"),
    workbench = context.getService<NodeWorkbenchService>("workbench"),
    files = workbench.files,
    id = context.nodeId!;
  if (!id || /[\\/\u0000-\u001f]/.test(id) || [".", ".."].includes(id))
    throw new Error("导演节点 ID 无效");
  const directory = `assets/${id}`,
    initial: DirectorDocument = { version: 1, scene: createEmptyScene(), plans: [] };
  const view = directorView(workbench);
  const pluginState = context.getService<Map<string, unknown>>("state");
  const unsettledKey = `director:${workbench.canvasId}:${id}:unsettledExport`;
  let unsettledFailure = pluginState.get(unsettledKey) as Error | undefined;
  let camera: { read(): CameraView | null; apply(value: CameraView): void } | undefined;
  let busy = false,
    phase = "",
    progress = 0,
    error = "",
    operation: AbortController | undefined;
  let exportTask: Promise<unknown> | undefined,
    jobId = "",
    jobState = "idle";
  let activeTask: Promise<unknown> | undefined;
  let hostOperation: AbortController | undefined,
    hostTask: Promise<unknown> | undefined,
    draftInstruction: string | undefined;
  function queue(callback: (signal: AbortSignal) => Promise<unknown>, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (busy || exportTask) throw new Error("导演台已有任务");
    jobId = crypto.randomUUID();
    jobState = "queued";
    const task = run(callback);
    exportTask = task;
    void task
      .then(
        () => {
          jobState = "succeeded";
          phase = "导出已保存";
          progress = 100;
        },
        (failure) => {
          if (isExecutionUnknown(failure) || failure instanceof AggregateError || failure?.ffmpegSettled === false) { unsettledFailure = failure instanceof Error ? failure : new Error("导演导出尚未确认终止"); pluginState.set(unsettledKey, unsettledFailure); }
          jobState =
            unsettledFailure ? "unknown" : failure instanceof DOMException && failure.name === "AbortError"
              ? "cancelled"
              : "failed";
          phase = jobState === "cancelled" ? "导出已取消" : "导出失败";
        },
      )
      .finally(() => {
        if (exportTask === task) exportTask = undefined;
      });
    return { status: "queued", jobId, executionSettled: false };
  }
  let draft: ReturnType<typeof createDirectorDraft> | undefined, draftRevision: string | undefined;
  const data = () => (document.readNode(id) as { data?: Record<string, any> }).data ?? {};
  const hostState = () => data().directorHostOperation as { taskId: string; status: string; revision: string; requestId?: string; error?: string } | undefined;
  const hostUnsettled = () => ["running", "delegated", "unknown"].includes(hostState()?.status ?? "");
  const revision = () => String(data().modelPath ?? "initial");
  const writable = () => {
    workbench.assertWritable();
    context.signal.throwIfAborted();
  };
  async function read() {
    const current = data(),
      before = revision();
    if (
      current.modelPath &&
      current.modelPath !== `${directory}/model.json` &&
      (!current.modelPath.startsWith(`${directory}/`) ||
        !/^model[0-9a-f]{32}\.json$/.test(current.modelPath.slice(directory.length + 1)))
    )
      throw new Error("导演台模型文件路径无效");
    const value = modelDocumentSchema.parse(
      current.modelSnapshot ??
        (current.modelPath ? await files.readJson(current.modelPath) : initial),
    );
    context.signal.throwIfAborted();
    if (before !== revision()) throw new Error("模型读取期间已变化，请重新读取");
    return {
      document: value,
      revision: before,
      selectedPlanId: data().selectedPlanId as string | undefined,
      anchors: z.array(anchorSchema).parse(data().anchors ?? []),
      lighting: { ...getSceneLighting(value.scene), ...data().lighting } as LightingSettings,
      sceneSettings: {
        gridVisible: true,
        skyVisible: true,
        ...data().sceneSettings,
      } as SceneSettings,
    };
  }
  async function write(
    value: DirectorDocument,
    expectedRevision: string,
    signal: AbortSignal,
    patch: Record<string, unknown> = {},
  ) {
    writable();
    signal.throwIfAborted();
    const next = modelDocumentSchema.parse(value);
    const ids = new Set(next.scene.objectList.map((object) => object.threeJsonId));
    if (next.plans.some((plan) => plan.tracks.some((track) => !ids.has(track.objectId))))
      throw new Error("导演方案引用了不存在的物体");
    const check = () => {
      writable();
      signal.throwIfAborted();
      if (revision() !== expectedRevision) throw new Error("导演台已更新，请重新读取后协调修改");
    };
    check();
    for (const path of ["assets", directory])
      await files.mkdir(path).catch((failure: any) => {
        if (failure?.response?.data?.data?.code !== "EEXIST") throw failure;
      });
    check();
    const path = `${directory}/model${crypto.randomUUID().replaceAll("-", "")}.json`;
    await files.writeJson(path, next, true);
    check();
    await document.updateData(
      { modelPath: path, modelSnapshot: null, ...patch },
      document.getRevision(),
      signal,
    );
    await document.save();
    draft = undefined;
    draftRevision = undefined;
    draftInstruction = undefined;
    return read();
  }
  async function run<T>(callback: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) {
    if (unsettledFailure) throw unsettledFailure;
    if (busy) throw new Error("导演台正在处理其他操作");
    writable();
    busy = true;
    error = "";
    operation = new AbortController();
    const combined = AbortSignal.any([
      context.signal,
      operation.signal,
      ...(signal ? [signal] : []),
    ]);
    const task = Promise.resolve().then(() => callback(combined));
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
    operation?.abort(new DOMException("导演操作已取消", "AbortError"));
    hostOperation?.abort(new DOMException("导演宿主请求已取消", "AbortError"));
    for (const task of [activeTask, exportTask, hostTask]) {
      await task?.catch((failure) => {
        if (failure instanceof AggregateError || failure?.ffmpegSettled === false) throw failure;
      });
    }
    if (hostUnsettled()) { await document.updateRuntimeData({ directorHostOperation: { ...hostState(), status: "unknown", error: "宿主尚未确认方案任务终止；保留原任务与草稿，等待实际发布" } }); await document.save(); }
    return { busy: busy || !!hostTask, executionSettled: !activeTask && !exportTask && !hostTask && !hostUnsettled() && !unsettledFailure };
  }
  const readOnlyTools = new Set(["getDirectorDocument", "getDirectorStatus", "readDocument"]);
  const documentOutputSchema = z.strictObject({ document: modelDocumentSchema, revision: z.string(), selectedPlanId: z.string().optional(), anchors: z.array(anchorSchema), lighting: z.strictObject({ globalEnabled: z.boolean(), globalIntensity: z.number(), sunEnabled: z.boolean(), azimuth: z.number(), elevation: z.number(), color: z.string(), intensity: z.number() }), sceneSettings: z.strictObject({ gridVisible: z.boolean(), skyVisible: z.boolean() }) });
  const outputSchemas = new Map<string, z.ZodType>([
    ...["getDirectorDocument", "setDirectorDocument", "setDirectorScene", "addDirectorMannequin", "applyDirectorDraft", "setDirectorPlan", "setDirectorSettings"].map(name => [name, documentOutputSchema] as const),
    ["getDirectorStatus", z.strictObject({ busy: z.boolean(), phase: z.string(), progress: z.number(), error: z.string(), revision: z.string(), jobId: z.string(), state: z.string(), taskId: z.string().optional(), requestId: z.string().optional(), executionSettled: z.boolean() })],
    ["cancelDirector", z.strictObject({ busy: z.boolean(), executionSettled: z.boolean() })],
    ...["exportDirectorImage", "exportDirectorVideo"].map(name => [name, z.strictObject({ status: z.string(), jobId: z.string(), executionSettled: z.boolean() })] as const),
    ["createDirectorOutputNode", z.strictObject({ nodeId: z.string(), path: z.string(), mimeType: z.string() })],
    ["requestDirectorPlan", z.strictObject({ requestId: z.string().optional(), status: z.enum(["accepted", "completed"]), text: z.string().optional(), result: z.unknown().optional(), taskId: z.string(), executionState: z.string() })],
    ["readDocument", z.union([z.strictObject({ value: z.json(), valid: z.boolean(), issues: z.array(z.string()) }), z.record(z.string(), z.json()).describe("section=schema时返回选定JSON Schema对象")])],
    ["editDocument", z.strictObject({ applied: z.number().int().nonnegative(), valid: z.boolean(), issues: z.array(z.string()) })],
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
  const viewOutput = z.strictObject({ view: directorViewSchema, viewRevision: z.number().int().nonnegative(), resourceRevision: z.string(), camera: cameraViewSchema.nullable(), persistence: z.literal("memory") });
  const readView = () => ({ view: view.read().value, viewRevision: view.read().revision, resourceRevision: revision(), camera: camera?.read() ?? null, persistence: "memory" as const });
  context.registerTool({ name: "getDirectorView", description: "读取真实导演台当前对象、时间轴(秒)、播放、自由视图、画幅及实际渲染相机。camera=null表示视口未挂载；视图仅保留于runtime内存，正式场景由getDirectorDocument读取。", parameters: z.strictObject({}), outputSchema: viewOutput, annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }, execute: readView });
  context.registerTool({ name: "setDirectorView", description: "修改同一导演台的对象选择、播放头、自由相机和画幅，不保存作品。显式camera修改要求先打开视口，自动开启freeView并暂停以保留该机位。", parameters: directorViewSchema.partial().extend({ expectedRevision: z.string().min(1), expectedViewRevision: z.number().int().nonnegative(), camera: cameraViewSchema.optional() }), outputSchema: viewOutput, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, async execute(args) {
    workbench.assertWritable(); const current = await read(); if (current.revision !== args.expectedRevision) throw new Error("导演台文档已变化，请重新读取");
    const { expectedRevision, expectedViewRevision, camera: cameraValue, ...patch } = args;
    const next = directorViewSchema.parse({ ...view.read().value, ...patch, ...(cameraValue ? { freeView: true, playing: false } : {}) });
    if (next.selected && !current.document.scene.objectList.some(value => value.threeJsonId === next.selected)) throw new Error("所选对象不在当前场景");
    const plan = current.document.plans.find(value => value.id === current.selectedPlanId);
    if (next.time > (plan?.duration ?? 300)) throw new Error("播放头超出当前方案范围");
    if (view.read().revision !== expectedViewRevision) throw Object.assign(new Error("导演台视图已变化，请重新读取"), { code: "draftRevisionConflict", actualRevision: view.read().revision });
    if (cameraValue && !camera?.read()) throw Object.assign(new Error("请先打开导演台，等待三维视口就绪"), { code: "viewportUnavailable" });
    view.replace(next, expectedViewRevision); if (cameraValue) camera!.apply(cameraValue); return readView();
  } });
  tool(
    "getDirectorDocument",
    "读取当前导演台场景、方案历史、机位锚点、照明与版本。",
    z.strictObject({}),
    read,
  );
  tool("getDirectorStatus", "读取导演台真实任务状态。", z.strictObject({}), () => ({
    busy: busy || !!hostTask,
    phase: hostTask ? "宿主正在处理导演方案" : phase,
    progress,
    error: unsettledFailure?.message ?? hostState()?.error ?? error,
    revision: revision(),
    jobId,
    state: unsettledFailure ? "unknown" : hostTask ? "waitingHost" : hostUnsettled() ? hostState()!.status : jobState,
    taskId: hostState()?.taskId,
    requestId: hostState()?.requestId,
    executionSettled: !activeTask && !exportTask && !hostTask && !hostUnsettled() && !unsettledFailure,
  }));
  tool(
    "setDirectorDocument",
    "验证完整场景和方案文档并存为新版本，纳入统一历史。",
    z.strictObject({ expectedRevision: z.string(), document: modelDocumentSchema }),
    (args, signal) => run((signal) => write(args.document, args.expectedRevision, signal), signal),
  );
  tool(
    "setDirectorScene",
    "替换场景但保留所有方案历史，拒绝遗失仍被方案引用的物体。",
    z.strictObject({ expectedRevision: z.string(), scene: sceneSchema }),
    (args, signal) =>
      run(async (signal) => {
        const current = await read();
        return write({ ...current.document, scene: args.scene }, args.expectedRevision, signal);
      }, signal),
  );
  tool(
    "addDirectorMannequin",
    "在场景添加原生关节人偶并保存。",
    z.strictObject({ expectedRevision: z.string() }),
    (args, signal) =>
      run(async (signal) => {
        const current = await read(),
          object = createMannequinObject(crypto.randomUUID());
        object.position.x = current.document.scene.objectList.length;
        current.document.scene.objectList.push(object);
        return write(current.document, args.expectedRevision, signal);
      }, signal),
  );
  async function ensureDraft() {
    const current = await read();
    if (!draft || draftRevision !== current.revision) {
      const selected = current.document.plans.find((plan) => plan.id === current.selectedPlanId);
      draft = createDirectorDraft(current.document.scene, selected, current.document.plans);
      draftRevision = current.revision;
    }
    return draft;
  }
  tool(
    "readDocument",
    "读取导演台独立草稿的scene/plan/schema或历史；按objectId/joint/path精确查询。",
    readSchema,
    async (args, signal) => {
      const value = await ensureDraft();
      return value.tools[0]!.execute(args, signal);
    },
  );
  tool(
    "editDocument",
    "原子批量修改导演台独立草稿；不触碰已发布场景或历史，返回valid和issues。",
    editSchema,
    async (args, signal) => {
      writable();
      const value = await ensureDraft();
      return value.tools[1]!.execute(args, signal);
    },
  );
  tool(
    "applyDirectorDraft",
    "验证草稿完整后发布场景与新方案，保留旧方案。",
    z.strictObject({ expectedRevision: z.string() }),
    (args, signal) =>
      run(async (signal) => {
        const value = await ensureDraft();
        if (draftRevision !== args.expectedRevision) throw new Error("草稿版本已变化");
        const next = value.read(),
          current = await read(),
          plan = {
            ...next.plan,
            id: crypto.randomUUID(),
            ...(draftInstruction ? { instruction: draftInstruction } : {}),
          };
        const result = await write(
          { version: 1, scene: next.scene, plans: [...current.document.plans, plan] },
          args.expectedRevision,
          signal,
          { selectedPlanId: plan.id },
        );
        if (hostUnsettled() && hostState()?.revision === args.expectedRevision) { await document.updateRuntimeData({ directorHostOperation: { ...hostState(), status: "completed" } }, signal); await document.save(); }
        return result;
      }, signal),
  );
  tool(
    "setDirectorPlan",
    "验证一份运镜/物体/关节动画方案，作为新版本方案保存。",
    z.strictObject({ expectedRevision: z.string(), plan: directorPlanSchema }),
    (args, signal) =>
      run(async (signal) => {
        const current = await read(),
          plan = { ...args.plan, id: crypto.randomUUID() };
        return write(
          { ...current.document, plans: [...current.document.plans, plan] },
          args.expectedRevision,
          signal,
          { selectedPlanId: plan.id },
        );
      }, signal),
  );
  tool(
    "setDirectorSettings",
    "保存选中方案、真实相机锚点、光照或显示设置，进入统一历史。",
    z.strictObject({
      expectedRevision: z.number().int().nonnegative().optional(),
      selectedPlanId: z.string().optional(),
      anchors: z.array(anchorSchema).max(120).optional(),
      expectedAnchors: z.array(anchorSchema).max(120).optional(),
      lighting: z
        .object({
          globalEnabled: z.boolean(),
          globalIntensity: z.number().min(0).max(100),
          sunEnabled: z.boolean(),
          azimuth: z.number().finite(),
          elevation: z.number().min(-90).max(90),
          color: z.string().regex(/^#[\da-f]{6}$/i),
          intensity: z.number().min(0).max(100),
        })
        .optional(),
      sceneSettings: z.object({ gridVisible: z.boolean(), skyVisible: z.boolean() }).optional(),
    }),
    async (args, signal) => {
      writable();
      if (busy) throw new Error("导演台正在处理任务，请等待或取消后修改设置");
      const baseline = document.getRevision();
      const { expectedRevision, expectedAnchors, ...patch } = args;
      if (expectedAnchors && JSON.stringify(expectedAnchors) !== JSON.stringify(z.array(anchorSchema).parse(data().anchors ?? []))) throw nodePreconditionError(workbench, id, "关键帧已被其他操作修改，原排序保留，请重新读取后重排", "draftBaselineConflict", { action: "readState", message: "读取getDirectorDocument.anchors，以实际锚点重新编排，并将该数组作为expectedAnchors；此次未改变锚点或顺序。" });
      if (
        patch.selectedPlanId &&
        !(await read()).document.plans.some((plan) => plan.id === patch.selectedPlanId)
      )
        throw new Error("方案不存在");
      await document.updateData(patch, expectedRevision ?? baseline, signal);
      await document.save();
      return read();
    },
  );
  async function upload(file: File, signal: AbortSignal) {
    for (const path of ["assets", directory])
      await files.mkdir(path).catch((failure: any) => {
        if (failure?.response?.data?.data?.code !== "EEXIST") throw failure;
      });
    signal.throwIfAborted();
    const path = `${directory}/${crypto.randomUUID()}${file.name.endsWith(".mp4") ? ".mp4" : ".png"}`;
    await files.write(path, file, true);
    return path;
  }
  tool(
    "exportDirectorImage",
    "按选中真实相机或动画时间渲染PNG，保存节点输出。",
    z.strictObject({
      expectedRevision: z.string(),
      planId: z.string().optional(),
      time: z.number().finite().min(0).max(300).optional(),
      aspect: z.number().positive().min(0.2).max(5).optional(),
      anchor: anchorSchema.optional(),
    }),
    (args, signal) =>
      queue(async (signal) => {
        const current = await read(),
          expectedData = JSON.stringify(data());
        if (current.revision !== args.expectedRevision) throw new Error("版本已变化");
        const plan = current.document.plans.find(
            (value) => value.id === (args.planId ?? current.selectedPlanId),
          ),
          anchor = args.anchor ??
            (plan
              ? samplePlanCamera(current.document.scene, plan, args.time ?? 0)
              : current.anchors[0]) ?? {
              id: crypto.randomUUID(),
              camera: current.document.scene.sceneConfig.camera,
              controls: current.document.scene.sceneConfig.controls,
            };
        phase = "正在渲染关键帧";
        const file = await renderImage(
            current.document.scene,
            anchor,
            args.aspect ?? 16 / 9,
            args.time ?? 0,
            signal,
            plan,
            current.lighting,
            current.sceneSettings,
          ),
          path = await upload(file, signal);
        if (revision() !== args.expectedRevision || JSON.stringify(data()) !== expectedData)
          throw new Error("导出期间版本或设置已变化，原输出保留");
        writable();
        await document.updateData(
          {
            outputs: {
              ...data().outputs,
              image: { dataType: "IMAGE", value: { url: path, mimeType: "image/png" } },
            },
          },
          document.getRevision(),
          signal,
        );
        await document.save();
        return { path, mimeType: "image/png" };
      }, signal),
  );
  tool(
    "exportDirectorVideo",
    "以浏览器原生编码导出真实场景动画MP4；不调用付费模型。",
    z.strictObject({
      expectedRevision: z.string(),
      planId: z.string().optional(),
      aspect: z.number().positive().min(0.2).max(5).optional(),
    }),
    (args, signal) =>
      queue(async (signal) => {
        const current = await read(),
          expectedData = JSON.stringify(data());
        if (current.revision !== args.expectedRevision) throw new Error("版本已变化");
        const plan = current.document.plans.find(
          (value) => value.id === (args.planId ?? current.selectedPlanId),
        );
        if (!plan) throw new Error("请先创建完整动画方案");
        phase = "正在导出动画";
        progress = 0;
        const file = await renderVideo(
            current.document.scene,
            plan,
            args.aspect ?? 16 / 9,
            signal,
            (value) => {
              progress = value;
            },
            current.lighting,
            current.sceneSettings,
          ),
          path = await upload(file, signal);
        if (revision() !== args.expectedRevision || JSON.stringify(data()) !== expectedData)
          throw new Error("导出期间版本或设置已变化，原输出保留");
        writable();
        await document.updateData(
          {
            outputs: {
              ...data().outputs,
              video: { dataType: "VIDEO", value: { url: path, mimeType: "video/mp4" } },
            },
          },
          document.getRevision(),
          signal,
        );
        await document.save();
        progress = 100;
        return { path, mimeType: "video/mp4" };
      }, signal),
  );
  tool(
    "requestDirectorPlan",
    "向当前宿主Agent请求导演方案。宿主可使用readDocument/editDocument/applyDirectorDraft处理；accepted只表示已受理。",
    z.strictObject({ prompt: z.string().min(1).max(20000) }),
    async (args, signal) => {
      writable();
      if (hostTask || hostUnsettled()) throw new Error("导演台已有宿主请求，须等待原任务真实发布方案或终态，请勿重复发起");
      signal.throwIfAborted();
      error = "";
      const requestOperation = new AbortController();
      const taskId = crypto.randomUUID();
      hostOperation = requestOperation;
      const combined = AbortSignal.any([signal, requestOperation.signal]);
      const task = Promise.resolve().then(async () => {
        combined.throwIfAborted();
        const current = await read();
        combined.throwIfAborted();
        await document.updateRuntimeData({ directorHostOperation: { taskId, status: "running", revision: current.revision } }, combined); await document.save();
        draftInstruction = args.prompt;
        return workbench.hostRequest(
          {
            kind: "directorPlan",
            prompt: `${directorPrompt}\n\n本轮由宿主执行。完成草稿校验后须调用 applyDirectorDraft，expectedRevision 为 ${current.revision}，成功发布新方案后再完成宿主请求；未发布不能声称已完成。\n\n${args.prompt}`,
            references: workbench.getInputs("in").filter((input) => input.value !== undefined),
            metadata: {
              nodeId: id,
              taskId,
              revision: current.revision,
              document: current.document,
              anchors: current.anchors,
              tools: ["readDocument", "editDocument", "applyDirectorDraft"],
            },
          },
          combined,
        );
      });
      hostTask = task;
      try {
        const response = await task;
        const state = hostState()?.status === "completed" ? "completed" : "delegated";
        const requestId = "requestId" in response && typeof response.requestId === "string" ? response.requestId : undefined;
        await document.updateRuntimeData({ directorHostOperation: { ...hostState(), taskId, ...(requestId ? { requestId } : {}), status: state } }); await document.save();
        return { ...response, taskId, executionState: state };
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure);
        const requestId = failure && typeof failure === "object" && "requestId" in failure && typeof failure.requestId === "string" ? failure.requestId : undefined;
        await document.updateRuntimeData({ directorHostOperation: { ...hostState(), taskId, ...(requestId ? { requestId } : {}), status: isExecutionUnknown(failure) ? "unknown" : combined.aborted ? "cancelled" : "failed", error } }).then(() => document.save()).catch(() => {});
        throw failure;
      } finally {
        if (hostTask === task) hostTask = undefined;
        if (hostOperation === requestOperation) hostOperation = undefined;
      }
    },
  );
  tool(
    "createDirectorOutputNode",
    "把已有导演导出副本保存为独立图片或视频节点；不重渲染、不调用生成模型。",
    z.strictObject({ kind: z.enum(["image", "video"]), expectedPath: z.string().min(1) }),
    (args, signal) =>
      run(async (signal) => {
        const output = data().outputs?.[args.kind];
        if (
          output?.value?.url !== args.expectedPath ||
          output.dataType !== args.kind.toUpperCase() ||
          !args.expectedPath.startsWith(`${directory}/`)
        )
          throw new Error("导演输出已变化，请刷新后再放入画布");
        const content = await files.read(args.expectedPath, 256 * 1024 ** 2, signal);
        signal.throwIfAborted();
        const childId = crypto.randomUUID(),
          mimeType = args.kind === "image" ? "image/png" : "video/mp4";
        const path = await uploadNodeFile(
          files,
          childId,
          new File([content], args.kind === "image" ? "director.png" : "director.mp4", {
            type: mimeType,
          }),
        );
        signal.throwIfAborted();
        writable();
        if (data().outputs?.[args.kind]?.value?.url !== args.expectedPath)
          throw new Error("复制期间导演输出已变化，未发布新节点");
        type Positioned = {
          position?: { x: number; y: number };
          width?: number;
          height?: number;
          style?: { width?: number; height?: number };
        };
        const owner = document.readNode(id) as Positioned,
          x = (owner.position?.x ?? 0) + (owner.width ?? 360) + 80;
        // ACT: 节点文档只读本节点；同一导演产物按序排放，跨节点整理交给画布。
        const count = workbench
          .readNodes()
          .filter((node) => node.data?.directorSourceId === id).length;
        const y = (owner.position?.y ?? 0) + count * 344;
        await workbench.createNodes(
          [
            {
              id: childId,
              type: `${args.kind}Node`,
              position: { x, y },
              data: {
                label: args.kind === "image" ? "导演关键帧" : "导演动画",
                directorSourceId: id,
                handles: [
                  {
                    id: "in",
                    type: "target",
                    dataType: args.kind.toUpperCase(),
                    label: "导演输出",
                  },
                  {
                    id: args.kind,
                    type: "source",
                    dataType: args.kind.toUpperCase(),
                    label: "输出",
                  },
                ],
                outputs: {
                  [args.kind]: {
                    dataType: args.kind.toUpperCase(),
                    value: { url: path, mimeType },
                  },
                },
              },
            },
          ],
          [
            {
              id: crypto.randomUUID(),
              source: id,
              sourceHandle: args.kind,
              target: childId,
              targetHandle: "in",
            },
          ],
          signal,
        );
        return { nodeId: childId, path, mimeType };
      }, signal),
  );
  tool("cancelDirector", "请求取消当前导演导出并等待真实任务收尾。", z.strictObject({}), cancel);
  context.onDispose(async () => {
    operation?.abort(new Error("导演插件已停止"));
    hostOperation?.abort(new Error("导演插件已停止"));
    await Promise.allSettled([activeTask, exportTask, hostTask].filter(Boolean));
  });
  return {
    bindCamera(value: typeof camera) { camera = value; return () => { if (camera === value) camera = undefined; }; },
    read,
    beforeHistory: async () => { await cancel(); if (hostUnsettled()) throw new Error("宿主导演任务尚未确认终止，请先完成原任务"); },
    beforeDelete: async () => { await cancel(); if (hostUnsettled()) throw new Error("宿主导演任务尚未确认终止，请先完成原任务"); },
    state: () => ({
      busy: busy || !!hostTask,
      phase: hostTask ? "宿主正在处理导演方案" : phase,
      progress,
      error: unsettledFailure?.message ?? hostState()?.error ?? error,
      jobId,
      state: unsettledFailure ? "unknown" : hostTask ? "waitingHost" : hostUnsettled() ? hostState()!.status : jobState,
      executionSettled: !activeTask && !exportTask && !hostTask && !hostUnsettled() && !unsettledFailure,
    }),
  };
}
export type DirectorService = ReturnType<typeof createDirectorService>;
