import { z } from "zod";
import type { BrowserFfmpegCommand, BrowserFfmpegFactory, FfprobeData } from "@toonflow/ffmpeg/browser";
import type { WorkspaceFiles } from "@toonflow/nodes-scaffold/nodeFiles";
import { nodeResourceManifestSchema } from "@toonflow/nodes-scaffold/nodeResources";
import { referenceDepthModelSchema } from "@toonflow/node-shared/referenceDepth";
import { countSampleFrames, frameCountPolicy, type FrameCountPolicy } from "@toonflow/node-shared/mediaSampling";
import { zipSync } from "fflate";
import motionNotice from "../../readme.md?raw";
import { cameraAnalysisSize } from "./cameraMotion";
import { buildOpenPoseJson, renderOpenPoseRgba } from "./openPose";
import { productionDocuments, productionPlanSchema, productionUsageDocuments, type ProductionPlan } from "@toonflow/node-shared/motionProduction";
import { motionDepthSchema, fileSha256, readMotionDepth, readDepthFile, validateMotionDepth } from "./depthResult";

const landmarkSchema = z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite(), visibility: z.number().min(0).max(1).optional(), presence: z.number().min(0).max(1).optional() });
const landmarksSchema = z.array(landmarkSchema).max(33).refine(value => value.length === 0 || value.length === 33, "关键点须为空或完整的33点");
const frameCountPolicySchema = z.enum([frameCountPolicy, "legacyCeil"]);
export const motionReportSchema = z.object({
  schemaVersion: z.literal(1), space: z.literal("image2d"),
  frameCountPolicy: frameCountPolicySchema.optional(),
  source: z.object({ url: z.string().min(1).max(2048), mimeType: z.string().startsWith("video/"), contentSha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  settings: z.object({ start: z.number().finite().min(0), end: z.number().finite().positive(), sampleFps: z.number().int().min(2).max(12) }),
  camera: z.object({
    frameCountPolicy: frameCountPolicySchema.optional(),
    fps: z.number().int().min(2).max(12), duration: z.number().finite().positive().max(30), width: z.number().int().positive().max(16384), height: z.number().int().positive().max(16384),
    frames: z.array(z.object({ time: z.number().finite().min(0), frameIndex: z.number().int().min(0),
      imageMotion: z.object({ xPixels: z.number().finite(), yPixels: z.number().finite(), scale: z.number().finite().positive(), rollRadians: z.number().finite() }),
      cameraMove: z.object({ pan: z.number().finite(), tilt: z.number().finite(), dollyZoom: z.number().finite().positive(), roll: z.number().finite() }), confidence: z.number().min(0).max(1),
    })).min(1).max(360),
    summary: z.object({ panPixels: z.number().finite(), tiltPixels: z.number().finite(), zoomRatio: z.number().finite().positive(), rollDegrees: z.number().finite(), averageConfidence: z.number().min(0).max(1) }),
  }).optional(),
  pose: z.object({
    frameCountPolicy: frameCountPolicySchema.optional(),
    fps: z.number().int().min(2).max(12), duration: z.number().positive().max(30), width: z.number().int().min(1).max(16384), height: z.number().int().min(1).max(16384),
    frames: z.array(z.object({ time: z.number().finite().min(0), landmarks: landmarksSchema, worldLandmarks: landmarksSchema, score: z.number().min(0).max(1), source: z.enum(["detected", "missing"]).optional() })).min(1).max(360),
    summary: z.object({ detectedFrames: z.number().int().min(0).max(360), averageScore: z.number().min(0).max(1) }),
  }).optional(),
  depth: motionDepthSchema.optional(),
  models: z.object({ pose: z.object({ engine: z.string().min(1).max(128), engineVersion: z.string().min(1).max(128), delegate: z.literal("CPU"),
    resources: nodeResourceManifestSchema.transform(value => Object.fromEntries(Object.entries(value).map(([name, { source: _source, ...resource }]) => [name, resource]))),
    worldSpace: z.literal("modelEstimatedHipRelative"), identityTracking: z.literal(false),
  }).optional(), depth: z.object({ provenance: referenceDepthModelSchema, runtime: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean()])) }).optional() }).optional(),
});
export type MotionReport = z.infer<typeof motionReportSchema>;
type VideoMetadata = {
  frameCountPolicy?: FrameCountPolicy;
  duration: number; fps: number; frameRate: string; frameCount: number; width: number; height: number;
  startTime?: number; sampleAspectRatio?: string;
  validSourceDuration: number;
  mapping: { sourceTimeOffset: number; clipTimeScale: 1; sourceMappedVideoEnd: number };
  lastFrameHold: { start: number; end: number; seconds: number; note: string };
  sampling?: string;
};
type ContactSheetMetadata = {
  width: number; height: number; columns: 5; rows: 2; cellWidth: 240; cellHeight: number;
  sampleFps: 1; sampledFrames: number; emptyCells: number; sourceTimeOffset: number; validSourceDuration: number;
  samplingWindowDuration: number; truncated: boolean; note: string;
  samplingVideo: Pick<VideoMetadata, "frameRate" | "frameCount" | "fps" | "duration">;
};
type ReviewMetadata = {
  purpose: "visualReviewOnly";
  clock: { frameCountPolicy: FrameCountPolicy; fps: number; frameCount: number; duration: number; validSourceDuration: number };
  layout: { order: string[]; labels: string[]; cellWidth: number; cellHeight: number; labelHeight: number; fit: "letterbox" };
  inputs: { role: string; path: string; bytes: number; sha256: string; video: VideoMetadata; reviewHold: { start: number; end: number; seconds: number } }[];
  note: string;
};

