import { useRef, useState } from "react";
import { errorText, isGenerationLocked, mediaValueSchema, type NodeViewProps } from "@toonflow/node-shared/reactNode";
import { readReferences } from "@toonflow/node-shared/reactReferences";

function localDateTime(value: Date) {
  return new Date(value.getTime() - value.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
}

export default function ReferenceDelivery({ node, controller, readOnly }: NodeViewProps) {
  const link = useRef<HTMLInputElement>(null);
  const [selectedPath, setSelectedPath] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [credentialExpiresAt, setCredentialExpiresAt] = useState("");
  const [temporaryCredential, setTemporaryCredential] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const workbench = controller.getNodeService(node.id);
  const references = readReferences(workbench, node.data ?? {}).flatMap(input => {
    const value = mediaValueSchema.safeParse(input.value);
    return input.dataType === "VIDEO" && value.success ? [value.data] : [];
  });
  const source = references.find(value => value.url === selectedPath) ?? references[0];
  let usesArk = false;
  try { usesArk = JSON.parse(String(node.data?.model ?? "null"))?.[0] === "ark"; } catch { /* Model selection is read from saved node data. */ }
  if (!usesArk || !references.length) return null;
  const disabled = readOnly || busy || isGenerationLocked((node.data?.generation as { status?: string } | undefined)?.status);

  async function register() {
    if (!source || !link.current?.value) return;
    setBusy(true); setError(""); setStatus("");
    const readUrl = link.current.value;
    link.current.value = "";
    try {
      workbench.assertWritable();
      if (!expiresAt) throw new Error("请填写链接的实际到期时间");
      const content = await workbench.files.read(source.url, 100 * 1024 ** 2);
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", content)), value => value.toString(16).padStart(2, "0")).join("");
      const input = { directory: workbench.directory, canvasId: workbench.canvasId, nodeId: node.id, path: source.url, sha256, readUrl, readExpiresAt: new Date(expiresAt).toISOString(), credentialExpiresAt: temporaryCredential && credentialExpiresAt ? new Date(credentialExpiresAt).toISOString() : null, operationId: crypto.randomUUID() };
      const response = await fetch("/api/ai/media/referenceBindings", { method: "POST", headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" }, body: JSON.stringify(input), signal: AbortSignal.timeout(150000) });
      const result = await response.json();
      if (!response.ok || result.code !== 200 || result.data?.status !== "ready") throw new Error(typeof result.message === "string" ? result.message : "临时视频参考登记失败");
      setStatus(`原始视频SHA已核对，链接名义到期 ${new Date(result.data.binding.readExpiresAt).toLocaleString()}；${result.data.binding.credentialExpiryKnown ? "底层凭据期限已声明" : "STS实际到期未知，仅确认当前可读"}。方舟任务预算1小时，${result.data.binding.queueExpiryCovered ? "链接期限覆盖该预算" : "不保证覆盖完整排队；过期失败不会自动重派"}。`);
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  }

  return <details className="nodeDetails"><summary>临时视频参考链接</summary>
    <label className="nodeField"><span>当前视频参考</span><select disabled={disabled} value={source?.url ?? ""} onChange={event => { setSelectedPath(event.target.value); setStatus(""); }}>{references.map((value, index) => <option key={`${value.url}:${index}`} value={value.url}>{value.url.split("/").at(-1)}</option>)}</select></label>
    <label className="nodeField"><span>已授权的 HTTPS 读取链接</span><input ref={link} type="password" autoComplete="off" spellCheck={false} disabled={disabled} aria-label="临时视频参考链接" onChange={event => {
      setStatus("");
      try {
        const url = new URL(event.target.value);
        setTemporaryCredential(url.searchParams.has("X-Tos-Security-Token"));
        const issued = url.searchParams.get("X-Tos-Date")?.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
        const seconds = Number(url.searchParams.get("X-Tos-Expires"));
        if (issued && Number.isInteger(seconds) && seconds > 0) setExpiresAt(localDateTime(new Date(Date.UTC(Number(issued[1]), Number(issued[2]) - 1, Number(issued[3]), Number(issued[4]), Number(issued[5]), Number(issued[6])) + seconds * 1000)));
      } catch { setTemporaryCredential(false); }
    }} /></label>
    <label className="nodeField"><span>链接签名到期（本地时间）</span><input type="datetime-local" step="1" value={expiresAt} disabled={disabled} onChange={event => setExpiresAt(event.target.value)} /></label>
    {temporaryCredential && <label className="nodeField"><span>STS实际到期（未知可留空）</span><input type="datetime-local" step="1" value={credentialExpiresAt} disabled={disabled} onChange={event => setCredentialExpiresAt(event.target.value)} /></label>}
    <p className="nodeStatus">只登记当前文件与此生成节点。链接提交后清空，不写入画布；提交时须至少剩10分钟。服务重启或过期后须重新登记。</p>
    <div className="nodeActions"><button type="button" disabled={disabled} onClick={() => void register()}>{busy ? "核对原始视频…" : "核对并登记"}</button></div>
    {status && <p className="nodeStatus" role="status">{status}</p>}{error && <p className="nodeError" role="alert">{error}</p>}
  </details>;
}
