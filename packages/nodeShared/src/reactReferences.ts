import { z } from "zod";
import type { PluginActivationContext } from "@toonflow/nodes-scaffold/contracts";
import type { NodeInputValue } from "@toonflow/nodes-scaffold/values";
import type { NodeWorkbenchService } from "@toonflow/nodes-scaffold/workbenchServices";
import { mediaValueSchema, pluginServices, readNodeData } from "./reactNode";
import { readReferenceRole, referenceKey, referenceRoleSchema } from "./videoShot";
export { referenceKey } from "./videoShot";

export function readReferences(workbench: NodeWorkbenchService, data: Record<string, unknown>, handleId = "in") {
  const order = (data.referenceOrder as Record<string, string[]> | undefined)?.[handleId] ?? [];
  const positions = new Map(order.map((key, index) => [key, index]));
  return [...workbench.getInputs(handleId)].map(input => {
    if (!["IMAGE", "VIDEO", "AUDIO"].includes(String(input.dataType)) || !input.value || typeof input.value !== "object") return input;
    // 端口可附带控制层元数据；媒体消费只取标准字段，不能因此漏掉预览和文件版本冻结。
    const media = mediaValueSchema.safeParse({ url: input.value.url, mimeType: input.value.mimeType });
    return media.success ? { ...input, value: media.data } : input;
  }).sort((left, right) => (positions.get(referenceKey(left)) ?? positions.size) - (positions.get(referenceKey(right)) ?? positions.size));
}

const sourceSchema = z.strictObject({ source: z.string().min(1).max(256), sourceHandle: z.string().min(1).max(256) });

export function registerReferenceTools(context: PluginActivationContext, handleId = "in", videoRoles = false) {
  const { id, document, workbench } = pluginServices(context);
  context.registerTool({ name: "getReferences", outputSchema: z.strictObject({ references: z.array(sourceSchema.extend({ dataType: z.union([z.string(), z.array(z.string())]), index: z.number().int().positive(), available: z.boolean(), role: referenceRoleSchema.optional(), preview: z.union([z.string(), z.number(), z.boolean(), mediaValueSchema]).optional() })), total: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative().nullable() }), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, description: "读取实际连线参考及其顺序，文本仅返回摘要；参考编号与提示词及首尾帧使用同一顺序。视频生成的role是应用侧创作职责，不是供应商硬控制能力；exclude仍保留连线。", parameters: z.strictObject({ offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional() }),
    execute(args) {
      const values = readReferences(workbench, readNodeData(document, id), handleId); const offset = args.offset ?? 0; const limit = args.limit ?? 20;
      const data = readNodeData(document, id);
      return { references: values.slice(offset, offset + limit).map((input, index) => ({ source: input.source, sourceHandle: input.sourceHandle, dataType: input.dataType, index: offset + index + 1, available: input.value !== undefined, ...(videoRoles ? { role: readReferenceRole(data, input) } : {}), preview: typeof input.value === "string" ? input.value.slice(0, 512) : input.value })), total: values.length, nextOffset: offset + limit < values.length ? offset + limit : null };
    } });
  context.registerTool({ name: "setReferenceOrder", outputSchema: z.strictObject({ ordered: z.boolean(), count: z.number().int().nonnegative() }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, description: "按当前实际连线参考重新排序；必须完整提供每个source/sourceHandle一次，不改变连线。", parameters: z.strictObject({ sources: z.array(sourceSchema).max(1000) }),
    async execute(args, { signal }) {
      const values = workbench.getInputs(handleId); const keys = args.sources.map(referenceKey); const existing = new Set(values.map(referenceKey));
      if (keys.length !== values.length || new Set(keys).size !== keys.length || keys.some(key => !existing.has(key))) throw new Error("参考连线已变化，请读取全部当前参考后重新排序");
      const data = readNodeData(document, id);
      await workbench.updateData({ referenceOrder: { ...(data.referenceOrder as object ?? {}), [handleId]: keys } }, document.getRevision(), signal);
      await document.save(); return { ordered: true, count: keys.length };
    } });
  context.registerTool({ name: "removeReference", outputSchema: z.strictObject({ removed: z.boolean() }), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }, description: "删除当前节点对应输入连线，保留上游节点及文件，并纳入统一历史。", parameters: sourceSchema,
    async execute(args, { signal }) { await workbench.disconnectInput(args, handleId, signal); return { removed: true }; } });
  if (videoRoles) context.registerTool({ name: "setReferenceRoles", description: "为当前视频生成连线显式设置创作职责；未提供的保留原值。identity只引用主体外观、不沿用构图，motion仅为软视频参考；exclude只排除本次生成输入，不断开连线。不提交生成。", parameters: z.strictObject({ references: z.array(sourceSchema.extend({ role: referenceRoleSchema })).min(1).max(1000) }), outputSchema: z.strictObject({ updated: z.number().int().nonnegative() }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async execute(args, { signal }) {
    workbench.assertWritable();
    const data = readNodeData(document, id), values = workbench.getInputs(handleId), existing = new Map(values.map(input => [referenceKey(input), input]));
    const roles = { ...(data.referenceRoles as Record<string, string> ?? {}) };
    const keys = args.references.map(referenceKey);
    if (new Set(keys).size !== keys.length) throw new Error("每条参考只能设置一次职责");
    for (const item of args.references) {
      const input = existing.get(referenceKey(item));
      if (!input) throw new Error("参考连线已变化，请重新读取getReferences");
      if (item.role === "instruction" && input.dataType !== "STRING" || item.role === "identity" && input.dataType !== "IMAGE" || item.role === "motion" && input.dataType !== "VIDEO" || item.role === "composition" && !["IMAGE", "VIDEO"].includes(String(input.dataType))) throw new Error("创作指令需文本、主体身份需图片、运动参考需视频、构图需图片或视频");
      roles[referenceKey(item)] = item.role;
    }
    await workbench.updateData({ referenceRoles: roles }, document.getRevision(), signal); await document.save();
    return { updated: args.references.length };
  } });
}
