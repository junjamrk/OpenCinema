import { z } from "zod";
import type { NodeInputValue } from "@toonflow/nodes-scaffold/values";

export const shotBriefSchema = z.strictObject({
  subject: z.string().max(2000).default(""),
  action: z.string().max(3000).default(""),
  subjectDirection: z.string().max(2000).default(""),
  screenDirection: z.string().max(1000).default(""),
  cameraMotion: z.string().max(2000).default(""),
  framing: z.string().max(1000).default(""),
  continuity: z.string().max(2000).default(""),
  continuousShot: z.boolean().default(true),
});
export type ShotBrief = z.infer<typeof shotBriefSchema>;
export const referenceRoleSchema = z.enum(["general", "instruction", "identity", "composition", "motion", "exclude"]);
export type ReferenceRole = z.infer<typeof referenceRoleSchema>;
export const referenceRoleLabels: Record<ReferenceRole, string> = { general: "通用参考", instruction: "创作指令", identity: "主体身份", composition: "构图参考", motion: "运动参考（软参考）", exclude: "不用于生成" };
export const reviewCheckSchema = z.enum(["unreviewed", "pass", "fail", "notApplicable"]);
export const videoReviewChecksSchema = z.strictObject({ direction: reviewCheckSchema, action: reviewCheckSchema, identity: reviewCheckSchema, continuity: reviewCheckSchema, unwantedCuts: reviewCheckSchema, artifacts: reviewCheckSchema });
export const reviewCheckLabels = { direction: "行进方向", action: "动作成立", identity: "主体身份", continuity: "空间连续", unwantedCuts: "意外切镜", artifacts: "形变与品牌" };
export const videoReviewSchema = z.strictObject({
  source: z.string().min(1), sourceRevision: z.string().min(1), taskId: z.string().optional(),
  status: z.enum(["approved", "rejected"]), start: z.number().finite().nonnegative(), end: z.number().finite().positive(),
  checks: videoReviewChecksSchema, notes: z.string().trim().min(1).max(10000), reviewedAt: z.string(), revision: z.number().int().positive().optional(),
});
export type VideoReview = z.infer<typeof videoReviewSchema>;
const videoSourceSchema = z.strictObject({ path: z.string().min(1), sourceRevision: z.string().optional(), taskId: z.string().optional(), origin: z.enum(["generated", "derived", "imported"]).optional(), sources: z.array(z.strictObject({ path: z.string().min(1), sourceRevision: z.string().optional() })).optional(), review: videoReviewSchema.optional() });
export type VideoSource = z.infer<typeof videoSourceSchema>;

export function referenceKey(input: Pick<NodeInputValue, "source" | "sourceHandle">) { return encodeURIComponent(JSON.stringify([input.source, input.sourceHandle])); }
export function readReferenceRole(data: Record<string, unknown>, input: Pick<NodeInputValue, "source" | "sourceHandle">): ReferenceRole {
  const roles = data.referenceRoles as Record<string, unknown> | undefined;
  return referenceRoleSchema.parse(roles?.[referenceKey(input)] ?? "general");
}
export function activeVideoReferences(data: Record<string, unknown>, inputs: NodeInputValue[]) { return inputs.filter(input => readReferenceRole(data, input) !== "exclude"); }
export function readShotBrief(data: Record<string, unknown>) { return data.shotBrief == null ? null : shotBriefSchema.parse(data.shotBrief); }
export function readVideoReview(data: Record<string, unknown>) { return data.shotReview == null ? null : videoReviewSchema.parse(data.shotReview); }
export function compareVideoReviews(left: VideoReview, right: VideoReview) {
  const revision = (right.revision ?? 0) - (left.revision ?? 0);
  if (revision) return revision;
  if (left.status !== right.status) return left.status === "rejected" ? -1 : 1;
  return right.reviewedAt.localeCompare(left.reviewedAt);
}
export function readVideoSources(data: Record<string, unknown>): VideoSource[] {
  const sources = z.array(videoSourceSchema).parse(data.videoSourceHistory ?? []);
  const generation = data.generation as { taskId?: string; status?: string; output?: { url?: string; mimeType?: string } } | undefined;
  const output = data.outputs as { video?: { value?: { url?: string } } } | undefined;
  const path = generation?.output?.mimeType?.startsWith("video/") ? generation.output.url : generation?.status === "completed" ? output?.video?.value?.url : undefined;
  if (path && generation?.taskId && !sources.some(value => value.path === path)) sources.push({ path, taskId: generation.taskId, origin: "generated" });
  const review = readVideoReview(data);
  if (review) {
    const source = sources.find(value => value.path === review.source && (!value.sourceRevision || value.sourceRevision === review.sourceRevision));
    if (source && (!source.review || compareVideoReviews(review, source.review) <= 0)) { source.sourceRevision = review.sourceRevision; source.review = review; }
    if (!source) sources.push({ path: review.source, sourceRevision: review.sourceRevision, origin: "imported", review, ...(review.taskId ? { taskId: review.taskId } : {}) });
  }
  return sources;
}
export function readVideoReviews(data: Record<string, unknown>) {
  const current = readVideoReview(data);
  return [...(current ? [current] : []), ...readVideoSources(data).flatMap(source => source.review ? [source.review] : [])];
}
export function isGeneratedVideo(data: Record<string, unknown>, source: string) {
  return readVideoSources(data).some(value => value.path === source && value.origin !== "imported");
}

