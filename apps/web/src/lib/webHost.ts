import { z } from "zod";
import type { HostAdapter, HostEvent } from "@toonflow/nodes-scaffold/contracts";

const sessionSchema = z.object({ id: z.string().min(1), name: z.string().min(1), directory: z.string().optional(), expiresAt: z.number(), capabilities: z.object({ requests: z.array(z.string()) }) });
const responseSchema = z.object({ requestId: z.string(), status: z.enum(["queued", "running", "completed", "failed", "cancelRequested", "cancelled", "unknown"]), text: z.string().optional(), result: z.unknown().optional(), error: z.string().optional(), progress: z.union([z.string(), z.record(z.string(), z.json())]).nullish() });

function progressMessage(progress: NonNullable<z.infer<typeof responseSchema>["progress"]>, text?: string) {
  if (typeof progress === "string") return progress;
  const label = [progress.message, progress.text, text, progress.step, progress.stage, progress.status].find(value => typeof value === "string" && value.trim());
  const count = typeof progress.current === "number" ? `${progress.current}${typeof progress.total === "number" ? `/${progress.total}` : ""}` : "";
  return [label, count].filter(Boolean).join(" · ") || JSON.stringify(progress);
}

export function createWebHostAdapter(getContext: HostAdapter["getContext"]): HostAdapter {
  const listeners = new Set<(event: HostEvent) => void>();
  let session: z.infer<typeof sessionSchema> | undefined;
  let lifetime = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  const emit = (event: HostEvent) => { for (const listener of listeners) listener(event); };
  async function request(path: string, body?: unknown, signal = lifetime.signal) {
    const response = await fetch(`/api/host/${path}`, { method: body === undefined ? "GET" : "POST", headers: { "x-toonflow-workspace": "1", "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal });
    const value = await response.json();
    if (!response.ok || value.code !== 200) throw new Error(value.message || `宿主请求失败（${response.status}）`);
    return value.data;
  }
  async function refresh() {
    if (!running) return;
    try {
      const value = z.object({ sessions: z.array(sessionSchema) }).parse(await request("state"));
      const context = await getContext();
      const eligible = value.sessions.filter(item => !item.directory || item.directory === context.workspaceId);
      let selected: string | null = null;
      try { selected = localStorage.getItem("openCinema.hostSessionId"); } catch { /* 浏览器缓存不可用时只复用当前会话或唯一候选。 */ }
      const next = selected ? eligible.find(item => item.id === selected) : eligible.find(item => item.id === session?.id) ?? (eligible.length === 1 ? eligible[0] : undefined);
      const changed = JSON.stringify(session) !== JSON.stringify(next);
      session = next;
      if (changed) emit({ type: "state", state: session ? "connected" : "disconnected" });
    } catch (error) {
      if (!lifetime.signal.aborted) { session = undefined; emit({ type: "state", state: "error", error: error instanceof Error ? error.message : String(error) }); }
    } finally { if (running) timer = setTimeout(() => void refresh(), 2000); }
  }
  return {
    id: "webHost",
    get name() { return session?.name ?? "等待 Agent 连接"; },
    get capabilities() { return { requests: session?.capabilities.requests ?? [], context: true, tools: true, cancellation: true, progress: true }; },
    getState: () => session ? "connected" : "disconnected",
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async connect() { if (running) return; running = true; lifetime = new AbortController(); await refresh(); },
    disconnect() { running = false; clearTimeout(timer); lifetime.abort(new Error("宿主连接已关闭")); session = undefined; emit({ type: "state", state: "disconnected" }); },
    getContext,
    async sendRequest(input, options = {}) {
      const selected = session;
      if (!selected || !selected.capabilities.requests.includes(input.kind)) throw new Error(`宿主未连接或不支持 ${input.kind}`);
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(options.timeoutMs ?? 20 * 60 * 1000), ...(options.signal ? [options.signal] : [])]);
      signal.throwIfAborted();
      const requestId = crypto.randomUUID();
      let cancellation: Promise<z.infer<typeof responseSchema>> | undefined;
      const cancel = () => {
        cancellation ??= request("requests/cancel", { requestId }, AbortSignal.timeout(10000)).then(value => responseSchema.parse(value));
        void cancellation.catch(() => {});
      };
      let terminal: z.infer<typeof responseSchema> | undefined;
      signal.addEventListener("abort", cancel, { once: true });
      try {
        // 提交使用独立期限；本地取消从登记前便携带固定ID，服务端用取消回执阻止迟到登记。
        const created = z.object({ requestId: z.string(), status: z.enum(["queued", "running", "completed", "cancelled"]) }).parse(await request("requests/create", { ...input, requestId, sessionId: selected.id }, AbortSignal.timeout(30000)));
        if (created.requestId !== requestId) throw new Error("宿主请求回执 ID 与提交不一致");
        if (created.status === "cancelled") throw new Error("宿主请求在登记前已取消");
        for (;;) {
          signal.throwIfAborted();
          const value = responseSchema.parse(await request("requests/status", { requestId: created.requestId }, signal));
          if (value.progress) emit({ type: "progress", requestId: value.requestId, message: progressMessage(value.progress, value.text) });
          if (value.status === "completed") {
            const response = { requestId: value.requestId, status: "completed" as const, text: value.text, result: value.result };
            emit({ type: "response", response }); return response;
          }
          if (["failed", "cancelled", "unknown"].includes(value.status)) {
            terminal = value;
            throw new Error(value.error || ({ failed: "宿主执行失败", cancelled: "宿主请求已取消", unknown: "宿主连接已失效，执行结果尚未确认" } as Record<string, string>)[value.status]);
          }
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 800);
            const abort = () => { clearTimeout(timeout); reject(signal.reason); };
            signal.addEventListener("abort", abort, { once: true });
          });
        }
      } catch (error) {
        // 网络或协议错误不代表用户取消，也不能向仍在执行的 Agent 发送取消请求。
        if (!signal.aborted) {
          const settled = terminal?.status === "failed" || terminal?.status === "cancelled";
          throw Object.assign(new Error(`${error instanceof Error ? error.message : String(error)}${settled ? "" : "；宿主执行结果尚未确认，请查询原请求"}；请求 ID：${requestId}`), { requestId, cause: error, ...(settled ? { executionSettled: true } : { code: "hostRequestUnknown", outcome: "unknown", executionSettled: false }) });
        }
        let settled = false;
        try {
          cancel();
          let receipt = await cancellation!;
          const deadline = Date.now() + 10000;
          while (["queued", "running", "cancelRequested"].includes(receipt.status) && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 500));
            receipt = responseSchema.parse(await request("requests/status", { requestId }, AbortSignal.timeout(3000)));
          }
          settled = ["completed", "failed", "cancelled"].includes(receipt.status);
        } catch { /* 无终态回执时保留原请求ID，不能把网络中断当作远端停止。 */ }
        throw Object.assign(new Error(`${error instanceof Error ? error.message : String(error)}${settled ? "" : "；宿主停止尚未确认，请查询原请求"}；请求 ID：${requestId}`), { requestId, cause: error, ...(settled ? { executionSettled: true } : { code: "hostRequestUnknown", outcome: "unknown", executionSettled: false }) });
      } finally { signal.removeEventListener("abort", cancel); }
    },
  };
}
