import poseWorker from "./motion/poseWorker?worker&inline";
import { observeMediaError } from "@toonflow/node-shared/mediaError";
import { countSampleFrames, frameCountPolicy } from "@toonflow/node-shared/mediaSampling";
import { exportMotion } from "./motion/exportMotion";
import type { ProductionPlan } from "@toonflow/node-shared/motionProduction";
import type { CameraMotionData, PoseData } from "./motion/types";
import { z } from "zod";
import { uploadNodeFile, type WorkspaceFiles } from "@toonflow/nodes-scaffold/nodeFiles";
import type { NodeMediaValue } from "@toonflow/nodes-scaffold/values";
import type { BrowserFfmpegFactory } from "@toonflow/ffmpeg/browser";
import type { createMotionResources } from "./reactResources";
type EngineContext = {
  signal: AbortSignal;
  getFiles(): WorkspaceFiles;
  resources: ReturnType<typeof createMotionResources>;
};

export const analysisSettingsSchema = z
  .strictObject({
    start: z.number().finite().min(0),
    end: z.number().finite().positive(),
    sampleFps: z.number().int().min(2).max(12),
    pose: z.boolean().optional(),
    depth: z.boolean().optional(),
  })
  .refine(
    (value) => value.end > value.start && value.end - value.start <= 30,
    "分析范围必须大于0且不超过30秒",
  );
export type AnalysisSettings = z.infer<typeof analysisSettingsSchema>;

function waitVideo(
  video: HTMLVideoElement,
  event: "loadeddata" | "seeked",
  signal: AbortSignal,
  action: () => void,
  describeFailure: () => string,
) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const clean = () => {
      clearTimeout(timer);
      video.removeEventListener(event, done);
      video.removeEventListener("error", failed);
      signal.removeEventListener("abort", abort);
    };
    const done = () => {
      clean();
      resolve();
    };
    const failed = () => {
      clean();
      reject(new Error(describeFailure()));
    };
    const abort = () => {
      clean();
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      clean();
      reject(new Error(`参考视频解码超时；${describeFailure()}`));
    }, 15000);
    video.addEventListener(event, done, { once: true });
    video.addEventListener("error", failed, { once: true });
    signal.addEventListener("abort", abort, { once: true });
    try {
      action();
    } catch (error) {
      clean();
      reject(error);
    }
  });
}

