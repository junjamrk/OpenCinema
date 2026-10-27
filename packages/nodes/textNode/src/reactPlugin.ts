import { z } from "zod";
import type { NodePluginDefinition } from "@toonflow/nodes-scaffold/contracts";
import type { NodeDocumentService } from "@toonflow/nodes-scaffold/react";
import TextNodeView from "./reactView";
import { isExecutionUnknown, cloneMediaNodeData, pluginServices, readNodeData } from "@toonflow/node-shared/reactNode";
import { readReferences, registerReferenceTools } from "@toonflow/node-shared/reactReferences";
import { requestNodeHost } from "@toonflow/node-shared/reactHostRequest";
import { editorSession } from "@toonflow/node-shared/editorSession";

const plugin: NodePluginDefinition<typeof TextNodeView> = {
  cloneData: cloneMediaNodeData,
  apiVersion: 1, id: "textNode", name: "文本", version: "1.0.0", renderer: "react", view: TextNodeView,
  composer: { label: "修改正文", placeholder: "描述写作要求，或希望如何修改这段正文…", tool: "generateText" },
  createData: () => ({ label: "文本", handles: [
    { id: "in", type: "target", dataType: ["VIDEO", "IMAGE", "AUDIO", "STRING", "FILE"], label: "输入" },
    { id: "text", type: "source", dataType: "STRING", label: "输出" },
  ], outputs: { text: { dataType: "STRING", value: "" } } }),
  activate(context) {
    const document = context.getService<NodeDocumentService>("document");
    const id = context.nodeId;
    if (!id) throw new Error("文本节点缺少节点绑定");
    const { workbench } = pluginServices(context);
    const selectionSchema = z.strictObject({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative(), text: z.string(), coordinates: z.enum(["proseMirrorDocument", "markdownCharacters"]) }).nullable();
    const selection = editorSession<z.output<typeof selectionSchema>>(workbench, "textSelection", null);
    registerReferenceTools(context);
    let pending: AbortController | undefined;
    let job: Promise<{ status: string; revision: number }> | undefined;
    let unknown: Error | undefined;
    const statusSchema = z.strictObject({ status: z.string(), taskId: z.string().optional(), requestId: z.string().optional(), error: z.string().optional(), startedAt: z.string().optional(), finishedAt: z.string().optional() });
    const generation = () => readNodeData(document, id).textGeneration as { status?: string; taskId?: string; error?: string } | undefined;
    context.onDispose(async () => { pending?.abort(new Error("节点已卸载")); await job?.catch(() => {}); });
    context.onBeforeChange(async () => {
      pending?.abort(new Error("节点即将变更")); await job?.catch(() => {});
      if (unknown) throw unknown;
      if (["running", "delegated", "unknown"].includes(generation()?.status ?? "")) throw new Error("此前宿主文本任务尚未确认终止，请先确认宿主任务终态");
    });
    context.registerTool({ name: "getText", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, description: "读取当前正文，区分draft/committed及当前富文本选区。选区coordinates明确proseMirrorDocument或markdownCharacters；前者不是Markdown字符偏移。null表示编辑器未挂载或没有选区。", parameters: z.strictObject({}), outputSchema: z.strictObject({ text: z.string(), revision: z.number().int().nonnegative(), documentRevision: z.number().int().nonnegative(), source: z.enum(["draft", "committed"]), selection: selectionSchema }),
      async execute() {
        const revision = document.getRevision();
        const text = await document.readText(id);
        const data = readNodeData(document, id);
        const output = (data.outputs as { text?: { value?: unknown } } | undefined)?.text?.value;
        const committed = typeof data.textPath === "string" ? await workbench.files.readText(data.textPath) : typeof output === "string" ? output : String(data.text ?? "");
        if (document.getRevision() !== revision) throw new Error("画布在读取正文期间已变化，请重新读取");
        return { text, revision, documentRevision: revision, source: text === committed ? "committed" as const : "draft" as const, selection: selection.read().value };
      } });
    context.registerTool({ name: "setPrompt", outputSchema: z.strictObject({ prompt: z.string() }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, description: "保存文本创作提示词，不发送宿主请求。", parameters: z.strictObject({ prompt: z.string().max(100000) }),
      async execute(args, { signal }) { await workbench.updateData({ prompt: args.prompt }, undefined, signal); await document.save(); return { prompt: args.prompt }; } });
    context.registerTool({ name: "getGenerationStatus", outputSchema: statusSchema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, description: "读取宿主文本任务的真实状态；delegated仍需等待正文产物。", parameters: z.strictObject({}), execute() { return { ...generation(), status: generation()?.status ?? "idle" }; } });
    context.registerTool({ name: "cancelGeneration", outputSchema: statusSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }, description: "取消此节点等待中的宿主文本请求；适配器未确认远端终止时保留unknown。", parameters: z.strictObject({}), async execute() {
      pending?.abort(new Error("用户取消文本创作")); await job?.catch(() => {});
      const saved = generation();
      if (["running", "delegated"].includes(saved?.status ?? "")) { await workbench.updateRuntimeData({ textGeneration: { ...saved, status: "unknown", error: "宿主尚未确认终止，等待原任务正文产物" } }); await document.save(); }
      return { ...generation(), status: generation()?.status ?? "idle" };
    } });
    context.registerTool({ name: "generateText", outputSchema: z.strictObject({ status: z.string(), revision: z.number().int().nonnegative() }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }, description: "将此节点的创作目标、当前正文和连线参考交给启动工作台的宿主 Agent；可传prompt保存本次创作要求，不传则沿用已保存指令。完成正文通过共享编辑会话保存。", parameters: z.strictObject({ prompt: z.string().max(100000).optional() }),
      async execute(args, { signal }) {
        workbench.assertWritable(); if (pending) throw new Error("此节点正在等待宿主创作"); if (unknown) throw unknown;
        if (["running", "delegated", "unknown"].includes(generation()?.status ?? "")) throw new Error("此前宿主文本任务仍在等待正文或终态，请勿重复发起");
        signal.throwIfAborted();
        const prompt = String(args.prompt ?? readNodeData(document, id).prompt ?? "").trim(); if (!prompt) throw new Error("请输入文本创作要求");
        const operation = pending = new AbortController(); const combined = AbortSignal.any([signal, context.signal, operation.signal]);
        const taskId = crypto.randomUUID();
        job = (async () => {
          if (args.prompt !== undefined) await workbench.updateData({ prompt: args.prompt }, undefined, combined);
          await workbench.updateRuntimeData({ textGeneration: { status: "running", taskId, startedAt: new Date().toISOString() } }, combined); await document.save();
          const revision = document.getRevision(); const original = await document.readText(id);
          if (document.getRevision() !== revision) throw new Error("读取期间正文已变化，请重新发起创作");
          combined.throwIfAborted();
          const references = readReferences(workbench, readNodeData(document, id));
          if (references.some(reference => reference.value === undefined)) throw new Error("引用节点暂无内容，请先补充引用内容");
          const response = await requestNodeHost(workbench, id, { kind: "edit", prompt: `请为文本节点 ${id} 完成正文创作。\n要求：${prompt}\n当前正文：\n${original}\n请仅返回最终正文，或使用该节点setText工具保存正文并携带taskId ${taskId} 确认原任务完成。`, references, metadata: { nodeId: id, expectedRevision: revision, operation: "generateText", taskId } }, combined);
          combined.throwIfAborted();
          if (response.status === "completed" && response.text && document.getRevision() === revision) { await document.writeText(id, response.text, revision, combined); await document.save(); }
          const status = generation()?.taskId === taskId && generation()?.status === "completed" || response.status === "completed" && await document.readText(id) !== original ? "completed" : "delegated";
          await workbench.updateRuntimeData({ textGeneration: { status, taskId } }, combined); await document.save();
          return { status, revision: document.getRevision() };
        })();
        try { return await job; }
        catch (error) {
          if (isExecutionUnknown(error)) {
            unknown = error instanceof Error ? error : new Error("宿主任务尚未确认终止");
            const requestId = "requestId" in error && typeof error.requestId === "string" ? error.requestId : "";
            await workbench.updateRuntimeData({ textGeneration: { status: "unknown", taskId, requestId, error: unknown.message } }).then(() => document.save()).catch(() => {});
          } else if (!context.signal.aborted) await workbench.updateRuntimeData({ textGeneration: { status: combined.aborted ? "cancelled" : "failed", taskId } }).then(() => document.save()).catch(() => {});
          throw error;
        }
        finally { if (pending === operation) { pending = undefined; job = undefined; } }
      } });
    context.registerTool({ name: "setText", outputSchema: z.strictObject({ nodeId: z.string(), saved: z.boolean(), revision: z.number().int().nonnegative() }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, description: "保存节点正文的新版本并纳入统一编辑历史；宿主任务完成时须带原taskId。", parameters: z.strictObject({ text: z.string().max(1000000), expectedRevision: z.number().int().nonnegative().optional(), taskId: z.uuid().optional() }),
      async execute(args, { signal }) {
        signal.throwIfAborted();
        const saved = generation();
        if (args.taskId && saved?.taskId !== args.taskId) throw new Error("文本任务标识已变化，请勿提交旧任务正文");
        if (!args.taskId && ["running", "delegated", "unknown"].includes(saved?.status ?? "")) throw new Error("宿主正文任务仍在等待终态，完成时须提供原taskId");
        await document.writeText(id, args.text, args.expectedRevision, signal);
        if (args.taskId) { unknown = undefined; await workbench.updateRuntimeData({ textGeneration: { taskId: args.taskId, status: "completed", finishedAt: new Date().toISOString() } }, signal); }
        signal.throwIfAborted();
        await document.save();
        signal.throwIfAborted();
        return { nodeId: id, saved: true, revision: document.getRevision() };
      } });
  },
};

export default plugin;
