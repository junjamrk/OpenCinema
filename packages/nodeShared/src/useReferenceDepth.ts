import type { ZodType } from "zod";
import { referenceDepthBindingSchema, referenceDepthModelStatusSchema, referenceDepthPreparationSchema, referenceDepthStartSchema, referenceDepthStatusSchema,
  type ReferenceDepthBinding, type ReferenceDepthResult, type ReferenceDepthStart, type ReferenceDepthStatus } from "./referenceDepth";

export function createReferenceDepthClient(value: ReferenceDepthBinding, options: {
  headers?: Record<string, string>; signal?: AbortSignal; check?: () => void;
} = {}) {
  const binding = Object.freeze(referenceDepthBindingSchema.parse(value));
  const headers = { ...options.headers, "Content-Type": "application/json", "x-toonflow-workspace": "1" };
  if (Object.keys(headers).some(name => /^(?:x-studio-|x-toonflow-collaboration$)/i.test(name))) throw new Error("相对深度客户端仅用于独立普通画布，不能携带项目或协作凭据");

  function uncertain(cause: unknown, status?: ReferenceDepthStatus) {
    return Object.assign(new Error(`相对深度操作终态未知；请保留操作ID ${binding.operationId} 与原稿，通过 status/cancel 查询原操作，不自动重新提交。${cause instanceof Error ? cause.message : "连接中断"}`),
      { operationId: binding.operationId, binding, uncertain: true, ...(status ? { state: status } : {}), cause });
  }
  function failed(status: ReferenceDepthStatus) {
    return Object.assign(new Error(`${status.error ?? "相对深度操作未完成"}${status.outputDirectory ? `；产物可能保留于 ${status.outputDirectory}` : ""}`),
      { operationId: binding.operationId, binding, state: status, code: status.errorCode });
  }
  async function request<T>(name: string, schema: ZodType<T>, body?: unknown, signal?: AbortSignal, timeoutMs = 10000): Promise<T> {
    const response = await fetch(`/api/media/referenceDepth/${name}${body === undefined ? `?${new URLSearchParams({ directory: binding.directory })}` : ""}`, {
      method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs), cache: "no-store",
    });
    const result = await response.json() as { code?: number; message?: string; data?: unknown };
    if (!response.ok || result.code !== 200) throw Object.assign(new Error(result.message || `本地相对深度请求失败（HTTP ${response.status}）`),
      { status: response.status, code: (result.data as { code?: string } | null)?.code, responseKnown: true });
    return schema.parse(result.data);
  }
  function readStatus(value: ReferenceDepthStatus) {
    if (value.operationId !== binding.operationId || value.directory !== binding.directory || value.canvasId !== binding.canvasId || value.nodeId !== binding.nodeId
      || value.input && (value.input.operationId !== binding.operationId || value.input.directory !== binding.directory || value.input.canvasId !== binding.canvasId || value.input.nodeId !== binding.nodeId)
      || value.result && (value.result.operationId !== binding.operationId || value.result.canvasId !== binding.canvasId || value.result.nodeId !== binding.nodeId
        || value.result.source.path !== value.input?.sourcePath || value.result.source.contentSha256 !== value.input?.contentSha256
        || JSON.stringify(value.result.settings) !== JSON.stringify(value.input?.settings))) throw uncertain(new Error("服务端相对深度回执与冻结目标不一致"));
    if ((value.state === "succeeded" && (!value.result || !value.executionSettled))
      || ["cancelled", "failed"].includes(value.state) && !value.executionSettled) throw uncertain(new Error("服务端未确认相对深度执行收尾"), value);
    return value;
  }
  async function status(signal?: AbortSignal, timeoutMs = 10000) {
    try { return readStatus(await request("status", referenceDepthStatusSchema, binding, signal, timeoutMs)); }
    catch (cause) { throw uncertain(cause); }
  }
  async function cancel() {
    try { return readStatus(await request("cancel", referenceDepthStatusSchema, binding)); }
    catch (cause) { throw uncertain(cause); }
  }
  async function pause(signal: AbortSignal | undefined, milliseconds = 1000) {
    signal?.throwIfAborted();
    await new Promise<void>((resolvePause, reject) => {
      const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolvePause(); }, milliseconds);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  async function cancelAndWait(timeoutMs = 15000) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error("取消收尾等待范围须为1～60000毫秒");
    const deadline = Date.now() + timeoutMs;
    let current: ReferenceDepthStatus | undefined;
    try {
      current = readStatus(await request("cancel", referenceDepthStatusSchema, binding, undefined, Math.min(10000, timeoutMs)));
      while (!current.executionSettled && current.state !== "unknown" && Date.now() < deadline) {
        await pause(undefined, Math.min(500, Math.max(1, deadline - Date.now())));
        current = await status(undefined, Math.max(1, Math.min(10000, deadline - Date.now())));
      }
    } catch (cause) { throw uncertain(cause, current); }
    if (!current.executionSettled || current.state === "unknown") throw uncertain(new Error("取消请求不等于子进程已终止"), current);
    if (current.state === "failed") throw failed(current);
    return current;
  }

  return {
    binding,
    readModelStatus: (signal?: AbortSignal) => request("modelStatus", referenceDepthModelStatusSchema, undefined, signal ?? options.signal, 70000),
    prepareModel: () => request("prepareModel", referenceDepthPreparationSchema, { directory: binding.directory }, undefined, 30000),
    cancelModelPreparation: () => request("cancelModelPreparation", referenceDepthPreparationSchema, { directory: binding.directory }, undefined, 30000),
    async start(source: Pick<ReferenceDepthStart, "sourcePath" | "contentSha256" | "settings">) {
      options.signal?.throwIfAborted();
      options.check?.();
      const input = referenceDepthStartSchema.parse({ ...binding, ...source });
      try {
        // 提交独立限时；中断等待不能证明未登记，禁止改ID自动重发。
        const current = readStatus(await request("start", referenceDepthStatusSchema, input, undefined, 30000));
        if (JSON.stringify(current.input) !== JSON.stringify(input)) throw uncertain(new Error("服务端回执没有保留完整冻结输入"), current);
        return current;
      } catch (cause) {
        if ((cause as { responseKnown?: boolean })?.responseKnown) throw cause;
        throw uncertain(cause);
      }
    },
    status, cancel, cancelAndWait,
    async wait(waitOptions: { signal?: AbortSignal; onStatus?: (status: ReferenceDepthStatus) => void } = {}): Promise<ReferenceDepthResult> {
      const signals = [options.signal, waitOptions.signal].filter((signal): signal is AbortSignal => !!signal);
      const signal = signals.length ? AbortSignal.any(signals) : undefined;
      try {
        while (true) {
          signal?.throwIfAborted();
          const current = await status(signal);
          waitOptions.onStatus?.(current);
          if (current.state === "unknown") throw uncertain(new Error(current.error), current);
          if (current.state === "succeeded") return current.result!;
          if (current.state === "failed") throw failed(current);
          if (current.state === "cancelled") throw Object.assign(new DOMException("相对深度分析已取消且执行已收尾", "AbortError"), { state: current });
          await pause(signal);
        }
      } catch (cause) {
        if (signal?.aborted) { await cancelAndWait(); throw signal.reason; }
        throw cause;
      }
    },
  };
}
