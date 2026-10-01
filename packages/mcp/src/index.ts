import type { ToolAnnotations } from "@modelcontextprotocol/server";

export type { ReadResourceResult, Resource } from "@modelcontextprotocol/server";

export type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  title?: string;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
  execute(args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
};
