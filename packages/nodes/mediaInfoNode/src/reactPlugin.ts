import { openCinema, version } from "../package.json";
import { z } from "zod";
import type { NodePluginDefinition } from "@toonflow/nodes-scaffold/contracts";
import { uploadNodeFile } from "@toonflow/nodes-scaffold/nodeFiles";
import { nodePreconditionError, cloneMediaNodeData, errorText, pluginServices, readNodeData, mediaValueSchema } from "@toonflow/node-shared/reactNode";
import { createMediaInfoService } from "./mediaInfoService";
import MediaInfoNodeView from "./reactView";

const plugin: NodePluginDefinition<typeof MediaInfoNodeView> = {
  cloneData: cloneMediaNodeData,
  ...openCinema, version, apiVersion: 1, renderer: "react", view: MediaInfoNodeView,
  createData: () => ({ label: openCinema.name, handles: [{ id: "input", type: "target", dataType: ["VIDEO", "AUDIO", "IMAGE", "FILE"], label: "媒体素材" }, { id: "report", type: "source", dataType: "FILE", label: "媒体信息报告 JSON" }, { id: "summary", type: "source", dataType: "STRING", label: "摘要" }], outputs: {} }),
  activate(context) {
    const { id, document, workbench } = pluginServices(context);
    const analyzer = createMediaInfoService(workbench.files, context.signal);
    context.onDispose(() => analyzer.dispose());
    let operation: AbortController | undefined;
    let task: Promise<{ path: string; summary: string; revision: number }> | undefined;
    const source = () => {
      const inputs = workbench.getInputs("input");
      if (inputs.length !== 1) throw nodePreconditionError(workbench, id, "请连接一路媒体素材", inputs.length ? "mediaSourceAmbiguous" : "mediaSourceRequired");
      const value = mediaValueSchema.safeParse(inputs[0]?.value);
      if (!value.success) throw nodePreconditionError(workbench, id, "输入节点尚未提供有效媒体，请先读取上游输出");
      return value.data;
    };
    context.onDispose(async () => { operation?.abort(new Error("节点已卸载")); await task?.catch(() => {}); });
    context.onBeforeChange(async () => { operation?.abort(new Error("节点即将变更")); await task?.catch(() => {}); });
    context.registerTool({ name: "getInspectionStatus", outputSchema: z.strictObject({ status: z.string(), bytesRead: z.number().nonnegative().optional(), error: z.string().optional() }), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, description: "读取真实检查状态；重载后中断的任务不会显示为仍在运行。", parameters: z.strictObject({}), execute() { const saved = readNodeData(document, id).mediaInfoStatus as { status?: string; bytesRead?: number; error?: string } | undefined; return { ...saved, status: saved?.status === "running" ? task ? "running" : "interrupted" : saved?.status ?? "idle" }; } });
    context.registerTool({ name: "cancelInspection", outputSchema: z.strictObject({ cancelling: z.boolean() }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, description: "取消本地媒体信息检查。", parameters: z.strictObject({}), execute() { operation?.abort(new Error("用户取消检查")); return { cancelling: !!task }; } });
    context.registerTool({ name: "inspectMedia", outputSchema: z.strictObject({ path: z.string(), summary: z.string(), revision: z.number().int().nonnegative() }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, description: "使用浏览器 MediaInfo WASM 本地检查容器、编码、时长、帧率与轨道，保存 JSON 报告；不上传媒体、不调用模型。", parameters: z.strictObject({}),
      async execute(_args, { signal }) {
        workbench.assertWritable();
        if (task) throw new Error("节点正在检查媒体");
        operation = new AbortController(); const combined = AbortSignal.any([context.signal, operation.signal, signal]);
        const initial = source(); const fingerprint = JSON.stringify(initial);
        task = (async () => {
          try {
            await workbench.updateRuntimeData({ mediaInfoStatus: { status: "running", bytesRead: 0 } }, combined);
            let lastPublished = 0;
            const result = await analyzer.service.analyze(initial, combined, bytes => {
              if (bytes - lastPublished < 1024 ** 2) return;
              lastPublished = bytes;
              void workbench.updateRuntimeData({ mediaInfoStatus: { status: "running", bytesRead: bytes } }, combined).catch(() => {});
            });
            combined.throwIfAborted();
            if (JSON.stringify(source()) !== fingerprint) throw new Error("输入已变化，未替换原检查结果");
            const path = await uploadNodeFile(workbench.files, id, new File([JSON.stringify(result.report, null, 2)], "mediaInfo.json", { type: "application/json" }));
            combined.throwIfAborted();
            if (JSON.stringify(source()) !== fingerprint) throw new Error("输入已变化，报告保留，未替换原结果");
            await workbench.updateData({ outputs: { ...(readNodeData(document, id).outputs as object ?? {}), report: { dataType: "FILE", value: { url: path, mimeType: "application/json" } }, summary: { dataType: "STRING", value: result.summary } }, mediaInfoInput: fingerprint }, undefined, combined);
            await workbench.updateRuntimeData({ mediaInfoStatus: { status: "completed", bytesRead: result.report.bytesRead } }, combined);
            await document.save(); return { path, summary: result.summary, revision: document.getRevision() };
          } catch (error) {
            if (!context.signal.aborted) await workbench.updateRuntimeData({ mediaInfoStatus: { status: combined.aborted ? "cancelled" : "failed", error: errorText(error) } }).catch(() => {});
            throw error;
          }
        })();
        try { return await task; } finally { task = undefined; operation = undefined; }
      } });
  },
};
export default plugin;
