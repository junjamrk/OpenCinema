import type { MediaGenerationRequest, MediaModel, ModelParameter } from "@toonflow/tools-scaffold/runtime";

export type NodeAiModel = {
  providerId: string;
  providerLabel: string;
  modelId: string;
  label: string;
  protocol: "openai-completions" | "openai-responses" | "anthropic-messages";
  contextWindow?: number;
  maxOutputTokens?: number;
};
export type NodeMediaModel = Omit<MediaModel, "mode"> & {
  mode?: (string | string[])[];
};
export type NodeModelParameter = ModelParameter;
export type NodeImageRequest = {
  directory: string;
  providerId: string;
  modelId: string;
  prompt: string;
  outputDirectory: string;
  images?: { path: string; mimeType: string }[];
  ratio?: string;
  size?: string;
  parameters?: MediaGenerationRequest["parameters"];
};
export type NodeImageResult = { path: string; mimeType: string; mediaType: "image" };
export type NodeVideoRequest = Pick<MediaGenerationRequest, "providerId" | "modelId" | "prompt" | "images" | "videos" | "audios" | "firstFrame" | "lastFrame" | "ratio" | "resolution" | "duration" | "generateAudio" | "mode" | "parameters"> & { directory: string; outputDirectory: string; operationId?: string };
export type NodeVideoResult = { path: string; mimeType: string; mediaType: "video" };
export type NodeMediaPriceRequest = (NodeImageRequest & { mediaType: "image" }) | (NodeVideoRequest & { mediaType: "video" }) | (NodeAudioRequest & { mediaType: "audio" });
export type NodeMediaPrice = { price: string; tips: string };
export type NodeMediaCost = { estimate: NodeMediaPrice | null; actual: { amount: number; unit: string; source: "vendor" | "balanceDelta" } | null };
export type NodeAudioRequest = Pick<MediaGenerationRequest, "providerId" | "modelId" | "prompt" | "images" | "audios" | "voice" | "speed" | "volume" | "pitch" | "language" | "format" | "sampleRate" | "parameters"> & { directory: string; outputDirectory: string };
export type NodeAudioResult = { path: string; mimeType: string; mediaType: "audio" };
export type NodeAiTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, signal?: AbortSignal): unknown | Promise<unknown>;
};

async function readResult<T>(response: Response): Promise<T> {
  const result = await response.json();
  if (!response.ok || result.code !== 200) throw Object.assign(new Error(result.message || `AI 请求失败（HTTP ${response.status}）`), { httpStatus: response.status });
  return result.data;
}

// ACT: 独立插件各有模块作用域，共用宿主缓存；模型设置保存后失效，不按节点重复请求。
const modelCacheKey = Symbol.for("toonflow.nodeModels");
const modelCacheHost = globalThis as typeof globalThis & { [modelCacheKey]?: Map<string, Promise<unknown[]>> };
const modelCache = modelCacheHost[modelCacheKey] ??= new Map<string, Promise<unknown[]>>();

type MediaPriceCache = {
  prices: Map<string, { expires: number; value: Promise<NodeMediaPrice | null> }>;
  requestedAt: Map<string, number>;
};
const mediaPriceCacheKey = Symbol.for("toonflow.nodeMediaPrices");
const mediaPriceCacheHost = globalThis as typeof globalThis & { [mediaPriceCacheKey]?: MediaPriceCache };
const mediaPriceCache = mediaPriceCacheHost[mediaPriceCacheKey] ??= (() => {
  const cache: MediaPriceCache = { prices: new Map(), requestedAt: new Map() };
  if (typeof window !== "undefined") {
    const invalidate = (event: Event) => {
      if (event.type === "toonflow:plugin-installed" && (event as CustomEvent<{ type?: string }>).detail?.type !== "provider") return;
      cache.prices.clear();
      modelCache.delete("/api/ai/media/models");
    };
    window.addEventListener("toonflow:provider-config-changed", invalidate);
    window.addEventListener("toonflow:plugin-installed", invalidate);
  }
  return cache;
})();

