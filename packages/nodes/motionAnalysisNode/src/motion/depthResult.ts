import { z } from "zod";
import type { WorkspaceFiles } from "@toonflow/nodes-scaffold/nodeFiles";
import { referenceDepthNormalizationSchema, referenceDepthResultSchema, type ReferenceDepthResult } from "@toonflow/node-shared/referenceDepth";
import { countSampleFrames, frameCountPolicy } from "@toonflow/node-shared/mediaSampling";

export const depthDataSchema = z.object({
  frameCountPolicy: z.enum([frameCountPolicy, "legacyCeil"]).optional(),
  space: z.literal("relative"), fps: z.number().int().min(2).max(12), duration: z.number().finite().positive().max(30),
  width: z.number().int().min(1).max(16384), height: z.number().int().min(1).max(16384),
  frames: z.array(z.object({ time: z.number().finite().min(0), min: z.number().finite(), max: z.number().finite(), mean: z.number().finite() })).min(1).max(360),
});
export const motionDepthSchema = depthDataSchema.extend({ provenance: referenceDepthResultSchema });
export type MotionDepth = z.infer<typeof motionDepthSchema>;

export async function fileSha256(bytes: ArrayBuffer) {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, "0")).join("");
}

export function validateMotionDepth(depth: MotionDepth, source: { url: string; contentSha256: string }, settings: { start: number; end: number; sampleFps: number }) {
  const { provenance } = depth, duration = settings.end - settings.start;
  const control = provenance.artifacts.find(artifact => artifact.kind === "depthControl")!;
  const video = control.video!;
  const [numerator, denominator] = video.frameRate.split("/").map(Number);
  const policy = depth.frameCountPolicy ?? "legacyCeil";
  const count = countSampleFrames(duration, settings.sampleFps, policy);
  if (provenance.source.path !== source.url || provenance.source.contentSha256 !== source.contentSha256
    || (provenance.frameCountPolicy ?? "legacyCeil") !== policy
    || JSON.stringify(provenance.settings) !== JSON.stringify(settings) || depth.fps !== settings.sampleFps || Math.abs(depth.duration - duration) > 0.001
    || depth.width !== provenance.source.width || depth.height !== provenance.source.height || depth.frames.length !== count
    || depth.frames.some((frame, index) => Math.abs(frame.time - index / depth.fps) > 0.001 || frame.time >= duration || frame.min > frame.mean || frame.mean > frame.max)
    || video.sampleCount !== count || video.frameCount !== count || Math.abs(numerator! / denominator! - video.fps) > 0.001
    || Math.abs(video.fps - depth.fps) > 0.001 || Math.abs(video.duration - count / depth.fps) > 0.002
    || Math.abs(video.validSourceDuration - duration) > 0.001 || Math.abs(video.mapping.sourceTimeOffset - settings.start) > 0.001
    || Math.abs(video.mapping.sourceMappedVideoEnd - Math.min(duration, video.duration)) > 0.001
    || Math.abs(video.lastFrameHold.start - video.mapping.sourceMappedVideoEnd) > 0.001 || Math.abs(video.lastFrameHold.end - video.duration) > 0.001
    || Math.abs(video.lastFrameHold.seconds - Math.max(0, video.duration - duration)) > 0.001) throw new Error("Depth 报告的来源、采样或实际视频映射不一致");
}

export async function readDepthFile(files: WorkspaceFiles, file: { path: string; size: number; sha256: string }, signal: AbortSignal) {
  signal.throwIfAborted();
  const bytes = await files.read(file.path, file.size, signal);
  signal.throwIfAborted();
  if (bytes.byteLength !== file.size || await fileSha256(bytes) !== file.sha256) throw new Error(`Depth 产物已变化，保留原引用：${file.path}`);
  signal.throwIfAborted();
  return bytes;
}

export async function readMotionDepth(files: WorkspaceFiles, value: ReferenceDepthResult, signal: AbortSignal): Promise<MotionDepth> {
  const result = referenceDepthResultSchema.parse(value);
  const manifestBytes = await readDepthFile(files, result.manifest, signal);
  const manifest = referenceDepthResultSchema.parse({ ...JSON.parse(new TextDecoder().decode(manifestBytes)), manifest: result.manifest });
  if (JSON.stringify(manifest) !== JSON.stringify(result)) throw new Error("Depth manifest 与服务端冻结回执不一致");
  let depth: z.infer<typeof depthDataSchema> | undefined;
  for (const artifact of result.artifacts) {
    const bytes = await readDepthFile(files, artifact, signal);
    if (artifact.kind !== "depthData") continue;
    const document = z.object({ schemaVersion: z.union([z.literal(1), z.literal(2)]), referenceId: z.string(), contentFingerprint: z.string(),
      range: z.object({ start: z.number(), end: z.number() }), mapping: z.object({ sourceTimeOffset: z.number(), clipTimeScale: z.literal(1) }),
      normalization: referenceDepthNormalizationSchema, depth: depthDataSchema }).parse(JSON.parse(new TextDecoder().decode(bytes)));
    if (document.schemaVersion !== result.schemaVersion || document.normalization !== result.normalization
      || document.referenceId !== result.operationId || document.contentFingerprint !== result.source.contentSha256
      || document.range.start !== result.settings.start || document.range.end !== result.settings.end || document.mapping.sourceTimeOffset !== result.settings.start) {
      throw new Error("Depth JSON 与冻结源片或区间不一致");
    }
    depth = document.depth;
  }
  if (!depth) throw new Error("Depth 结果缺少真实采样 JSON");
  const measured = { ...depth, provenance: result };
  validateMotionDepth(measured, { url: result.source.path, contentSha256: result.source.contentSha256 }, result.settings);
  return measured;
}
