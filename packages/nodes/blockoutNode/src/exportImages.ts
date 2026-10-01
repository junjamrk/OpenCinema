// OpenCinema adaptation of Blockout's still/contact-sheet/top-down delivery (Apache-2.0).
// Copyright 2026 Sam Wasserman (wassermanproductions.com); see ../readme.md.
import { z } from "zod";
import type { WorkspaceFiles } from "@toonflow/nodes-scaffold/nodeFiles";
import { zipSync } from "fflate";
import readme from "../readme.md?raw";
import { getShot } from "./editing";
import { environmentRendering } from "./environment";
import { ASPECT_RATIOS } from "./nativeBlockout/camera";
import { ShotEvaluator } from "./nativeBlockout/evaluate";
import type { ProjectDoc, Shot } from "./nativeBlockout/types";

export const stillExportSchema = z.strictObject({ sceneId: z.string().min(1), shotId: z.string().min(1), maxDimension: z.union([z.literal(640), z.literal(1280)]).optional(), showLabels: z.boolean().optional() });
export const contactSheetSchema = z.strictObject({ sceneId: z.string().min(1) });
export const topDownExportSchema = z.strictObject({ sceneId: z.string().min(1), shotId: z.string().min(1) });
const imageExportSchema = z.discriminatedUnion("type", [stillExportSchema.extend({ type: z.literal("stills") }), contactSheetSchema.extend({ type: z.literal("contactSheet") }), topDownExportSchema.extend({ type: z.literal("topDown") })]);
export type ImageExportInput = z.infer<typeof imageExportSchema>;
const maximumPngBytes = 64 * 1024 ** 2;
const maximumZipBytes = 80 * 1024 ** 2;
const notice = "Blockout — a previs tool for AI-native filmmaking\nCopyright 2026 Sam Wasserman\nhttps://wassermanproductions.com · https://wasserman.ai\n\nThis product was created by Sam Wasserman. Credit: Sam Wasserman (wassermanproductions.com).\nSource: wassermanproductions/blockout@3f2d0564fd575f70fc28e9bfaa7e94b05e3955d9; Apache-2.0.\nOpenCinema adapts still selection/contact-sheet/top-down composition to instance capture, local files, cancellation and history.\nThe accompanying readme.txt retains the complete Apache-2.0 license and original NOTICE.\nThis is an image handoff, not a restorable project or a license grant for user-imported content.\n";

export function stillTimes(shot: Shot) {
  const samples = new Map<string, { time: number; labels: string[]; cameraMarkIds: string[] }>();
  const add = (time: number, label: string, markId?: string) => {
    if (!Number.isFinite(time) || time < 0 || time > shot.duration) throw new Error("关键帧时间超出镜头范围");
    const key = time.toFixed(7), sample = samples.get(key) ?? { time, labels: [], cameraMarkIds: [] };
    sample.labels.push(label); if (markId) sample.cameraMarkIds.push(markId);
    samples.set(key, sample);
  };
  add(0, "first"); add(Math.max(0, shot.duration - 1 / shot.fps), "last");
  [...shot.camera.marks].sort((a, b) => a.time - b.time).forEach((mark, index) => add(mark.time, `cameraMark${index + 1}`, mark.id));
  if (samples.size > 256) throw new Error("关键帧包最多256个去重时间点，请减少当前机位标记后重试");
  return [...samples.values()].sort((a, b) => a.time - b.time);
}

function imageCanvas(width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 32000000) throw new Error("图片尺寸超出16384单边或3200万像素限制");
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("当前环境无法创建图片画布");
  context.fillStyle = "#111113"; context.fillRect(0, 0, width, height);
  return { canvas, context };
}
function caption(context: CanvasRenderingContext2D, text: string, x: number, y: number, width: number) {
  let fitted = text;
  while (fitted.length && context.measureText(fitted).width > width) fitted = fitted.slice(0, -1);
  if (fitted !== text) { fitted = fitted.slice(0, -1); context.fillText(`${fitted}…`, x, y); }
  else context.fillText(text, x, y);
}
async function pngBytes(canvas: HTMLCanvasElement) {
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
  if (!blob || blob.type !== "image/png") throw new Error("PNG编码失败");
  return new Uint8Array(await blob.arrayBuffer());
}
async function sha256(bytes: Uint8Array) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer)), value => value.toString(16).padStart(2, "0")).join("");
}

