import { uploadNodeFile } from "@toonflow/nodes-scaffold/nodeFiles";
import type { NodeWorkbenchService } from "@toonflow/nodes-scaffold/workbenchServices";

export async function requestNodeHost(workbench: NodeWorkbenchService, nodeId: string, input: Parameters<NodeWorkbenchService["hostRequest"]>[0], signal: AbortSignal) {
  signal.throwIfAborted();
  const references = input.references ?? [];
  if (input.prompt.length <= 3000 && new TextEncoder().encode(JSON.stringify(references)).length <= 512 * 1024) return workbench.hostRequest(input, signal);
  workbench.assertWritable();
  const path = await uploadNodeFile(workbench.files, nodeId, new File([JSON.stringify({ version: 1, nodeId, ...input }, null, 2)], "hostContext.json", { type: "application/json" }));
  signal.throwIfAborted();
  return workbench.hostRequest({ ...input, prompt: `请完成节点 ${nodeId} 的操作。完整要求、正文和全部参考已保存于工作区 ${path}（绝对目录：${workbench.directory}）。请先读取该JSON，按其中完整prompt及references执行；下列仅为开头摘要，不可将摘要当完整要求。\n${input.prompt.slice(0, 1800)}\n请使用节点工具保存实际产物，保留原素材。`, references: [{ dataType: "FILE", value: { url: path, mimeType: "application/json" }, label: "完整创作要求与参考" }], metadata: { ...input.metadata, contextFile: path } }, signal);
}
