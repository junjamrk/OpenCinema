import { z } from "zod";
import { frameCountPolicy } from "./mediaSampling";

const relativePath = z.string().min(1).max(4096).refine(value => !value.startsWith("/") && !value.includes("\\")
  && !/[\u0000-\u001f:]/.test(value) && value.split("/").every(part => part && part !== "." && part !== ".."), "须使用工作区内的相对路径");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const nodeId = z.string().min(1).max(200).refine(value => !/[\\/\u0000-\u001f]/.test(value) && value !== "." && value !== "..", "节点ID无效");

export const referenceDepthSettingsSchema = z.strictObject({
  start: z.number().finite().min(0), end: z.number().finite().positive(), sampleFps: z.number().int().min(2).max(12),
}).refine(value => value.end > value.start && value.end - value.start <= 30, "相对深度分析范围须大于0且不超过30秒");
export const referenceDepthBindingSchema = z.strictObject({
  operationId: z.uuid(), directory: z.string().min(1).max(4096), canvasId: relativePath.refine(value => /\.json$/i.test(value) && !value.startsWith("assets/"), "请选择已保存的普通画布"), nodeId,
});
export const referenceDepthStartSchema = referenceDepthBindingSchema.extend({
  sourcePath: relativePath, contentSha256: digest, settings: referenceDepthSettingsSchema,
});
export type ReferenceDepthBinding = z.infer<typeof referenceDepthBindingSchema>;
export type ReferenceDepthStart = z.infer<typeof referenceDepthStartSchema>;

export const referenceDepthModelSchema = z.strictObject({
  id: z.enum(["depthAnythingSmall", "videoDepthAnythingSmall"]), revision: z.string().min(1).max(200), backend: z.enum(["onnx-cpu", "pytorch"]),
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/).optional(), sourceArchiveSha256: digest.optional(), sourceArchiveSize: z.number().int().positive().max(32 * 1024 ** 2).optional(),
  fingerprint: digest, license: z.literal("Apache-2.0"),
  files: z.array(z.strictObject({ name: relativePath, sha256: digest, size: z.number().int().positive().max(256 * 1024 ** 2) })).min(1).max(32),
}).refine(value => value.id === "depthAnythingSmall" ? value.backend === "onnx-cpu"
  : value.backend === "pytorch" && !!value.sourceRevision && !!value.sourceArchiveSha256 && !!value.sourceArchiveSize, "深度模型与推理后端或固定源码不一致");
export const referenceDepthNormalizationSchema = z.enum([
  "per-frame min/max; relative inverse depth, no metric calibration",
  "clip min/max; temporally aligned relative inverse depth, no metric calibration",
]);
const videoSchema = z.strictObject({
  width: z.number().int().min(48).max(384), height: z.number().int().min(48).max(384),
  fps: z.number().finite().positive(), frameRate: z.string().min(3).max(100).refine(value => {
    const pieces = value.split("/");
    return pieces.length === 2 && Number(pieces[1]) > 0 && Number.isFinite(Number(pieces[0]) / Number(pieces[1])) && Number(pieces[0]) / Number(pieces[1]) > 0;
  }, "编码帧率须为有限正分数"), frameCount: z.number().int().min(1).max(360), duration: z.number().finite().positive().max(31),
  sampleCount: z.number().int().min(1).max(360), validSourceDuration: z.number().finite().positive().max(30),
  mapping: z.strictObject({ sourceTimeOffset: z.number().finite().min(0), clipTimeScale: z.literal(1), sourceMappedVideoEnd: z.number().finite().min(0).max(30) }),
  lastFrameHold: z.strictObject({ start: z.number().finite().min(0), end: z.number().finite().positive(), seconds: z.number().finite().min(0), note: z.string().min(1).max(1000) }),
});
const fileSchema = z.strictObject({ path: relativePath, mimeType: z.string().min(1).max(100), size: z.number().int().positive().max(100 * 1024 ** 2), sha256: digest });
export const referenceDepthArtifactSchema = fileSchema.extend({
  kind: z.enum(["depthData", "depthControl", "depthPoster"]), video: videoSchema.optional(),
}).refine(value => value.mimeType === ({ depthData: "application/json", depthControl: "video/mp4", depthPoster: "image/png" }[value.kind])
  && (value.kind === "depthControl") === (value.video !== undefined), "相对深度产物类型与元数据不一致");
export const referenceDepthResultSchema = z.strictObject({
  schemaVersion: z.union([z.literal(1), z.literal(2)]), operationId: z.uuid(), canvasId: relativePath, nodeId,
  frameCountPolicy: z.enum([frameCountPolicy, "legacyCeil"]).optional(),
  source: z.strictObject({ path: relativePath, contentSha256: digest, width: z.number().int().positive().max(16384), height: z.number().int().positive().max(16384), duration: z.number().finite().positive(), fps: z.number().finite().positive() }),
  settings: referenceDepthSettingsSchema, model: referenceDepthModelSchema,
  normalization: referenceDepthNormalizationSchema,
  runtime: z.record(z.string().max(100), z.union([z.string().max(1000), z.number().finite(), z.boolean()])),
  artifacts: z.array(referenceDepthArtifactSchema).length(3), manifest: fileSchema,
}).refine(value => (value.schemaVersion === 1 ? value.model.id === "depthAnythingSmall" && value.normalization.startsWith("per-frame")
  : value.model.id === "videoDepthAnythingSmall" && value.normalization.startsWith("clip"))
  && new Set(value.artifacts.map(artifact => artifact.kind)).size === 3
  && [value.manifest, ...value.artifacts].every(file => file.path.startsWith(`assets/${value.nodeId}/motionDepth${value.operationId.replaceAll("-", "")}/`)), "相对深度产物不属于当前操作");
export type ReferenceDepthResult = z.infer<typeof referenceDepthResultSchema>;
export const referenceDepthStatusSchema = referenceDepthBindingSchema.extend({
  state: z.enum(["preparing", "running", "cancelling", "succeeded", "failed", "cancelled", "unknown"]),
  executionSettled: z.boolean(), cancelRequested: z.boolean(),
  outputDirectory: relativePath.optional(), input: referenceDepthStartSchema.optional(), result: referenceDepthResultSchema.optional(),
  error: z.string().max(10000).optional(), errorCode: z.string().max(100).optional(),
});
export type ReferenceDepthStatus = z.infer<typeof referenceDepthStatusSchema>;
export const referenceDepthPreparationSchema = z.strictObject({
  phase: z.enum(["missing", "preparing", "cancelling", "committing", "ready", "failed", "cancelled"]),
  received: z.number().nonnegative(), total: z.number().nonnegative(), error: z.string().optional(),
});
export const referenceDepthModelStatusSchema = z.strictObject({
  available: z.boolean(), model: referenceDepthModelSchema, phase: z.enum(["missing", "preparing", "cancelling", "committing", "ready", "failed", "cancelled"]),
  runtimeAvailable: z.boolean(), mediaToolsAvailable: z.boolean(), message: z.string().max(2000),
  preparation: z.strictObject({ automatic: z.literal(false), entry: z.string().min(1).max(200), modelId: z.enum(["depthAnythingSmall", "videoDepthAnythingSmall"]) }),
  preparationProgress: referenceDepthPreparationSchema.optional(),
});
export type ReferenceDepthModelStatus = z.infer<typeof referenceDepthModelStatusSchema>;
