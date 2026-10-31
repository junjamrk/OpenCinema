import type { z } from "zod";
import type { NodeRequirements } from "./nodeCapabilities";
import type { createNodeResources, NodeResourceBundle } from "./nodeResources";
import type { PortEdge, PortNode } from "./nodePortValues";

export type PluginRenderer = "react" | (string & {});
export type JsonSchema = Record<string, unknown>;
export type RuntimeCapabilities = Readonly<Record<string, number>>;
export type ToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

export type PluginToolContext = {
  signal: AbortSignal;
  instanceId: string;
  nodeId?: string;
};

export type PluginToolDefinition<Schema extends z.ZodType = z.ZodType, Result extends z.ZodType = z.ZodType> = {
  name: string;
  description: string;
  parameters: Schema;
  outputSchema?: Result;
  annotations?: ToolAnnotations;
  execute(args: z.output<Schema>, context: PluginToolContext): z.output<Result> | Promise<z.output<Result>>;
};

export type PluginToolInfo = {
  pluginId: string;
  instanceId: string;
  nodeId?: string;
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: ToolAnnotations;
  requires?: NodeRequirements;
};

export type PluginToolCall = {
  instanceId: string;
  name: string;
  args: unknown;
};

export type PluginActivationContext = PluginToolContext & {
  config: Readonly<Record<string, unknown>>;
  capabilities: RuntimeCapabilities;
  resources: ReturnType<typeof createNodeResources>;
  getService<T = unknown>(name: string): T;
  registerTool<Schema extends z.ZodType, Result extends z.ZodType = z.ZodType>(definition: PluginToolDefinition<Schema, Result>): () => void;
  onBeforeChange(prepare: (operation: "history" | "delete") => void | Promise<void>): () => void;
  onDispose(dispose: () => void | Promise<void>): () => void;
};

export type PluginActivation = {
  service?: unknown;
  dispose?(): void | Promise<void>;
};

// 视图由宿主渲染器解释；合同与运行时不导入 UI 框架，不兼容的渲染器由宿主拒绝。
export type NodePluginDefinition<View = unknown> = {
  apiVersion: 1;
  id: string;
  name: string;
  version: string;
  icon?: string;
  category?: string;
  description?: string;
  composer?: {
    label: string; placeholder: string; tool: string; maxLength?: number; defaultAction?: boolean;
    getState?(data: Readonly<Record<string, unknown>>): { requiresHost?: boolean; disabledReason?: string };
  };
  scope?: "node" | "workspace";
  requires?: NodeRequirements;
  resources?: NodeResourceBundle;
  renderer?: PluginRenderer;
  view?: View;
  createData?(): Record<string, unknown>;
  cloneData?(data: Record<string, unknown>): Record<string, unknown>;
  canConnect?(connection: PortEdge, context: { nodes: readonly PortNode[]; edges: readonly PortEdge[] }): boolean;
  tools?: readonly PluginToolDefinition[];
  activate?(context: PluginActivationContext): PluginActivation | void | Promise<PluginActivation | void>;
};

export type PluginModule<View = unknown> = { default: NodePluginDefinition<View> };
export type PluginSource<View = unknown> = string | URL | (() => PluginModule<View> | Promise<PluginModule<View>>);

export type PluginInstance<View = unknown> = {
  readonly pluginId: string;
  readonly instanceId: string;
  readonly nodeId?: string;
  readonly version: string;
  readonly renderer?: PluginRenderer;
  readonly view?: View;
  readonly service: unknown;
  readonly signal: AbortSignal;
};

export type HostCapabilities = {
  requests: readonly string[];
  context: boolean;
  tools: boolean;
  cancellation: boolean;
  progress: boolean;
};

export type HostConnectionState = "disconnected" | "connecting" | "connected" | "error";
export type HostContext = {
  workspaceId?: string;
  documentId?: string;
  revision?: number | string;
  documentRevision?: number | string;
  toolCatalogVersion?: number | string;
  runtimeRevision?: string;
  selectedNodeIds?: readonly string[];
  references?: readonly { path: string; mimeType?: string; label?: string }[];
  data?: Record<string, unknown>;
};

export type HostRequest = {
  kind: string;
  prompt: string;
  context?: HostContext;
  metadata?: Record<string, unknown>;
};

export type HostResponse = {
  requestId: string;
  status: "accepted" | "completed";
  text?: string;
  result?: unknown;
};

export type HostEvent =
  | { type: "state"; state: HostConnectionState; error?: string }
  | { type: "progress"; requestId: string; message: string }
  | { type: "requestError"; requestId: string; error: string; errorDetails?: import("./toolErrors").ToolErrorDetails }
  | { type: "response"; response: HostResponse };

export type HostRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type HostToolInfo = { name: string; description: string; inputSchema: JsonSchema; outputSchema?: JsonSchema; annotations?: ToolAnnotations };
export type HostToolProvider = {
  list(): readonly HostToolInfo[];
  call(name: string, args: unknown, signal: AbortSignal): unknown | Promise<unknown>;
};

// 通用 AI 请求只发给宿主。视频专项生成由节点插件自己的工具和配置执行。
export interface HostAdapter {
  readonly id: string;
  readonly name: string;
  readonly capabilities: HostCapabilities;
  getState(): HostConnectionState;
  subscribe(listener: (event: HostEvent) => void): () => void;
  connect(options?: HostRequestOptions): Promise<void>;
  disconnect(): void;
  getContext(options?: HostRequestOptions): Promise<HostContext>;
  sendRequest(request: HostRequest, options?: HostRequestOptions): Promise<HostResponse>;
  cancelRequest?(requestId: string): void;
}
