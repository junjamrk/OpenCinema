import { z } from "zod";
import type { BrowserFfmpegCommand, BrowserFfmpegFactory, FfprobeData } from "@toonflow/ffmpeg/browser";
import type { WorkspaceFiles } from "@toonflow/nodes-scaffold/nodeFiles";
import { countSampleFrames, frameCountPolicy } from "@toonflow/node-shared/mediaSampling";
import { ASPECT_RATIOS } from "./nativeBlockout/camera";
import { getShot } from "./editing";
import { environmentPreset, environmentRendering } from "./environment";
import type { ProjectDoc } from "./nativeBlockout/types";
import type { CapturePass, ControlLayer } from "./renderPass";

export const videoExportSchema = z.strictObject({
  sceneId: z.string().min(1), shotId: z.string().min(1),
  start: z.number().finite().min(0).max(300).optional(), end: z.number().finite().positive().max(300).optional(),
  fps: z.number().int().min(1).max(60).optional(), maxDimension: z.union([z.literal(640), z.literal(1280)]).optional(),
  controlLayers: z.array(z.enum(["depth", "normal"])).max(2).refine(value => new Set(value).size === value.length, "控制层不能重复").optional(),
  depthRange: z.strictObject({ near: z.number().finite().min(0.05).max(4999.99), far: z.number().finite().max(5000) }).refine(value => value.far > value.near, "Depth far须大于near").optional(),
}).refine(value => value.controlLayers?.includes("depth") ? !!value.depthRange : !value.depthRange, "选择Depth时须明确提供米制depthRange；未选择Depth时不传该范围");
export type VideoExportInput = z.infer<typeof videoExportSchema>;
export const animaticExportSchema = z.strictObject({ sceneId: z.string().min(1), maxDimension: z.union([z.literal(640), z.literal(1280)]).optional() });
export type AnimaticExportInput = z.infer<typeof animaticExportSchema>;
type CapturedFrame = { dataUrl: string; width: number; height: number };
type MeasuredVideo = { width: number; height: number; duration: number; fps: number; frameRate: string; frameCount: number; bytes: number };

function encode(command: BrowserFfmpegCommand, signal: AbortSignal) {
  signal.throwIfAborted();
  const cancel = () => command.kill();
  signal.addEventListener("abort", cancel, { once: true });
  return new Promise<void>((resolve, reject) => {
    command.on("start", () => { if (signal.aborted) command.kill(); });
    command.on("error", reject);
    command.on("end", () => resolve());
    command.run();
  }).finally(() => signal.removeEventListener("abort", cancel));
}

