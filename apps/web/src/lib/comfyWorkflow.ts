import { z } from "zod";

// 导入时推断一次映射并交用户确认，生成时服务端只按保存的映射替换字段，不再猜测。
const nodeSchema = z.object({ class_type: z.string().min(1), inputs: z.record(z.string(), z.unknown()), _meta: z.object({ title: z.string().optional() }).passthrough().optional() }).passthrough();
const workflowSchema = z.record(z.string(), nodeSchema);
type ComfyWorkflow = z.infer<typeof workflowSchema>;
export type ComfyMediaType = "image" | "video" | "audio";
export type ComfyTarget = { node: string; field: string };
export type ComfyRole = "firstFrame" | "lastFrame" | "reference" | "keep";
export type ComfyLoader = ComfyTarget & { type: ComfyMediaType; title: string; role: ComfyRole };
export type ComfyTextNode = { node: string; title: string; fields: string[] };
export type ComfyAnalysis = {
  workflow: ComfyWorkflow; type: ComfyMediaType; textNodes: ComfyTextNode[]; promptNode: string; loaders: ComfyLoader[];
  size?: { width: number; height: number; targets: ComfyTarget[] }; frames?: { count: number; targets: ComfyTarget[] }; fps?: number;
};

const mediaFiles: [ComfyMediaType, RegExp][] = [["image", /\.(png|jpe?g|webp|bmp|gif)$/i], ["video", /\.(mp4|mov|webm|mkv|avi|m4v)$/i], ["audio", /\.(wav|mp3|flac|ogg|m4a|opus)$/i]];
const textFields = /^(text|text_?g|text_?l|prompt|positive_prompt|caption|clip_l|t5xxl|string(_a)?|value)$/i;
const frameFields = ["length", "frames", "num_frames", "frame_count", "video_frames", "video_length"];
const rateFields = ["fps", "frame_rate", "framerate"];
const nodeOrder = (a: string, b: string) => Number(a) - Number(b) || a.localeCompare(b);
const nodeTitle = (workflow: ComfyWorkflow, id: string) => `${workflow[id]?._meta?.title || workflow[id]?.class_type} #${id}`;
const isLink = (value: unknown): value is [string, number] => Array.isArray(value) && typeof value[0] === "string";

function reachable(workflow: ComfyWorkflow, fields: string[]) {
  const found = new Set<string>();
  const visit = (value: unknown) => {
    if (!isLink(value) || found.has(value[0]) || !workflow[value[0]]) return;
    found.add(value[0]);
    Object.values(workflow[value[0]]!.inputs).forEach(visit);
  };
  for (const node of Object.values(workflow)) for (const field of fields) visit(node.inputs[field]);
  return found;
}

function promptNode(workflow: ComfyWorkflow, textNodes: ComfyTextNode[]) {
  const positive = reachable(workflow, ["positive", "conditioning"]), negative = reachable(workflow, ["negative"]);
  const title = (node: string) => workflow[node]?._meta?.title ?? "";
  const candidates = textNodes.filter(({ node }) => !/negative|负向|反向/i.test(title(node)));
  // Flux 等工作流用 ConditioningZeroOut 从正向条件派生负向，正向节点会同时出现在两条路径上。
  return (candidates.find(({ node }) => positive.has(node) && !negative.has(node)) ?? candidates.find(({ node }) => /positive|prompt|正向|提示词/i.test(title(node))) ?? candidates.find(({ node }) => positive.has(node)) ?? candidates.find(({ node }) => !negative.has(node)))?.node ?? "";
}

function loaderRole(title: string, type: ComfyMediaType): ComfyRole {
  if (type !== "image") return "reference";
  return /first|start|begin|首帧|起始/i.test(title) ? "firstFrame" : /last|end|尾帧|结束/i.test(title) ? "lastFrame" : "reference";
}

function findSize(workflow: ComfyWorkflow, ids: string[]) {
  const sized = ids.filter(id => typeof workflow[id]?.inputs.width === "number" && typeof workflow[id]?.inputs.height === "number");
  const primary = sized.find(id => /empty|latent|tovideo|video/i.test(workflow[id]!.class_type)) ?? sized[0];
  if (!primary) return undefined;
  const { width, height } = workflow[primary]!.inputs as { width: number; height: number };
  // 只映射与主尺寸相同的节点，放大等后续尺寸保持原样。
  const matching = sized.filter(id => workflow[id]!.inputs.width === width && workflow[id]!.inputs.height === height);
  return { width, height, targets: matching.flatMap(node => [{ node, field: "width" }, { node, field: "height" }]) };
}

function findFrames(workflow: ComfyWorkflow, ids: string[]) {
  const targets = ids.flatMap(node => frameFields.filter(field => typeof workflow[node]?.inputs[field] === "number").map(field => ({ node, field })));
  const count = targets[0] && workflow[targets[0].node]!.inputs[targets[0].field] as number;
  const matching = targets.filter(({ node, field }) => workflow[node]!.inputs[field] === count);
  return count ? { count, targets: matching } : undefined;
}