async function sourceHash(files: WorkspaceFiles, path: string, signal: AbortSignal) {
  const bytes = await files.read(path, 256 * 1024 ** 2, signal);
  signal.throwIfAborted();
  const hash = await fileSha256(bytes);
  signal.throwIfAborted();
  return hash;
}

function run(command: BrowserFfmpegCommand, signal: AbortSignal) {
  signal.throwIfAborted();
  const cancel = () => command.kill();
  signal.addEventListener("abort", cancel, { once: true });
  return new Promise<void>((resolve, reject) => {
    command.on("start", () => { if (signal.aborted) command.kill(); });
    // 保留公共桥接的 ffmpegSettled；abort 本身不能证明远端进程已退出。
    command.on("error", reject);
    command.on("end", () => resolve());
    command.run();
  }).finally(() => signal.removeEventListener("abort", cancel));
}

export async function exportMotion(files: WorkspaceFiles, ffmpeg: BrowserFfmpegFactory, nodeId: string, reportPath: string, signal: AbortSignal, onPhase: (phase: string) => void, inputPlan?: ProductionPlan) {
  if (!nodeId || /[\\/\u0000-\u001f]/.test(nodeId) || [".", ".."].includes(nodeId) || !reportPath.startsWith(`assets/${nodeId}/`)
    || reportPath.includes("\\") || reportPath.split("/").some(part => !part || [".", ".."].includes(part))) throw new Error("分析报告不属于当前节点");
  signal.throwIfAborted();
  onPhase("正在读取已有分析报告…");
  const bytes = await files.read(reportPath, 16 * 1024 ** 2, signal);
  const report = motionReportSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  const plan = inputPlan ? productionPlanSchema.parse(inputPlan) : undefined;
  const layers: ProductionPlan["layers"] = plan?.layers ?? ["rgb", ...(report.pose ? ["pose" as const] : [])];
  const { source, settings, pose, camera } = report;
  const duration = settings.end - settings.start;
  const reportPolicy = report.frameCountPolicy ?? "legacyCeil";
  const frameCount = countSampleFrames(duration, settings.sampleFps, reportPolicy);
  const controlFrameCount = countSampleFrames(duration, settings.sampleFps);
  if (duration <= 0 || duration > 30 || pose && (pose.fps !== settings.sampleFps || Math.abs(pose.duration - duration) > 0.001
    || pose.frames.length !== countSampleFrames(duration, pose.fps, pose.frameCountPolicy ?? "legacyCeil") || pose.frames.some((frame, index) => Math.abs(frame.time - index / pose.fps) > 0.001
      || frame.source === "missing" && frame.landmarks.length !== 0 || frame.landmarks.length !== frame.worldLandmarks.length))) throw new Error("分析报告中的时间映射或姿态帧无效");
  if (camera && (camera.fps !== settings.sampleFps || Math.abs(camera.duration - duration) > 0.001 || camera.frames.length !== countSampleFrames(duration, camera.fps, camera.frameCountPolicy ?? "legacyCeil")
    || camera.frames.some((frame, index) => frame.frameIndex !== index || Math.abs(frame.time - index / camera.fps) > 0.001))) throw new Error("相机二维分析的采样或时间映射无效");
  if (layers.includes("pose") && !pose) throw new Error("当前报告没有姿态，请启用人体姿态重新分析，或取消姿态导出层");
  if (layers.includes("camera") && !camera) throw new Error("当前报告没有二维相机数据，请重新分析");
  if (report.depth) validateMotionDepth(report.depth, source, settings);
  if (layers.includes("depth") && !report.depth) throw new Error("当前报告没有真实 Depth 产物，请先完成相对深度分析或取消该导出层");
  if (layers.includes("combinedReview") && (!pose?.frames.some(frame => frame.landmarks.length === 33 && frame.source !== "missing") || !report.depth)) throw new Error("Combined review需要实际检出的Pose与已有真实Depth，不能用空白控制板补齐");
  if (layers.includes("frameDifferenceMask") && controlFrameCount < 2) throw new Error("运动差分遮罩至少需要两个采样帧，请增加分析区间");
  onPhase("正在核对源视频摘要…");
  if (await sourceHash(files, source.url, signal) !== source.contentSha256) throw new Error("源视频已变化，不能将历史姿态与新视频一起导出");
  const directory = `assets/${nodeId}/motionExport${crypto.randomUUID().replaceAll("-", "")}`;
  await files.mkdir(directory);
  let cleanupSafe = true;
  try {
    const artifacts: Record<string, { path: string; mimeType: string; video?: VideoMetadata; image?: ContactSheetMetadata; review?: ReviewMetadata }> = {};
    async function probeVideo(path: string) {
      signal.throwIfAborted();
      cleanupSafe = false;
      const data = await new Promise<FfprobeData>((resolve, reject) => ffmpeg(path).ffprobe((error, value) => error ? reject(error) : resolve(value)));
      cleanupSafe = true;
      signal.throwIfAborted();
      return { data, video: data.streams.find(stream => stream.codec_type === "video") };
    }
    async function encode(command: BrowserFfmpegCommand, path: string, expectedDuration?: number, expectedFrames?: number, image?: { width: number; height: number }, zeroStart = false) {
      signal.throwIfAborted();
      cleanupSafe = false;
      await run(command, signal);
      cleanupSafe = true;
      signal.throwIfAborted();
      const { data, video } = await probeVideo(path);
      if (image) {
        if (video?.codec_name !== "mjpeg" || video.width !== image.width || video.height !== image.height) throw new Error("Contact sheet 的JPEG编码或画面尺寸校验失败");
        return;
      }
      const actualDuration = Number(data.format.duration ?? video?.duration);
      const startTime = Number(video?.start_time);
      if (video?.codec_name !== "h264" || !video.width || !video.height || !Number.isFinite(actualDuration)
        || expectedDuration !== undefined && Math.abs(actualDuration - expectedDuration) > 0.6) throw new Error(expectedDuration === undefined
          ? "Contact sheet的1fps采样未产生可用帧或媒体校验失败，请扩大选区" : "导出视频的编码、画面或时长校验失败");
      if (expectedFrames !== undefined && Number(video.nb_frames) !== expectedFrames) throw new Error("导出视频的采样帧数不匹配，未发布本次结果");
      if (zeroStart && (!Number.isFinite(startTime) || Math.abs(startTime) > 0.001 || expectedDuration === undefined || Math.abs(actualDuration - expectedDuration) > 0.001)) throw new Error("导出视频的零起点或完整帧时长校验失败，未发布本次结果");
      if (!plan) return;
      const frameRate = String(video.avg_frame_rate ?? "");
      const [numerator, denominator = "1"] = frameRate.split("/");
      const actualFps = Number(numerator) / Number(denominator), actualFrameCount = Number(video.nb_frames);
      if (actualDuration <= 0 || !Number.isFinite(actualFps) || actualFps <= 0 || !Number.isSafeInteger(actualFrameCount) || actualFrameCount < 1) throw new Error("FFprobe未提供完整的视频时间信息，未发布生产包");
      const sourceMappedVideoEnd = Math.min(duration, actualDuration);
      return { duration: actualDuration, fps: actualFps, frameRate, frameCount: actualFrameCount, width: video.width, height: video.height,
        ...(Number.isFinite(startTime) ? { startTime } : {}),
        ...(video.sample_aspect_ratio ? { sampleAspectRatio: video.sample_aspect_ratio } : {}),
        validSourceDuration: duration, mapping: { sourceTimeOffset: settings.start, clipTimeScale: 1 as const, sourceMappedVideoEnd },
        lastFrameHold: { start: sourceMappedVideoEnd, end: actualDuration, seconds: Math.max(0, actualDuration - duration),
          note: "0≤t<sourceMappedVideoEnd对应名义选区时间；RGB另有帧量化，以sampling为准，不表示逐帧原PTS精确相等。之后仅保持末帧至视频结束，不代表选区外的新源帧" } };
    }
    let videoPath: string | undefined, rgbSampling: string | undefined;
    if (layers.includes("rgb")) {
      videoPath = `${directory}/video.mp4`;
      const { video: sourceVideo } = await probeVideo(source.url);
      const sourceFrameRate = String(sourceVideo?.r_frame_rate ?? "");
      const [numerator = 0, denominator = 0] = sourceFrameRate.split("/").map(Number);
      const sourceFps = numerator / denominator;
      if (!/^\d+\/\d+$/.test(sourceFrameRate) || !Number.isFinite(sourceFps) || numerator <= 0 || denominator <= 0 || sourceFps <= 0 || sourceFps > 1000) throw new Error("源视频标称帧率无效（需有限正分数且不超过1000fps），未导出RGB");
      const rgbFrames = countSampleFrames(duration, sourceFps);
      onPhase("正在用本机 FFmpeg 导出 RGB 片段…");
      // 先限定输入区间再归零，避免输出-t在编码时间基舍入后丢尾帧；RGB不使用分析采样率。
      const video = await encode(ffmpeg(source.url, { timeout: 60 }).seekInput(settings.start).inputOptions("-t", String(duration)).noAudio().frames(rgbFrames).videoCodec("libx264")
        .videoFilters(`pad=ceil(iw/2)*2:ceil(ih/2)*2,setpts=PTS-STARTPTS,fps=${sourceFrameRate}:start_time=0:round=up:eof_action=pass`).output(videoPath).format("mp4")
        .outputOptions("-map", "0:v:0", "-threads", "1", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-fps_mode", "cfr", "-movflags", "+faststart"), videoPath, rgbFrames / sourceFps, rgbFrames, undefined, true);
      rgbSampling = `首个start之后可解码帧归零，按源r_frame_rate=${sourceFrameRate}编码CFR（源avg_frame_rate=${sourceVideo?.avg_frame_rate ?? "未提供"}）；VFR会重采样。sourceTimeOffset是名义选区起点，起点+t不是逐帧原PTS精确相等；末帧保持不超过一个源标称帧间隔。`;
      artifacts.rgb = { path: videoPath, mimeType: "video/mp4", video: video ? { ...video, frameCountPolicy, sampling: rgbSampling } : undefined };
    }
    let openPosePath: string | undefined, posePath: string | undefined;
    if (pose && layers.includes("pose")) {
      onPhase("正在导出 OpenPose BODY25 关键点…");
      openPosePath = `${directory}/openPose.json`;
      const mapping = { sourceTimeOffset: settings.start, clipTimeScale: 1 };
      await files.writeJson(openPosePath, { schema: "openpose-body25-sequence-v1", frameCountPolicy: pose.frameCountPolicy ?? "legacyCeil", source: plan ? { mimeType: source.mimeType, contentSha256: source.contentSha256 } : source, mapping,
        frames: buildOpenPoseJson(pose, pose.width, pose.height).map((frame, index) => ({ time: pose.frames[index]!.time, source: pose.frames[index]!.source, ...frame })) }, true);
      const size = cameraAnalysisSize(pose.width, pose.height);
      const width = Math.ceil(size.width / 2) * 2, height = Math.ceil(size.height / 2) * 2;
      // ACT: 控制图最长边192、最多360帧，RGBA总量不超过53MiB，保持现有100MiB界面传输上限。
      const frameBytes = width * height * 4;
      const frames = new Uint8Array(frameBytes * pose.frames.length);
      for (let index = 0; index < pose.frames.length; index++) {
        signal.throwIfAborted();
        onPhase(`正在绘制姿态控制帧 ${index + 1}/${pose.frames.length}…`);
        frames.set(renderOpenPoseRgba(pose.frames[index], width, height), index * frameBytes);
        if (index % 8 === 0) await new Promise(resolve => setTimeout(resolve, 0));
      }
      const rawPath = `${directory}/pose.rgba`;
      await files.write(rawPath, frames.buffer, true);
      signal.throwIfAborted();
      posePath = `${directory}/pose.mp4`;
      onPhase("正在用本机 FFmpeg 编码姿态控制视频…");
      const video = await encode(ffmpeg(rawPath, { timeout: 60 }).inputFormat("rawvideo").inputOptions("-pixel_format", "rgba", "-video_size", `${width}x${height}`, "-framerate", String(pose.fps))
        .noAudio().frames(pose.frames.length).videoCodec("libx264").output(posePath).format("mp4")
        .outputOptions("-threads", "1", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart"), posePath, pose.frames.length / pose.fps, pose.frames.length);
      await files.remove(rawPath);
      artifacts.openPose = { path: openPosePath, mimeType: "application/json" };
      artifacts.pose = { path: posePath, mimeType: "video/mp4", video: video ? { ...video, frameCountPolicy: pose.frameCountPolicy ?? "legacyCeil", sampling: "Pose为选区内固定fps的实测骨架，缺失人体保持空帧；末帧可保持到完整帧结束" } : undefined };
    }
    let cameraPath: string | undefined, contactSheetPath: string | undefined;
    if (camera && layers.includes("camera")) {
      cameraPath = `${directory}/cameraMotion.json`;
      await files.writeJson(cameraPath, { schema: "openCinema-image-motion-v1", space: "image2d", approximate: true,
        source: { mimeType: source.mimeType, contentSha256: source.contentSha256 }, mapping: { sourceTimeOffset: settings.start, clipTimeScale: 1 },
        cameraMotion: camera, limitations: ["图像平面运动估计，不是三维摄影机恢复，没有真实场景尺度", "前景物体、遮挡与纹理不足会影响置信度；使用前需审阅"] }, true);
      artifacts.camera = { path: cameraPath, mimeType: "application/json" };
    }
    const filteredLayers = [
      { id: "edges", filter: "edgedetect=low=0.08:high=0.28,format=gray,eq=contrast=1.35", phase: "正在导出 Edges 二维边缘…", sampling: "Edges为选区内视频按采样fps重采样后的二维边缘；末帧可保持到完整帧结束" },
      { id: "lineart", filter: "format=gray,sobel,negate,eq=contrast=1.2", phase: "正在导出灰度Sobel反相 Lineart（非模型推理）…", sampling: "Lineart为灰度Sobel反相与对比度过滤；非模型推理或法线，末帧可保持到完整帧结束" },
      { id: "frameDifferenceMask", filter: "tblend=all_mode=difference,format=gray,eq=contrast=3.2:brightness=0.02,boxblur=1:1,tpad=start=1:start_mode=add:color=black,setpts=N/FRAME_RATE/TB", phase: "正在导出运动差分遮罩（非语义分割）…", sampling: "frameDifferenceMask为相邻采样帧差分，首帧补黑；末帧可保持到完整帧结束，不是语义分割" },
      { id: "normalsProxy", filter: "format=gray,eq=contrast=1.45:brightness=0.03,boxblur=2:1,format=gray,sobel,eq=contrast=1.7", phase: "正在导出亮度梯度 Normals proxy（非表面法线）…", sampling: "亮度代理经Sobel得到灰度梯度；非XYZ表面法线、非真实Depth。单条过滤链复用固定上游处理意图，与上游两次H264不保证像素一致；按分析fps采样，末帧可保持到完整帧结束" },
    ] as const;
    for (const layer of filteredLayers) {
      if (!layers.includes(layer.id)) continue;
      const path = `${directory}/${layer.id}.mp4`;
      // 上游真实二维过滤器；Normals保留亮度proxy处理意图，未借用AI Depth冒称法线。
      onPhase(layer.phase);
      const video = await encode(ffmpeg(source.url, { timeout: 60 }).seekInput(settings.start).inputOptions("-t", String(duration)).noAudio().videoCodec("libx264")
        .videoFilters(`fps=${settings.sampleFps}:start_time=0:round=up:eof_action=pass,scale=w='min(640,iw)':h='min(640,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,${layer.filter},pad=ceil(iw/2)*2:ceil(ih/2)*2`)
        .frames(controlFrameCount).output(path).format("mp4").outputOptions("-map", "0:v:0", "-threads", "1", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-movflags", "+faststart"), path, controlFrameCount / settings.sampleFps, controlFrameCount, undefined, layer.id === "normalsProxy");
      artifacts[layer.id] = { path, mimeType: "video/mp4", video: video ? { ...video, frameCountPolicy, sampling: layer.sampling } : undefined };
    }
    if (layers.includes("contactSheet")) {
      onPhase("正在按1fps、240px宽采样 Contact sheet，最多十格…");
      const { video: original } = await probeVideo(source.url);
      if (!original?.width || !original.height || original.width > 16384 || original.height > 16384) throw new Error("Contact sheet缺少有效源画面尺寸");
      const cellHeight = Math.round(240 * original.height / original.width / 2) * 2;
      if (cellHeight < 2 || cellHeight > 2048) throw new Error("源画幅比例超出Contact sheet的1200×4096像素上限，未变形或裁剪原片");
      const samplePath = `${directory}/contactSamples.mp4`;
      const samples = await encode(ffmpeg(source.url, { timeout: 60 }).seekInput(settings.start).inputOptions("-t", String(duration)).noAudio()
        .videoFilters("fps=1,scale=240:-2").frames(10).videoCodec("libx264").output(samplePath).format("mp4")
        .outputOptions("-map", "0:v:0", "-threads", "1", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-movflags", "+faststart"), samplePath);
      if (!samples || samples.width !== 240 || samples.height !== cellHeight || Math.abs(samples.fps - 1) > 0.001 || samples.frameCount > 10
        || Math.abs(samples.duration - samples.frameCount) > 0.002) throw new Error("Contact sheet的实际1fps采样帧或时长不一致");
      contactSheetPath = `${directory}/contactSheet.jpg`;
      await encode(ffmpeg(samplePath, { timeout: 60 }).noAudio().videoFilters("tile=5x2:color=black").frames(1).videoCodec("mjpeg")
        .output(contactSheetPath).format("image2").outputOptions("-threads", "1", "-q:v", "2", "-update", "1"), contactSheetPath, undefined, undefined, { width: 1200, height: cellHeight * 2 });
      await files.remove(samplePath);
      artifacts.contactSheet = { path: contactSheetPath, mimeType: "image/jpeg", image: { width: 1200, height: cellHeight * 2, columns: 5, rows: 2, cellWidth: 240, cellHeight,
        sampleFps: 1, sampledFrames: samples.frameCount, emptyCells: 10 - samples.frameCount, sourceTimeOffset: settings.start, validSourceDuration: duration,
        samplingWindowDuration: Math.min(duration, samples.frameCount), truncated: duration > 10,
        samplingVideo: { frameRate: samples.frameRate, frameCount: samples.frameCount, fps: samples.fps, duration: samples.duration },
        note: "先实读1fps重采样视频帧数，再按行填5×2格；不足十格的黑格为空，不重复末帧填格。fps=1使用FFmpeg默认round-near/eof-round选择源帧，可能重复低帧率源帧；格序是重采样输出次序，不代表精确源帧时间或十个互异源帧。超过十秒只展示前十格。" } };
    }
    if (layers.includes("depth") && report.depth) {
      onPhase("正在核对并复制已有真实 Depth 产物，不重新推理…");
      const measured = await readMotionDepth(files, report.depth.provenance, signal);
      const result = measured.provenance;
      const names = { depthData: "relativeDepth.json", depthControl: "relativeDepth.mp4", depthPoster: "relativeDepth.png" };
      if (result.artifacts.reduce((total, artifact) => total + artifact.size, 0) > 96 * 1024 ** 2) throw new Error("Depth 载荷超过96MiB生产包上限");
      for (const artifact of result.artifacts) {
        const path = `${directory}/${names[artifact.kind]}`;
        await files.write(path, await readDepthFile(files, artifact, signal), true);
        artifacts[artifact.kind] = { path, mimeType: artifact.mimeType, video: artifact.video ? { ...artifact.video, frameCountPolicy: result.frameCountPolicy ?? "legacyCeil" } : undefined };
      }
      const path = `${directory}/depthProvenance.json`;
      await files.writeJson(path, { schema: "openCinema-portable-depth-provenance-v1", frameCountPolicy: result.frameCountPolicy ?? "legacyCeil", model: result.model, runtime: result.runtime,
        normalization: result.normalization, source: { contentSha256: source.contentSha256, originalSourceIncluded: false }, settings,
        origin: { operationId: result.operationId, manifestSha256: result.manifest.sha256 },
        artifacts: result.artifacts.map(artifact => ({ ...artifact, path: names[artifact.kind] })) }, true);
      artifacts.depthProvenance = { path, mimeType: "application/json" };
    }
    if (layers.includes("combinedReview")) {
      const reviewDuration = frameCount / settings.sampleFps;
      const inputs: ReviewMetadata["inputs"] = [];
      let inputBytes = 0;
      for (const role of ["rgb", "depthControl", "pose"] as const) {
        const artifact = artifacts[role], metadata = artifact?.video;
        if (!artifact || !metadata) throw new Error(`Combined review缺少所选真实视频或实读元数据：${role}`);
        const { data, video } = await probeVideo(artifact.path);
        const startTime = Number(video?.start_time), actualDuration = Number(data.format.duration ?? video?.duration);
        if (video?.codec_name !== "h264" || !Number.isFinite(startTime) || Math.abs(startTime) > 0.001 || video.width !== metadata.width || video.height !== metadata.height
          || Number(video.nb_frames) !== metadata.frameCount || video.avg_frame_rate !== metadata.frameRate || !Number.isFinite(actualDuration) || Math.abs(actualDuration - metadata.duration) > 0.002
          || Math.abs(metadata.validSourceDuration - duration) > 0.001 || Math.abs(metadata.mapping.sourceTimeOffset - settings.start) > 0.001
          || role !== "rgb" && (metadata.frameCount !== countSampleFrames(duration, settings.sampleFps, metadata.frameCountPolicy ?? "legacyCeil")
            || Math.abs(metadata.fps - settings.sampleFps) > 0.001 || Math.abs(metadata.duration - metadata.frameCount / settings.sampleFps) > 0.002)) throw new Error(`Combined review输入的实际视频、零起点或时间映射不一致：${role}`);
        const content = await files.read(artifact.path, 96 * 1024 ** 2, signal);
        signal.throwIfAborted();
        inputBytes += content.byteLength;
        if (inputBytes > 96 * 1024 ** 2) throw new Error("Combined review输入超过96MiB预算");
        inputs.push({ role, path: artifact.path.slice(directory.length + 1), bytes: content.byteLength, sha256: await fileSha256(content), video: { ...metadata, startTime,
          ...(video.sample_aspect_ratio ? { sampleAspectRatio: video.sample_aspect_ratio } : {}) },
          reviewHold: { start: Math.min(metadata.duration, reviewDuration), end: reviewDuration, seconds: Math.max(0, reviewDuration - metadata.duration) } });
      }
      const cellWidth = 320, labelHeight = 32;
      const cellHeight = Math.min(640, Math.max(48, Math.round(cellWidth * inputs[0]!.video.height / inputs[0]!.video.width / 2) * 2));
      const labels = ["RGB", "Relative Depth", "Pose"];
      const canvas = document.createElement("canvas");
      canvas.width = cellWidth * 3; canvas.height = labelHeight;
      const drawing = canvas.getContext("2d");
      if (!drawing) throw new Error("无法绘制Combined review标签，未发布无标签视频");
      drawing.fillStyle = "#14202c"; drawing.fillRect(0, 0, canvas.width, canvas.height);
      drawing.fillStyle = "#ffffff"; drawing.font = "bold 16px sans-serif"; drawing.textBaseline = "middle";
      labels.forEach((label, index) => drawing.fillText(label, index * cellWidth + 12, labelHeight / 2));
      const pixels = drawing.getImageData(0, 0, canvas.width, canvas.height).data;
      if (inputBytes + pixels.byteLength > 96 * 1024 ** 2) throw new Error("Combined review输入与标签超过96MiB预算");
      const labelPath = `${directory}/reviewLabels.rgba`;
      await files.write(labelPath, new Uint8Array(pixels).buffer, true);
      const tileFilter = `setpts=PTS-STARTPTS,fps=${settings.sampleFps}:start_time=0:round=up:eof_action=pass,scale=${cellWidth}:${cellHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1,pad=${cellWidth}:${cellHeight}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p`;
      const filters = inputs.map((_input, index) => `[${index}:v]${tileFilter}[cell${index}]`);
      filters.push("[cell0][cell1][cell2]hstack=inputs=3:shortest=0[body]", "[3:v]format=yuv420p[labels]", "[labels][body]vstack=inputs=2:shortest=0[review]");
      const path = `${directory}/combinedReview.mp4`;
      onPhase("正在合成RGB / Relative Depth / Pose三路审阅（非校准同步）…");
      const video = await encode(ffmpeg(`${directory}/${inputs[0]!.path}`, { timeout: 60 }).input(`${directory}/${inputs[1]!.path}`).input(`${directory}/${inputs[2]!.path}`)
        .input(labelPath).inputFormat("rawvideo").inputOptions("-pixel_format", "rgba", "-video_size", `${cellWidth * 3}x${labelHeight}`, "-framerate", String(settings.sampleFps))
        .noAudio().complexFilter(filters).frames(frameCount).videoCodec("libx264").output(path).format("mp4")
        .outputOptions("-map", "[review]", "-threads", "1", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-fps_mode", "cfr", "-movflags", "+faststart"), path, reviewDuration, frameCount, undefined, true);
      if (!video || video.width !== cellWidth * 3 || video.height !== cellHeight + labelHeight || Math.abs(video.fps - settings.sampleFps) > 0.001) throw new Error("Combined review的实读画面尺寸或帧率不匹配，未发布本次结果");
      await files.remove(labelPath);
      artifacts.combinedReview = { path, mimeType: "video/mp4", video: { ...video, frameCountPolicy: reportPolicy, sampling: "已有三路视频按冻结报告的分析时钟归零并重采样，RGB可重复已有帧；不增加实测样本，不作为生成条件或精确校准同步" },
        review: { purpose: "visualReviewOnly", clock: { frameCountPolicy: reportPolicy, fps: settings.sampleFps, frameCount, duration: reviewDuration, validSourceDuration: duration },
          layout: { order: inputs.map(input => input.role), labels, cellWidth, cellHeight, labelHeight, fit: "letterbox" }, inputs,
          note: "顶部标签不覆盖原画面；左RGB、中真实相对Depth、右Pose。每路保留自己的实际采样率、帧数、源映射与末帧保持，reviewHold只记为审阅时钟延长的保持段；名义时间对照不是逐帧原PTS或空间校准同步。" } };
    }
    onPhase("正在确认源视频及导出清单…");
    if (await sourceHash(files, source.url, signal) !== source.contentSha256) throw new Error("导出期间源视频已变化，本次导出作废");
    const manifestPath = `${directory}/manifest.json`;
    let productionPackPath: string | undefined, planPath: string | undefined;
    if (plan) {
      const mapping = { sourceTimeOffset: settings.start, clipTimeScale: 1 };
      const documents = productionDocuments(plan, mapping, duration);
      Object.assign(documents, { "noticeAndLicense.md": motionNotice.slice(motionNotice.indexOf("## 第三方来源与许可")) });
      const writeDocuments = async (documents: Record<string, string>) => {
        for (const [name, text] of Object.entries(documents)) {
          signal.throwIfAborted();
          const path = `${directory}/${name}`;
          await files.write(path, text, true);
          artifacts[name] = { path, mimeType: name.endsWith(".json") ? "application/json" : name.endsWith(".py") ? "text/x-python" : "text/markdown" };
        }
      };
      await writeDocuments(documents);
      planPath = `${directory}/shotBible.json`;
      const analysisPath = `${directory}/analysis.json`;
      await files.writeJson(analysisPath, { schema: "openCinema-portable-motion-analysis-v1", frameCountPolicy: reportPolicy, settings, space: "image2d",
        camera: layers.includes("camera") ? camera : undefined, pose: layers.includes("pose") ? pose : undefined,
        models: { pose: layers.includes("pose") ? report.models?.pose : undefined, depth: layers.includes("depth") ? report.models?.depth : undefined },
        source: { mimeType: source.mimeType, contentSha256: source.contentSha256, role: "originalSourceProvenance", originalSourceIncluded: false },
        mapping, depth: layers.includes("depth") && report.depth ? { ...report.depth, provenance: undefined, normalization: report.depth.provenance.normalization, provenanceFile: "depthProvenance.json" }
          : { available: false, reason: "未选择真实 Depth 层" } }, true);
      artifacts.analysis = { path: analysisPath, mimeType: "application/json" };
      await writeDocuments(productionUsageDocuments(plan, mapping, duration, Object.entries(artifacts).map(([role, artifact]) => ({
        role, path: artifact.path.slice(directory.length + 1), mimeType: artifact.mimeType,
      }))));
      const entries: Record<string, Uint8Array> = {};
      const members: { role: string; path: string; mimeType: string; bytes: number; sha256: string; video?: VideoMetadata; image?: ContactSheetMetadata; review?: ReviewMetadata }[] = [];
      let totalBytes = 0;
      onPhase("正在核对 Production Pack 文件 SHA-256…");
      for (const [role, artifact] of Object.entries(artifacts)) {
        signal.throwIfAborted();
        const content = await files.read(artifact.path, 96 * 1024 ** 2, signal);
        totalBytes += content.byteLength;
        if (totalBytes > 96 * 1024 ** 2) throw new Error("Production Pack 内容超过96MiB，请减少导出层或缩短区间");
        const name = artifact.path.slice(directory.length + 1);
        const sha256 = await fileSha256(content);
        const reviewInput = artifacts.combinedReview?.review?.inputs.find(input => input.path === name);
        if (reviewInput && (reviewInput.sha256 !== sha256 || reviewInput.bytes !== content.byteLength)) throw new Error("三路审阅输入在合成后变化，未发布本次生产包");
        entries[name] = new Uint8Array(content);
        members.push({ role, path: name, mimeType: artifact.mimeType, bytes: content.byteLength, sha256, video: artifact.video, image: artifact.image, review: artifact.review });
      }
      const manifest = { schema: "openCinema-motion-production-pack-v1", createdAt: new Date().toISOString(), plan,
        source: { mimeType: source.mimeType, contentSha256: source.contentSha256, originalSourceIncluded: false }, settings, mapping, files: members,
        sampling: { frameCountPolicy: reportPolicy, fps: settings.sampleFps, frameCount, controlDuration: frameCount / settings.sampleFps, validSourceDuration: duration,
          lastFrameHoldSeconds: Math.max(0, frameCount / settings.sampleFps - duration), note: "此项描述冻结报告与combinedReview的分析时钟；新RGB/源滤镜使用halfOpenStableCeilV1，已有Pose/Depth保留各自冻结规则。各视频以files[].video的policy、实读时长/帧率/帧数及映射/末帧保持为准，不代表额外源帧" },
        depth: layers.includes("depth") && report.depth ? { available: true, normalization: report.depth.provenance.normalization, provenanceFile: "depthProvenance.json", model: report.depth.provenance.model }
          : { available: false, reason: "未选择真实 Depth 层；不能以边缘或帧差遮罩替代" },
        controlProtocol: "仅RGB可作为普通视频参考；姿态、Depth、Edges、Lineart和frameDifferenceMask须接收方明确支持的专用条件协议；normalsProxy非XYZ表面法线，combinedReview仅作人工审阅不作生成条件；Contact sheet为采样索引图",
        integrity: "files 包含所有载荷文件的SHA-256；manifest.json为索引，不自我校验；无工作区外部文件依赖",
        attribution: { name: "Motion Previs Studio", author: "Sam Wasserman", license: "Apache-2.0", commit: "95e7d0ff1d4cc546f7eb09a74ccbd084988a19bc" },
      };
      const manifestText = JSON.stringify(manifest, null, 2);
      await files.write(manifestPath, manifestText, true);
      entries["manifest.json"] = new TextEncoder().encode(manifestText);
      signal.throwIfAborted();
      onPhase("正在打包实际文件；不会上传或提交生成…");
      // ACT: 最多96MiB；视频不再压缩，避免派生Worker和额外模型/网络资源。
      const packed = zipSync(entries, { level: 0 });
      signal.throwIfAborted();
      if (packed.byteLength > 100 * 1024 ** 2) throw new Error("Production Pack 超过100MiB传输上限");
      productionPackPath = `${directory}/productionPack.zip`;
      await files.write(productionPackPath, new Blob([new Uint8Array(packed).buffer], { type: "application/zip" }), true);
    } else {
      await files.writeJson(manifestPath, { schemaVersion: 1, frameCountPolicy: reportPolicy, reportPath, source, settings, mapping: { sourceTimeOffset: settings.start, clipTimeScale: 1 }, rgbSampling, rgbFrameCountPolicy: videoPath ? frameCountPolicy : undefined,
        artifacts: { video: videoPath, openPose: openPosePath, poseControl: posePath }, controlProtocol: "OpenPose BODY25；控制视频须使用专用条件协议，不作为普通RGB参考" }, true);
    }
    signal.throwIfAborted();
    return { videoPath, openPosePath, posePath, cameraPath, edgesPath: artifacts.edges?.path, lineartPath: artifacts.lineart?.path, contactSheetPath,
      frameDifferenceMaskPath: artifacts.frameDifferenceMask?.path, normalsProxyPath: artifacts.normalsProxy?.path, combinedReviewPath: artifacts.combinedReview?.path, manifestPath, productionPackPath, planPath };
  } catch (failure) {
    cleanupSafe ||= (failure as { ffmpegSettled?: boolean })?.ffmpegSettled === true;
    if (!cleanupSafe) throw new AggregateError([failure], `FFmpeg 结束状态未确认；本次目录保留，请确认后台进程结束后再处理：${directory}`);
    try { await files.remove(directory, true); }
    catch (cleanup) { throw new AggregateError([failure, cleanup], `Motion 导出未完成，临时目录清理失败：${directory}`); }
    throw failure;
  }
}
