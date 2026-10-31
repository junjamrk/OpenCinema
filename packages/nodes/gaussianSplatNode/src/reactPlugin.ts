import { z } from "zod";
import type { NodePluginDefinition } from "@toonflow/nodes-scaffold/contracts";
import { getNodeDirectory, uploadNodeFile } from "@toonflow/nodes-scaffold/nodeFiles";
import { ToolExecutionError } from "@toonflow/nodes-scaffold/toolErrors";
import type { BrowserFfmpegCommand } from "@toonflow/ffmpeg/browser";
import { errorText, mediaValueSchema, nodePreconditionError, pluginServices, readNodeData, relativePathSchema } from "@toonflow/node-shared/reactNode";
import { inspectSplatFile, maximumSplatBytes, maximumSplatCount, splatFormatOf, splatFormats, splatMimeTypes } from "./splatFile";
import { createSplatStage, defaultBackground, frameCamera, type SplatCamera, type SplatStage } from "./splatStage";
import GaussianSplatNodeView from "./reactView";

// 数据模型：splat（来源，进入历史）、camera（机位，进入历史）、outputs.file/image/video（端口），splatRender（运行态，不进入历史）。
const vec3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
export const cameraSchema = z.strictObject({
  position: vec3.describe("相机位置，场景单位"), target: vec3.describe("注视点"), up: vec3.default([0, 1, 0]), fov: z.number().min(10).max(120).default(50).describe("垂直视角，度"),
});
export const sourceSchema = z.strictObject({ path: z.string(), format: z.enum(splatFormats), bytes: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/), splatCount: z.number().int().positive(), name: z.string() });
export type SplatSource = z.infer<typeof sourceSchema>;
const boundsSchema = z.strictObject({ min: vec3, max: vec3, center: vec3, radius: z.number() });
const renderStatusSchema = z.strictObject({
  status: z.enum(["idle", "running", "completed", "failed", "cancelled", "interrupted"]), kind: z.enum(["still", "turntable"]).optional(), phase: z.string().optional(),
  progress: z.number().min(0).max(100).optional(), taskId: z.string().optional(), error: z.string().optional(), output: mediaValueSchema.optional(),
});
export type RenderStatus = z.infer<typeof renderStatusSchema>;
const expected = { expectedRevision: z.number().int().nonnegative().optional().describe("画布 documentRevision；省略时按当前修订写入") };
const background = z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().default(defaultBackground).describe("十六进制底色；null 为透明背景");
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const writes = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const revision = z.number().int().nonnegative();

function readSource(data: Record<string, unknown>) { const parsed = sourceSchema.safeParse(data.splat); return parsed.success ? parsed.data : undefined; }
function readCamera(data: Record<string, unknown>) { const parsed = cameraSchema.safeParse(data.camera); return parsed.success ? parsed.data : undefined; }
function readStatus(data: Record<string, unknown>): RenderStatus { const parsed = renderStatusSchema.safeParse(data.splatRender); return parsed.success ? parsed.data : { status: "idle" }; }
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
const ignoreExisting = (error: { response?: { data?: { data?: { code?: string } } } }) => { if (error.response?.data?.data?.code !== "EEXIST") throw error; };

