import { z } from "zod";
import { EventSourceParserStream } from "eventsource-parser/stream";
import { createMessageHostAdapter, hostContextSchema, type MessageHostOptions } from "@toonflow/nodes-scaffold/hostAdapter";
import type { HostAdapter, HostEvent, HostRequestOptions, HostToolProvider } from "@toonflow/nodes-scaffold/contracts";
import { ToolExecutionError, serializeToolError, type ToolErrorDetails } from "@toonflow/nodes-scaffold/toolErrors";
import type { OpenCinemaTransport } from "./openCinemaTransport";
import type { WorkbenchRuntime } from "./workbenchController";
import { createWebHostAdapter } from "./webHost";

export type WorkbenchHostBridge = Pick<MessageHostOptions, "targetWindow" | "targetOrigin">
  & Partial<Pick<MessageHostOptions, "id" | "name" | "sourceWindow" | "channel" | "timeoutMs">>;

declare global {
  interface Window {
    openCinemaHost?: HostAdapter;
    openCinemaHostBridge?: WorkbenchHostBridge;
  }
}

const controlEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ready") }),
  z.strictObject({ type: z.literal("cancel"), callId: z.uuid() }),
  z.strictObject({
    type: z.literal("call"), callId: z.uuid(), name: z.string().min(1).max(128), args: z.record(z.string(), z.unknown()),
    directory: z.string().min(1).max(4096).optional(), canvasId: z.string().min(1).max(256).optional(),
  }),
]);
const initialCanvasSchema = z.object({
  session: z.string().min(16).max(256), directory: z.string().min(1).max(4096).nullable(), canvasId: z.string().min(1).max(256).nullable(),
});
const workspaceNavigation = new Set(["openProject", "switchCanvas", "addCanvas", "renameCanvas", "manageCanvas"]);

async function waitFor<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort = () => {};
  try {
    const result = await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    })]);
    signal.throwIfAborted();
    return result;
  } finally { signal.removeEventListener("abort", abort); }
}