export function analyzeComfyWorkflow(source: string): ComfyAnalysis {
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new Error("文件不是有效的 JSON"); }
  if (value && typeof value === "object" && "nodes" in value && "links" in value) throw new Error("这是 ComfyUI 画布格式。请在 ComfyUI 中选择“导出（API）”后重新导入");
  const parsed = workflowSchema.safeParse(value);
  if (!parsed.success || !Object.keys(parsed.data).length) throw new Error("文件不是 ComfyUI API 格式的工作流");
  const workflow = parsed.data, ids = Object.keys(workflow).sort(nodeOrder);
  const textNodes = ids.flatMap(node => {
    const fields = Object.entries(workflow[node]!.inputs).flatMap(([field, input]) => typeof input === "string" && textFields.test(field) && !mediaFiles.some(([, pattern]) => pattern.test(input)) ? [field] : []);
    return fields.length ? [{ node, title: nodeTitle(workflow, node), fields }] : [];
  });
  const loaders = ids.flatMap(node => Object.entries(workflow[node]!.inputs).flatMap(([field, input]) => {
    const type = typeof input === "string" ? mediaFiles.find(([, pattern]) => pattern.test(input))?.[0] : undefined;
    const title = nodeTitle(workflow, node);
    return type ? [{ node, field, type, title, role: loaderRole(title, type) }] : [];
  }));
  const outputs = Object.values(workflow).map(node => node.class_type).join(" ");
  const type: ComfyMediaType = /SaveVideo|SaveWEBM|VideoCombine/i.test(outputs) ? "video" : /SaveAudio/i.test(outputs) ? "audio" : "image";
  const fps = ids.flatMap(id => rateFields.map(field => workflow[id]!.inputs[field])).find((rate): rate is number => typeof rate === "number" && rate > 0);
  return { workflow, type, textNodes, promptNode: promptNode(workflow, textNodes), loaders, size: findSize(workflow, ids), frames: fps ? findFrames(workflow, ids) : undefined, ...(fps ? { fps } : {}) };
}

function greatestDivisor(a: number, b: number): number { return b ? greatestDivisor(b, a % b) : a; }

function videoModes(loaders: ComfyLoader[]) {
  const count = (type: ComfyMediaType, role: ComfyRole = "reference") => loaders.filter(item => item.type === type && item.role === role).length;
  const first = count("image", "firstFrame"), last = count("image", "lastFrame"), images = count("image"), videos = count("video"), audios = count("audio");
  if (first > 1 || last > 1) throw new Error("首帧和尾帧各只能指定一个节点");
  if ((first || last) && images + videos + audios) throw new Error("首尾帧不能和其他参考素材同时使用");
  if (first && last) return ["startEndRequired"];
  if (first) return ["endFrameOptional"];
  if (last) return ["startFrameOptional"];
  if (!images && !videos && !audios) return ["text"];
  if (images === 1 && !videos && !audios) return ["singleImage"];
  return [[images && `imageReference:${images}`, videos && `videoReference:${videos}`, audios && `audioReference:${audios}`].filter((value): value is string => !!value)];
}

export function buildComfyModel(analysis: ComfyAnalysis, draft: { id: string; label: string; type: ComfyMediaType; promptNode: string; loaders: ComfyLoader[] }) {
  const textNode = analysis.textNodes.find(item => item.node === draft.promptNode);
  if (!textNode) throw new Error("请选择接收提示词的节点");
  const target = ({ node, field }: ComfyTarget) => ({ node, field });
  const slot = (type: ComfyMediaType, role: ComfyRole = "reference") => draft.loaders.filter(item => item.type === type && item.role === role).map(target);
  const inputs: Record<string, ComfyTarget[]> = { prompt: textNode.fields.map(field => ({ node: textNode.node, field })), images: slot("image"), videos: slot("video"), audios: slot("audio"), firstFrame: slot("image", "firstFrame"), lastFrame: slot("image", "lastFrame") };
  const { size, frames, fps } = analysis;
  if (size) { inputs.width = size.targets.filter(item => item.field === "width"); inputs.height = size.targets.filter(item => item.field === "height"); }
  const video = draft.type === "video";
  const duration = video && frames && fps ? Math.max(1, Math.round(frames.count / fps)) : undefined;
  if (duration) inputs.frames = frames!.targets;
  const divisor = size && greatestDivisor(size.width, size.height);
  const short = size && `${Math.min(size.width, size.height)}p`;
  const frameStep = frames && (frames.count - 1) % 8 === 0 ? 8 : frames && (frames.count - 1) % 4 === 0 ? 4 : 1;
  return {
    id: draft.id, label: draft.label, type: draft.type,
    ...(size && draft.type !== "audio" ? { imageRatios: [`${size.width / divisor!}:${size.height / divisor!}`] } : {}),
    ...(size && draft.type === "image" ? { imageSizes: [short!] } : {}),
    ...(video ? { mode: videoModes(draft.loaders), ...(duration ? { durationResolutionMap: [{ duration: [duration], resolution: short ? [short] : [] }] } : {}) } : {}),
    comfy: { workflow: analysis.workflow, inputs: Object.fromEntries(Object.entries(inputs).filter(([, targets]) => targets.length)), ...(duration ? { fps, frameStep } : {}) },
  };
}