const plugin: NodePluginDefinition<typeof GaussianSplatNodeView> = {
  apiVersion: 1, id: "gaussianSplatNode", name: "Gaussian Splat", version: "1.0.0", renderer: "react", icon: "spatial", view: GaussianSplatNodeView,
  createData: () => ({
    label: "Gaussian Splat",
    handles: [
      { id: "source", type: "target", dataType: "FILE", label: "扫描文件 .ply / .splat / .ksplat / .spz" },
      { id: "image", type: "source", dataType: "IMAGE", label: "渲染静帧" },
      { id: "video", type: "source", dataType: "VIDEO", label: "环绕视频" },
      { id: "file", type: "source", dataType: "FILE", label: "扫描文件" },
    ],
    outputs: {},
  }),
  cloneData(data) {
    const copy = structuredClone(data);
    if (readStatus(copy).status === "running") delete copy.splatRender;
    return copy;
  },
  activate(context) {
    const { id, document, workbench } = pluginServices(context);
    const files = workbench.files;
    const target = { directory: workbench.directory, canvasId: workbench.canvasId, nodeId: id };
    let headless: { stage: SplatStage; key: string } | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let operation: AbortController | undefined;
    let task: Promise<unknown> | undefined;
    const data = () => readNodeData(document, id);
    const outputsOf = () => (data().outputs as Record<string, unknown> | undefined) ?? {};
    const setStatus = (status: RenderStatus, signal?: AbortSignal) => workbench.updateRuntimeData({ splatRender: status }, signal).catch(() => {});
    function requireSource() {
      const source = readSource(data());
      if (!source) throw nodePreconditionError(workbench, id, "尚未选择扫描文件", "splatSourceRequired", { action: "readState", message: "先 getSplatInfo 读取当前状态；连接 FILE 输入或准备好工作区内的扫描文件后调用 setSplatSource。此前未启动任何渲染。", tool: "getSplatInfo", args: {} });
      return source;
    }
    function requireIdle() {
      if (task) throw new ToolExecutionError({ code: "renderBusy", message: "节点正在渲染，请等待完成或先取消", phase: "validation", executionState: "notDispatched", target, recovery: { action: "readState", message: "用 getRenderStatus 观察进度，必要时 cancelRender 后重试", tool: "getRenderStatus", args: {} } });
    }
    async function readContent(source: SplatSource, signal: AbortSignal) {
      const head = files.readRange ? await files.readRange(source.path, 0, 1, undefined, signal) : undefined;
      if (head && head.size !== source.bytes) throw new Error("扫描文件已变化，字节数与记录不符；请重新调用 setSplatSource");
      const content = await files.read(source.path, maximumSplatBytes, signal);
      if (content.byteLength !== source.bytes) throw new Error("扫描文件读取不完整");
      return content;
    }
    // 空闲 90 秒后释放无界面舞台；任务进行中不释放，任务结束时重新计时。
    function touchIdle() { clearTimeout(idleTimer); idleTimer = setTimeout(() => { if (task) touchIdle(); else void releaseStage(); }, 90000); }
    async function releaseStage() { clearTimeout(idleTimer); const current = headless; headless = undefined; await current?.stage.dispose(); }
    // 无界面舞台按来源 SHA 缓存，空闲 90 秒后释放；视图有自己的交互舞台，两者互不影响。
    async function stageFor(source: SplatSource, signal: AbortSignal) {
      touchIdle();
      if (headless?.key === source.sha256) return headless.stage;
      await releaseStage();
      const stage = createSplatStage();
      try { await stage.load(await readContent(source, signal), source.format, signal); }
      catch (error) { await stage.dispose().catch(() => {}); throw error; }
      headless = { stage, key: source.sha256 };
      touchIdle();
      return stage;
    }
    context.onDispose(async () => { operation?.abort(new Error("节点已卸载")); await task?.catch(() => {}); await releaseStage(); });
    context.onBeforeChange(async () => { operation?.abort(new Error("节点即将变更")); await task?.catch(() => {}); });

    context.registerTool({
      name: "getSplatInfo", annotations: readOnly,
      description: "读取当前扫描来源（路径、格式、字节数、SHA-256、Gaussian 数量）、已保存机位、渲染状态、三个输出端口与已连接的 FILE 输入；不读文件内容、不渲染。先调用它再决定下一步。",
      parameters: z.strictObject({}),
      outputSchema: z.strictObject({ source: sourceSchema.nullable(), camera: cameraSchema.nullable(), render: renderStatusSchema, outputs: z.strictObject({ image: mediaValueSchema.optional(), video: mediaValueSchema.optional(), file: mediaValueSchema.optional() }), connectedInput: mediaValueSchema.nullable(), limits: z.strictObject({ maximumBytes: z.number(), maximumSplats: z.number(), formats: z.array(z.string()) }), revision }),
      execute() {
        const current = data(), outputs = outputsOf() as Record<string, { value?: unknown } | undefined>;
        const media = (key: string) => { const parsed = mediaValueSchema.safeParse(outputs[key]?.value); return parsed.success ? parsed.data : undefined; };
        const input = workbench.getInputs("source").map(item => mediaValueSchema.safeParse(item.value)).find(item => item.success);
        return { source: readSource(current) ?? null, camera: readCamera(current) ?? null, render: statusNow(), outputs: { image: media("image"), video: media("video"), file: media("file") }, connectedInput: input?.success ? input.data : null, limits: { maximumBytes: maximumSplatBytes, maximumSplats: maximumSplatCount, formats: [...splatFormats] }, revision: document.getRevision() };
      },
    });
    function statusNow(): RenderStatus {
      const saved = readStatus(data());
      return saved.status === "running" && !task ? { ...saved, status: "interrupted", error: "渲染在页面重载或节点重建时中断，未发布产物" } : saved;
    }

    context.registerTool({
      name: "setSplatSource", annotations: writes,
      description: "选择扫描文件：传入工作区相对路径，或省略 path 使用已连接的 FILE 输入。按扩展名识别 ply/splat/ksplat/spz，校验结构并记录 SHA-256 与 Gaussian 数量，写入 file 输出端口；更换来源会清除旧机位与旧渲染输出。上限 100 MiB、2,000,000 个 Gaussian。",
      parameters: z.strictObject({ path: relativePathSchema.optional().describe("工作区内的扫描文件；省略时使用连接到 source 端口的 FILE"), ...expected }),
      outputSchema: sourceSchema.extend({ revision }),
      async execute(args, { signal }) {
        workbench.assertWritable(args.expectedRevision); requireIdle();
        const combined = AbortSignal.any([context.signal, signal]);
        let path = args.path, declaredMimeType: string | undefined;
        if (!path) {
          const inputs = workbench.getInputs("source"), value = inputs.map(item => mediaValueSchema.safeParse(item.value)).find(item => item.success)?.data;
          if (!value) throw nodePreconditionError(workbench, id, inputs.length ? "上游节点尚未提供文件" : "未连接 FILE 输入，也未提供 path", "splatSourceRequired");
          path = value.url; declaredMimeType = value.mimeType;
        }
        const format = splatFormatOf(path);
        if (!format) throw new Error("仅支持 .ply / .splat / .ksplat / .spz 扫描文件");
        const head = files.readRange ? await files.readRange(path, 0, 1, undefined, combined) : undefined;
        if (head && (!head.size || head.size > maximumSplatBytes)) throw new Error("扫描文件须非空且不超过 100 MiB");
        const content = await files.read(path, maximumSplatBytes, combined);
        const inspected = await inspectSplatFile(content, format, combined);
        const source: SplatSource = { path, format, ...inspected, name: path.split("/").at(-1) ?? path };
        workbench.assertWritable(args.expectedRevision);
        const { image: _image, video: _video, ...rest } = outputsOf();
        const mimeType = declaredMimeType && declaredMimeType !== "application/octet-stream" ? declaredMimeType : splatMimeTypes[format];
        await workbench.updateData({ splat: source, camera: null, outputs: { ...rest, file: { dataType: "FILE", value: { url: path, mimeType } } } }, args.expectedRevision, combined);
        await setStatus({ status: "idle" });
        if (headless && headless.key !== source.sha256) await releaseStage();
        await document.save();
        return { ...source, revision: document.getRevision() };
      },
    });

    context.registerTool({
      name: "getCamera", annotations: readOnly, description: "读取已保存机位（位置、注视点、上方向、垂直视角）与画布修订；未保存时返回 null。",
      parameters: z.strictObject({}), outputSchema: z.strictObject({ camera: cameraSchema.nullable(), revision }),
      execute() { return { camera: readCamera(data()) ?? null, revision: document.getRevision() }; },
    });
    context.registerTool({
      name: "setCamera", annotations: writes, description: "保存机位，纳入画布历史；节点视图随即切到该机位，后续 renderStill 默认使用它。",
      parameters: z.strictObject({ camera: cameraSchema, ...expected }), outputSchema: z.strictObject({ camera: cameraSchema, revision }),
      async execute(args, { signal }) {
        workbench.assertWritable(args.expectedRevision); requireSource();
        await workbench.updateData({ camera: args.camera }, args.expectedRevision, signal);
        await document.save();
        return { camera: args.camera, revision: document.getRevision() };
      },
    });
    context.registerTool({
      name: "frameCamera", annotations: writes,
      description: "加载扫描并按 2%–98% 分位包围球自动取景：azimuthDeg 绕竖直轴、elevationDeg 向上为正、distanceScale 1 刚好装进画面。返回机位与包围盒；save 为 true 时保存为当前机位。需要 WebGL，首次调用会读取整份文件。",
      parameters: z.strictObject({ azimuthDeg: z.number().min(-360).max(360).default(35), elevationDeg: z.number().min(-89).max(89).default(18), distanceScale: z.number().min(0.2).max(10).default(1), aspect: z.number().min(0.2).max(5).default(16 / 9), fov: z.number().min(10).max(120).default(50), save: z.boolean().default(true), ...expected }),
      outputSchema: z.strictObject({ camera: cameraSchema, bounds: boundsSchema, splatCount: z.number().int(), saved: z.boolean(), revision }),
      async execute(args, { signal }) {
        if (args.save) workbench.assertWritable(args.expectedRevision);
        const source = requireSource(); requireIdle();
        const combined = AbortSignal.any([context.signal, signal]);
        const stage = await stageFor(source, combined);
        const bounds = stage.getBounds()!;
        const camera = frameCamera(bounds, args.fov, args.aspect, args);
        if (args.save) { workbench.assertWritable(args.expectedRevision); await workbench.updateData({ camera }, args.expectedRevision, combined); await document.save(); }
        return { camera, bounds, splatCount: stage.getSplatCount(), saved: args.save, revision: document.getRevision() };
      },
    });

    context.registerTool({
      name: "renderStill", annotations: writes,
      description: "用本机 WebGL 渲染一张 PNG 静帧并写入 image 端口：camera 省略时用已保存机位，都没有时自动取景并保存该机位。同步返回产物路径；不调用生成模型。",
      parameters: z.strictObject({ width: z.number().int().min(64).max(4096).default(1280), height: z.number().int().min(64).max(4096).default(720), camera: cameraSchema.optional(), background, ...expected }),
      outputSchema: z.strictObject({ path: z.string(), mimeType: z.literal("image/png"), width: z.number().int(), height: z.number().int(), camera: cameraSchema, revision }),
      async execute(args, { signal }) {
        workbench.assertWritable(args.expectedRevision);
        const source = requireSource(); requireIdle();
        operation = new AbortController();
        const combined = AbortSignal.any([context.signal, operation.signal, signal]);
        const current = task = (async () => {
          try {
            await setStatus({ status: "running", kind: "still", phase: "正在加载扫描", progress: 0 }, combined);
            const stage = await stageFor(source, combined);
            const saved = readCamera(data());
            const camera = args.camera ?? saved ?? frameCamera(stage.getBounds()!, 50, args.width / args.height);
            await setStatus({ status: "running", kind: "still", phase: "正在渲染", progress: 40 }, combined);
            const blob = await stage.capturePng(args.width, args.height, { camera, background: args.background }, combined);
            if (blob.size > 64 * 1024 ** 2) throw new Error("PNG 超过 64 MiB，请降低尺寸");
            const path = await uploadNodeFile(files, id, new File([blob], "still.png", { type: "image/png" }));
            combined.throwIfAborted(); workbench.assertWritable(args.expectedRevision);
            const output = { url: path, mimeType: "image/png" as const };
            await workbench.updateData({ outputs: { ...outputsOf(), image: { dataType: "IMAGE", value: output } }, ...(saved || args.camera ? {} : { camera }) }, args.expectedRevision, combined);
            await setStatus({ status: "completed", kind: "still", progress: 100, output });
            await document.save();
            return { path, mimeType: "image/png" as const, width: args.width, height: args.height, camera, revision: document.getRevision() };
          } catch (error) {
            if (!context.signal.aborted) await setStatus({ status: combined.aborted ? "cancelled" : "failed", kind: "still", error: errorText(error) });
            throw error;
          }
        })();
        try { return await current; } finally { if (task === current) { task = undefined; operation = undefined; } touchIdle(); }
      },
    });

    context.registerTool({
      name: "renderTurntable", annotations: writes,
      description: "后台渲染一段环绕扫描中心的 H.264 MP4（无声）并写入 video 端口：逐帧 WebGL 截图，再由本机 FFmpeg 编码。立即返回 taskId，用 getRenderStatus 跟踪、cancelRender 取消；最多 600 帧。需要已配置 FFmpeg。",
      parameters: z.strictObject({ seconds: z.number().min(1).max(20).default(4), fps: z.number().int().min(1).max(30).default(24), width: z.number().int().min(64).max(1920).default(1280), height: z.number().int().min(64).max(1920).default(720), elevationDeg: z.number().min(-89).max(89).default(15), distanceScale: z.number().min(0.2).max(10).default(1), startAzimuthDeg: z.number().min(-360).max(360).default(35), clockwise: z.boolean().default(true), background, ...expected }),
      outputSchema: z.strictObject({ status: z.literal("queued"), taskId: z.string(), frames: z.number().int(), executionSettled: z.literal(false) }),
      async execute(args, { signal }) {
        workbench.assertWritable(args.expectedRevision);
        const source = requireSource(); requireIdle();
        const frames = Math.round(args.seconds * args.fps);
        if (frames < 1 || frames > 600) throw new Error("环绕视频最多 600 帧（seconds × fps）");
        const taskId = crypto.randomUUID();
        operation = new AbortController();
        // 任务信号只跟随节点与取消，不跟随这次调用的 120 秒超时；FFmpeg 工厂绑定的是它的生命周期信号，必须用长期信号创建。
        const combined = AbortSignal.any([context.signal, operation.signal]);
        signal.throwIfAborted();
        const ffmpeg = await workbench.ffmpeg(combined);
        const framesDirectory = `${getNodeDirectory(id)}/turntable-${taskId}`;
        const current = task = (async () => {
          let created = false, cleanupSafe = true;
          try {
            await setStatus({ status: "running", kind: "turntable", phase: "正在加载扫描", progress: 0, taskId }, combined);
            const stage = await stageFor(source, combined), bounds = stage.getBounds()!;
            for (const directory of ["assets", getNodeDirectory(id)]) await files.mkdir(directory).catch(ignoreExisting);
            await files.mkdir(framesDirectory); created = true;
            let bytes = 0;
            for (let index = 0; index < frames; index++) {
              combined.throwIfAborted();
              const azimuthDeg = args.startAzimuthDeg + (args.clockwise ? -1 : 1) * 360 * index / frames;
              const camera = frameCamera(bounds, 50, args.width / args.height, { azimuthDeg, elevationDeg: args.elevationDeg, distanceScale: args.distanceScale });
              const blob = await stage.capturePng(args.width, args.height, { camera, background: args.background }, combined);
              bytes += blob.size;
              if (bytes > 512 * 1024 ** 2) throw new Error("渲染帧合计超过 512 MiB，请缩短时长或降低尺寸");
              await files.write(`${framesDirectory}/frame${String(index).padStart(5, "0")}.png`, blob, true);
              await setStatus({ status: "running", kind: "turntable", phase: `正在渲染 ${index + 1}/${frames}`, progress: Math.round((index + 1) / frames * 85), taskId }, combined);
            }
            await setStatus({ status: "running", kind: "turntable", phase: "正在用本机 FFmpeg 编码", progress: 90, taskId }, combined);
            const videoPath = `${getNodeDirectory(id)}/${crypto.randomUUID()}.mp4`;
            // 编码期间若桥接断开，无法确认进程已退出：保留帧目录，不删除可能仍在读取的文件。
            cleanupSafe = false;
            await encode(ffmpeg(`${framesDirectory}/frame%05d.png`, { timeout: 300 }).inputFormat("image2").inputOptions("-framerate", String(args.fps), "-start_number", "0").noAudio().frames(frames)
              .videoCodec("libx264").videoFilters("pad=ceil(iw/2)*2:ceil(ih/2)*2").output(videoPath).format("mp4").outputOptions("-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart"), combined);
            cleanupSafe = true; combined.throwIfAborted();
            workbench.assertWritable();
            const output = { url: videoPath, mimeType: "video/mp4" };
            await workbench.updateData({ outputs: { ...outputsOf(), video: { dataType: "VIDEO", value: output } }, turntable: { seconds: args.seconds, fps: args.fps, width: args.width, height: args.height, elevationDeg: args.elevationDeg, distanceScale: args.distanceScale, startAzimuthDeg: args.startAzimuthDeg, clockwise: args.clockwise, frames } }, undefined, combined);
            await setStatus({ status: "completed", kind: "turntable", progress: 100, taskId, output });
            await document.save();
          } catch (error) {
            if (!context.signal.aborted) await setStatus({ status: combined.aborted ? "cancelled" : "failed", kind: "turntable", taskId, error: errorText(error) });
            throw error;
          } finally {
            if (created && cleanupSafe) await files.remove(framesDirectory, true).catch(() => {});
          }
        })();
        current.catch(() => {}).finally(() => { if (task === current) { task = undefined; operation = undefined; } touchIdle(); });
        return { status: "queued" as const, taskId, frames, executionSettled: false as const };
      },
    });

    context.registerTool({
      name: "getRenderStatus", annotations: readOnly, description: "读取真实渲染状态：idle、running（含 phase/progress）、completed（含 output）、failed、cancelled；页面重载后中断的任务显示为 interrupted，不会显示为仍在运行。",
      parameters: z.strictObject({}), outputSchema: renderStatusSchema, execute() { return statusNow(); },
    });
    context.registerTool({
      name: "cancelRender", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, description: "取消正在进行的静帧或环绕视频渲染；已发布的输出不受影响。",
      parameters: z.strictObject({}), outputSchema: z.strictObject({ cancelRequested: z.boolean(), busy: z.boolean() }),
      execute() { const busy = !!task; operation?.abort(new Error("用户取消渲染")); return { cancelRequested: busy, busy }; },
    });
  },
};
export default plugin;