export async function exportImages(options: {
  files: WorkspaceFiles; directory: string; project: ProjectDoc; revision: string; input: ImageExportInput; signal: AbortSignal;
  capture: (sceneId: string, shotId: string, time: number, width: number) => Promise<{ dataUrl: string; width: number; height: number }>;
  captureTopDown: (sceneId: string, shotId: string) => Promise<{ dataUrl: string; width: number; height: number; diagram: Record<string, unknown> }>;
  check: () => void; progress: (phase: string, percent: number) => void;
}) {
  const { files, directory, project, revision, signal, check, progress } = options;
  const input = imageExportSchema.parse(options.input);
  const scene = project.scenes.find(item => item.id === input.sceneId);
  if (!scene) throw new Error("Blockout场景不存在");
  const shots = input.type === "contactSheet" ? scene.shots : [getShot(project, scene.id, input.shotId).shot];
  if (!shots.length || shots.length > 100) throw new Error("图片导出须选择有效镜头；联系表最多100个镜头");
  for (const shot of shots) if (!Number.isFinite(shot.duration) || shot.duration <= 0 || shot.duration > 300 || !Number.isInteger(shot.fps) || shot.fps < 1 || shot.fps > 60 || !ASPECT_RATIOS[shot.aspect]) throw new Error("镜头时长须为0–300秒、帧率1–60且画幅有效");
  const samples = shots.flatMap(shot => (input.type === "stills" ? stillTimes(shot) : [{ time: 0, labels: ["first"], cameraMarkIds: [] }]).map(sample => ({ shot, ...sample })));
  const entries: Record<string, Uint8Array> = {};
  const payloads: { path: string; mimeType: string; bytes: number; sha256: string }[] = [];
  const frames: Record<string, unknown>[] = [];
  const manifestPath = `${directory}/manifest.json`, archivePath = `${directory}/${input.type}.zip`;
  let pngTotal = 0, captureTotal = 0, created = false, previewPath = "";
  let sheet: ReturnType<typeof imageCanvas> | undefined;
  const cols = Math.min(3, shots.length), rows = Math.ceil(shots.length / cols), cellWidth = 640, cellHeight = 360, padding = 24, captionHeight = 44;
  async function addPayload(path: string, bytes: Uint8Array, mimeType: string) {
    check(); signal.throwIfAborted();
    if (mimeType === "image/png") { pngTotal += bytes.byteLength; if (pngTotal > maximumPngBytes) throw new Error("本次全部输出PNG超过64MiB，请减少关键帧数量或选择640像素"); }
    const digest = await sha256(bytes); check(); signal.throwIfAborted();
    await files.write(`${directory}/${path}`, bytes.slice().buffer, true); check(); signal.throwIfAborted();
    entries[path] = bytes; payloads.push({ path, mimeType, bytes: bytes.byteLength, sha256: digest });
  }
  try {
    check(); signal.throwIfAborted();
    await files.mkdir(directory); created = true;
    if (input.type === "contactSheet") {
      sheet = imageCanvas(cols * cellWidth + (cols + 1) * padding, rows * (cellHeight + captionHeight) + (rows + 1) * padding + 92);
      sheet.context.fillStyle = "#ececf1"; sheet.context.font = "bold 28px system-ui, sans-serif";
      caption(sheet.context, `${scene.name} · 联系表`, padding, 42, sheet.canvas.width - padding * 2);
    }
    for (const [index, sample] of samples.entries()) {
      check(); signal.throwIfAborted(); progress(`正在捕获${input.type === "topDown" ? "正交俯视图" : "摄影关键帧"} ${index + 1}/${samples.length}`, Math.round(index / samples.length * 80));
      const { shot, time } = sample, aspect = ASPECT_RATIOS[shot.aspect];
      const width = input.type === "topDown" ? 1600 : input.type === "stills" ? Math.round((input.maxDimension ?? 1280) * Math.min(1, aspect)) : Math.max(1, Math.floor(Math.min(cellWidth, cellHeight * aspect)));
      const height = input.type === "topDown" ? 1600 : Math.round(width / aspect), state = new ShotEvaluator(scene, shot).evaluate(time);
      const image = await (input.type === "topDown" ? options.captureTopDown(scene.id, shot.id) : options.capture(scene.id, shot.id, time, width)); check(); signal.throwIfAborted();
      if (image.width !== width || image.height !== height || !image.dataUrl.startsWith("data:image/png;base64,") || image.dataUrl.length > 16 * 1024 ** 2 * 4 / 3 + 100) throw new Error("摄影机返回PNG格式、尺寸或16MiB单帧边界无效");
      const captured = Uint8Array.from(atob(image.dataUrl.slice(22)), value => value.charCodeAt(0));
      captureTotal += captured.byteLength;
      if (captured.byteLength > 16 * 1024 ** 2 || captureTotal > maximumPngBytes) throw new Error("本次摄影捕获PNG合计超过64MiB，请减少帧数或选择640像素");
      const sourceSha256 = await sha256(captured); check(); signal.throwIfAborted();
      const bitmap = await createImageBitmap(new Blob([captured.buffer], { type: "image/png" }));
      let labelled: ReturnType<typeof imageCanvas> | undefined;
      let path: string | undefined, outputWidth = width, outputHeight = height, rect = { x: 0, y: 0, width, height };
      try {
        check(); signal.throwIfAborted();
        if (bitmap.width !== width || bitmap.height !== height) throw new Error("实解码PNG尺寸与摄影捕获不一致");
        if (input.type === "topDown") {
          path = "topDown.png"; await addPayload(path, captured, "image/png"); previewPath = `${directory}/${path}`;
        } else if (input.type === "stills") {
          let bytes = captured;
          if (input.showLabels !== false) {
            labelled = imageCanvas(width, height + 72); labelled.context.drawImage(bitmap, 0, 0);
            labelled.context.fillStyle = "#ececf1"; labelled.context.font = "600 16px system-ui, sans-serif";
            caption(labelled.context, `${scene.name} / ${shot.name}`, 12, height + 22, width - 24);
            labelled.context.fillStyle = "#b4b4c0"; labelled.context.font = "14px system-ui, sans-serif";
            caption(labelled.context, `机位${shot.cameraName ?? "A"} · ${time.toFixed(3)}s · ${state.camera.focalLength.toFixed(1)}mm · ${sample.labels.join("/")}`, 12, height + 43, width - 24);
            labelled.context.font = "11px system-ui, sans-serif"; caption(labelled.context, "Blockout · Sam Wasserman (wassermanproductions.com) / OpenCinema", 12, height + 62, width - 24);
            bytes = await pngBytes(labelled.canvas); outputHeight = labelled.canvas.height;
          }
          path = `frame${String(index).padStart(3, "0")}.png`;
          check(); signal.throwIfAborted(); await addPayload(path, bytes, "image/png");
          previewPath ||= `${directory}/${path}`;
        } else {
          const x = padding + index % cols * (cellWidth + padding), y = 60 + padding + Math.floor(index / cols) * (cellHeight + captionHeight + padding);
          const scale = Math.min(cellWidth / width, cellHeight / height), drawWidth = Math.round(width * scale), drawHeight = Math.round(height * scale);
          rect = { x: x + Math.floor((cellWidth - drawWidth) / 2), y: y + Math.floor((cellHeight - drawHeight) / 2), width: drawWidth, height: drawHeight };
          sheet!.context.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height);
          sheet!.context.fillStyle = "#ececf1"; sheet!.context.font = "600 16px system-ui, sans-serif"; caption(sheet!.context, shot.name, x, y + cellHeight + 18, cellWidth);
          sheet!.context.fillStyle = "#9b9ba6"; sheet!.context.font = "14px system-ui, sans-serif";
          caption(sheet!.context, `机位${shot.cameraName ?? "A"} · ${state.camera.focalLength.toFixed(1)}mm · ${shot.duration.toFixed(1)}s · ${shot.aspect}`, x, y + cellHeight + 38, cellWidth);
        }
        frames.push({ shotId: shot.id, shotName: shot.name, cameraName: shot.cameraName ?? "A", takeId: shot.blockingTakeId, takeConfirmed: !!scene.blocking.find(take => take.id === shot.blockingTakeId)?.confirmed, time, labels: sample.labels, cameraMarkIds: sample.cameraMarkIds, fps: shot.fps, duration: shot.duration, aspect: shot.aspect, camera: state.camera, sensorId: shot.camera.sensorId, capture: { width, height, mimeType: "image/png", bytes: captured.byteLength, sha256: sourceSha256 }, image: { path: path ?? "contactSheet.png", width: outputWidth, height: outputHeight, pictureRect: rect }, referenceIncludedInPixels: false, ...(input.type === "topDown" && "diagram" in image ? { diagram: image.diagram } : {}) });
      } finally { bitmap.close(); if (labelled) { labelled.canvas.width = 1; labelled.canvas.height = 1; } }
    }
    if (sheet) {
      sheet.context.fillStyle = "#9b9ba6"; sheet.context.font = "12px system-ui, sans-serif";
      caption(sheet.context, "Blockout · Sam Wasserman (wassermanproductions.com) / OpenCinema", padding, sheet.canvas.height - 16, sheet.canvas.width - padding * 2);
      for (const frame of frames) Object.assign(frame.image as object, { width: sheet.canvas.width, height: sheet.canvas.height });
      const bytes = await pngBytes(sheet.canvas); check(); signal.throwIfAborted(); await addPayload("contactSheet.png", bytes, "image/png");
      previewPath = `${directory}/contactSheet.png`;
    }
    progress("正在写入图片来源与许可", 85);
    await addPayload("readme.txt", new TextEncoder().encode(readme), "text/plain");
    await addPayload("notice.txt", new TextEncoder().encode(notice), "text/plain");
    const manifest = { schema: "openCinema-blockout-images-v1", type: input.type, createdAt: new Date().toISOString(), source: { projectId: project.id, revision: revision.split("/").at(-1), sceneId: scene.id, sceneName: scene.name, environment: structuredClone(scene.environment) }, rendering: environmentRendering, attribution: { name: "Blockout", author: "Sam Wasserman (wassermanproductions.com)", license: "Apache-2.0", commit: "3f2d0564fd575f70fc28e9bfaa7e94b05e3955d9", adaptation: "OpenCinema image delivery" }, frames, payloads, layout: input.type === "topDown" ? { width: 1600, height: 1600, projection: "orthographic", time: 0, annotations: "allCurrentTakeMarksAndWorldPathsAndActiveCamera", picture: "diagramNotPhotography" } : input.type === "stills" ? { showLabels: input.showLabels !== false, captionOutsidePicture: input.showLabels !== false, captionHeight: input.showLabels === false ? 0 : 72, maximumPictureDimension: input.maxDimension ?? 1280 } : { cols, rows, cellWidth, cellHeight, captionHeight, padding, fit: "contain" }, limits: { maximumShotDuration: 300, maximumStills: 256, maximumContactShots: 100, maximumPngBytes, maximumZipBytes, maximumCanvasPixels: 32000000, maximumTopDownPathPoints: 250000, maximumTopDownMarks: 8192 }, capturedPngBytes: captureTotal, outputPngBytes: pngTotal, hashing: "SHA-256 covers every PNG/readme/notice payload; manifest excludes itself; archive digest is returned separately", limitations: [input.type === "topDown" ? "俯视图为t0场景实体、当前Take全部原标记/世界路径和活动摄影机示意；遵循excludeFromExport排除几何/标记/路径/名称，仅清单列排除ID与原因；非摄影成片" : "摄影帧来自当前活动机位；参考Ghost/PiP、编辑辅助不烧入像素", "标题使用系统字体，长文本图片显示省略号；完整名称保留于清单", "这是静帧交付包，不包含可还原工程或用户模型原资产", "本图片包没有animatic、GLB或生成模型调用；俯视路径按10Hz并加入原mark/hold边界求值，不是精确解析曲线，文字可能重叠"] };
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
    if (manifestBytes.byteLength > 8 * 1024 ** 2) throw new Error("图片清单超过8MiB，未发布");
    await files.write(manifestPath, manifestBytes.buffer, true); check(); signal.throwIfAborted(); entries["manifest.json"] = manifestBytes;
    progress("正在打包本地图片", 94);
    // ACT: PNG已压缩；同步store ZIP仅限64MiB图片+8MiB清单，避免worker/CSP与无界内存，打包前后检查取消。
    const packed = zipSync(entries, { level: 0 });
    if (packed.byteLength > maximumZipBytes) throw new Error("图片ZIP超过80MiB，未发布");
    check(); signal.throwIfAborted();
    const archiveSha256 = await sha256(packed); check(); signal.throwIfAborted();
    await files.write(archivePath, packed.slice().buffer, true); check(); signal.throwIfAborted(); progress("图片已打包，正在发布", 98);
    return { directory, archivePath, archiveSha256, archiveBytes: packed.byteLength, manifestPath, previewPath, manifest };
  } catch (failure) {
    if (created) try { await files.remove(directory, true); } catch (cleanup) { throw new AggregateError([failure, cleanup], `图片导出未完成且清理失败：${directory}`); }
    throw failure;
  } finally { if (sheet) { sheet.canvas.width = 1; sheet.canvas.height = 1; } }
}