export async function exportVideo(options: {
  files: WorkspaceFiles; ffmpeg: BrowserFfmpegFactory; directory: string;
  project: ProjectDoc; revision: string; input: VideoExportInput | AnimaticExportInput; signal: AbortSignal;
  capture: (shotId: string, time: number, width: number, pass?: CapturePass) => Promise<CapturedFrame>;
  check: () => void; progress: (phase: string, percent: number) => void;
}) {
  const { files, ffmpeg, directory, project, revision, signal, capture, check, progress } = options;
  const single = "shotId" in options.input ? videoExportSchema.parse(options.input) : undefined;
  const input = single ?? animaticExportSchema.parse(options.input);
  const scene = project.scenes.find(item => item.id === input.sceneId);
  if (!scene) throw new Error("Blockout场景不存在");
  const shots = single ? [getShot(project, single.sceneId, single.shotId).shot] : scene.shots;
  if (!shots.length || shots.length > 100) throw new Error("Animatic须有1–100个镜头");
  const shot = shots[0]!, take = scene.blocking.find(item => item.id === shot.blockingTakeId)!;
  const fps = single?.fps ?? shot.fps, start = single?.start ?? 0, end = single?.end ?? shot.duration;
  let frameCount = 0, sourceDuration = 0;
  const segments = shots.map(item => {
    if (!Number.isFinite(item.duration) || item.duration <= 0 || item.duration > 300 || !ASPECT_RATIOS[item.aspect] || !Number.isInteger(item.fps) || item.fps < 1 || item.fps > 60 || !scene.blocking.some(take => take.id === item.blockingTakeId)) throw new Error("导出镜头的时长、画幅、帧率或Take无效");
    if (!single && (item.aspect !== shot.aspect || item.fps !== fps)) throw new Error("场景Animatic要求全部镜头画幅与帧率一致；请先在镜头设置中统一，不自动裁切或改速");
    const from = single ? start : 0, to = single ? end : item.duration;
    if (to <= from || to > item.duration) throw new Error("视频导出须选择镜头内的正时间区间");
    const count = countSampleFrames(to - from, fps);
    const segment = { shot: item, start: from, end: to, frameStart: frameCount, frameCount: count };
    frameCount += count; sourceDuration += to - from;
    return segment;
  });
  const duration = frameCount / fps;
  // ACT: 源秒累加仅容忍1e-9帧的浮点误差；实际900帧/30秒编码上限仍严格检查。
  if (sourceDuration > 30 + 1e-9 / fps || duration > 30 || frameCount > 900) throw new Error("本次全部视频须合计最多30秒、900帧；Animatic逐镜头按ceil(duration*fps)量化，请缩短场景后重试");
  const aspect = ASPECT_RATIOS[shot.aspect], maximum = input.maxDimension ?? 1280;
  const width = Math.floor(maximum * Math.min(1, aspect) / 2) * 2;
  const height = Math.round(width / aspect);
  const outputHeight = Math.ceil(height / 2) * 2;
  const framesDirectory = `${directory}/frames`, videoPath = `${directory}/video.mp4`, manifestPath = `${directory}/manifest.json`;
  const passes = ["rgb", ...single?.controlLayers ?? []] as const;
  const controlLayers: { type: ControlLayer; path: string; mimeType: "video/mp4"; measured: MeasuredVideo; protocol: Record<string, unknown> }[] = [];
  let rgbMeasured: MeasuredVideo | undefined;
  let cleanupSafe = true;
  let created = false;
  let completed = false;
  try {
    check(); signal.throwIfAborted();
    await files.mkdir(directory); created = true;
    await files.mkdir(framesDirectory);
    let frameBytes = 0;
    for (const [passIndex, layer] of passes.entries()) {
      const passFrames = `${framesDirectory}/${layer}`, passVideo = layer === "rgb" ? videoPath : `${directory}/${layer}.mp4`;
      await files.mkdir(passFrames);
      const pass = layer === "rgb" ? undefined : { layer, depthRange: single?.depthRange };
      for (let index = 0; index < frameCount; index++) {
        check(); signal.throwIfAborted();
        progress(`正在渲染 ${layer} ${index + 1}/${frameCount}`, Math.round((passIndex + index / frameCount * 0.75) / passes.length * 95));
        const segment = segments.find(item => index >= item.frameStart && index < item.frameStart + item.frameCount)!;
        const frame = await capture(segment.shot.id, segment.start + (index - segment.frameStart) / fps, width, pass);
        check(); signal.throwIfAborted();
        if (frame.width !== width || frame.height !== height || !frame.dataUrl.startsWith("data:image/png;base64,")) throw new Error("摄影机返回的 PNG 尺寸或格式无效");
        const png = Uint8Array.from(atob(frame.dataUrl.slice(22)), value => value.charCodeAt(0));
        frameBytes += png.byteLength;
        if (frameBytes > 512 * 1024 ** 2) throw new Error("本次全部层渲染帧合计超过512MiB，请缩短区间、减少控制层或选择640分辨率");
        await files.write(`${passFrames}/frame${String(index).padStart(6, "0")}.png`, png.buffer, true);
        check(); signal.throwIfAborted();
      }
      progress(`正在使用本机 FFmpeg 编码 ${layer}`, Math.round((passIndex + 0.8) / passes.length * 95));
      // ACT: 桥接断连不等于进程已退出；未知结果时保留本次独占目录，避免删除仍在使用的帧。
      cleanupSafe = false;
      await encode(ffmpeg(`${passFrames}/frame%06d.png`, { timeout: 120 }).inputFormat("image2")
        .inputOptions("-framerate", String(fps), "-start_number", "0").noAudio().frames(frameCount)
        .videoCodec("libx264").videoFilters("pad=ceil(iw/2)*2:ceil(ih/2)*2").output(passVideo).format("mp4")
        .outputOptions("-threads", "1", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart"), signal);
      cleanupSafe = true; check(); signal.throwIfAborted();
      progress(`正在核对 ${layer} 视频`, Math.round((passIndex + 0.95) / passes.length * 95));
      cleanupSafe = false;
      const media = await new Promise<FfprobeData>((resolve, reject) => ffmpeg(passVideo).ffprobe((error, value) => error ? reject(error) : resolve(value)));
      cleanupSafe = true; check(); signal.throwIfAborted();
      const video = media.streams.find(stream => stream.codec_type === "video");
      const actualDuration = Number(media.format.duration ?? video?.duration), size = Number(media.format.size);
      if (video?.codec_name !== "h264" || video.width !== width || video.height !== outputHeight || !Number.isFinite(actualDuration)
        || Math.abs(actualDuration - duration) > Math.max(0.05, 1 / fps) || !Number.isFinite(size) || size <= 0 || size > 256 * 1024 ** 2) throw new Error("导出视频的编码、尺寸、时长或文件大小校验失败");
      const frameRate = String(video.avg_frame_rate ?? ""), rate = /^(\d+)\/(\d+)$/.exec(frameRate);
      const actualFps = rate && Number(rate[2]) > 0 ? Number(rate[1]) / Number(rate[2]) : NaN, actualFrameCount = Number(video.nb_frames);
      if (!Number.isFinite(actualFps) || Math.abs(actualFps - fps) > 0.000001 || !Number.isSafeInteger(actualFrameCount) || actualFrameCount !== frameCount || actualDuration <= 0) throw new Error("FFprobe实读帧率、帧数或时长与本次时间线不一致，未发布全部所选层");
      const measured = { width: video.width, height: video.height, duration: actualDuration, fps: actualFps, frameRate, frameCount: actualFrameCount, bytes: size };
      if (layer === "rgb") rgbMeasured = measured;
      else controlLayers.push({ type: layer, path: `${layer}.mp4`, mimeType: "video/mp4", measured, protocol: layer === "depth"
        ? { schema: "openCinema-blockout-depth-v1", source: "ThreeDepthTextureFromOpaqueSurfaces", space: "cameraViewZ", unit: "meter", clipNear: 0.05, clipFar: 5000, ...single?.depthRange,
          normalization: "1-clamp((positiveViewZ-near)/(far-near),0,1)", background: 0, nearIsWhite: true, surfacePolicy: "opaqueNearestSurface", alphaPolicy: "preserveAlphaTestTreatBlendAsOpaque", alphaTestOpacity: "originalBaseOpacity", depthTest: true, depthWrite: true, opticalTransmission: false, bits: 8, codec: "h264-yuv420p-crf18", metricFile: false }
        : { schema: "openCinema-blockout-normal-v1", space: "cameraView", axes: "x-right,y-up,z-towardsCamera", encoding: "rgb=normalize(baseShadingNormal)*0.5+0.5", background: [0, 0, 0], normalAndBumpMaps: true,
          skinAndMorph: true, alphaTest: true, surfacePolicy: "opaqueNearestSurface", alphaPolicy: "preserveAlphaTestTreatBlendAsOpaque", alphaTestOpacity: "originalBaseOpacity", depthTest: true, depthWrite: true, opticalTransmission: false, toneMapping: false, transfer: "linearValuesNoGamma", bits: 8, codec: "h264-yuv420p-crf18" } });
    }
    progress("正在写入全部已核验视频与来源清单", 97);
    const manifest = {
      schema: single ? "openCinema-blockout-rgb-v1" : "openCinema-blockout-animatic-v1", createdAt: new Date().toISOString(),
      source: { projectId: project.id, revision: revision.split("/").at(-1), sceneId: scene.id, ...(single ? { shotId: shot.id, shotName: shot.name, cameraName: shot.cameraName ?? "A", takeId: take.id, takeConfirmed: !!take.confirmed } : { shotIds: shots.map(item => item.id), order: "scene.shots" }) },
      range: single ? { start, end, sourceTimeOffset: start, sourceTimePerVideoSecond: 1 } : { start: 0, end: sourceDuration, mapping: "seeCuts", durationQuantization: "eachShotCeilDurationTimesFps", frameCountPolicy },
      ...(single ? {} : { cuts: segments.map(item => ({ shotId: item.shot.id, shotName: item.shot.name, cameraName: item.shot.cameraName ?? "A", takeId: item.shot.blockingTakeId, takeConfirmed: !!scene.blocking.find(take => take.id === item.shot.blockingTakeId)?.confirmed, sourceStart: item.start, sourceEnd: item.end, frameStart: item.frameStart, frameEndExclusive: item.frameStart + item.frameCount, frameCount: item.frameCount, videoStart: item.frameStart / fps, videoEndExclusive: (item.frameStart + item.frameCount) / fps, lastSourceTime: item.start + (item.frameCount - 1) / fps, camera: structuredClone(item.shot.camera), reference: { includedInPixels: false, selection: item.shot.referenceVideo ? structuredClone(item.shot.referenceVideo) : null } })), editing: { transition: "hardCut", labels: false, audio: false, sequence: "singleContiguousPngSequenceOneEncode", mixedAspectOrFps: "reject" } }),
      video: { path: "video.mp4", mimeType: "video/mp4", width, height: outputHeight, fps, frameCount, frameCountPolicy, duration, codec: "h264", audio: false, measured: rgbMeasured },
      camera: single ? structuredClone(shot.camera) : undefined, aspect: shot.aspect,
      reference: { includedInPixels: false, usage: "editorMonitorOnly", selection: single && shot.referenceVideo ? structuredClone(shot.referenceVideo) : null },
      rendering: { ...environmentRendering, environmentPreset: environmentPreset(scene.environment.lighting).id },
      intent: { sceneName: scene.name, environment: structuredClone(scene.environment), entities: structuredClone(scene.entities), ...(single ? { take: structuredClone(take) } : { takes: structuredClone(scene.blocking.filter(take => shots.some(shot => shot.blockingTakeId === take.id))) }), modelFilesRelativeTo: "parentNodeAssets" },
      attribution: { name: "Blockout", author: "Sam Wasserman (wassermanproductions.com)", license: "Apache-2.0", commit: "3f2d0564fd575f70fc28e9bfaa7e94b05e3955d9", adaptation: "OpenCinema local sequential capture and encoding" },
      protocol: { type: "rgb", purpose: ["spatialLayout", "cameraFraming", "actionTiming"], controlLayers,
        appearance: "程序化代理或用户导入模型；外观约束须另行选择，不会自动发送给生成模型", generatedBy: "Three 摄影机逐帧渲染与本机 FFmpeg 编码" },
      limitations: [...(single ? [] : ["Animatic仅按场景镜头顺序clean硬切，每镜从t0开始；不含其他bank机位、不含控制层/转场/音频/标签，逐镜ceil采样可能延长不足一帧"]), "Ghost/PiP参考仅用于编辑器监看，不烧入视频或PNG，不自动重定向人物/摄影机", "RGB端口仍是意图参考；仅清单中列出的独立Depth/Normal才实际导出，未生成Pose/Mask/Edges", "控制视频是8位有损H264可视条件，不是浮点米制深度或无损法线数据；yuv420p与CRF18会改变像素，范围外Depth夹断", "Depth/Normal共同使用不透明最近几何表面；保留alphaTest/贴图/原base opacity裁剪，BLEND与折射按不透明处理且强制深度测试/写入，不是光学穿透或透明介质测距；随机alpha、自定义shader和不支持图元拒绝，不含clearcoat等额外光学层", "按已保存时间线离线渲染；摄影录制先转为可编辑标记，不是实时屏幕录屏或人物表演捕捉", "太阳阴影以场景原点为目标，使用光源视角正负25米的固定正交范围，不动态跟随主体；范围外仍有直射光和环境光", "转向与行走等意图由求值器表达，生成结果仍须另行评审"],
    };
    await files.writeJson(manifestPath, manifest, true);
    await files.remove(framesDirectory, true);
    check(); signal.throwIfAborted();
    completed = true;
    return { directory, videoPath, manifestPath, manifest, controlLayers: controlLayers.map(layer => ({ ...layer, path: `${directory}/${layer.path}` })) };
  } catch (failure) {
    if (!created) throw failure;
    cleanupSafe ||= (failure as { ffmpegSettled?: boolean })?.ffmpegSettled === true;
    if (!cleanupSafe) throw new AggregateError([failure], `FFmpeg 结束状态未确认；旧输出保留，本次临时目录未删除：${directory}`);
    try { await files.remove(directory, true); }
    catch (cleanup) { throw new AggregateError([failure, cleanup], `导出未完成，临时目录清理失败：${directory}`); }
    throw failure;
  } finally { if (completed) progress("全部所选视频已完成", 100); }
}
