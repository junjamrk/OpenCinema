import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";
import { countSampleFrames, frameCountPolicy } from "@toonflow/node-shared/mediaSampling";
import { cameraAnalysisSize, createCameraMotionAnalyzer } from "./cameraMotion";
import type { PoseData, PoseFrame, Landmark } from "./types";

let landmarker: PoseLandmarker | undefined;
let camera: ReturnType<typeof createCameraMotionAnalyzer> | undefined;
let pose: PoseData;
let canvas: OffscreenCanvas;
let drawing: OffscreenCanvasRenderingContext2D;
let previousTime = -1;
let pending = false;

function landmarks(values: Landmark[]) {
  if (values.length !== 33 || values.some(value => ![value.x, value.y, value.z, value.visibility ?? 0, value.presence ?? 0].every(Number.isFinite))) throw new Error("姿态模型返回无效关键点");
  return values.map(({ x, y, z, visibility, presence }) => ({ x, y, z, visibility, presence }));
}

self.onmessage = async (event: MessageEvent) => {
  const message = event.data;
  if (pending) { message.bitmap?.close(); return; }
  pending = true;
  try {
    if (message.type === "init") {
      if (landmarker || ![message.width, message.height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 16384)) throw new Error("Worker初始化参数无效");
      if (message.model && !await FilesetResolver.isSimdSupported()) throw new Error("此浏览器不支持姿态模型所需的WASM SIMD");
      if (message.model) {
        const urls = [URL.createObjectURL(new Blob([message.loader], { type: "text/javascript" })), URL.createObjectURL(new Blob([message.wasm], { type: "application/wasm" }))];
        try {
          landmarker = await PoseLandmarker.createFromOptions({ wasmLoaderPath: urls[0]!, wasmBinaryPath: urls[1]! }, {
            baseOptions: { modelAssetBuffer: new Uint8Array(message.model), delegate: "CPU" },
            runningMode: "VIDEO", numPoses: 1, minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5, outputSegmentationMasks: false,
          });
        } finally { urls.forEach(url => URL.revokeObjectURL(url)); }
      }
      pose = { frameCountPolicy, fps: message.fps, duration: message.duration, width: message.width, height: message.height, frames: [], summary: { totalFrames: 0, detectedFrames: 0, missingFrames: 0, averageScore: 0, runtimeModel: "lite", runtimeDelegate: "CPU" } };
      camera = createCameraMotionAnalyzer({ width: message.width, height: message.height, fps: message.fps, duration: message.duration, poseData: message.model ? pose : undefined });
      const size = cameraAnalysisSize(message.width, message.height);
      canvas = new OffscreenCanvas(size.width, size.height);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("Worker无法读取视频帧");
      drawing = context;
      self.postMessage({ type: "ready" });
    } else if (message.type === "frame") {
      const bitmap = message.bitmap as ImageBitmap;
      try {
        if (!camera || !(bitmap instanceof ImageBitmap) || bitmap.width > 1280 || bitmap.height > 1280 || !Number.isFinite(message.time) || message.time <= previousTime || message.time < 0 || message.time >= pose.duration
          || pose.frames.length >= countSampleFrames(pose.duration, pose.fps, pose.frameCountPolicy) || pose.frames.length >= 360) throw new Error("Worker视频帧无效");
        const result = landmarker?.detectForVideo(bitmap, message.time * 1000);
        const points = result?.landmarks[0] ? landmarks(result.landmarks[0]) : [];
        const world = result?.worldLandmarks[0] ? landmarks(result.worldLandmarks[0]) : [];
        const score = points.length ? points.reduce((sum, value) => sum + (value.visibility ?? 0), 0) / points.length : 0;
        const frame: PoseFrame = { time: message.time, landmarks: points, worldLandmarks: world, score, source: points.length ? "detected" : "missing" };
        pose.frames.push(frame);
        drawing.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        camera.pushFrame(drawing.getImageData(0, 0, canvas.width, canvas.height), message.time);
        previousTime = message.time;
        result?.close();
        self.postMessage({ type: "frame", detected: !!points.length });
      } finally { bitmap?.close(); }
    } else if (message.type === "finish") {
      if (!camera || !pose.frames.length) throw new Error("尚未分析视频帧");
      const detected = pose.frames.filter(frame => frame.source === "detected");
      pose.summary = { ...pose.summary, totalFrames: pose.frames.length, detectedFrames: detected.length, missingFrames: pose.frames.length - detected.length, averageScore: detected.length ? detected.reduce((sum, frame) => sum + frame.score, 0) / detected.length : 0 };
      // 不合成缺失帧，不推断跨帧身份；保留模型原始单人关键点及其置信度。
      self.postMessage({ type: "result", camera: camera.finish(), pose: landmarker ? pose : undefined });
      landmarker?.close(); landmarker = undefined;
    } else throw new Error("未知Worker请求");
  } catch (failure) {
    self.postMessage({ type: "error", message: failure instanceof Error ? failure.message : "姿态分析失败" });
  } finally { pending = false; }
};