export async function connectWorkbenchHost(controller: WorkbenchRuntime) {
  const lifetime = new AbortController();
  const calls = new Map<string, { controller: AbortController; name: string }>();
  const transport = window.openCinemaTransport;
  const initial = transport ? initialCanvasSchema.parse(await transport.ready) : undefined;
  const initialCanvas = initial ? { directory: initial.directory, canvasId: initial.canvasId } : undefined;
  let connectionId: string | null = null;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let connection: AbortController | undefined;
  let workspace = new AbortController();
  let activeHost: HostAdapter | undefined;
  let binding = readBinding();
  let syncContext = () => {};

  function readBinding() {
    const current = controller.getSnapshot();
    return JSON.stringify([current.directory, current.canvasId]);
  }
  function readContext() { return { ...controller.getControlState(), connectionId }; }
  function readAgentContext() {
    const state = readContext();
    delete state.capabilities;
    delete state.tools;
    return state;
  }
  function requireBinding(before: string) {
    if (readBinding() !== before) throw new Error("工作区或画布已切换，请重新读取应用状态");
  }
  const releaseState = controller.subscribe(() => {
    const next = readBinding();
    if (next !== binding) {
      binding = next;
      workspace.abort(new Error("工作区或画布已切换")); workspace = new AbortController();
      for (const call of calls.values()) if (!workspaceNavigation.has(call.name)) call.controller.abort(new Error("工作区或画布已切换"));
    }
    syncContext();
  });

  const tools: HostToolProvider = {
    list: () => controller.hostTools.list(),
    call(name, args, signal) {
      const combined = AbortSignal.any([lifetime.signal, signal, ...(workspaceNavigation.has(name) ? [] : [workspace.signal])]);
      combined.throwIfAborted();
      if (!controller.hostTools.list().some(tool => tool.name === name)) throw new Error(`React 工作台尚未提供操作：${name}`);
      return controller.hostTools.call(name, args, combined);
    },
  };

  function createTransportAdapter(native: OpenCinemaTransport): HostAdapter {
    const events = new Set<(event: HostEvent) => void>();
    let connected = false;
    let nativeLifetime = new AbortController();
    let release: (() => void) | undefined;
    let lastContext = "";
    let contextQueue = Promise.resolve();
    const emit = (event: HostEvent) => { for (const listener of events) listener(event); };
    const publishContext = () => {
      const value = JSON.stringify(readAgentContext());
      if (!connected || value === lastContext) return;
      lastContext = value;
      const current = nativeLifetime;
      contextQueue = contextQueue.then(async () => {
        current.signal.throwIfAborted();
        await native.updateContext(JSON.parse(value));
      }).catch(() => { if (nativeLifetime === current) lastContext = ""; });
    };
    syncContext = publishContext;
    return {
      id: "nativeTransport", name: "宿主 Agent",
      capabilities: { requests: ["edit"], context: true, tools: true, cancellation: false, progress: false },
      getState: () => connected ? "connected" : "disconnected",
      subscribe(listener) { events.add(listener); return () => { events.delete(listener); }; },
      async connect(options) {
        if (connected) return;
        nativeLifetime = new AbortController();
        contextQueue = Promise.resolve(); lastContext = "";
        await waitFor(native.ready, AbortSignal.any([nativeLifetime.signal, lifetime.signal, ...(options?.signal ? [options.signal] : [])]));
        connected = true;
        native.setWorkspace({ flushSave: () => controller.save() });
        release = controller.subscribe(publishContext);
        publishContext();
        emit({ type: "state", state: "connected" });
      },
      disconnect() {
        nativeLifetime.abort(new Error("宿主连接已关闭"));
        connected = false; release?.(); release = undefined;
        native.setWorkspace(undefined);
        emit({ type: "state", state: "disconnected" });
      },
      async getContext(options) {
        options?.signal?.throwIfAborted();
        if (!connected) throw new Error("宿主连接尚未就绪");
        return controller.getHostContext();
      },
      async sendRequest(request, options: HostRequestOptions = {}) {
        if (!connected || !connectionId) throw new Error("宿主画布控制连接尚未就绪");
        if (request.kind !== "edit") throw new Error(`当前宿主传输不支持 ${request.kind} 请求`);
        const prompt = z.string().trim().min(1).max(16000).parse(request.prompt);
        const before = readBinding();
        const control = readAgentContext();
        const frozen = hostContextSchema.parse(structuredClone(request.context ?? controller.getHostContext()));
        const selectedNodeIds = [...new Set(frozen.selectedNodeIds ?? [])];
        if (!control.directory || !control.canvasId || selectedNodeIds.length > 20) throw new Error("请打开画布，并选择不超过 20 个节点");
        if ((frozen.workspaceId && frozen.workspaceId !== control.directory) || (frozen.documentId && frozen.documentId !== control.canvasId)) throw new Error("请求的工作区或画布与当前目标不一致");
        const selectedNodes = selectedNodeIds.map(id => {
          const node = controller.getSnapshot().document?.nodes.find(value => value.id === id);
          if (!node) throw new Error(`创作目标已不存在：${id}`);
          return { id: node.id, type: node.type, label: String(node.data?.label ?? node.id).slice(0, 512), selected: true };
        });
        const context = { ...control, ...frozen, selectedNodeIds, selectedNodes, selectedCount: selectedNodes.length, selectedNodesTruncated: false,
          ...(request.metadata ? { metadata: structuredClone(request.metadata) } : {}) };
        const signal = AbortSignal.any([lifetime.signal, nativeLifetime.signal, workspace.signal, AbortSignal.timeout(options.timeoutMs ?? 30000), ...(options.signal ? [options.signal] : [])]);
        await waitFor(controller.save(), signal);
        requireBinding(before);
        if (connectionId !== context.connectionId) throw new Error("宿主画布控制连接已变化，请重新发送");
        for (const id of selectedNodeIds) if (!controller.getSnapshot().document?.nodes.some(node => node.id === id)) throw new Error(`创作目标已不存在：${id}`);
        const requestId = crypto.randomUUID();
        signal.throwIfAborted();
        // 由消息层区分派发前取消与派发后回执未知；不能在外层抢先把已发送消息报为取消。
        await native.sendPrompt(prompt, context, signal);
        const response = { requestId, status: "accepted" as const };
        emit({ type: "response", response });
        return response;
      },
    };
  }

  async function controlToken() {
    if (transport) return "openCinemaNativeTransport";
    const response = await fetch("/api/settings/get", { headers: { "x-toonflow-workspace": "1" }, signal: lifetime.signal });
    if (!response.ok) throw new Error(`工作台设置读取失败（${response.status}）`);
    const body = await response.json();
    if (body.code !== 200) throw new Error("工作台设置读取失败");
    const config = z.object({ mcp: z.object({ enabled: z.boolean().optional(), token: z.string().optional() }).optional() }).parse(body.data).mcp;
    return config?.enabled === true && config.token && config.token.length >= 32 ? config.token : "";
  }

  async function connectControl(token: string) {
    const current = new AbortController();
    connection = current;
    const signal = AbortSignal.any([lifetime.signal, current.signal]);
    const id = crypto.randomUUID();
    const headers = { Authorization: `Bearer ${token}`, "x-toonflow-workspace": "1" };
    const seen = new Set<string>();
    let revision = 0;
    let stateQueue = Promise.resolve();
    let lastState = "";
    let reader: ReadableStreamDefaultReader<{ data: string }> | undefined;

    async function post(path: "state" | "result", body: Record<string, unknown>, callSignal?: AbortSignal) {
      const response = await fetch(`/api/mcp/control/${path}`, {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId: id, ...(path === "state" ? { revision: ++revision } : {}), ...body }), signal,
      });
      if (path === "result" && response.status === 404 && callSignal?.aborted) return;
      if (!response.ok) throw new Error(`工作台控制响应失败（${response.status}）`);
    }
    const publishState = () => {
      const state = JSON.stringify(controller.getControlState());
      if (state === lastState) return stateQueue;
      lastState = state;
      stateQueue = stateQueue.then(() => post("state", { state: JSON.parse(state) }));
      void stateQueue.catch(() => current.abort(new Error("工作台控制状态同步失败")));
      return stateQueue;
    };
    async function execute(request: Extract<z.infer<typeof controlEventSchema>, { type: "call" }>) {
      if (seen.has(request.callId)) return;
      seen.add(request.callId);
      const call = new AbortController();
      calls.set(request.callId, { controller: call, name: request.name });
      const callSignal = AbortSignal.any([signal, call.signal, AbortSignal.timeout(120000)]);
      let result: unknown;
      let error: string | undefined;
      let errorDetails: ToolErrorDetails | undefined;
      let dispatched = false;
      try {
        callSignal.throwIfAborted();
        const state = controller.getControlState();
        if ((request.directory && request.directory !== state.directory) || (request.canvasId && request.canvasId !== state.canvasId)) throw new ToolExecutionError({
          code: "targetChanged", message: "工作区或画布已切换，请重新读取应用状态", phase: "target", executionState: "notDispatched",
          recovery: { action: "readState", message: "调用 getAppState 固定当前工程、画布和连接后重新提交", tool: "getAppState" },
        });
        if (request.name === "openProject") {
          const { directory } = z.strictObject({ directory: z.string().trim().min(1).max(4096) }).parse(request.args);
          dispatched = true;
          await controller.openProject(directory);
          result = readAgentContext();
        } else {
          if (request.name !== "getAppState" && !controller.hostTools.list().some(tool => tool.name === request.name)) throw new ToolExecutionError({
            code: "toolUnavailable", message: `React 工作台尚未提供操作：${request.name}`, phase: "target", executionState: "notDispatched",
            recovery: { action: "rediscoverTools", message: "重新读取当前工作台的可用工具目录", tool: "getAppState" },
          });
          dispatched = true;
          result = await controller.callTool(request.name, request.args, callSignal);
        }
        callSignal.throwIfAborted();
      } catch (reason) {
        errorDetails = serializeToolError(reason, { target: { toolName: request.name, connectionId: id, ...(request.directory ? { directory: request.directory } : {}), ...(request.canvasId ? { canvasId: request.canvasId } : {}) },
          executionState: dispatched ? "unknown" : "notDispatched" });
        error = errorDetails.message;
      }
      try {
        if (!signal.aborted) {
          await publishState();
          await post("result", { callId: request.callId, ...(errorDetails ? { error, errorDetails } : { result: result ?? null }) }, callSignal);
        }
      } finally { calls.delete(request.callId); }
    }

    const release = controller.subscribe(() => { if (connectionId === id) void publishState(); });
    try {
      const response = await fetch(`/api/mcp/control/events?connectionId=${encodeURIComponent(id)}`, { headers, signal });
      if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) throw new Error("工作台控制连接未返回事件流");
      connectionId = id;
      syncContext();
      await publishState();
      reader = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream({ maxBufferSize: 1024 * 1024 })).getReader();
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        signal.throwIfAborted();
        const event = controlEventSchema.parse(JSON.parse(value.data));
        if (event.type === "cancel") calls.get(event.callId)?.controller.abort(new Error("宿主取消了控制调用"));
        else if (event.type === "call") void execute(event).catch(() => current.abort(new Error("工作台控制结果提交失败")));
        if (seen.size >= 10000) throw new Error("控制连接达到调用上限，请重新连接");
      }
    } catch {
      // 重连仅建立新控制会话；执行过的编辑命令和结果不会重放。
    } finally {
      if (connectionId === id) connectionId = null;
      release(); current.abort(new Error("工作台控制连接已关闭"));
      for (const call of calls.values()) call.controller.abort(new Error("工作台控制连接已关闭"));
      await reader?.cancel().catch(() => {});
      if (!lifetime.signal.aborted) reconnect = setTimeout(() => void connectControl(token), 3000);
    }
  }

  function cleanup() {
    lifetime.abort(new Error("工作台宿主连接已关闭"));
    connection?.abort(); workspace.abort(); clearTimeout(reconnect);
    releaseState();
    for (const call of calls.values()) call.controller.abort();
    activeHost?.disconnect();
  }

  try {
    const token = await controlToken();
    if (token) void connectControl(token);
    activeHost = window.openCinemaHost;
    if (!activeHost && transport) activeHost = createTransportAdapter(transport);
    // origin 只校验消息来源，不代表授权；桥只能由可信启动脚本注入，不能从 URL 或远程消息启用。
    if (!activeHost && window.openCinemaHostBridge) {
      const config = window.openCinemaHostBridge;
      activeHost = createMessageHostAdapter({ ...config, id: config.id ?? "messageHost", name: config.name ?? "宿主 Agent", tools });
    }
    if (!activeHost) activeHost = createWebHostAdapter(async () => controller.getHostContext());
    if (activeHost) await controller.setHost(activeHost);
    return { cleanup, initialCanvas };
  } catch (error) { cleanup(); throw error; }
}