type MediaTaskResult = { code: number; data: (NodeImageResult | NodeVideoResult | NodeAudioResult)[] | null; message: string };
export type NodeMediaTask = { taskId: string; status: string; executionSettled: boolean; sideEffectMayContinue: boolean; result?: MediaTaskResult; providerId?: string; modelId?: string; providerJobId?: string; phase?: string; progress?: number; cancelMode?: string; cost?: NodeMediaCost };
type PendingMediaTask = { directory: string; failedAt?: number; finish: (result: MediaTaskResult) => void; fail: (error: unknown) => void };
const mediaTasksKey = Symbol.for("toonflow.nodeMediaTasks");
const mediaTasksHost = globalThis as typeof globalThis & { [mediaTasksKey]?: ReturnType<typeof createMediaTasks> };
// ACT: 图片、视频等独立插件 共用短轮询；每批最多 100 项，不按节点占用长连接。
const mediaTasks = mediaTasksHost[mediaTasksKey] ??= createMediaTasks();

function createMediaTasks() {
  const pending = new Map<string, PendingMediaTask>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling = false;

  function schedule(delay = 1000) {
    if (polling || timer !== undefined || !pending.size) return;
    timer = setTimeout(poll, delay);
  }

  async function cancel(directory: string, taskId: string) {
    try {
      const response = await fetch("/api/ai/media/tasks/cancel", {
        method: "POST", headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" },
        body: JSON.stringify({ directory, taskIds: [taskId] }), signal: AbortSignal.timeout(30000),
      }).then(readResult<{ tasks: { taskId: string; status: string; executionSettled: boolean; sideEffectMayContinue: boolean; cost?: NodeMediaCost }[] }>);
      const task = response.tasks?.find(task => task.taskId === taskId);
      if (!task || !task.executionSettled || task.sideEffectMayContinue || !["cancelled", "completed", "failed"].includes(task.status)) throw new Error("服务端尚未确认生成任务及其外部副作用终止");
      return task;
    } catch (cause) {
      throw Object.assign(new Error(`生成任务终态尚未确认；任务 ID：${taskId}；${cause instanceof Error ? cause.message : String(cause)}`), { code: "mediaTaskUnknown", taskId, cause });
    }
  }

  async function poll() {
    timer = undefined;
    polling = true;
    try {
      const directories = new Set([...pending.values()].map(task => task.directory));
      for (const directory of directories) {
        const taskIds = [...pending].filter(([, task]) => task.directory === directory).map(([id]) => id);
        for (let offset = 0; offset < taskIds.length; offset += 100) {
          const batch = taskIds.slice(offset, offset + 100).filter(id => pending.has(id));
          if (!batch.length) continue;
          try {
            const results = await fetch("/api/ai/media/tasks/status", {
              method: "POST", headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" },
              body: JSON.stringify({ directory, taskIds: batch }), signal: AbortSignal.timeout(10000),
            }).then(readResult<NodeMediaTask[]>);
            const byId = new Map(results.map(result => [result.taskId, result]));
            for (const id of batch) {
              const task = pending.get(id);
              if (!task) continue;
              const item = byId.get(id);
              if (!item) throw new Error("生成任务响应不完整，请重试");
              task.failedAt = undefined;
              if (item.status === "unknown" || item.sideEffectMayContinue) task.fail(Object.assign(new Error(item.result?.message || "生成任务状态未知，请保留原 taskId 查询"), { code: "mediaTaskUnknown", taskId: id }));
              else if (item.result) task.finish(item.result);
            }
          } catch (error) {
            for (const id of batch) {
              const task = pending.get(id);
              if (!task) continue;
              // ACT: 状态查询允许 90 秒临时断线，不因几次快速失败取消已经提交的生成。
              task.failedAt ??= Date.now();
              if (task.failedAt + 90000 <= Date.now()) { pending.delete(id); void cancel(directory, id).then(() => task.fail(error), reason => task.fail(reason)); }
            }
          }
        }
      }
    } finally {
      polling = false;
      schedule();
    }
  }

  function wait(directory: string, taskId: string, signal: AbortSignal) {
    signal.throwIfAborted();
    return new Promise<NonNullable<MediaTaskResult["data"]>>((resolve, reject) => {
      const cleanup = () => {
        pending.delete(taskId);
        signal.removeEventListener("abort", abort);
        if (!pending.size) { clearTimeout(timer); timer = undefined; }
      };
      const abort = () => { cleanup(); void cancel(directory, taskId).then(() => reject(signal.reason), reject); };
      pending.set(taskId, {
        directory,
        finish(result) {
          cleanup();
          if (result.code === 200 && result.data) resolve(result.data);
          else reject(new Error(result.message || "媒体生成失败"));
        },
        fail(error) { cleanup(); reject(error); },
      });
      signal.addEventListener("abort", abort, { once: true });
      schedule();
    });
  }

  return { wait, cancel };
}

