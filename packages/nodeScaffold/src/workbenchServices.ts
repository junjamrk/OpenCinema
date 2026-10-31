// @ts-ignore ACT: tarball 不含工作区包，仓库外此类型退化为 any；要精确类型须把它移进脚手架。
import type { BrowserFfmpegFactory } from "@toonflow/ffmpeg/browser";
import type { WorkspaceFiles } from "./nodeFiles";
import type { NodeInputValue } from "./values";

export type NodeWorkbenchService = {
  directory: string;
  canvasId: string;
  files: WorkspaceFiles;
  focusComposer(input?: { prompt?: string; insertText?: string; action?: boolean }): void;
  selectNodes(nodeIds: string[]): void;
  getLayout(): { position: { x: number; y: number }; width: number };
  assertWritable(expectedRevision?: number): void;
  getInputs(handleId?: string): NodeInputValue[];
  readNodes(): { id: string; type?: string; data?: Record<string, unknown> }[];
  disconnectInput(input: { source: string; sourceHandle: string }, handleId?: string, signal?: AbortSignal): Promise<void>;
  updateData(data: Record<string, unknown>, expectedRevision?: number, signal?: AbortSignal): Promise<void>;
  updateRuntimeData(data: Record<string, unknown>, signal?: AbortSignal): Promise<void>;
  createNodes(nodes: Record<string, unknown>[], edges?: Record<string, unknown>[], signal?: AbortSignal): Promise<void>;
  updateNodes(updates: { id: string; data: Record<string, unknown> }[], expectedRevision?: number, signal?: AbortSignal): Promise<void>;
  ffmpeg(signal?: AbortSignal): Promise<BrowserFfmpegFactory>;
  hostRequest(input: { kind?: string; prompt: string; references?: unknown[]; metadata?: Record<string, unknown> }, signal?: AbortSignal): Promise<{ text?: string; result?: unknown; status: string }>;
};

export type ReactNodeServices = {
  getNodeService(nodeId: string): NodeWorkbenchService;
  callNodeTool(nodeId: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
};
