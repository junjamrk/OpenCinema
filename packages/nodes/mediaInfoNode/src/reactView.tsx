import { useEffect, useState } from "react";
import { errorText, type NodeViewProps } from "@toonflow/node-shared/reactNode";
import NodeIcon from "@toonflow/node-shared/reactIcon";
import "@toonflow/node-shared/nodeControls";

export default function MediaInfoNodeView({ node, controller, readOnly }: NodeViewProps) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inputs = controller.getNodeService(node.id).getInputs("input");
  const outputs = node.data?.outputs as { summary?: { value?: unknown }; report?: { value?: { url?: string } } } | undefined;
  const status = node.data?.mediaInfoStatus as { status?: string; bytesRead?: number; error?: string } | undefined;
  const [taskState, setTaskState] = useState("");
  useEffect(() => { let active = true; void controller.callNodeTool(node.id, "getInspectionStatus", {}).then(value => { if (active) setTaskState((value as { status: string }).status); }).catch(reason => { if (active) setError(errorText(reason)); }); return () => { active = false; }; }, [controller, node.id, status?.status]);
  const running = busy || taskState === "running";
  const stale = !!node.data?.mediaInfoInput && JSON.stringify(inputs[0]?.value) !== node.data.mediaInfoInput;
  async function inspect() { setBusy(true); setError(""); try { await controller.callNodeTool(node.id, "inspectMedia", {}); } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); } }
  return <div className="nodeControls nodrag nopan nowheel">
    {inputs[0]?.value && typeof inputs[0].value === "object" && "url" in inputs[0].value && <span className="nodeStatus" title={String(inputs[0].value.url)}>{String(inputs[0].value.url).split("/").at(-1)}</span>}
    <div className="nodeActions"><button type="button" className="nodePrimary" disabled={readOnly || running || inputs.length !== 1} onClick={() => void inspect()}><NodeIcon name="info" />检查媒体信息</button>
      {running && <button type="button" onClick={() => void controller.callNodeTool(node.id, "cancelInspection", {}).catch(reason => setError(errorText(reason)))}>取消</button>}</div>
    {typeof outputs?.summary?.value === "string" && <pre className="nodeReport">{outputs.summary.value}</pre>}
    {stale && <span className="nodeStatus">输入已变化，请重新检查</span>}
    {status?.bytesRead !== undefined && <span className="nodeStatus">已读取 {(status.bytesRead / 1024 ** 2).toFixed(2)} MiB · 本地 MediaInfo</span>}
    {(error || status?.error) && <p className="nodeError" role="alert">{error || status?.error}</p>}
    {outputs?.report?.value?.url && <button type="button" onClick={() => void controller.acquireMedia(outputs.report!.value!.url!, "application/json").then(media => {
      const link = document.createElement("a"); link.href = media.url; link.download = "mediaInfo.json"; link.click(); setTimeout(media.release, 1000);
    }).catch(reason => setError(errorText(reason)))}><NodeIcon name="download" />下载 JSON 报告</button>}
  </div>;
}
