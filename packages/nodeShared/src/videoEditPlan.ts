import { z } from "zod";
import type { FfprobeData } from "@toonflow/ffmpeg/browser";
import { relativePathSchema } from "./reactNode";
import { videoReviewSchema } from "./videoShot";

export const compositionSourceSchema = z.strictObject({ path: relativePathSchema, sourceRevision: z.string().min(1).max(256).describe("工作区range/getMediaDraft.currentSourceRevision的源快照版本，不能使用内容SHA fileRevision") });
const compositionClipSchema = compositionSourceSchema.extend({ label: z.string().trim().min(1).max(300).optional(), start: z.number().finite().nonnegative().optional(), end: z.number().finite().positive().optional() }).refine(value => value.end === undefined || value.end > (value.start ?? 0), "结束时间须晚于开始时间");
export const videoCompositionSchema = z.strictObject({
  clips: z.array(compositionClipSchema).min(2).max(16),
  resolution: z.enum(["1280x720", "1920x1080", "720x1280", "1080x1920", "1080x1080"]),
  fps: z.union([z.literal(24), z.literal(25), z.literal(30)]),
  audio: compositionSourceSchema.extend({ mode: z.enum(["mix", "replace"]), volume: z.number().finite().min(0).max(2).optional() }).optional(),
});
export const videoEditPlanSchema = videoCompositionSchema.extend({ version: z.literal(1) });
export const renderedVideoPlanSchema = z.strictObject({ planRevision: z.number().int().positive(), path: relativePathSchema, sourceRevision: z.string().min(1), duration: z.number().positive(), width: z.number().int().positive(), height: z.number().int().positive(), fps: z.number().positive() });
const storedVideoEditPlanSchema = z.strictObject({ revision: z.number().int().positive(), plan: videoEditPlanSchema, rendered: renderedVideoPlanSchema.optional() });
const planBlockerSchema = z.strictObject({ code: z.string(), message: z.string() });
const planSourceSchema = z.strictObject({ path: relativePathSchema, expectedRevision: z.string(), currentRevision: z.string().optional(), status: z.enum(["ready", "stale", "unavailable"]), message: z.string().optional() });
export const videoEditPlanOutputSchema = z.strictObject({
  planRevision: z.number().int().nonnegative(), plan: videoEditPlanSchema.nullable(), rendered: renderedVideoPlanSchema.nullable(), status: z.enum(["none", "unrendered", "current", "modified", "sourceChanged", "outputChanged"]), persistence: z.literal("document"), sources: z.array(planSourceSchema),
  clips: z.array(z.strictObject({ index: z.number().int().nonnegative(), label: z.string(), nodeId: z.string().optional(), path: relativePathSchema, sourceRevision: z.string(), sourceStatus: planSourceSchema.shape.status, start: z.number().nonnegative(), end: z.number().nullable(), sourceDuration: z.number().positive().nullable(), frames: z.number().int().positive().nullable(), duration: z.number().positive().nullable(), timelineStart: z.number().nonnegative().nullable(), timelineEnd: z.number().positive().nullable(), reviewRequired: z.boolean(), reviewStatus: z.enum(["notRequired", "pending", "approved", "rejected"]), reviewAllowsRange: z.boolean(), review: videoReviewSchema.nullable(), blockers: z.array(planBlockerSchema) })),
  totalFrames: z.number().int().nonnegative().nullable(), totalDuration: z.number().nonnegative().nullable(), canRender: z.boolean(), blockers: z.array(planBlockerSchema),
});
export type VideoComposition = z.infer<typeof videoCompositionSchema>;
export type VideoEditPlan = z.infer<typeof videoEditPlanSchema>;
export type StoredVideoEditPlan = z.infer<typeof storedVideoEditPlanSchema>;
export type VideoEditPlanSnapshot = z.infer<typeof videoEditPlanOutputSchema>;
export function readVideoEditPlan(data: Record<string, unknown>) { return data.videoEditPlan == null ? null : storedVideoEditPlanSchema.parse(data.videoEditPlan); }

export function resolveCompositionClip(value: VideoComposition["clips"][number], probe: FfprobeData, fps: number) {
  const video = probe.streams.find(stream => stream.codec_type === "video" && !stream.disposition?.attached_pic), audio = probe.streams.find(stream => stream.codec_type === "audio");
  const streamDuration = Number(video?.duration), sourceDuration = Number.isFinite(streamDuration) && streamDuration > 0 ? streamDuration : Number(probe.format.duration);
  const width = Number(video?.width), height = Number(video?.height), start = value.start ?? 0, end = value.end ?? sourceDuration;
  if (!video || !Number.isFinite(sourceDuration) || sourceDuration <= 0 || sourceDuration > 600 || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width > 4096 || height > 4096 || width * height > 4096 * 2160) throw new Error("每项须为600秒以内、画面像素不超过4096×2160且最长边不超过4096的真实视频");
  if (end > sourceDuration || end <= start) throw new Error("镜头范围须在实际视频画面时长内");
  const frames = Math.floor((end - start) * fps + 1e-7);
  if (frames < 1) throw new Error("每个镜头至少保留目标帧率的一帧");
  return { video, audio, sourceDuration, start, end: start + frames / fps, frames, duration: frames / fps };
}

export function compositionAudioStream(probe: FfprobeData) {
  const audio = probe.streams.find(stream => stream.codec_type === "audio");
  const streamDuration = Number(audio?.duration), duration = Number.isFinite(streamDuration) && streamDuration > 0 ? streamDuration : Number(probe.format.duration);
  if (!audio || !Number.isFinite(duration) || duration <= 0 || duration > 600) throw new Error("audio须为600秒以内、包含实际音轨的媒体");
  return audio;
}
