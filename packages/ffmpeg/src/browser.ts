import { EventSourceParserStream } from "eventsource-parser/stream";
import { chainMethods, queryMethods, runMethods } from "./browserTypes";
import type { BrowserFfmpegCommand, BrowserFfmpegFactory, BrowserFfmpegOptions, BrowserFfmpegRequest, FfmpegCall, FfmpegRemoteEvent } from "./browserTypes";

export type { BrowserFfmpegCommand, BrowserFfmpegFactory, BrowserFfmpegOptions, BrowserFfmpegEvents } from "./browserTypes";
export type { FfprobeData, FilterSpecification, ScreenshotsConfig } from "./types";

const chainNames = new Set<string>(chainMethods);
const runNames = new Set<string>(runMethods);
const queryNames = new Set<string>(queryMethods);
type Listener = (...args: any[]) => void;

function snapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (["function", "symbol", "bigint"].includes(typeof item) || (typeof item === "number" && !Number.isFinite(item))) {
      throw new Error("浏览器 FFmpeg 参数必须可序列化；请传入工作区文件路径");
    }
    return item;
  }));
}

function createCall(method: string, args: unknown[]): FfmpegCall {
  // JSON 会把位置参数 undefined 变成 null；保留原生可选参数的含义。
  return snapshot({ method, args, undefinedArgs: args.flatMap((value, index) => value === undefined ? [index] : []) });
}

function remoteError(value: unknown) {
  const details = value as { message?: string; name?: string; code?: unknown; data?: { code?: string } | null };
  return Object.assign(new Error(details.message || "FFmpeg 执行失败"), details, details.data?.code ? { code: details.data.code } : {});
}

async function request(input: BrowserFfmpegRequest, signal?: AbortSignal) {
  const response = await fetch("/api/ffmpeg/execute", {
    method: "POST", headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" },
    body: JSON.stringify(input), signal,
  });
  if (!response.ok) throw Object.assign(remoteError(await response.json()), { responseKnown: true });
  return response;
}