export function invalidateNodeModels(type: "language" | "media") {
  modelCache.delete(type === "language" ? "/api/ai/models" : "/api/ai/media/models");
  if (type === "media") mediaPriceCache.prices.clear();
}

async function readModels<T>(url: string, signal: AbortSignal): Promise<T[]> {
  signal.throwIfAborted();
  let pending = modelCache.get(url);
  if (!pending) {
    const request = fetch(url, { cache: "no-store" }).then(readResult<unknown[]>).catch(error => {
      if (modelCache.get(url) === request) modelCache.delete(url);
      throw error;
    });
    pending = request;
    modelCache.set(url, request);
  }
  // 单个节点关闭只取消自己的等待，不能中断其他节点共用的请求。
  let cancel = () => {};
  try {
    const models = await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        cancel = () => reject(signal.reason);
        signal.addEventListener("abort", cancel, { once: true });
      }),
    ]);
    signal.throwIfAborted();
    return modelCache.get(url) === pending ? models as T[] : readModels<T>(url, signal);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export function createMediaAiClient(lifetime: AbortSignal = new AbortController().signal) {
  const requestSignal = (signal?: AbortSignal) => signal ? AbortSignal.any([lifetime, signal]) : lifetime;

  async function getMediaModels(signal?: AbortSignal) {
    return readModels<NodeMediaModel>("/api/ai/media/models", requestSignal(signal));
  }

  async function getMediaTask(directory: string, taskId: string, signal?: AbortSignal) {
    const tasks = await fetch("/api/ai/media/tasks/status", {
      method: "POST", headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" },
      body: JSON.stringify({ directory, taskIds: [taskId] }), signal: requestSignal(signal),
    }).then(readResult<NodeMediaTask[]>);
    const task = tasks.find(value => value.taskId === taskId);
    if (!task) throw new Error("生成任务响应不完整");
    return task;
  }

  async function getMediaPrice(input: NodeMediaPriceRequest, signal?: AbortSignal): Promise<NodeMediaPrice | null> {
    const waitingSignal = requestSignal(signal);
    waitingSignal.throwIfAborted();
    const now = Date.now();
    const { prices, requestedAt } = mediaPriceCache;
    for (const [key, entry] of prices) if (entry.expires <= now) prices.delete(key);
    for (const [key, time] of requestedAt) if (time + 2000 <= now) requestedAt.delete(key);
    const key = JSON.stringify({ ...input, outputDirectory: undefined });
    let entry = prices.get(key);
    if (!entry) {
      // ACT: 节流状态跨节点面板重建保留；每个节点最多每 2 秒发起一次新报价。
      const nodeKey = JSON.stringify([input.directory, input.outputDirectory, input.providerId]);
      const delay = (requestedAt.get(nodeKey) ?? 0) + 2000 - now;
      if (delay > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let cancel = () => {};
        try {
          await new Promise<void>((resolve, reject) => {
            timer = setTimeout(resolve, delay);
            cancel = () => reject(waitingSignal.reason);
            waitingSignal.addEventListener("abort", cancel, { once: true });
          });
          return await getMediaPrice(input, signal);
        } finally {
          clearTimeout(timer);
          waitingSignal.removeEventListener("abort", cancel);
        }
      }
      requestedAt.set(nodeKey, now);
      if (requestedAt.size > 500) requestedAt.delete(requestedAt.keys().next().value!);
      if (prices.size >= 500) prices.delete(prices.keys().next().value!);
      const hasReferences = !!(input.images?.length || ("videos" in input && input.videos?.length) || ("audios" in input && input.audios?.length)
        || ("firstFrame" in input && input.firstFrame) || ("lastFrame" in input && input.lastFrame));
      const pending = { expires: Infinity, value: Promise.resolve<NodeMediaPrice | null>(null) };
      // ACT: 最多缓存 500 条 / 30 秒；参考文件没有前端修订号，只合并进行中的查询，避免同路径覆盖后复用旧价。
      pending.value = fetch("/api/ai/media/price", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(15000),
      }).then(readResult<NodeMediaPrice | null>).then(price => {
        if (price !== null && (!price || typeof price.price !== "string" || !price.price.trim() || typeof price.tips !== "string")) {
          throw new Error("价格响应格式不正确");
        }
        pending.expires = hasReferences ? 0 : Date.now() + 30000;
        return price;
      }).catch(error => {
        pending.expires = Date.now() + 5000;
        throw error;
      });
      prices.set(key, pending);
      entry = pending;
    }
    // 单个节点退出只取消自己的等待，共用请求继续为其他节点提供结果。
    let cancel = () => {};
    try {
      const price = await Promise.race([entry.value, new Promise<never>((_resolve, reject) => {
        cancel = () => reject(waitingSignal.reason);
        waitingSignal.addEventListener("abort", cancel, { once: true });
      })]);
      waitingSignal.throwIfAborted();
      return prices.get(key) === entry ? price : getMediaPrice(input, signal);
    } finally {
      waitingSignal.removeEventListener("abort", cancel);
    }
  }

  async function generateMedia<T extends "image" | "video" | "audio">(mediaType: T, input: NodeImageRequest | NodeVideoRequest | NodeAudioRequest, signal?: AbortSignal, taskId: string = crypto.randomUUID()) {
    const waitingSignal = requestSignal(signal);
    waitingSignal.throwIfAborted();
    // 提交使用独立超时；用户取消立即结束等待，提交收尾后再取消，避免先取消后登记的竞态。
    const submitted = fetch("/api/ai/media/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" },
      body: JSON.stringify({ ...input, mediaType, taskId }), signal: AbortSignal.timeout(30000),
    }).then(readResult<{ taskId: string }>);
    let abort = () => {};
    try {
      const started = await Promise.race([submitted, new Promise<never>((_resolve, reject) => {
        abort = () => reject(waitingSignal.reason);
        waitingSignal.addEventListener("abort", abort, { once: true });
      })]);
      waitingSignal.throwIfAborted();
      if (started.taskId !== taskId) throw new Error("生成任务响应无效，请确认服务端已更新");
    } catch (error) {
      try { await submitted; }
      catch (failure) {
        const httpStatus = failure && typeof failure === "object" && "httpStatus" in failure ? Number(failure.httpStatus) : 0;
        if (httpStatus >= 400 && httpStatus < 500 && httpStatus !== 409) throw failure;
      }
      await mediaTasks.cancel(input.directory, taskId);
      throw error;
    } finally {
      waitingSignal.removeEventListener("abort", abort);
    }
    return await mediaTasks.wait(input.directory, taskId, waitingSignal) as { path: string; mimeType: string; mediaType: T }[];
  }

  function generateImage(input: NodeImageRequest, signal?: AbortSignal, taskId?: string) {
    return generateMedia("image", input, signal, taskId);
  }

  function generateVideo(input: NodeVideoRequest, signal?: AbortSignal, taskId?: string) {
    const { operationId, ...request } = input;
    if (operationId && taskId && operationId !== taskId) throw new Error("operationId 与 taskId 必须一致");
    return generateMedia("video", request, signal, taskId ?? operationId);
  }

  function generateAudio(input: NodeAudioRequest, signal?: AbortSignal, taskId?: string) {
    return generateMedia("audio", input, signal, taskId);
  }

  return { getMediaModels, getMediaPrice, getMediaTask, generateImage, generateVideo, generateAudio, cancelMediaTask: mediaTasks.cancel };
}
