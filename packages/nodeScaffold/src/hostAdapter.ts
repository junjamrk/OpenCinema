import { z } from "zod";
import { ToolExecutionError, serializeToolError, toolAnnotationsSchema, toolErrorDetailsSchema } from "./toolErrors";
import type {
  HostAdapter, HostCapabilities, HostConnectionState, HostContext, HostEvent, HostRequest, HostRequestOptions,
  HostResponse, HostToolProvider,
} from "./contracts";

export type MessageHostOptions = {
  id: string;
  name: string;
  targetWindow: Pick<Window, "postMessage">;
  targetOrigin: string;
  sourceWindow?: MessageEventSource;
  eventTarget?: Pick<Window, "addEventListener" | "removeEventListener">;
  channel?: string;
  timeoutMs?: number;
  tools?: HostToolProvider;
};

export const hostCapabilitiesSchema = z.strictObject({
  requests: z.array(z.string().min(1).max(128)).max(64),
  context: z.boolean(),
  tools: z.boolean(),
  cancellation: z.boolean(),
  progress: z.boolean(),
});

export const hostContextSchema = z.strictObject({
  workspaceId: z.string().max(4096).optional(),
  documentId: z.string().max(4096).optional(),
  revision: z.union([z.number().finite(), z.string().max(4096)]).optional(),
  documentRevision: z.union([z.number().finite(), z.string().max(4096)]).optional(),
  toolCatalogVersion: z.union([z.number().finite(), z.string().max(4096)]).optional(),
  runtimeRevision: z.string().max(256).optional(),
  selectedNodeIds: z.array(z.string().max(4096)).max(10000).optional(),
  references: z.array(z.strictObject({ path: z.string().min(1).max(4096), mimeType: z.string().max(256).optional(), label: z.string().max(4096).optional() })).max(1000).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

const hostResponseSchema = z.strictObject({
  requestId: z.string().min(1).max(128),
  status: z.enum(["accepted", "completed"]),
  text: z.string().optional(),
  result: z.unknown().optional(),
});
const hostRequestSchema = z.strictObject({
  kind: z.string().min(1).max(128),
  prompt: z.string().trim().min(1).max(1000000),
  context: hostContextSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export const messageHostMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ channel: z.string(), apiVersion: z.literal(1), type: z.literal("response"), requestId: z.string().min(1).max(128), result: z.unknown().optional(), error: z.string().max(10000).optional(), errorDetails: toolErrorDetailsSchema.optional() }),
  z.strictObject({ channel: z.string(), apiVersion: z.literal(1), type: z.literal("progress"), requestId: z.string().min(1).max(128), message: z.string().max(10000) }),
  z.strictObject({ channel: z.string(), apiVersion: z.literal(1), type: z.literal("toolCall"), requestId: z.string().min(1).max(128), name: z.string().min(1).max(512), args: z.unknown() }),
  z.strictObject({ channel: z.string(), apiVersion: z.literal(1), type: z.literal("listTools"), requestId: z.string().min(1).max(128) }),
  z.strictObject({ channel: z.string(), apiVersion: z.literal(1), type: z.literal("cancel"), requestId: z.string().min(1).max(128) }),
]);

type PendingRequest = {
  method: string;
  resolve(result: unknown): void;
  reject(reason: unknown): void;
};