/** 只传输 fluent 调用，执行库和媒体文件始终留在宿主。目录在创建工厂时固定。 */
export async function createBrowserFfmpeg(directory: string, signal?: AbortSignal): Promise<BrowserFfmpegFactory> {
  signal?.throwIfAborted();
  const prepared = await request({ directory, requestId: crypto.randomUUID(), options: {}, calls: [], operation: { method: "prepare", args: [] } }, signal);
  const result = await prepared.json() as { code: number; message?: string };
  if (result.code !== 200) throw remoteError(result);

  function createCommand(options: BrowserFfmpegOptions, calls: FfmpegCall[] = []): BrowserFfmpegCommand {
    const listeners = new Map<string, { callback: Listener; once: boolean }[]>();
    let active: AbortController | undefined;
    function emit(event: string, args: unknown[]) {
      const handlers = [...(listeners.get(event) ?? [])];
      if (event === "error" && !handlers.length) {
        queueMicrotask(() => { throw args[0]; });
      }
      for (const item of handlers) {
        if (item.once) listeners.set(event, (listeners.get(event) ?? []).filter(entry => entry !== item));
        item.callback(...args);
      }
    }

    function start(operation: FfmpegCall, callback?: Listener) {
      if (active) throw new Error("当前 FFmpeg 命令正在执行；并行处理请使用 clone()");
      const input = snapshot({ directory, requestId: crypto.randomUUID(), options, calls, operation });
      const controller = active = new AbortController();
      const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const transport = new AbortController();
      let finished = false;
      let ready = false;
      let cancellation: Promise<void> | undefined;
      let cancellationError: unknown;
      const cancel = () => {
        if (!ready || finished || cancellation) return;
        // 显式等待服务端确认本地进程与写入收尾；登记取消不能代替终态回执。
        cancellation = request({ ...input, options: {}, calls: [], operation: { method: "cancel", args: [] } }, AbortSignal.timeout(15000))
          .then(async response => { const value = await response.json(); if (!value || typeof value !== "object" || !("code" in value) || value.code !== 200) throw new Error("FFmpeg 取消回执无效"); })
          .catch(error => { cancellationError = Object.assign(new Error("FFmpeg 停止尚未确认，请保留原任务与产物目录"), { code: "ffmpegTaskUnknown", executionSettled: false, requestId: input.requestId, cause: error }); })
          .finally(() => transport.abort(requestSignal.reason));
      };
      requestSignal.addEventListener("abort", cancel, { once: true });
      void (async () => {
        requestSignal.throwIfAborted();
        const headersLifetime = new AbortController();
        const headersTimer = setTimeout(() => headersLifetime.abort(new Error("FFmpeg 响应头超时")), 30000);
        let response: Response;
        try { response = await request(input, AbortSignal.any([transport.signal, headersLifetime.signal])); }
        finally { clearTimeout(headersTimer); }
        ready = true;
        if (requestSignal.aborted) cancel();
        if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) throw new Error("FFmpeg 响应不是事件流");
        const reader = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream()).getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            requestSignal.throwIfAborted();
            if (done) break;
            if (!value.data) continue;
            const { event, args } = JSON.parse(value.data) as FfmpegRemoteEvent;
            if (["error", "end", "result"].includes(event)) {
              finished = true;
              active = undefined;
            }
            if (event === "error") {
              const error = remoteError(args[0]);
              if (callback) callback(error);
              else emit("error", [error, ...args.slice(1)]);
            } else if (event === "result") callback?.(null, args[0]);
            else emit(event, args);
            if (finished) break;
          }
          if (!finished) throw new Error("FFmpeg 连接已断开，未收到完成结果");
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      })().catch(async error => {
        // 事件流可能先收到心跳或断开；取消握手完成前不让调用方清理仍在使用的文件。
        if (requestSignal.aborted) await cancellation;
        if (cancellationError) error = cancellationError;
        else if (!finished && !requestSignal.aborted && !(error as { responseKnown?: boolean })?.responseKnown) error = Object.assign(new Error("FFmpeg 结果尚未确认，请保留原任务与产物目录"), { code: "ffmpegTaskUnknown", executionSettled: false, requestId: input.requestId, cause: error });
        if (active === controller) active = undefined;
        if (finished) queueMicrotask(() => { throw error; });
        else if (callback) callback(error);
        else emit("error", [error]);
      }).finally(() => requestSignal.removeEventListener("abort", cancel));
    }

    const command = new Proxy({} as BrowserFfmpegCommand, {
      get(_target, name: string) {
        if (["on", "once", "addListener"].includes(name)) return (event: string, callback: Listener) => {
          if (typeof callback !== "function") throw new Error("FFmpeg 事件监听器必须是函数");
          listeners.set(event, [...(listeners.get(event) ?? []), { callback, once: name === "once" }]);
          return command;
        };
        if (["off", "removeListener"].includes(name)) return (event: string, callback: Listener) => {
          const handlers = listeners.get(event) ?? [];
          const index = handlers.findLastIndex(item => item.callback === callback);
          if (index >= 0) handlers.splice(index, 1);
          return command;
        };
        if (name === "removeAllListeners") return (event?: string) => {
          if (event) listeners.delete(event);
          else listeners.clear();
          return command;
        };
        if (name === "kill") return (mode = "SIGKILL") => {
          if (!["SIGKILL", "SIGTERM"].includes(mode)) throw new Error("浏览器 FFmpeg 仅支持取消任务");
          active?.abort(new DOMException("FFmpeg 任务已取消", "AbortError"));
          return command;
        };
        if (["preset", "usingPreset"].includes(name)) return (preset: (command: BrowserFfmpegCommand) => void) => {
          if (typeof preset !== "function") throw new Error("浏览器 FFmpeg 预设请使用本地函数");
          preset(command);
          return command;
        };
        if (name === "clone") return () => createCommand(snapshot(options), [...snapshot(calls), { method: "clone", args: [] }]);
        if (queryNames.has(name)) return (...args: unknown[]) => {
          const callback = args.pop();
          if (typeof callback !== "function") throw new Error("FFmpeg 查询需要回调函数");
          start(createCall(name, args), callback as Listener);
        };
        if (runNames.has(name) || chainNames.has(name)) return (...args: unknown[]) => {
          const call = createCall(name, args);
          if (runNames.has(name)) start(call);
          else {
            if (active) throw new Error("FFmpeg 执行期间不能修改配置");
            calls.push(call);
          }
          return name === "run" ? undefined : command;
        };
        // 不伪装 Promise、Node.js Stream 或子进程，未知属性按普通对象返回 undefined。
        return undefined;
      },
    });
    return command;
  }

  const factory = ((input?: string | BrowserFfmpegOptions, options?: BrowserFfmpegOptions) => {
    return createCommand(snapshot(typeof input === "object" ? input : { ...options, source: input }));
  }) as BrowserFfmpegFactory;
  for (const method of queryMethods) {
    Object.assign(factory, { [method]: (...args: unknown[]) => {
      const command = method === "ffprobe" ? factory(args.shift() as string) : factory();
      Reflect.apply(command[method], command, args);
    } });
  }
  return factory;
}
