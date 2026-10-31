import { z } from "zod";
import type { PluginActivationContext, PluginToolDefinition, PluginToolContext } from "@toonflow/nodes-scaffold/contracts";
import type { NodeWorkbenchService } from "@toonflow/nodes-scaffold/workbenchServices";
import type { NodeMediaValue } from "@toonflow/nodes-scaffold/values";
import { uploadNodeFile } from "@toonflow/nodes-scaffold/nodeFiles";
import { mediaValueSchema, nodePreconditionError, pluginServices, readMedia, readNodeData } from "@toonflow/node-shared/reactNode";
import { buildLightingPrompt, lightingSettingsSchema, readLightingSettings } from "./imageLighting";
import { buildMultiAnglePrompt, multiAngleSettingsSchema, readMultiAngleSettings } from "./imageMultiAngle";
import { getPanoramaViews } from "./imagePanorama";
import { createPanoramaRenderer, panoramaSchema } from "./panoramaRenderer";
import { readMediaSourceRevision, readMediaSourceSnapshot } from "@toonflow/node-shared/mediaEditor";

import { imageEditor, imageDraftSchema, imageHistorySchema, strokesSchema, type ImageStroke } from "./imageEditor";
export type { ImageStroke } from "./imageEditor";
const annotationLayers = new WeakMap<HTMLCanvasElement, HTMLCanvasElement>();

export async function readImageSnapshot(workbench: NodeWorkbenchService, source: NodeMediaValue, signal: AbortSignal, sourceRevision?: string) {
  const { content, revision } = await readMediaSourceSnapshot(workbench.files, source.url, 100 * 1024 ** 2, signal, sourceRevision);
  signal.throwIfAborted();
  if (!content.byteLength || content.byteLength > 100 * 1024 ** 2) throw new Error("图片须为 100 MiB 以内的非空文件");
  const url = URL.createObjectURL(new Blob([content], { type: source.mimeType }));
  const image = new Image(); image.src = url;
  try {
    await image.decode(); signal.throwIfAborted();
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 32 * 1024 ** 2) throw new Error("图片编辑支持最多 3200 万像素");
    const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d"); if (!context) throw new Error("浏览器无法创建图像编辑器");
    context.drawImage(image, 0, 0);
    return { canvas, revision };
  } finally { URL.revokeObjectURL(url); }
}
export async function readImageCanvas(workbench: NodeWorkbenchService, source: NodeMediaValue, signal: AbortSignal) { return (await readImageSnapshot(workbench, source, signal)).canvas; }

export function drawImageStrokes(canvas: HTMLCanvasElement, strokes: ImageStroke[], mask = false, opacity = 1) {
  let layer = annotationLayers.get(canvas);
  if (!layer) { layer = globalThis.document.createElement("canvas"); annotationLayers.set(canvas, layer); }
  if (layer.width !== canvas.width || layer.height !== canvas.height) { layer.width = canvas.width; layer.height = canvas.height; }
  const context = layer.getContext("2d"); if (!context) throw new Error("无法创建标记画布");
  context.clearRect(0, 0, layer.width, layer.height);
  context.lineCap = "round"; context.lineJoin = "round";
  for (const stroke of strokes) {
    if (stroke.tool === "clear") { context.clearRect(0, 0, layer.width, layer.height); continue; }
    context.globalCompositeOperation = stroke.tool === "eraser" ? "destination-out" : "source-over";
    context.strokeStyle = mask ? "#ffffff" : stroke.color; context.fillStyle = context.strokeStyle; context.lineWidth = stroke.width;
    const first = stroke.points[0]!;
    if (stroke.tool === "text") { context.font = `${stroke.width}px sans-serif`; context.textBaseline = "top"; stroke.text!.split("\n").forEach((line, index) => context.fillText(line, first.x * canvas.width, first.y * canvas.height + index * stroke.width * 1.25)); continue; }
    if (stroke.tool === "rectangle" || stroke.tool === "circle") {
      const end = stroke.points[1]!; const x = first.x * canvas.width; const y = first.y * canvas.height; const width = (end.x - first.x) * canvas.width; const height = (end.y - first.y) * canvas.height;
      context.beginPath(); if (stroke.tool === "rectangle") context.rect(x, y, width, height);
      else context.ellipse(x + width / 2, y + height / 2, Math.abs(width) / 2, Math.abs(height) / 2, 0, 0, Math.PI * 2);
      // 蒙版要覆盖框内区域；只描边时局部重绘只会换掉一圈边线。
      if (mask) context.fill();
      context.stroke(); continue;
    }
    context.beginPath(); context.moveTo(first.x * canvas.width, first.y * canvas.height);
    for (const point of stroke.points.slice(1)) context.lineTo(point.x * canvas.width, point.y * canvas.height);
    if (stroke.points.length > 1) context.stroke(); else { context.arc(first.x * canvas.width, first.y * canvas.height, stroke.width / 2, 0, Math.PI * 2); context.fill(); }
  }
  const target = canvas.getContext("2d"); if (!target) throw new Error("无法创建标记画布");
  target.globalAlpha = opacity; target.drawImage(layer, 0, 0); target.globalAlpha = 1;
}