// 桥只处理固定协议与显式工具表；绝不将收到的字符串当 JS 或任意宿主方法执行。
export function createMessageHostAdapter(options: MessageHostOptions): HostAdapter {
  if (!options.id.trim() || !options.name.trim()) throw new Error("宿主适配器需要 ID 与名称");
  const targetOrigin = new URL(options.targetOrigin).origin;
  if (targetOrigin === "null" || targetOrigin !== options.targetOrigin) throw new Error("宿主桥必须指定完整、精确的 origin");
  const eventTarget = options.eventTarget ?? (typeof window !== "undefined" ? window : undefined);
  if (!eventTarget) throw new Error("当前环境需要显式提供宿主桥消息监听器");
  const events = eventTarget;
  const sourceWindow = options.sourceWindow ?? options.targetWindow;
  const channel = options.channel ?? "openCinema";
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!channel.trim() || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("宿主桥 channel 或超时无效");
  const listeners = new Set<(event: HostEvent) => void>();
  const pending = new Map<string, PendingRequest>();
  const accepted = new Map<string, number>();
  const inbound = new Map<string, AbortController>();
  const seenCalls = new Set<string>();
  let state: HostConnectionState = "disconnected";
  let capabilities: HostCapabilities = Object.freeze({ requests: [], context: false, tools: false, cancellation: false, progress: false });
  let connection = new AbortController();
  let connecting: Promise<void> | undefined;
  let listening = false;

  function emit(event: HostEvent) {
    for (const listener of listeners) {
      try { listener(event); } catch (error) { console.error("宿主状态监听器失败", error); }
    }
  }

  function setState(next: HostConnectionState, error?: string) {
    state = next;
    emit({ type: "state", state: next, ...(error ? { error } : {}) });
  }

  function post(message: Record<string, unknown>) {
    options.targetWindow.postMessage({ channel, apiVersion: 1, ...message }, targetOrigin);
  }

  function getTools() {
    const tools = options.tools?.list() ?? [];
    const names = new Set<string>();
    if (tools.length > 10000) throw new Error("宿主可发现的工具不能超过 10000 项");
    return tools.map(tool => {
      if (!tool.name || tool.name.length > 512 || names.has(tool.name) || !tool.description.trim() || tool.inputSchema.type !== "object") throw new Error("宿主工具声明无效或重名");
      names.add(tool.name);
      const annotations = tool.annotations ? toolAnnotationsSchema.parse(tool.annotations) : undefined;
      return { name: tool.name, description: tool.description, inputSchema: structuredClone(tool.inputSchema),
        ...(tool.outputSchema ? { outputSchema: structuredClone(tool.outputSchema) } : {}), ...(annotations ? { annotations } : {}) };
    });
  }

  function isTracked(requestId: string) {
    const expiry = accepted.get(requestId);
    if (expiry !== undefined && expiry <= Date.now()) accepted.delete(requestId);
    return pending.get(requestId)?.method === "sendRequest" || accepted.has(requestId);
  }

  async function handleToolCall(message: Extract<z.infer<typeof messageHostMessageSchema>, { type: "toolCall" }>) {
    if (state !== "connected" || !capabilities.tools || !options.tools) return;
    if (seenCalls.has(message.requestId)) {
      const errorDetails = serializeToolError(new Error("工具请求 ID 已使用，禁止重复执行"), { code: "requestIdReused", phase: "validation", executionState: "notDispatched", recovery: { action: "readState", message: "读取原请求结果，确认副作用后再决定是否创建新请求" } });
      post({ type: "toolResult", requestId: message.requestId, error: errorDetails.message, errorDetails });
      return;
    }
    // ACT: 每次连接保留请求 ID 防止重复执行；达到上限后要求重新握手，不静默淘汰旧 ID。
    if (seenCalls.size >= 10000 || inbound.size >= 64) {
      const errorDetails = serializeToolError(new Error("宿主工具请求达到本次连接上限，请重新连接或稍后重试"), { code: "hostCallLimit", phase: "transport", executionState: "notDispatched", recovery: { action: "retry", message: "等待并发调用结束；达到连接总量上限时正常重连" } });
      post({ type: "toolResult", requestId: message.requestId, error: errorDetails.message, errorDetails });
      return;
    }
    seenCalls.add(message.requestId);
    const current = connection;
    const controller = new AbortController();
    inbound.set(message.requestId, controller);
    const signal = AbortSignal.any([controller.signal, current.signal, AbortSignal.timeout(120000)]);
    let abort = () => {};
    let dispatched = false;
    try {
      if (!getTools().some(tool => tool.name === message.name)) throw new ToolExecutionError({ code: "toolUnavailable", message: "工具未公开，请重新发现可用工具", phase: "target", executionState: "notDispatched", recovery: { action: "rediscoverTools", message: "重新读取当前宿主公开的工具目录" } });
      const result = await Promise.race([
        Promise.resolve().then(() => { signal.throwIfAborted(); dispatched = true; return options.tools!.call(message.name, message.args, signal); }),
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
        }),
      ]);
      signal.throwIfAborted();
      post({ type: "toolResult", requestId: message.requestId, result: result ?? null });
    } catch (error) {
      const errorDetails = serializeToolError(error, { target: { toolName: message.name }, executionState: dispatched ? "unknown" : "notDispatched" });
      if (connection === current && !current.signal.aborted) post({ type: "toolResult", requestId: message.requestId, error: errorDetails.message, errorDetails });
    } finally {
      signal.removeEventListener("abort", abort);
      if (inbound.get(message.requestId) === controller) inbound.delete(message.requestId);
    }
  }

  const onMessage = (event: MessageEvent) => {
    if (event.origin !== targetOrigin || event.source !== sourceWindow) return;
    const parsed = messageHostMessageSchema.safeParse(event.data);
    if (!parsed.success || parsed.data.channel !== channel) return;
    const message = parsed.data;
    if (message.type === "toolCall") { void handleToolCall(message); return; }
    if (message.type === "listTools") {
      if (state !== "connected" || !capabilities.tools) return;
      try { post({ type: "toolList", requestId: message.requestId, tools: getTools() }); }
      catch (error) { const errorDetails = serializeToolError(error, { phase: "validation", executionState: "notDispatched" }); post({ type: "toolList", requestId: message.requestId, error: errorDetails.message, errorDetails }); }
      return;
    }
    if (message.type === "cancel") { if (capabilities.cancellation) inbound.get(message.requestId)?.abort(new Error("宿主取消工具执行")); return; }
    if (message.type === "progress") {
      if (capabilities.progress && isTracked(message.requestId)) emit({ type: "progress", requestId: message.requestId, message: message.message });
      return;
    }
    const waiting = pending.get(message.requestId);
    if (waiting) {
      if (message.errorDetails) waiting.reject(new ToolExecutionError(message.errorDetails));
      else if (message.error !== undefined) waiting.reject(new Error(message.error));
      else waiting.resolve(message.result);
      return;
    }
    if (!isTracked(message.requestId)) return;
    if (message.error !== undefined || message.errorDetails) {
      accepted.delete(message.requestId);
      emit({ type: "requestError", requestId: message.requestId, error: message.errorDetails?.message ?? message.error!, ...(message.errorDetails ? { errorDetails: message.errorDetails } : {}) });
      return;
    }
    const response = hostResponseSchema.safeParse(message.result);
    if (!response.success || response.data.requestId !== message.requestId) return;
    if (response.data.status === "completed") accepted.delete(message.requestId);
    emit({ type: "response", response: response.data });
  };

  async function rpc(method: string, params: unknown, requestOptions: HostRequestOptions = {}) {
    const waitMs = requestOptions.timeoutMs ?? timeoutMs;
    if (!Number.isSafeInteger(waitMs) || waitMs <= 0) throw new Error("宿主请求超时必须为正整数");
    const current = connection;
    const signal = AbortSignal.any([current.signal, AbortSignal.timeout(waitMs), ...(requestOptions.signal ? [requestOptions.signal] : [])]);
    signal.throwIfAborted();
    if (pending.size >= 256) throw new Error("宿主并发请求过多");
    const requestId = crypto.randomUUID();
    let abort = () => {};
    let sent = false;
    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        pending.set(requestId, { method, resolve, reject });
        abort = () => {
          if (sent && capabilities.cancellation && method === "sendRequest" && connection === current && !current.signal.aborted) post({ type: "cancel", requestId });
          reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        try { post({ type: "request", requestId, method, params }); sent = true; } catch (error) { reject(error); }
      });
      signal.throwIfAborted();
      return { requestId, result };
    } catch (error) {
      const details = serializeToolError(error, { code: sent && method === "sendRequest" ? "hostRequestUnknown" : "hostRequestFailed", phase: "transport", requestId,
        executionState: sent ? "unknown" : "notDispatched", recovery: sent && method === "sendRequest"
          ? { action: "readState", message: "宿主请求已派发，请先读取原请求与作品状态，不要自动重复提交" }
          : { action: "retry", message: "确认宿主连接状态后重试" } });
      if (sent && method === "sendRequest" && details.executionState === "unknown" && connection === current && !current.signal.aborted) {
        for (const [id, expiry] of accepted) if (expiry <= Date.now()) accepted.delete(id);
        if (accepted.size >= 256) accepted.delete(accepted.keys().next().value!);
        accepted.set(requestId, Date.now() + 3600000);
      }
      throw new ToolExecutionError(details);
    } finally {
      pending.delete(requestId);
      signal.removeEventListener("abort", abort);
    }
  }

  async function connect(requestOptions?: HostRequestOptions) {
    if (state === "connected") return;
    if (connecting) return connecting;
    connection = new AbortController();
    const current = connection;
    if (!listening) { events.addEventListener("message", onMessage as EventListener); listening = true; }
    setState("connecting");
    connecting = (async () => {
      try {
        const response = await rpc("connect", { adapterId: options.id, client: "openCinema", tools: getTools() }, requestOptions);
        const info = z.strictObject({ capabilities: hostCapabilitiesSchema }).parse(response.result);
        current.signal.throwIfAborted();
        capabilities = Object.freeze({ ...info.capabilities, requests: Object.freeze([...new Set(info.capabilities.requests)]) });
        setState("connected");
      } catch (error) {
        if (!current.signal.aborted) setState("error", error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        if (connection === current) connecting = undefined;
      }
    })();
    return connecting;
  }

  function disconnect() {
    connection.abort(new Error("宿主连接已断开"));
    connecting = undefined;
    if (listening) { events.removeEventListener("message", onMessage as EventListener); listening = false; }
    for (const request of pending.values()) request.reject(connection.signal.reason);
    for (const controller of inbound.values()) controller.abort(connection.signal.reason);
    pending.clear(); inbound.clear(); accepted.clear(); seenCalls.clear();
    capabilities = Object.freeze({ requests: [], context: false, tools: false, cancellation: false, progress: false });
    setState("disconnected");
  }

  return {
    id: options.id, name: options.name,
    get capabilities() { return capabilities; },
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    connect, disconnect,
    async getContext(requestOptions): Promise<HostContext> {
      if (state !== "connected" || !capabilities.context) throw new Error("当前宿主未提供上下文能力");
      return hostContextSchema.parse((await rpc("getContext", {}, requestOptions)).result);
    },
    async sendRequest(request: HostRequest, requestOptions): Promise<HostResponse> {
      if (state !== "connected") throw new Error("请先连接宿主 Agent");
      const parsed = hostRequestSchema.parse(request);
      if (!capabilities.requests.includes(parsed.kind)) throw new Error(`当前宿主不支持 ${parsed.kind} 请求`);
      const response = await rpc("sendRequest", { ...parsed, ...(capabilities.tools ? { tools: getTools() } : {}) }, requestOptions);
      const parsedResult = hostResponseSchema.safeParse(response.result);
      if (!parsedResult.success || parsedResult.data.requestId !== response.requestId) throw new ToolExecutionError({ code: "invalidHostResponse", message: "宿主响应格式或 requestId 不匹配", phase: "result", executionState: "unknown", requestId: response.requestId,
        recovery: { action: "readState", message: "请求已经派发，请读取原宿主请求与作品状态后再决定是否重试" } });
      const result = parsedResult.data;
      if (result.status === "accepted") {
        for (const [id, expiry] of accepted) if (expiry <= Date.now()) accepted.delete(id);
        if (accepted.size >= 256) accepted.delete(accepted.keys().next().value!);
        accepted.set(result.requestId, Date.now() + 3600000);
      }
      emit({ type: "response", response: result });
      return result;
    },
    cancelRequest(requestId) {
      if (state !== "connected" || !capabilities.cancellation) throw new Error("当前宿主不支持取消请求");
      if (!isTracked(requestId)) throw new Error("宿主请求不存在或已结束");
      post({ type: "cancel", requestId });
      // 发送取消仅代表提出请求，保留跟踪直到宿主返回最终结果。
    },
  };
}
