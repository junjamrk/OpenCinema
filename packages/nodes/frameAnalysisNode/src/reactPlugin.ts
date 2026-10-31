import { openCinema, version } from "../package.json";
import { z } from "zod";
import type { NodePluginDefinition } from "@toonflow/nodes-scaffold/contracts";
import { getTargetValues } from "@toonflow/nodes-scaffold/nodePortValues";
import { isExecutionUnknown, nodePreconditionError, cloneMediaNodeData, pluginServices, readNodeData, errorText, mediaValueSchema, relativePathSchema } from "@toonflow/node-shared/reactNode";
import { createMediaDirectory, createResultNode } from "@toonflow/node-shared/reactMediaActions";
import { analyzeVideo, type AnalysisResult } from "./videoAnalysis";
import FrameAnalysisNodeView from "./reactView";

const settingsSchema = z.strictObject({ method: z.enum(["adaptive", "content"]).optional(), threshold: z.number().finite().min(.1).max(255).optional(), minSceneSeconds: z.number().finite().min(0).max(60).optional(), frames: z.boolean().optional(), clips: z.boolean().optional(), audio: z.boolean().optional(), aiEnabled: z.boolean().optional(), focus: z.string().max(2000).optional() });
const defaults = { method: "adaptive" as const, threshold: 3, minSceneSeconds: .6, frames: true, clips: true, audio: true, aiEnabled: false, focus: "" };
const annotationSchema = z.strictObject({ shotSize: z.string().min(1).max(40), cameraAngle: z.string().min(1).max(60), movement: z.string().min(1).max(220), description: z.string().min(1).max(1000) });
const reportSchema = z.strictObject({ manifest: relativePathSchema, scenes: z.array(z.strictObject({ index: z.number().int().nonnegative(), annotation: annotationSchema })).max(10000).optional(), overview: z.strictObject({ summary: z.string().min(1).max(500), narrative: z.string().min(1).max(1000), rhythm: z.string().min(1).max(800), editing: z.string().min(1).max(800), focusResponse: z.string().max(1000) }).optional(), overviewError: z.string().max(1000).optional() }).refine(value => value.scenes?.length || value.overview || value.overviewError, "请提供镜头分析或整段归纳");
const settingsOutputSchema = settingsSchema.required().extend({ source: mediaValueSchema.optional() });
const resultSummarySchema = z.strictObject({ manifest: relativePathSchema, sceneCount: z.number().int().nonnegative(), width: z.number(), height: z.number(), duration: z.number(), source: z.string().nullable(), sourceCurrent: z.boolean(), overview: reportSchema.shape.overview });