export function videoShotPrompt(data: Record<string, unknown>, inputs: NodeInputValue[]) {
  const brief = readShotBrief(data);
  const directions = brief ? [
    brief.continuousShot ? "单个连续镜头，从开始到结束保持同一机位逻辑。动作连续，不自行切镜或插入其他景别。" : "允许按本镜头计划切镜。",
    ...([ ["主体", brief.subject], ["本镜单一主要动作", brief.action], ["主体相对地面／自身朝向的运动", brief.subjectDirection], ["主体在画面中的方向", brief.screenDirection], ["摄影机运动（与主体运动分开）", brief.cameraMotion], ["景别与构图", brief.framing], ["前后镜连续性", brief.continuity] ] as const).filter(([, value]) => value.trim()).map(([label, value]) => `${label}：${value.trim()}`),
  ].join("\n") : "";
  const counts: Record<string, number> = {};
  const names = new Map<number, string>();
  const roles: string[] = [];
  const text = inputs.flatMap((input, index) => {
    const role = readReferenceRole(data, input);
    if (role === "exclude") return [];
    if (typeof input.dataType === "string") counts[input.dataType] = (counts[input.dataType] ?? 0) + 1;
    if (input.dataType === "STRING" && typeof input.value === "string") { names.set(index + 1, `文本参考 ${index + 1}`); return [`文本参考 ${index + 1}${role === "instruction" ? "（创作指令）" : ""}：\n${input.value}`]; }
    const name = input.dataType === "IMAGE" ? "图片" : input.dataType === "VIDEO" ? "视频" : "音频";
    const ordinal = counts[String(input.dataType)];
    names.set(index + 1, `${name}${ordinal}`);
    if (role === "identity") roles.push(`${name}${ordinal}仅参考主体的可识别外观；机位、构图和动作以本镜头计划为准。`);
    if (role === "composition") roles.push(`${name}${ordinal}用于本镜构图与空间布局。`);
    if (role === "motion") roles.push(`${name}${ordinal}用于连续运动和摄影机调度的视觉参考；最终画面重建成所要求的材质与美术。`);
    return [];
  });
  return [directions, String(data.prompt ?? "").trim(), ...text, roles.join("\n")].filter(Boolean).join("\n\n").replace(/\{\{ref\s+(\d+)\}\}/g, (_token, number: string) => {
    const name = names.get(Number(number));
    if (!name) throw new Error(`引用 {{ref ${number}}} 已排除或不存在；请修正创作指令，未提交生成`);
    return name;
  });
}

export function videoCreativeFingerprint(data: Record<string, unknown>, inputs: NodeInputValue[]) {
  return JSON.stringify({ references: inputs, brief: readShotBrief(data), roles: data.referenceRoles ?? {}, ...Object.fromEntries(["prompt", "model", "ratio", "resolution", "duration", "mode", "generateAudio"].map(key => [key, data[key]])) });
}

export function videoReviewAllows(review: VideoReview | null, source: string, sourceRevision: string, start: number, end: number, taskId?: string) {
  return !!review && review.status === "approved" && review.source === source && review.sourceRevision === sourceRevision && (!taskId || review.taskId === taskId) && Object.values(review.checks).every(value => value === "pass" || value === "notApplicable") && start >= review.start - 1e-7 && end <= review.end + 1e-7;
}
