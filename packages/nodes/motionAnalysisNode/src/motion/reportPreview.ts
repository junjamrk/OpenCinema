import { z } from "zod";
import { motionReportSchema } from "./exportMotion";
import type { CameraMotionData, PoseData } from "./types";
import { validateMotionDepth } from "./depthResult";
import { countSampleFrames } from "@toonflow/node-shared/mediaSampling";

export type MotionPreviewReport = {
  kind: "local" | "studio";
  sourceFingerprint: string;
  source?: { url: string; mimeType: string; contentSha256: string };
  settings: { start: number; end: number };
  camera?: CameraMotionData;
  pose?: PoseData;
  diagnostics: string[];
};

const poseSchema = motionReportSchema.shape.pose.unwrap();
const frameCountSchema = z.number().int().min(0).max(360);
const modelStateSchema = z.discriminatedUnion("available", [
  z.object({ available: z.literal(false), reason: z.string().min(1).max(2048) }),
  z.object({ available: z.literal(true), provenance: z.object({
    id: z.enum(["blazePoseLite", "depthAnythingSmall", "videoDepthAnythingSmall"]), backend: z.enum(["tfjs-cpu", "onnx-cpu", "pytorch"]),
    revision: z.string().min(1).max(256), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), license: z.literal("Apache-2.0"),
    files: z.array(z.object({ name: z.string().min(1).max(256), sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().positive() })).min(1).max(64),
  }), runtime: z.record(z.string().min(1).max(128), z.union([z.string().max(2048), z.number().finite(), z.boolean()])).refine(value => Object.keys(value).length <= 64, "模型运行记录过多") }),
]);
const studioReportSchema = z.object({
  schemaVersion: z.literal(1), space: z.literal("image2d"),
  frameCountPolicy: motionReportSchema.shape.frameCountPolicy,
  source: z.object({ referenceId: z.string().min(1).max(80), contentFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    width: z.number().int().min(1).max(16384), height: z.number().int().min(1).max(16384), duration: z.number().finite().positive(), fps: z.number().finite().positive() }),
  range: z.object({ start: z.number().finite().min(0), end: z.number().finite().positive() }),
  mapping: z.object({ sourceTimeOffset: z.number().finite().min(0), clipTimeScale: z.literal(1) }),
  cameraMotion: motionReportSchema.shape.camera.unwrap(),
  models: z.object({ pose: modelStateSchema, depth: modelStateSchema }),
  pose: poseSchema.extend({
    frames: z.array(poseSchema.shape.frames.element.extend({ source: z.enum(["detected", "filled", "missing"]).optional(), filled: z.boolean().optional(), smoothed: z.boolean().optional() })).min(1).max(360),
    summary: poseSchema.shape.summary.extend({ totalFrames: frameCountSchema.optional(), rawDetectedFrames: frameCountSchema.optional(),
      filledFrames: frameCountSchema.optional(), missingFrames: frameCountSchema.optional(), diagnostics: z.array(z.string().max(2048)).max(64).optional() }),
  }).optional(),
  depth: z.object({ frameCountPolicy: motionReportSchema.shape.frameCountPolicy, space: z.literal("relative"), fps: z.number().finite().min(2).max(12), duration: z.number().finite().positive().max(30),
    width: z.number().int().min(1).max(16384), height: z.number().int().min(1).max(16384),
    frames: z.array(z.object({ time: z.number().finite().min(0), min: z.number().finite(), max: z.number().finite(), mean: z.number().finite() })).min(1).max(360) }).optional(),
  quality: z.object({ confidence: z.number().min(0).max(1), status: z.enum(["review", "good"]), measuredFrames: frameCountSchema }),
  warnings: z.array(z.string().max(2048)).max(64),
});