const plugin: NodePluginDefinition<typeof FrameAnalysisNodeView> = {
  cloneData: cloneMediaNodeData,
  ...openCinema, version, apiVersion: 1, renderer: "react", view: FrameAnalysisNodeView,
  composer: { label: "分析镜头", placeholder: "描述希望重点分析的镜头语言、叙事或剪辑节奏…", tool: "analyzeScenes", maxLength: 2000 },
  canConnect(connection, context) {
    const edges = context.edges.filter(edge => edge.source !== connection.source || edge.sourceHandle !== connection.sourceHandle || edge.target !== connection.target || edge.targetHandle !== connection.targetHandle);
    return getTargetValues(connection.target, "in", context.nodes, [...edges, connection]).length <= 1;
  },
  createData: () => ({ label: openCinema.name, handles: [{ id: "in", type: "target", dataType: "VIDEO", label: "视频素材" }], frameAnalysis: { ...defaults }, outputs: {} }),
  activate(context) {
    const { id, document, workbench } = pluginServices(context);
    let task: { controller: AbortController; promise: Promise<void>; state: string; percent: number; label: string; hostPending: boolean; error?: string } | undefined;
    context.onDispose(async () => { task?.controller.abort(new Error("节点已卸载")); await task?.promise; });
    // ACT: 拉片产物写入独立目录，宿主报告按manifest校验；未确认的任务只锁本节点，不阻断画布操作。
    context.onBeforeChange(async () => { task?.controller.abort(new Error("节点即将变更")); await task?.promise; });
    function assertIdle() {
      const saved = readNodeData(document, id).analysisProgress as { status?: string } | undefined;
      if ([task?.state, saved?.status].some(status => ["running", "delegated", "unknown"].includes(status ?? ""))) throw new Error("请先完成当前拉片任务或解除锁定；宿主已受理时等待实际报告");
    }
    const state = () => ({ ...defaults, ...(readNodeData(document, id).frameAnalysis as object ?? {}) });
    const config = () => { const saved = state() as Record<string, unknown>; return settingsOutputSchema.parse({ ...Object.fromEntries(Object.keys(defaults).map(key => [key, saved[key]])), ...(saved.source ? { source: saved.source } : {}) }); };
    const source = () => {
      const inputs = workbench.getInputs("in");
      if (inputs.length > 1) throw nodePreconditionError(workbench, id, "视频分析只接受一路视频，请明确选择一路输入", "mediaSourceAmbiguous");
      const value = inputs.length ? inputs[0]?.value : (state() as Record<string, unknown>).source;
      const parsed = mediaValueSchema.safeParse(value);
      if (!parsed.success || !parsed.data.mimeType.startsWith("video/")) throw nodePreconditionError(workbench, id, "请连接或选择有效视频素材");
      return parsed.data;
    };
    context.registerTool({ name: "getAnalysisFrames", description: "分页读取已生成关键帧与镜头片段的真实工作区引用、源视频版本和时间。此工具返回引用；使用宿主图像感知入口读取image.path内容后才能宣称观察图像。不会重新分析或生成截图。", parameters: z.strictObject({ offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(20).default(8), expectedManifest: relativePathSchema.optional() }), outputSchema: z.strictObject({ manifest: relativePathSchema.nullable(), source: z.string().nullable(), sourceCurrent: z.boolean(), width: z.number().nonnegative(), height: z.number().nonnegative(), duration: z.number().nonnegative(), frames: z.array(z.strictObject({ sceneIndex: z.number().int(), start: z.number(), end: z.number(), image: z.strictObject({ path: relativePathSchema, mimeType: z.literal("image/jpeg") }).optional(), video: z.strictObject({ path: relativePathSchema, mimeType: z.literal("video/mp4") }).optional(), sampleTimes: z.array(z.number()).optional(), annotation: annotationSchema.optional() })), total: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative().nullable(), documentRevision: z.number().int().nonnegative() }), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }, execute(args) {
      const saved = state() as typeof defaults & { lastResult?: AnalysisResult; resultSource?: string };
      const result = saved.lastResult;
      if (args.expectedManifest && result?.manifest !== args.expectedManifest) throw Object.assign(new Error("关键帧清单已变化，请从首项重新读取"), { code: "analysisManifestChanged", actualManifest: result?.manifest });
      const total = result?.scenes.length ?? 0;
      return { manifest: result?.manifest ?? null, source: saved.resultSource ?? null, sourceCurrent: !!saved.resultSource && saved.resultSource === source().url, width: result?.width ?? 0, height: result?.height ?? 0, duration: result?.duration ?? 0, frames: (result?.scenes ?? []).slice(args.offset, args.offset + args.limit).map(scene => ({ sceneIndex: scene.index, start: scene.start, end: scene.end, ...(scene.image ? { image: { path: scene.image, mimeType: "image/jpeg" as const } } : {}), ...(scene.video ? { video: { path: scene.video, mimeType: "video/mp4" as const } } : {}), ...(scene.sampleTimes ? { sampleTimes: scene.sampleTimes } : {}), ...(scene.annotation ? { annotation: scene.annotation } : {}) })), total, nextOffset: args.offset + args.limit < total ? args.offset + args.limit : null, documentRevision: document.getRevision() };
    } });
    async function saveReport(args: z.output<typeof reportSchema>, signal: AbortSignal) {
      workbench.assertWritable(); signal.throwIfAborted();
      const saved = state() as typeof defaults & { lastResult?: AnalysisResult; resultSource?: string; source?: unknown };
      const result = saved.lastResult;
      if (!result || result.manifest !== args.manifest || saved.resultSource !== source().url) throw new Error("拉片结果或输入已变化，请重新读取结果后提交分析");
      const progress = readNodeData(document, id).analysisProgress as { status?: string; phase?: string } | undefined;
      if (progress?.status === "unknown" && !task?.hostPending && progress.phase !== "host") throw new Error("本地解码任务尚未确认终止，不能用旧报告解除任务状态");
      const annotations = new Map(args.scenes?.map(scene => [scene.index, scene.annotation]));
      if (annotations.size !== (args.scenes?.length ?? 0) || [...annotations.keys()].some(index => !result.scenes.some(scene => scene.index === index))) throw new Error("镜头编号重复或不存在");
      const revision = document.getRevision();
      const path = `${await createMediaDirectory(workbench, id)}/aiAnalysis${crypto.randomUUID()}.json`;
      const overview = args.overview ?? result.overview;
      const annotated: AnalysisResult = { ...result, manifest: path, scenes: result.scenes.map(scene => annotations.has(scene.index) ? { ...scene, annotation: annotations.get(scene.index)! } : scene), ...(overview ? { overview } : {}), ai: { providerId: "host", modelId: "hostAgent", analyzedAt: new Date().toISOString(), focus: saved.focus, ...(args.overviewError ? { overviewError: args.overviewError } : {}) } };
      signal.throwIfAborted();
      await workbench.files.writeJson(path, { version: 1, source: saved.resultSource, previousManifest: result.manifest, ...annotated }, true);
      signal.throwIfAborted();
      const scenes = new Map(annotated.scenes.map(scene => [scene.index, scene]));
      const updates = workbench.readNodes().flatMap(node => {
        const origin = node.data?.frameAnalysisResult as { ownerId?: string; manifest?: string; sceneIndex?: number } | undefined;
        if (origin?.ownerId !== id || origin.manifest !== result.manifest) return [];
        const scene = scenes.get(origin.sceneIndex ?? 0); const kind = node.type?.replace(/^remote-/, "");
        const label = scene?.annotation && (kind === "imageNode" || kind === "videoNode") ? `${kind === "imageNode" ? "S" : "M"}${String(scene.index).padStart(2, "0")} · ${scene.annotation.shotSize} · ${scene.annotation.cameraAngle} · ${scene.annotation.description}` : undefined;
        return [{ id: node.id, data: { frameAnalysisResult: { ...origin, manifest: path, ...(scene?.annotation ? { annotation: scene.annotation } : {}) }, ...(label ? { label } : {}) } }];
      });
      await workbench.updateNodes([{ id, data: { frameAnalysis: { ...saved, lastResult: annotated } } }, ...updates], revision, signal);
      if (task?.hostPending || progress?.phase === "host") {
        if (task) { task.state = "completed"; task.label = "宿主报告已保存"; task.error = undefined; }
        await workbench.updateRuntimeData({ analysisProgress: { percent: 100, label: "宿主报告已保存", status: "completed", phase: "host" } }, signal); await document.save();
      }
      return { manifest: path, scenes: annotated.scenes.length, overview: !!annotated.overview, updatedNodes: updates.length, revision: document.getRevision() };
    }
    async function requestAnalysis(input: z.output<typeof mediaValueSchema>, result: AnalysisResult, settings: ReturnType<typeof state>, signal: AbortSignal) {
      const response = await workbench.hostRequest({ kind: "edit", prompt: `请分析视频分析节点 ${id} 的真实视频、关键帧与镜头片段，逐镜头观察景别、角度、运动与画面内容，并归纳叙事、节奏与剪辑。分析重点：${settings.focus || "完整分析"}。结果清单位于 ${result.manifest}。请先发现该节点setAnalysisReport工具的schema，再用它保存结构化镜头分析与整段归纳，manifest须填写 ${result.manifest}；已有逐镜头分析时可只补整段归纳。也可以返回完整正文报告。保留原素材。证据不足的运动与声音推断须明确说明。`, references: [{ dataType: "VIDEO", value: input }, ...result.scenes.flatMap(scene => scene.image ? [{ dataType: "IMAGE", value: { url: scene.image, mimeType: "image/jpeg" } }] : [])], metadata: { nodeId: id, manifest: result.manifest, operation: "analyzeScenes" } }, signal);
      signal.throwIfAborted();
      if ((state() as { lastResult?: AnalysisResult }).lastResult?.manifest !== result.manifest) return "completed";
      if (response.status !== "completed") return "delegated";
      const parsed = reportSchema.safeParse(response.result);
      if (parsed.success) await saveReport(parsed.data, signal);
      else if (response.text?.trim()) {
        if (source().url !== input.url) throw new Error("输入已变化，未保存宿主报告");
        const saved = state() as typeof defaults & { lastResult?: AnalysisResult; hostReport?: unknown };
        if (saved.lastResult?.manifest !== result.manifest) return "completed";
        const report = await createResultNode(workbench, document, id, "text", response.text, "拉片分析报告", undefined, signal);
        await workbench.updateData({ frameAnalysis: { ...state(), hostReport: { text: response.text, nodeId: report.nodeId, manifest: result.manifest } } }, undefined, signal);
        await document.save();
      } else if ((state() as { lastResult?: AnalysisResult }).lastResult?.manifest === result.manifest) return "delegated";
      return "completed";
    }
    context.registerTool({ name: "getAnalysisStatus", outputSchema: z.strictObject({ status: z.string(), percent: z.number(), label: z.string().optional(), error: z.string().optional(), settings: settingsOutputSchema, result: resultSummarySchema.optional(), revision: z.number().int().nonnegative() }), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, description: "读取本地拉片真实状态、配置和上次结果摘要；关键帧/镜头引用请分页调用getAnalysisFrames，完整报告读取manifest。", parameters: z.strictObject({}), execute() { const saved = readNodeData(document, id).analysisProgress as { status?: string; percent?: number; label?: string } | undefined; return { status: task?.state ?? (saved?.status === "running" ? "interrupted" : saved?.status) ?? "idle", percent: task?.percent ?? saved?.percent ?? 0, label: task?.label ?? saved?.label, error: task?.error, settings: config(), result: (() => { const value = state() as typeof defaults & { lastResult?: AnalysisResult; resultSource?: string }; const result = value.lastResult; return result ? { manifest: result.manifest, sceneCount: result.scenes.length, width: result.width, height: result.height, duration: result.duration, source: value.resultSource ?? null, sourceCurrent: value.resultSource === source().url, overview: result.overview } : undefined; })(), revision: document.getRevision() }; } });
    context.registerTool({ name: "setSource", outputSchema: z.strictObject({ source: mediaValueSchema }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, description: "指定工作区已有视频，已有上游连线时优先使用连线。", parameters: mediaValueSchema,
      async execute(args, { signal }) { workbench.assertWritable(); assertIdle(); if (!args.mimeType.startsWith("video/")) throw new Error("请选择视频文件"); await workbench.files.readRange?.(args.url, 0, 1, undefined, signal); await workbench.updateData({ frameAnalysis: { ...state(), source: args } }, undefined, signal); await document.save(); return { source: args }; } });
    context.registerTool({ name: "setAnalysisConfig", outputSchema: settingsOutputSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, description: "修改本地检测维度、阈值与宿主分析重点，不启动处理。", parameters: settingsSchema,
      async execute(args, { signal }) { assertIdle(); await workbench.updateData({ frameAnalysis: { ...state(), ...args } }, undefined, signal); await document.save(); return config(); } });
    context.registerTool({ name: "cancelAnalysis", outputSchema: z.strictObject({ status: z.string() }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, description: "取消本地解码、场景检测或宿主补充分析，保留上次结果；宿主未确认远端终止时保留unknown。acknowledge=true放弃已无活动进程的unknown/interrupted/delegated任务并写为cancelled以解除节点锁定，原任务迟到的文件只留在其独立目录。", parameters: z.strictObject({ acknowledge: z.boolean().optional() }), async execute(args) {
      task?.controller.abort(new Error("用户取消拉片")); await task?.promise;
      const saved = readNodeData(document, id).analysisProgress as { status?: string; phase?: string } | undefined;
      if (args.acknowledge && ["running", "delegated", "unknown"].includes(task?.state ?? saved?.status ?? "")) {
        workbench.assertWritable(); task = undefined;
        await workbench.updateRuntimeData({ analysisProgress: { ...saved, status: "abandoned", label: "已解除锁定，原任务可能仍在运行，上次结果保留" } }); await document.save();
      } else if (saved?.status === "delegated" || !task && saved?.status === "running") {
        if (task) { task.state = "unknown"; task.label = "宿主尚未确认终止，等待实际报告"; }
        await workbench.updateRuntimeData({ analysisProgress: { ...saved, status: "unknown", label: "任务尚未确认终止，保留本地结果与原任务" } }); await document.save();
      }
      return { status: task?.state ?? (readNodeData(document, id).analysisProgress as { status?: string } | undefined)?.status ?? "idle" };
    } });
    context.registerTool({ name: "setAnalysisReport", outputSchema: z.strictObject({ manifest: relativePathSchema, scenes: z.number().int().nonnegative(), overview: z.boolean(), updatedNodes: z.number().int().nonnegative(), revision: z.number().int().nonnegative() }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, description: "将宿主Agent观察到的结构化逐镜头分析和整段归纳保存为新报告版本；manifest须匹配当前结果。", parameters: reportSchema, execute: (args, { signal }) => saveReport(args, signal) });
    context.registerTool({ name: "analyzeScenes", outputSchema: z.strictObject({ status: z.string() }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }, description: "在已有本地拉片结果上补充或重试宿主Agent分析，不重复切镜和生成素材。可传prompt保存本次分析重点，不传则沿用已保存重点。", parameters: z.strictObject({ prompt: z.string().max(2000).optional() }), async execute(args, { signal }) {
      workbench.assertWritable(); signal.throwIfAborted();
      assertIdle();
      const input = source(); const settings = { ...state(), ...(args.prompt !== undefined ? { focus: args.prompt } : {}) }; const result = (settings as { lastResult?: AnalysisResult; resultSource?: string }).lastResult;
      if (!result || (settings as { resultSource?: string }).resultSource !== input.url) throw new Error("请先完成当前视频的本地拉片");
      const operation = { controller: new AbortController(), promise: Promise.resolve(), state: "running", percent: 100, label: "等待宿主分析", hostPending: true, error: undefined as string | undefined };
      task = operation; const combined = AbortSignal.any([context.signal, operation.controller.signal]);
      operation.promise = (async () => { try {
          if (args.prompt !== undefined) await workbench.updateData({ frameAnalysis: settings }, undefined, combined);
          combined.throwIfAborted();
          await workbench.updateRuntimeData({ analysisProgress: { percent: 100, label: operation.label, status: "running", phase: "host" } }, combined); await document.save();
          if (source().url !== input.url || (state() as { lastResult?: AnalysisResult }).lastResult?.manifest !== result.manifest) throw new Error("拉片结果或输入已变化，请重新读取后分析");
          operation.state = await requestAnalysis(input, result, settings, combined); operation.label = operation.state === "completed" ? "宿主报告已保存" : "已交给宿主补充分析"; }
        catch (error) { operation.state = !!isExecutionUnknown(error) ? "unknown" : combined.aborted ? "cancelled" : "failed"; operation.error = errorText(error); operation.label = `本地结果已保留；${operation.error}`; }
        finally { if (!context.signal.aborted) await workbench.updateRuntimeData({ analysisProgress: { percent: 100, label: operation.label, status: operation.state, phase: "host" } }).then(() => document.save()).catch(() => {}); } })();
      return { status: "running" };
    } });
    context.registerTool({ name: "analyzeVideo", outputSchema: z.strictObject({ status: z.string() }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }, description: "本地检测分镜、提取关键帧/镜头片段/原音轨，并将真实结果生成到画布。可用aiEnabled覆盖本次是否继续交给宿主，不传则沿用已保存配置；false只执行本地拉片。立即返回，状态用getAnalysisStatus读取。", parameters: z.strictObject({ aiEnabled: z.boolean().optional() }),
      async execute(args, { signal }) {
        workbench.assertWritable(); signal.throwIfAborted();
        assertIdle();
        const input = source(); const settings = state();
        const aiEnabled = args.aiEnabled ?? settings.aiEnabled;
        if (!settings.frames && !settings.clips && !settings.audio) throw new Error("请至少选择一个拆解维度");
        const operation = { controller: new AbortController(), promise: Promise.resolve(), state: "running", percent: 0, label: "准备读取素材", hostPending: false, error: undefined as string | undefined };
        const combined = AbortSignal.any([context.signal, operation.controller.signal]);
        task = operation;
        const outputId = crypto.randomUUID();
        operation.promise = (async () => {
          let published = false;
          try {
            await workbench.updateRuntimeData({ analysisProgress: { percent: 0, label: operation.label, status: "running", phase: "local" } }, combined); await document.save();
            const directory = await createMediaDirectory(workbench, outputId);
            const ffmpeg = await workbench.ffmpeg(combined);
            const result = await analyzeVideo({ ffmpeg, workspace: workbench.files, source: input.url, directory, method: settings.method, threshold: settings.threshold, minSceneSeconds: settings.minSceneSeconds, frames: settings.frames, clips: settings.clips, audio: settings.audio, signal: combined,
              onProgress(percent, label) { operation.percent = Math.round(percent); operation.label = label; void workbench.updateRuntimeData({ analysisProgress: { percent: operation.percent, label, status: "running", phase: "local" } }, combined).catch(() => {}); } });
            combined.throwIfAborted();
            if (source().url !== input.url) throw new Error("输入视频已变化，未发布本次结果");
            const nodes = resultNodes(result, id, document.readNode(id));
            await workbench.createNodes(nodes, [], combined);
            published = true;
            const chosenSource = (state() as Record<string, unknown>).source;
            await workbench.updateData({ frameAnalysis: { ...settings, ...(chosenSource ? { source: chosenSource } : {}), lastResult: result, resultSource: input.url } }, undefined, combined);
            operation.hostPending = aiEnabled;
            await workbench.updateRuntimeData({ analysisProgress: { percent: 100, label: aiEnabled ? "本地拉片完成，等待宿主分析" : "拉片完成", status: aiEnabled ? "running" : "completed", phase: operation.hostPending ? "host" : "local" } }, combined);
            await document.save();
            operation.percent = 100; operation.label = "拉片完成";
            if (aiEnabled) {
              operation.state = await requestAnalysis(input, result, settings, combined);
              operation.label = operation.state === "completed" ? "宿主报告已保存" : "已交给宿主补充分析";
            } else operation.state = "completed";
            await workbench.updateRuntimeData({ analysisProgress: { percent: operation.percent, label: operation.label, status: operation.state, phase: operation.hostPending ? "host" : "local" } }, combined);
            await document.save();
          } catch (error) {
            const unknown = !!isExecutionUnknown(error);
            operation.state = unknown ? "unknown" : published ? "completed" : combined.aborted ? "cancelled" : "failed"; operation.error = operation.state === "cancelled" ? undefined : published ? `本地拉片已完成，宿主补充分析未完成：${errorText(error)}` : errorText(error);
            if (!published && !unknown) await workbench.files.remove(`assets/${outputId}`, true).catch(() => {});
            if (!context.signal.aborted) await workbench.updateRuntimeData({ analysisProgress: { percent: operation.percent, label: operation.error ?? "已取消", status: operation.state, phase: operation.hostPending ? "host" : "local" } }).then(() => document.save()).catch(() => {});
          }
        })();
        return { status: "running" };
      } });
  },
};

function resultNodes(result: AnalysisResult, ownerId: string, owner: unknown) {
  const position = (owner as { position?: { x: number; y: number } })?.position ?? { x: 0, y: 0 };
  const nodes: Record<string, unknown>[] = [];
  const media = result.scenes.flatMap(scene => [
    ...(scene.image ? [{ kind: "image", path: scene.image, mimeType: "image/jpeg", label: `S${String(scene.index).padStart(2, "0")} · ${scene.start.toFixed(2)}–${scene.end.toFixed(2)}s`, index: scene.index }] : []),
    ...(scene.video ? [{ kind: "video", path: scene.video, mimeType: "video/mp4", label: `M${String(scene.index).padStart(2, "0")} · ${scene.start.toFixed(2)}–${scene.end.toFixed(2)}s`, index: scene.index }] : []),
  ]);
  if (result.audio) media.push({ kind: "audio", path: result.audio, mimeType: "audio/mp4", label: "A01 · 原音轨", index: 0 });
  for (let offset = 0; offset < media.length; offset += 12) {
    const groupId = crypto.randomUUID(); const items = media.slice(offset, offset + 12); const columns = Math.min(3, items.length);
    nodes.push({ id: groupId, type: "canvasGroup", position: { x: position.x + 420, y: position.y + offset / 12 * 1260 }, style: { width: `${columns * 352 + 24}px`, height: `${Math.ceil(items.length / columns) * 300 + 56}px` }, data: { label: `拉片结果 ${offset / 12 + 1}` } });
    items.forEach((item, index) => nodes.push({ id: crypto.randomUUID(), type: `${item.kind}Node`, parentNode: groupId, position: { x: 24 + index % columns * 352, y: 40 + Math.floor(index / columns) * 300 }, data: { label: item.label, frameAnalysisResult: { ownerId, manifest: result.manifest, sceneIndex: item.index }, handles: [{ id: item.kind, type: "source", dataType: item.kind.toUpperCase(), label: "输出" }], outputs: { [item.kind]: { dataType: item.kind.toUpperCase(), value: { url: item.path, mimeType: item.mimeType } } } } }));
  }
  return nodes;
}

export default plugin;
