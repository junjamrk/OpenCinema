import { useState } from "react";
import { z } from "zod";
import type { PluginActivationContext } from "@toonflow/nodes-scaffold/contracts";
import { errorText, nodePreconditionError, pluginServices, readMedia, readNodeData, type NodeViewProps } from "@toonflow/node-shared/reactNode";
import NodeIcon from "@toonflow/node-shared/reactIcon";
import { createVideoDepthData } from "./reactService";

export function registerVideoDepthSourceTool(context: PluginActivationContext) {
  const { id, document, workbench } = pluginServices(context);
  let creating = false;
  context.registerTool({ name: "createVideoDepth", description: "为当前RGB视频创建并连接视频深度白模节点，选中新节点以调整范围；不启动推理。随后发现新节点的setDepthSettings/runDepth/applyDepthResult。", parameters: z.strictObject({}),
    outputSchema: z.strictObject({ nodeId: z.string(), sourceNodeId: z.string(), created: z.literal(true) }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async execute(_args, { signal }) {
      workbench.assertWritable(); signal.throwIfAborted();
      if (creating) throw new Error("正在创建深度白模节点，请等待当前操作完成");
      creating = true;
      try {
        const data = readNodeData(document, id), source = readMedia(data, "video");
        const outputs = data.outputs as Record<string, { value?: { url?: string; controlType?: string } }> | undefined;
        const handles = data.handles as { id: string; type: string; dataType: unknown }[] | undefined;
        const output = handles?.find(handle => handle.type === "source" && handle.dataType === "VIDEO" && outputs?.[handle.id]?.value?.url === source?.url);
        if (!source || !output || outputs?.[output.id]?.value?.controlType) throw nodePreconditionError(workbench, id, "请先选择或生成原始RGB视频，不能对深度结果再次提取");
        if ([data.generation, data.mediaOperation].some(value => value && typeof value === "object" && "status" in value && ["running", "delegated", "cancelRequested", "unknown", "interrupted"].includes(String(value.status)))) throw nodePreconditionError(workbench, id, "原视频任务尚未收尾，请先确认任务状态");
        const layout = workbench.getLayout();
        const position = { x: layout.position.x + layout.width + 80, y: layout.position.y };
        const childId = crypto.randomUUID();
        await workbench.createNodes([{ id: childId, type: "videoDepthNode", position, data: { ...createVideoDepthData(), label: `${String(data.label ?? "视频")} · 深度白模`, origin: { nodeId: id } } }],
          [{ id: crypto.randomUUID(), source: id, sourceHandle: output.id, target: childId, targetHandle: "input" }], signal);
        workbench.selectNodes([childId]);
        return { nodeId: childId, sourceNodeId: id, created: true as const };
      } finally { creating = false; }
    } });
}

export default function VideoDepthAction({ node, controller, readOnly }: NodeViewProps) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  if (!readMedia(node.data, "video")) return null;
  const outputs = node.data?.outputs as { video?: { value?: { controlType?: string } } } | undefined;
  if (outputs?.video?.value?.controlType) return null;
  const blocked = [node.data?.generation, node.data?.mediaOperation].some(value => value && typeof value === "object" && "status" in value && ["running", "delegated", "cancelRequested", "unknown", "interrupted"].includes(String(value.status)));
  return <><button type="button" className="nodeMediaTool" title={error || "视频深度白模"} aria-label="视频深度白模" aria-busy={busy} disabled={readOnly || busy || blocked} onClick={() => {
    if (busy) return;
    setBusy(true); setError("");
    void controller.callNodeTool(node.id, "createVideoDepth", {}).catch(reason => setError(errorText(reason))).finally(() => setBusy(false));
  }}><NodeIcon name="merge" /></button>{error && <span className="nodeError" role="alert">{error}</span>}</>;
}