const extension = {
  apiVersion: 1,
  activate(context: EngineContext) {
    const resourceState = { value: "模型随插件离线提供，启用姿态后校验加载" };
    const phase = { value: "" };
    let busy = false;
    return {
      service: {
        resourceState,
        phase,
        async exportResult(
          nodeId: string,
          reportPath: string,
          loadFfmpeg: (signal?: AbortSignal) => Promise<BrowserFfmpegFactory>,
          signal: AbortSignal,
          plan?: ProductionPlan,
        ) {
          const combined = AbortSignal.any([signal, context.signal, AbortSignal.timeout(180000)]);
          combined.throwIfAborted();
          if (busy) throw new Error("当前画布已有 Motion 任务，请完成或取消后再试");
          busy = true;
          try {
            const files = context.getFiles();
            phase.value = "正在检查本机 FFmpeg；不会自动下载安装…";
            const ffmpeg = await loadFfmpeg(combined);
            return await exportMotion(
              files,
              ffmpeg,
              nodeId,
              reportPath,
              combined,
              (value) => {
                phase.value = value;
              },
              plan,
            );
          } finally {
            busy = false;
            phase.value = "";
          }
        },
        async analyze(
          nodeId: string,
          reference: NodeMediaValue,
          input: AnalysisSettings,
          signal: AbortSignal,
          onProgress: (progress: number) => void,
          frozen?: { files: WorkspaceFiles; contentSha256: string },
        ) {
          const settings = analysisSettingsSchema.parse(input);
          if (settings.depth)
            throw new Error("相对深度须由当前节点的固定本机操作委托执行，不能直接混入浏览器推理");
          const combined = AbortSignal.any([signal, context.signal, AbortSignal.timeout(180000)]);
          combined.throwIfAborted();
          if (!reference.mimeType.startsWith("video/")) throw new Error("Motion 只接受视频参考");
          if (busy) throw new Error("当前画布已有Motion分析，请完成或取消后再试");
          busy = true;
          let worker: Worker | undefined;
          let url = "";
          const video = document.createElement("video");
          const mediaFailure = observeMediaError(video);
          const stop = () => worker?.terminate();
          combined.addEventListener("abort", stop, { once: true });
          try {
            const files = frozen?.files ?? context.getFiles();
            phase.value = "正在读取本地参考视频…";
            const bytes = await files.read(reference.url, 256 * 1024 ** 2, combined);
            combined.throwIfAborted();
            if (!bytes.byteLength || bytes.byteLength > 256 * 1024 ** 2)
              throw new Error("参考视频须为256MiB以内的非空文件");
            const hash = await crypto.subtle.digest("SHA-256", bytes);
            const contentSha256 = Array.from(new Uint8Array(hash), (value) =>
              value.toString(16).padStart(2, "0"),
            ).join("");
            if (frozen && contentSha256 !== frozen.contentSha256)
              throw new Error("源视频与冻结 Depth 输入的摘要不一致，原报告保留");
            const describeFailure = () =>
              `${mediaFailure.describe("参考视频无法解码")}；源 ${bytes.byteLength} 字节，SHA-256 ${contentSha256}`;
            url = URL.createObjectURL(new Blob([bytes], { type: reference.mimeType }));
            video.muted = true;
            video.preload = "auto";
            phase.value = "正在解码参考视频…";
            await waitVideo(
              video,
              "loadeddata",
              combined,
              () => {
                video.src = url;
                video.load();
              },
              describeFailure,
            );
            if (
              !Number.isFinite(video.duration) ||
              ![video.videoWidth, video.videoHeight].every(
                (value) => value > 0 && value <= 16384,
              ) ||
              settings.end > video.duration + 0.01
            )
              throw new Error("分析范围超过视频时长，或视频尺寸超过16384像素");
            const duration = settings.end - settings.start;
            const resources = context.resources;
            let model: ArrayBuffer | undefined,
              wasm: ArrayBuffer | undefined,
              loader: ArrayBuffer | undefined;
            if (settings.pose) {
              if (!resources) throw new Error("宿主缺少插件资源管理能力，请更新应用");
              resourceState.value = "正在校验离线模型与WASM…";
              phase.value = resourceState.value;
              [model, wasm, loader] = await Promise.all(
                ["poseModel", "visionWasm", "visionLoader"].map((name) =>
                  resources.read(name, combined),
                ),
              );
              combined.throwIfAborted();
              resourceState.value = "资源校验通过，正在启动后台分析…";
            }
            phase.value = "正在启动 Motion Worker…";
            worker = new poseWorker();
            async function request(
              message: Record<string, unknown>,
              transfer: Transferable[] = [],
            ) {
              combined.throwIfAborted();
              return new Promise<{ type: string; camera?: CameraMotionData; pose?: PoseData }>(
                (resolve, reject) => {
                  const cleanup = () => {
                    clearTimeout(timer);
                    combined.removeEventListener("abort", abort);
                    worker!.onmessage = null;
                    worker!.onerror = null;
                    worker!.onmessageerror = null;
                  };
                  const fail = (reason: unknown) => {
                    cleanup();
                    reject(reason);
                  };
                  const abort = () => fail(combined.reason);
                  const timer = setTimeout(() => fail(new Error("Motion 后台分析响应超时")), 60000);
                  combined.addEventListener("abort", abort, { once: true });
                  worker!.onerror = (event) => {
                    event.preventDefault();
                    fail(new Error("Motion 后台分析执行失败，请重新加载插件"));
                  };
                  worker!.onmessageerror = () => fail(new Error("Motion 后台分析消息无法解析"));
                  worker!.onmessage = (event) => {
                    cleanup();
                    if (event.data?.type === "error") return reject(new Error(event.data.message));
                    const expected =
                      message.type === "init"
                        ? "ready"
                        : message.type === "finish"
                          ? "result"
                          : "frame";
                    if (event.data?.type !== expected)
                      return reject(new Error("Motion 后台分析响应无效"));
                    resolve(event.data);
                  };
                  try {
                    worker!.postMessage(message, transfer);
                  } catch (failure) {
                    fail(failure);
                  }
                },
              );
            }
            await request(
              {
                type: "init",
                model,
                wasm,
                loader,
                width: video.videoWidth,
                height: video.videoHeight,
                fps: settings.sampleFps,
                duration,
              },
              model && wasm && loader ? [model, wasm, loader] : [],
            );
            if (settings.pose) resourceState.value = "BlazePose Lite v1 · 离线模型已就绪";
            const count = countSampleFrames(duration, settings.sampleFps);
            const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
            for (let index = 0; index < count; index++) {
              combined.throwIfAborted();
              phase.value = `正在分析第 ${index + 1}/${count} 帧…`;
              const time = settings.start + index / settings.sampleFps;
              if (Math.abs(video.currentTime - time) > 0.001)
                await waitVideo(
                  video,
                  "seeked",
                  combined,
                  () => {
                    video.currentTime = time;
                  },
                  describeFailure,
                );
              const bitmap = await createImageBitmap(video, {
                resizeWidth: Math.max(1, Math.round(video.videoWidth * scale)),
                resizeHeight: Math.max(1, Math.round(video.videoHeight * scale)),
              });
              try {
                await request({ type: "frame", bitmap, time: index / settings.sampleFps }, [
                  bitmap,
                ]);
              } finally {
                bitmap.close();
              }
              onProgress(Math.round(((index + 1) / count) * 100));
            }
            const result = await request({ type: "finish" });
            combined.throwIfAborted();
            const camera = result.camera;
            const pose = result.pose;
            if (!camera || (settings.pose && !pose))
              throw new Error("Motion 后台分析未返回完整结果");
            const report = {
              schemaVersion: 1,
              space: "image2d",
              frameCountPolicy,
              source: { ...reference, contentSha256 },
              settings,
              camera,
              pose,
              models: settings.pose
                ? {
                    pose: {
                      engine: "@mediapipe/tasks-vision",
                      engineVersion: "1.1.1",
                      delegate: "CPU",
                      resources: resources!.manifest,
                      worldSpace: "modelEstimatedHipRelative",
                      identityTracking: false,
                    },
                  }
                : undefined,
            };
            phase.value = "正在保存不可变分析报告…";
            const path = await uploadNodeFile(
              files,
              nodeId,
              new File([JSON.stringify(report)], "motion.json", { type: "application/json" }),
            );
            combined.throwIfAborted();
            const summary = `二维图像运动：水平 ${camera.summary.panPixels.toFixed(1)} px，垂直 ${camera.summary.tiltPixels.toFixed(1)} px，缩放 ${camera.summary.zoomRatio.toFixed(3)}，滚转 ${camera.summary.rollDegrees.toFixed(1)}°，平均置信度 ${camera.summary.averageConfidence.toFixed(2)}。${pose ? ` 人体姿态：${pose.summary.detectedFrames}/${pose.frames.length}帧检出，每人33关键点，缺失${pose.summary.missingFrames}帧。` : ""}`;
            return { path, summary };
          } catch (failure) {
            if (settings.pose)
              resourceState.value = combined.aborted
                ? "分析已停止；模型资源仍保留在插件中"
                : "姿态加载或分析失败，可重新检查离线资源";
            throw failure;
          } finally {
            busy = false;
            phase.value = "";
            combined.removeEventListener("abort", stop);
            worker?.terminate();
            mediaFailure.dispose();
            video.pause();
            video.removeAttribute("src");
            video.load();
            if (url) URL.revokeObjectURL(url);
          }
        },
      },
    };
  },
};

export type MotionService = ReturnType<typeof extension.activate>["service"];
export default extension;