export function readMotionPreviewReport(input: unknown, studio: boolean): MotionPreviewReport {
  if (!studio) {
    const report = motionReportSchema.parse(input);
    if (report.depth) validateMotionDepth(report.depth, report.source, report.settings);
    return { ...report, kind: "local", sourceFingerprint: report.source.contentSha256, diagnostics: report.depth
      ? [`Depth：${report.depth.frames.length} 个真实模型采样帧；${report.depth.provenance.schemaVersion === 2 ? "Video Depth Anything 时序对齐，整片统一归一化" : "旧单帧模型逐帧归一化"}，没有米制尺度。`] : [] };
  }
  const report = studioReportSchema.parse(input);
  const { source, range, mapping, cameraMotion: camera, pose, depth, models } = report;
  const duration = range.end - range.start;
  if (duration <= 0 || duration > 30 || range.end > source.duration + 0.001 || Math.abs(mapping.sourceTimeOffset - range.start) > 0.001
    || camera.width !== source.width || camera.height !== source.height || models.pose.available !== !!pose || models.depth.available !== !!depth
    || models.pose.available && (models.pose.provenance.id !== "blazePoseLite" || models.pose.provenance.backend !== "tfjs-cpu")
    || models.depth.available && !(models.depth.provenance.id === "depthAnythingSmall" && models.depth.provenance.backend === "onnx-cpu"
      || models.depth.provenance.id === "videoDepthAnythingSmall" && models.depth.provenance.backend === "pytorch")) {
    throw new Error("Studio 报告的源片、范围或模型记录不一致，未显示预览");
  }
  for (const stream of [camera, pose, depth]) {
    if (!stream) continue;
    if (stream.fps !== camera.fps || Math.abs(stream.duration - duration) > 0.001 || stream.frames.length > countSampleFrames(duration, stream.fps, stream.frameCountPolicy ?? "legacyCeil")
      || stream.frames.some((frame, index) => Math.abs(frame.time - index / stream.fps) > 0.001 || frame.time >= duration)) {
      throw new Error("Studio 报告的采样或时间映射无效，未显示预览");
    }
  }
  if (camera.frames.some((frame, index) => frame.frameIndex !== index) || pose && (pose.width !== source.width || pose.height !== source.height
    || pose.frames.length !== camera.frames.length || pose.frames.some(frame => frame.source === "missing" ? frame.landmarks.length !== 0
      : (frame.source === "detected" || frame.source === "filled" || frame.filled) && frame.landmarks.length !== 33))) {
    throw new Error("Studio 报告的关键点或帧记录无效，未显示预览");
  }
  const diagnostics = [
    `Studio 权威报告：${report.quality.status === "good" ? "质量良好" : "需要审阅"}，二维运动置信度 ${Math.round(report.quality.confidence * 100)}%，已比较 ${report.quality.measuredFrames} 帧间运动。`,
    `源片 ${source.width}×${source.height}，报告区间 ${range.start.toFixed(2)}–${range.end.toFixed(2)}s，${camera.fps}fps、${camera.frames.length} 个采样帧。`,
    models.pose.available ? `Pose 模型：${models.pose.provenance.id}（${models.pose.provenance.backend}）。` : `Pose 不可用：${models.pose.reason}`,
    models.depth.available ? `Depth 模型：${models.depth.provenance.id}（${models.depth.provenance.backend}），相对深度 ${depth!.frames.length} 帧。` : `Depth 不可用：${models.depth.reason}`,
  ];
  if (pose) {
    const filled = pose.frames.filter(frame => frame.source === "filled" || frame.filled).length;
    const missing = pose.frames.filter(frame => !frame.landmarks.length).length;
    diagnostics.push(`Pose 原始检出 ${pose.summary.rawDetectedFrames ?? "未记录"}/${pose.frames.length} 帧，补帧 ${filled}，缺失 ${missing}；补帧不是该帧的实测结果。`, ...(pose.summary.diagnostics ?? []));
  }
  return { kind: "studio", sourceFingerprint: source.contentFingerprint, settings: { start: mapping.sourceTimeOffset, end: range.end }, camera, pose,
    diagnostics: [...new Set([...diagnostics, ...report.warnings])] };
}
