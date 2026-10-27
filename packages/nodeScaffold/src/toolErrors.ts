import { z } from "zod";

export const toolAnnotationsSchema = z.strictObject({
  title: z.string().trim().min(1).max(256).optional(),
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
});
export const toolErrorDetailsSchema = z.strictObject({
  code: z.string().regex(/^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/),
  message: z.string().max(10000),
  phase: z.enum(["validation", "target", "authorization", "execution", "result", "transport"]),
  target: z.strictObject({
    directory: z.string().max(4096).optional(), canvasId: z.string().max(4096).optional(),
    path: z.string().max(4096).optional(),
    nodeId: z.string().max(4096).optional(), instanceId: z.string().max(4096).optional(),
    pluginId: z.string().max(128).optional(), toolName: z.string().max(512).optional(),
    connectionId: z.string().max(256).optional(),
  }).optional(),
  executionState: z.enum(["notDispatched", "accepted", "running", "completed", "failed", "cancelled", "unknown"]),
  recovery: z.strictObject({
    action: z.enum(["correctInput", "readState", "rediscoverTools", "queryOperation", "retry", "none"]),
    message: z.string().max(4096), tool: z.string().max(512).optional(), args: z.record(z.string(), z.unknown()).optional(),
  }),
  actualRevision: z.union([z.number().finite(), z.string().max(4096)]).optional(),
  expectedRevision: z.union([z.number().finite(), z.string().max(4096)]).optional(),
  toolCatalogVersion: z.union([z.number().finite(), z.string().max(4096)]).optional(),
  operationId: z.string().max(256).optional(),
  requestId: z.string().max(128).optional(),
});
export type ToolErrorDetails = z.infer<typeof toolErrorDetailsSchema>;

export class ToolExecutionError extends Error {
  readonly details: ToolErrorDetails;
  get code() { return this.details.code; }
  get requestId() { return this.details.requestId; }
  constructor(details: ToolErrorDetails) {
    const parsed = toolErrorDetailsSchema.parse(details);
    super(parsed.message);
    this.name = "ToolExecutionError";
    this.details = parsed;
  }
}

export function serializeToolError(reason: unknown, fallback: Partial<ToolErrorDetails> = {}): ToolErrorDetails {
  const fields = reason && typeof reason === "object" ? reason as Record<string, unknown> : {};
  const parsed = toolErrorDetailsSchema.safeParse(fields.details ?? fields);
  if (parsed.success) return { ...fallback, ...parsed.data, target: { ...fallback.target, ...parsed.data.target } };
  const invalid = reason instanceof z.ZodError;
  const revisionConflict = fields.code === "revisionConflict";
  const denied = fields.code === "readOnly" || fields.code === "disposed";
  const inputValidation = invalid && (fallback.executionState === undefined || fallback.executionState === "notDispatched" || fallback.phase === "validation");
  const code = z.string().regex(/^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/).safeParse(fields.code);
  const message = reason instanceof Error ? reason.message : String(reason);
  const details: ToolErrorDetails = {
    ...fallback,
    code: code.success ? code.data : inputValidation ? "invalidArguments" : fallback.code ?? "toolExecutionFailed",
    message: message.slice(0, 10000),
    phase: inputValidation ? "validation" : revisionConflict ? "target" : denied ? "authorization" : fallback.phase ?? "execution",
    executionState: fallback.executionState ?? (inputValidation ? "notDispatched" : "unknown"),
    recovery: inputValidation ? { action: "correctInput", message: "按工具公布的输入 Schema 修正参数后重试" }
      : revisionConflict ? { action: "readState", message: "读取当前资源修订后重新提交" }
      : denied ? { action: "readState", message: "确认当前目标、权限与编辑会话状态后再调用" }
      : fallback.recovery ?? { action: "readState", message: "读取当前目标与任务状态，确认副作用后再决定是否重试" },
  };
  for (const name of ["actualRevision", "expectedRevision"] as const) {
    const revision = z.union([z.number().finite(), z.string().max(4096)]).safeParse(fields[name]);
    if (revision.success) details[name] = revision.data;
  }
  return details;
}