export function canvasBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("图片编码失败")), "image/png"));
}

function sourceValue(context: PluginActivationContext) {
  const { id, document, workbench } = pluginServices(context);
  const output = readMedia(readNodeData(document, id), "image");
  if (output) return output;
  const inputs = workbench.getInputs("in").filter(input => input.dataType === "IMAGE");
  const source = mediaValueSchema.safeParse(inputs[0]?.value);
  if (!source.success || !source.data.mimeType.startsWith("image/")) throw nodePreconditionError(workbench, id, "当前节点没有可用图片；请先选择图片输出或连接有效图片参考");
  return source.data;
}

export function registerImageEditingTools(context: PluginActivationContext) {
  const { id, document, workbench } = pluginServices(context);
  const actions = new Map<string, (args: unknown, call: PluginToolContext) => unknown>();
  const createdImagesSchema = z.strictObject({ nodeIds: z.array(z.string()) });
  const draftNodeSchema = z.strictObject({ nodeId: z.string(), prompt: z.string().optional(), status: z.literal("draft") });
  const actionResults = new Map<string, z.ZodType>([["markImage", createdImagesSchema], ["splitGrid", createdImagesSchema], ["transformImage", createdImagesSchema], ["capturePanorama", createdImagesSchema], ["createInpaint", draftNodeSchema]]);
  function registerImageTool<Schema extends z.ZodType, Result extends z.ZodType = z.ZodType>(definition: PluginToolDefinition<Schema, Result>) {
    actions.set(definition.name, (args, call) => definition.execute(definition.parameters.parse(args), call));
    context.registerTool({ ...definition, outputSchema: definition.outputSchema ?? actionResults.get(definition.name), annotations: definition.annotations ?? { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } });
  }
  let operation: AbortController | undefined;
  let job: Promise<unknown> | undefined;
  let editingSourceRevision: string | undefined;
  const stop = async () => { operation?.abort(new Error("节点即将变更")); await job?.catch(() => {}); };
  context.onBeforeChange(stop);
  context.onDispose(stop);
  const draft = imageEditor(workbench, readMedia(readNodeData(document, id), "image")?.url ?? "", readNodeData(document, id));
  const strokePageSchema = z.strictObject({ tool: z.enum(["brush", "eraser", "rectangle", "circle", "text", "clear"]).optional(), text: z.string().optional(), color: z.string(), width: z.number(), index: z.number().int(), pointCount: z.number().int(), points: z.array(z.strictObject({ x: z.number(), y: z.number() })), nextPointOffset: z.number().int().nullable() });
  const draftOutput = imageDraftSchema.omit({ strokes: true }).extend({ strokes: z.array(strokePageSchema), totalStrokes: z.number().int(), nextStrokeOffset: z.number().int().nullable(), draftRevision: z.number().int().nonnegative(), currentSourceRevision: z.string(), sourceCurrent: z.boolean(), history: imageHistorySchema, persistence: z.literal("memory"), saved: z.literal(false) });
  function requireDraftIdle() {
    if (draft.history.gestureActive) throw nodePreconditionError(workbench, id, "图片编辑台正在绘制或拖动，请等待手势结束后重新读取草稿", "draftBusy", { action: "readState", message: "等待history.gestureActive为false，再用最新draftRevision操作", tool: "getImageDraft" });
  }
  function requireDraftRevision(expectedRevision: number) {
    if (draft.read().revision !== expectedRevision) throw nodePreconditionError(workbench, id, "图片草稿已变化，未修改草稿历史", "draftRevisionConflict", { action: "readState", message: "重新读取getImageDraft并使用最新draftRevision", tool: "getImageDraft" });
  }
  const readDraft = async (options: { strokeOffset?: number; strokeLimit?: number; pointOffset?: number; pointLimit?: number } = {}, signal?: AbortSignal) => {
    const snapshot = draft.read(), value = snapshot.value, strokeOffset = options.strokeOffset ?? 0, strokeLimit = options.strokeLimit ?? 4, pointOffset = options.pointOffset ?? 0, pointLimit = options.pointLimit ?? 128;
    const source = sourceValue(context), current = await readMediaSourceRevision(workbench.files, source.url, undefined, signal);
    if (draft.read().revision !== snapshot.revision) throw Object.assign(new Error("图片草稿在读取期间变化，请重新读取"), { code: "draftRevisionConflict", actualRevision: draft.read().revision });
    return { ...value, strokes: value.strokes.slice(strokeOffset, strokeOffset + strokeLimit).map((stroke, index) => ({ ...stroke, index: strokeOffset + index, pointCount: stroke.points.length, points: stroke.points.slice(pointOffset, pointOffset + pointLimit), nextPointOffset: pointOffset + pointLimit < stroke.points.length ? pointOffset + pointLimit : null })), totalStrokes: value.strokes.length, nextStrokeOffset: strokeOffset + strokeLimit < value.strokes.length ? strokeOffset + strokeLimit : null, draftRevision: snapshot.revision, currentSourceRevision: current.revision, sourceCurrent: value.source === source.url && (value.sourceRevision === null || value.sourceRevision === current.revision), history: draft.history, persistence: "memory" as const, saved: false as const };
  };
  context.registerTool({ name: "applyImageDraft", description: "明确采用同一编辑台草稿：mark保存标记副本，inpaint创建重绘草稿，crop/grid/panorama本地生成新图片，lighting/angle创建生成草稿；不启动付费生成。", parameters: z.strictObject({ expectedDraftRevision: z.number().int().nonnegative(), action: z.enum(["mark", "inpaint", "crop", "grid", "lighting", "angle", "panorama"]) }), outputSchema: z.union([createdImagesSchema, draftNodeSchema]), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, async execute(args, call) {
    workbench.assertWritable(); requireDraftIdle(); requireDraftRevision(args.expectedDraftRevision);
    const snapshot = draft.read();
    if (snapshot.value.source !== sourceValue(context).url) throw Object.assign(new Error("源图片已变化，未采用旧选区"), { code: "draftSourceChanged" });
    if (!snapshot.value.sourceRevision) throw Object.assign(new Error("草稿尚未绑定源图片版本，请先getImageDraft并用currentSourceRevision明确建立草稿"), { code: "draftSourceRevisionRequired" });
    await readMediaSourceRevision(workbench.files, snapshot.value.source, snapshot.value.sourceRevision, call.signal);
    requireDraftIdle(); requireDraftRevision(args.expectedDraftRevision);
    if (snapshot.value.source !== sourceValue(context).url) throw nodePreconditionError(workbench, id, "源图片已变化，未采用旧选区", "draftSourceChanged", { action: "readState", message: "重新读取getImageDraft并确认当前图片", tool: "getImageDraft" });
    const value = snapshot.value, strokes = value.strokes.slice(0, value.strokeCount);
    if (["mark", "inpaint"].includes(args.action) && !strokes.length) throw new Error("请先在草稿绘制有效选区或标记");
    const choices = { mark: ["markImage", { strokes }], inpaint: ["createInpaint", { strokes }], crop: ["transformImage", { crop: value.crop }], grid: ["splitGrid", { rows: value.rows, columns: value.columns }], lighting: ["createLighting", { settings: value.lighting }], angle: ["createMultiAngle", { settings: value.angle }], panorama: ["capturePanorama", value.panorama] } as const;
    const [name, input] = choices[args.action]; const action = actions.get(name); if (!action) throw new Error("图片编辑工具尚未就绪");
    return z.union([createdImagesSchema, draftNodeSchema]).parse(await action({ ...input, sourceRevision: snapshot.value.sourceRevision }, call));
  } });
  registerImageTool({ name: "getImageDraft", description: "读取同一图片编辑台的未采用草稿与局部撤销/重做history。笔画按strokeOffset/pointOffset分页，最多4笔×128点；坐标为原图归一化0–1，笔宽为原图像素。使用draftRevision固定连续读取；currentSourceRevision是本编辑台的文件快照版本，sourceRevision=null表示尚未绑定；history仅包含最多50步内容编辑，开关编辑台/切换页签不入历史。草稿与历史仅保留于当前runtime内存。", parameters: z.strictObject({ strokeOffset: z.number().int().nonnegative().optional(), strokeLimit: z.number().int().min(1).max(4).optional(), pointOffset: z.number().int().nonnegative().optional(), pointLimit: z.number().int().min(1).max(128).optional(), expectedDraftRevision: z.number().int().nonnegative().optional() }), outputSchema: draftOutput, annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }, execute(args) { if (args.expectedDraftRevision !== undefined && args.expectedDraftRevision !== draft.read().revision) throw Object.assign(new Error("图片草稿已变化，请重新开始读取"), { code: "draftRevisionConflict", actualRevision: draft.read().revision }); return readDraft(args); } });
  registerImageTool({ name: "setImageDraft", description: "修改同一图片编辑台草稿，不生成文件或节点。须携带源路径、getImageDraft的currentSourceRevision和草稿版本；源版本变化时清除旧笔画/裁剪，只有显式提供的新选区才保留。open=true打开真实编辑台。", parameters: imageDraftSchema.omit({ source: true, strokeCount: true }).partial().extend({ source: z.string().min(1), sourceRevision: z.string().min(1).describe("getImageDraft.currentSourceRevision或图像感知sourceRevision；不能传内容SHA fileRevision"), expectedDraftRevision: z.number().int().nonnegative() }), outputSchema: draftOutput, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, async execute(args, { signal }) {
    workbench.assertWritable(); requireDraftIdle(); requireDraftRevision(args.expectedDraftRevision); if (args.source !== sourceValue(context).url) throw Object.assign(new Error("源图片已变化，未应用旧选区"), { code: "draftSourceChanged" });
    await readMediaSourceRevision(workbench.files, args.source, args.sourceRevision, signal);
    requireDraftIdle(); requireDraftRevision(args.expectedDraftRevision);
    if (args.source !== sourceValue(context).url) throw nodePreconditionError(workbench, id, "源图片已变化，未应用旧选区", "draftSourceChanged", { action: "readState", message: "重新读取getImageDraft的source与currentSourceRevision", tool: "getImageDraft" });
    const { expectedDraftRevision, ...patch } = args; const stored = draft.read().value;
    const previous = stored.source === args.source && stored.sourceRevision === args.sourceRevision ? stored : { ...stored, strokes: [], strokeCount: 0, crop: { x: 0, y: 0, width: 1, height: 1 } };
    const next = imageDraftSchema.parse({ ...previous, ...patch, ...(patch.strokes ? { strokeCount: patch.strokes.length } : {}) });
    draft.replace(next, expectedDraftRevision, "Agent 修改图片草稿"); return readDraft();
  } });
  for (const direction of ["undo", "redo"] as const) registerImageTool({ name: direction === "undo" ? "undoImageDraft" : "redoImageDraft", description: `${direction === "undo" ? "撤销" : "重做"}图片编辑台最近一步内容编辑，与手工编辑台共用局部history并切换到相关页签。须使用getImageDraft的source、sourceRevision和draftRevision；手势进行中明确拒绝，不采用草稿、不创建文件或节点、不操作画布历史。`, parameters: z.strictObject({ source: z.string().min(1), sourceRevision: z.string().min(1).describe("getImageDraft的已绑定sourceRevision；不能传内容SHA fileRevision"), expectedDraftRevision: z.number().int().nonnegative() }), outputSchema: draftOutput, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, async execute(args, { signal }) {
    workbench.assertWritable(); requireDraftIdle(); requireDraftRevision(args.expectedDraftRevision);
    function requireSource() {
      const value = draft.read().value;
      if (args.source !== sourceValue(context).url || value.source !== args.source || value.sourceRevision !== args.sourceRevision) throw nodePreconditionError(workbench, id, "图片源或草稿绑定版本已变化，未操作历史", "draftSourceChanged", { action: "readState", message: "重新读取getImageDraft并确认sourceCurrent与sourceRevision", tool: "getImageDraft" });
    }
    requireSource(); await readMediaSourceRevision(workbench.files, args.source, args.sourceRevision, signal);
    requireDraftIdle(); requireDraftRevision(args.expectedDraftRevision); requireSource();
    draft[direction](args.expectedDraftRevision); return readDraft({}, signal);
  } });
  registerImageTool({ name: "setImageEditSettings", description: "保存图片打光与多角度编辑参数，不创建生成请求。", parameters: z.strictObject({ lighting: lightingSettingsSchema.optional(), multiAngle: multiAngleSettingsSchema.optional() }).refine(value => value.lighting || value.multiAngle, "请提供打光或多角度设置"), outputSchema: z.strictObject({ lighting: lightingSettingsSchema.optional(), multiAngle: multiAngleSettingsSchema.optional() }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async execute(args, { signal }) {
    workbench.assertWritable();
    const generation = readNodeData(document, id).generation as { status?: string } | undefined;
    if (["running", "delegated", "unknown", "cancelRequested"].includes(generation?.status ?? "")) throw new Error("生成任务尚未完成，请先确认任务终态");
    const settings = { ...(args.lighting ? { lighting: readLightingSettings(args.lighting) } : {}), ...(args.multiAngle ? { multiAngle: readMultiAngleSettings(args.multiAngle) } : {}) };
    await workbench.updateData(settings, undefined, signal); await document.save(); return settings;
  } });
  async function edit(signal: AbortSignal, action: (canvas: HTMLCanvasElement, source: NodeMediaValue, signal: AbortSignal) => Promise<unknown>, sourceRevision?: string) {
    workbench.assertWritable(); if (job) throw new Error("此节点正在处理图片");
    operation = new AbortController();
    const combined = AbortSignal.any([signal, context.signal, operation.signal]); const source = sourceValue(context);
    job = (async () => { const snapshot = await readImageSnapshot(workbench, source, combined, sourceRevision); editingSourceRevision = snapshot.revision; combined.throwIfAborted(); return action(snapshot.canvas, source, combined); })();
    try { return await job; } finally { job = undefined; operation = undefined; editingSourceRevision = undefined; }
  }
  async function publish(canvases: { canvas: HTMLCanvasElement; label: string }[], source: NodeMediaValue, signal: AbortSignal, layoutColumns?: number) {
    const owner = document.readNode(id) as { position?: { x: number; y: number }; data?: Record<string, unknown> };
    const groupId = canvases.length > 1 ? crypto.randomUUID() : undefined; const columns = Math.min(layoutColumns ?? 3, canvases.length);
    const created: Record<string, unknown>[] = []; const edges: Record<string, unknown>[] = [];
    if (groupId) created.push({ id: groupId, type: "canvasGroup", position: { x: (owner.position?.x ?? 0) + 420, y: owner.position?.y ?? 0 }, style: { width: `${columns * 352 + 24}px`, height: `${Math.ceil(canvases.length / columns) * 300 + 56}px` }, data: { label: `${String(owner.data?.label ?? "图片")} · ${canvases.length} 张` } });
    for (const [index, item] of canvases.entries()) {
      signal.throwIfAborted(); const childId = crypto.randomUUID();
      const path = await uploadNodeFile(workbench.files, childId, new File([await canvasBlob(item.canvas)], "image.png", { type: "image/png" }));
      signal.throwIfAborted();
      created.push({ id: childId, type: "imageNode", ...(groupId ? { parentNode: groupId } : {}), position: { x: groupId ? 24 + index % columns * 352 : (owner.position?.x ?? 0) + 420, y: groupId ? 40 + Math.floor(index / columns) * 300 : owner.position?.y ?? 0 }, data: { label: `${String(owner.data?.label ?? "图片")} · ${item.label}`, handles: [{ id: "in", type: "target", dataType: "IMAGE", label: "来源图片" }, { id: "image", type: "source", dataType: "IMAGE", label: "输出" }], outputs: { image: { dataType: "IMAGE", value: { url: path, mimeType: "image/png" } } } } });
      edges.push({ id: crypto.randomUUID(), source: id, sourceHandle: "image", target: childId, targetHandle: "in" });
    }
    if (JSON.stringify(sourceValue(context)) !== JSON.stringify(source)) throw new Error("源图片已变化，已保存文件保留，未创建结果节点");
    await readMediaSourceRevision(workbench.files, source.url, editingSourceRevision, signal, "failed");
    await workbench.createNodes(created, edges, signal); await document.save(); return { nodeIds: created.map(node => node.id) };
  }
  registerImageTool({ name: "markImage", description: "将归一化坐标笔画绘制为新图片节点，保留原图。", parameters: z.strictObject({ strokes: strokesSchema.min(1), sourceRevision: z.string().min(1).describe("getImageDraft.currentSourceRevision或图像感知sourceRevision；不能传内容SHA fileRevision").optional() }), execute(args, { signal }) { return edit(signal, async (canvas, source, current) => { drawImageStrokes(canvas, args.strokes); return publish([{ canvas, label: "标记" }], source, current); }, args.sourceRevision); } });
  registerImageTool({ name: "splitGrid", description: "按宫格将图片实际裁切为多个图片节点并分组，保留原图。", parameters: z.strictObject({ rows: z.number().int().min(1).max(10), columns: z.number().int().min(1).max(10), sourceRevision: z.string().min(1).describe("getImageDraft.currentSourceRevision或图像感知sourceRevision；不能传内容SHA fileRevision").optional() }), execute(args, { signal }) { return edit(signal, async (sourceCanvas, source, current) => {
    const pieces: { canvas: HTMLCanvasElement; label: string }[] = [];
    if (args.columns > sourceCanvas.width || args.rows > sourceCanvas.height) throw new Error("宫格尺寸超过图片像素数");
    for (let row = 0; row < args.rows; row++) for (let column = 0; column < args.columns; column++) {
      const left = Math.round(column * sourceCanvas.width / args.columns); const right = Math.round((column + 1) * sourceCanvas.width / args.columns); const top = Math.round(row * sourceCanvas.height / args.rows); const bottom = Math.round((row + 1) * sourceCanvas.height / args.rows);
      const canvas = globalThis.document.createElement("canvas"); canvas.width = right - left; canvas.height = bottom - top;
      canvas.getContext("2d")!.drawImage(sourceCanvas, left, top, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
      pieces.push({ canvas, label: `${row + 1}-${column + 1}` });
    }
    return publish(pieces, source, current, args.columns);
  }, args.sourceRevision); } });
  registerImageTool({ name: "transformImage", description: "本地旋转、翻转或按归一化范围裁剪图片，创建新节点。", parameters: z.strictObject({ rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(), flipX: z.boolean().optional(), flipY: z.boolean().optional(), sourceRevision: z.string().min(1).describe("getImageDraft.currentSourceRevision或图像感知sourceRevision；不能传内容SHA fileRevision").optional(), crop: z.strictObject({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) }).refine(value => value.x + value.width <= 1 && value.y + value.height <= 1).optional() }), execute(args, { signal }) { return edit(signal, async (sourceCanvas, source, current) => {
    const crop = args.crop ?? { x: 0, y: 0, width: 1, height: 1 }; const width = Math.max(1, Math.round(crop.width * sourceCanvas.width)); const height = Math.max(1, Math.round(crop.height * sourceCanvas.height)); const rotation = args.rotation ?? 0;
    const canvas = globalThis.document.createElement("canvas"); canvas.width = rotation % 180 ? height : width; canvas.height = rotation % 180 ? width : height;
    const painter = canvas.getContext("2d")!; painter.translate(canvas.width / 2, canvas.height / 2); painter.rotate(rotation * Math.PI / 180); painter.scale(args.flipX ? -1 : 1, args.flipY ? -1 : 1); painter.drawImage(sourceCanvas, crop.x * sourceCanvas.width, crop.y * sourceCanvas.height, width, height, -width / 2, -height / 2, width, height);
    return publish([{ canvas, label: "编辑" }], source, current);
  }, args.sourceRevision); } });
  registerImageTool({ name: "createInpaint", description: "用真实原图与白色蒙版创建局部重绘子节点；只创建草稿，不发起生成。prompt可省略，之后通过统一创作入口填写要求。", parameters: z.strictObject({ prompt: z.string().trim().min(1).max(10000).optional(), strokes: strokesSchema.min(1), sourceRevision: z.string().min(1).describe("getImageDraft.currentSourceRevision或图像感知sourceRevision；不能传内容SHA fileRevision").optional() }), execute(args, { signal }) { return edit(signal, async (canvas, source, current) => {
    const childId = crypto.randomUUID(); const mask = globalThis.document.createElement("canvas"); mask.width = canvas.width; mask.height = canvas.height; drawImageStrokes(mask, args.strokes, true);
    const guide = globalThis.document.createElement("canvas"); guide.width = canvas.width; guide.height = canvas.height; const painter = guide.getContext("2d")!; painter.drawImage(canvas, 0, 0); drawImageStrokes(guide, args.strokes.map(stroke => ({ ...stroke, color: "#ff0000" })));
    const originalPath = await uploadNodeFile(workbench.files, childId, new File([await canvasBlob(canvas)], "original.png", { type: "image/png" }));
    const maskPath = await uploadNodeFile(workbench.files, childId, new File([await canvasBlob(mask)], "mask.png", { type: "image/png" }));
    const guidePath = await uploadNodeFile(workbench.files, childId, new File([await canvasBlob(guide)], "guide.png", { type: "image/png" }));
    current.throwIfAborted(); if (sourceValue(context).url !== source.url) throw new Error("原图片已变化，未创建重绘子节点");
    await readMediaSourceRevision(workbench.files, source.url, editingSourceRevision, current, "failed");
    const parent = document.readNode(id) as { position?: { x: number; y: number } };
    await workbench.createNodes([{ id: childId, type: "imageGenerationNode", position: { x: (parent.position?.x ?? 0) + 420, y: parent.position?.y ?? 0 }, data: { label: "局部重绘", ...(args.prompt ? { prompt: args.prompt } : {}), model: "", inpaint: { source: source.url, original: originalPath, guide: guidePath, mask: maskPath, images: [] }, handles: [{ id: "in", type: "target", dataType: ["IMAGE", "STRING"], label: "参考输入" }, { id: "image", type: "source", dataType: "IMAGE", label: "输出" }], outputs: {} } }], [{ id: crypto.randomUUID(), source: id, sourceHandle: "image", target: childId, targetHandle: "in" }], current);
    await document.save(); return { nodeId: childId, status: "draft" };
  }, args.sourceRevision); } });
  for (const mode of ["lighting", "multiAngle"] as const) registerImageTool({ name: mode === "lighting" ? "createLighting" : "createMultiAngle", description: `${mode === "lighting" ? "打光" : "多角度"}参数转换为有真实图像参考的生成子节点；不直接启动付费生成。`, parameters: z.strictObject({ settings: mode === "lighting" ? lightingSettingsSchema : multiAngleSettingsSchema, sourceRevision: z.string().min(1).describe("getImageDraft.currentSourceRevision或图像感知sourceRevision；不能传内容SHA fileRevision").optional() }), outputSchema: z.strictObject({ nodeId: z.string(), prompt: z.string(), status: z.literal("draft") }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async execute(args, { signal }) {
      workbench.assertWritable(); const source = sourceValue(context); const childId = crypto.randomUUID(); const owner = document.readNode(id) as { position?: { x: number; y: number } };
      const sourceRevision = (await readMediaSourceRevision(workbench.files, source.url, args.sourceRevision, signal)).revision;
      const prompt = mode === "lighting" ? "按当前灯光设置重新打光" : "按当前机位设置生成新视角";
      const parameters = mode === "lighting" ? readLightingSettings(args.settings) : readMultiAngleSettings(args.settings);
      await workbench.updateData({ [mode]: parameters }, undefined, signal);
      await readMediaSourceRevision(workbench.files, source.url, sourceRevision, signal);
      await workbench.createNodes([{ id: childId, type: "imageGenerationNode", position: { x: (owner.position?.x ?? 0) + 420, y: owner.position?.y ?? 0 }, data: { label: mode === "lighting" ? "打光" : "多角度", imageEdit: mode, prompt, model: parameters.model, size: parameters.size, ratio: parameters.ratio, [mode]: parameters, sourceImage: source, handles: [{ id: "in", type: "target", dataType: ["STRING", "IMAGE"], label: "参考输入" }, { id: "image", type: "source", dataType: "IMAGE", label: "输出" }], outputs: {} } }], [{ id: crypto.randomUUID(), source: id, sourceHandle: "image", target: childId, targetHandle: "in" }], signal);
      await document.save(); return { nodeId: childId, prompt, status: "draft" as const };
    } });
  registerImageTool({ name: "capturePanorama", description: "本地球面或柱面投影并叠加镜头/透视/拉伸/地平线/接缝校正，截取1/4/12个1280×720视角；可拼图或分图。", parameters: panoramaSchema.safeExtend({ sourceRevision: z.string().min(1).describe("getImageDraft.currentSourceRevision或图像感知sourceRevision；不能传内容SHA fileRevision").optional() }), execute(args, { signal }) { return edit(signal, async (sourceCanvas, source, current) => {
    const projector = createPanoramaRenderer(sourceCanvas, args.mode);
    const canvases: { canvas: HTMLCanvasElement; label: string }[] = [];
    try {
      for (const view of getPanoramaViews(args.mode, args.count, args.yaw ?? 0, args.pitch ?? 0)) {
        current.throwIfAborted(); projector.render({ ...args, yaw: view.yaw, pitch: view.pitch });
        const canvas = globalThis.document.createElement("canvas"); canvas.width = 1280; canvas.height = 720; canvas.getContext("2d")!.drawImage(projector.canvas, 0, 0); canvases.push({ canvas, label: view.label });
      }
      if (args.layout === "combined" && canvases.length > 1) {
        const columns = args.count === 4 ? 2 : 4; const combined = globalThis.document.createElement("canvas"); combined.width = 1280 * columns; combined.height = 720 * Math.ceil(canvases.length / columns);
        canvases.forEach((item, index) => combined.getContext("2d")!.drawImage(item.canvas, index % columns * 1280, Math.floor(index / columns) * 720));
        return await publish([{ canvas: combined, label: `全景 ${args.count} 宫格` }], source, current);
      }
      return await publish(canvases, source, current, args.count === 4 ? 2 : 4);
    } finally { projector.dispose(); }
  }, args.sourceRevision); } });
}

export function buildImageEditPrompt(prompt: string, data: Record<string, unknown>) {
  const settings = data.imageEdit === "lighting" ? buildLightingPrompt(readLightingSettings(data.lighting))
    : data.imageEdit === "multiAngle" ? buildMultiAnglePrompt(readMultiAngleSettings(data.multiAngle)) : "";
  return settings ? `${settings}\n\n创作要求：${prompt}` : prompt;
}

export async function composeInpaintResult(workbench: NodeWorkbenchService, nodeId: string, data: Record<string, unknown>, result: { path: string; mimeType: string }, signal: AbortSignal) {
  if (!data.inpaint || typeof data.inpaint !== "object") return result;
  const inpaint = data.inpaint as { original?: unknown; mask?: unknown };
  const original = await readImageCanvas(workbench, mediaValueSchema.parse({ url: inpaint.original, mimeType: "image/png" }), signal);
  const mask = await readImageCanvas(workbench, mediaValueSchema.parse({ url: inpaint.mask, mimeType: "image/png" }), signal);
  if (original.width !== mask.width || original.height !== mask.height) throw new Error("原图与蒙版尺寸不一致");
  const generated = await readImageCanvas(workbench, { url: result.path, mimeType: result.mimeType }, signal);
  const output = globalThis.document.createElement("canvas"); output.width = original.width; output.height = original.height;
  const painter = output.getContext("2d")!; painter.drawImage(generated, 0, 0, output.width, output.height); painter.globalCompositeOperation = "destination-in"; painter.drawImage(mask, 0, 0); painter.globalCompositeOperation = "destination-over"; painter.drawImage(original, 0, 0);
  const path = await uploadNodeFile(workbench.files, nodeId, new File([await canvasBlob(output)], "inpaint.png", { type: "image/png" })); signal.throwIfAborted(); return { path, mimeType: "image/png" };
}
