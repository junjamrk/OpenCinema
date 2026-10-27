import { useEffect, useRef, useState } from "react";
import NodeIcon from "@toonflow/node-shared/reactIcon";
import type { CollaborationService } from "./reactService";
import "./reactStyles.scss";

const roleLabels: Record<string, string> = { owner: "工程所有者", editor: "可编辑", viewer: "仅查看" };
function formatTime(value: number) {
  return new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function CollaborationPanel({ service }: { service: CollaborationService }) {
  const [, refresh] = useState(0);
  const [mode, setMode] = useState<"start" | "join">("start");
  const [invitation, setInvitation] = useState("");
  const [inviteRole, setInviteRole] = useState<"editor" | "viewer">("editor");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [manualCopy, setManualCopy] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const state = service.state;
  const statusCard = useRef<HTMLDivElement>(null);
  const copyButton = useRef<HTMLButtonElement>(null);
  const previousRole = useRef(state.role);
  const previousInvite = useRef(state.invite);
  const workspaceName = service.directory.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "当前工程";
  const invitationText = service.invitationText;
  const status = !state.role ? "尚未加入协作" : service.paused ? state.conflict ? "修改冲突 · 同步已暂停" : "同步已暂停" : state.lastSyncedAt ? "同步正常" : "已连接 · 等待同步";
  useEffect(() => service.subscribe(() => refresh(value => value + 1)), [service]);
  useEffect(() => { previousRole.current = state.role; previousInvite.current = state.invite; setInvitation(""); setError(""); setMode("start"); setCopied(false); setManualCopy(false); }, [service]);
  useEffect(() => {
    if (previousRole.current === state.role) return;
    previousRole.current = state.role;
    statusCard.current?.focus();
  }, [state.role]);
  useEffect(() => {
    if (!state.invite) { previousInvite.current = ""; return; }
    if (state.busy || previousInvite.current === state.invite) return;
    previousInvite.current = state.invite;
    copyButton.current?.focus();
  }, [state.invite, state.busy]);
  useEffect(() => { setCopied(false); setManualCopy(false); }, [state.invite]);
  useEffect(() => { setConfirmClose(false); }, [state.role]);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1600); return () => clearTimeout(timer); }, [copied]);
  async function join() {
    setError("");
    await service.joinInvitation(invitation);
    if (service.state.role) setInvitation("");
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(invitationText);
      setCopied(true);
      setError("");
    } catch {
      setManualCopy(true);
      setError("无法自动复制，请在下方选中完整邀请后手动复制。");
    }
  }
  return <section className="collaborationReactPanel" aria-label="工程协作" aria-busy={state.busy} onKeyDown={event => event.stopPropagation()}>
    <div ref={statusCard} className="collaborationState" tabIndex={-1} aria-label={`${workspaceName} · ${status}`} data-state={service.paused && state.role ? "paused" : state.role ? "connected" : "idle"}>
      <NodeIcon name={state.role && !service.paused ? "check" : "users"} />
      <div><strong>{workspaceName}</strong><span role="status">{state.busy ? "正在处理…" : status}</span></div>
      {state.role && <span className="collaborationRole">{roleLabels[state.role]}</span>}
    </div>
    {!state.role ? <>
      <div className="collaborationModes" role="group" aria-label="协作方式">
        <button type="button" aria-pressed={mode === "start"} disabled={state.busy} onClick={() => setMode("start")}>邀请他人</button>
        <button type="button" aria-pressed={mode === "join"} disabled={state.busy} onClick={() => setMode("join")}>使用邀请加入</button>
      </div>
      {mode === "start" ? <div className="collaborationStep">
        <p>先开启当前工程的协作，再选择对方的权限并复制邀请。</p>
        <button type="button" className="collaborationPrimary" disabled={state.busy} onClick={() => void service.open()}><NodeIcon name="invite" />开启工程协作</button>
        <small>这个工程已开启过协作时，会恢复现有协作。</small>
      </div> : <form className="collaborationStep" onSubmit={event => { event.preventDefault(); void join(); }}>
        <p>先打开对方共享的工程，再粘贴收到的完整邀请。</p>
        <label><span>邀请内容</span><input value={invitation} disabled={state.busy} onChange={event => { setInvitation(event.target.value); setError(""); }} type="text" autoComplete="off" spellCheck={false} placeholder="粘贴 OpenCinema 邀请" aria-label="协作邀请" maxLength={16000} /></label>
        <button type="submit" className="collaborationPrimary" disabled={state.busy || !invitation.trim()}><NodeIcon name="link" />加入当前工程</button>
        <small>邀请仅能使用一次；加入后会显示你的实际权限。</small>
      </form>}
    </> : <>
      <div className="collaborationSession">
        <span>{state.role === "viewer" ? "可以查看共享画布，不能修改内容。" : "画布与节点的修改会同步到这个工程。"}</span>
        {state.lastSyncedAt > 0 && <small>最近同步 {new Date(state.lastSyncedAt).toLocaleTimeString("zh-CN")}</small>}
        <small>本次会话有效至 {formatTime(state.expiresAt)}</small>
      </div>
      {service.paused && <div className="collaborationRecovery">
        <strong>{state.conflict ? "本地与共享内容发生冲突" : "连接或同步需要恢复"}</strong>
        <p>{state.conflict ? "当前修改已保留。可以先另存一份草稿，再载入共享内容。" : "未确认的修改和命令已保留，解决下方提示的问题后可尝试继续同步。"}</p>
        <button type="button" className="collaborationPrimary" disabled={state.busy} onClick={() => void (state.conflict ? service.recoverDraft() : service.resume())}><NodeIcon name="reset" />{state.conflict ? "另存草稿并载入共享内容" : "继续同步"}</button>
      </div>}
      {state.role === "owner" && <div className="collaborationInvite">
        <label><span>对方的权限</span><select value={inviteRole} disabled={state.busy} aria-label="邀请权限" onChange={event => setInviteRole(event.target.value as "editor" | "viewer")}><option value="editor">可编辑</option><option value="viewer">仅查看</option></select></label>
        <p>{inviteRole === "viewer" ? "对方可以查看画布，不能修改工程。" : "对方可以编辑画布与节点，并撤销自己的修改。"}</p>
        <button type="button" disabled={state.busy} onClick={() => void service.invite(inviteRole)}><NodeIcon name="invite" />{state.invite ? "生成另一份邀请" : "生成邀请"}</button>
        {state.invite && <div className="collaborationInvitation">
          <div><strong>{roleLabels[state.inviteRole] || "协作"}邀请已生成</strong><small>可使用一次 · {formatTime(state.inviteExpiresAt)} 前有效</small></div>
          <button ref={copyButton} type="button" className="collaborationPrimary" disabled={state.busy} onClick={() => void copy()}><NodeIcon name={copied ? "check" : "copy"} />{copied ? "邀请已复制" : "复制邀请"}</button>
          <small>把邀请交给对方，在「使用邀请加入」中粘贴。</small>
          <details open={manualCopy} onToggle={event => setManualCopy(event.currentTarget.open)}><summary>手动复制邀请</summary><textarea value={invitationText} readOnly rows={3} aria-label="完整邀请内容" spellCheck={false} onFocus={event => event.currentTarget.select()} /></details>
          <details><summary>撤销这份邀请</summary><p>此邀请及通过它加入的会话都会失效。</p><button type="button" disabled={state.busy} onClick={() => void service.revoke()}><NodeIcon name="unlink" />撤销邀请</button></details>
        </div>}
      </div>}
      <details className="collaborationManagement"><summary>离开或结束协作</summary>
        <p>离开只退出当前会话，未同步的修改会另存为工程中的草稿文件。</p>
        <button type="button" disabled={state.busy} onClick={() => void service.leave()}>离开并保全草稿</button>
        {state.role === "owner" && (confirmClose ? <div className="collaborationCloseConfirm"><p>结束后，其他人也将停止同步。</p><div className="invitationActions"><button type="button" disabled={state.busy} onClick={() => setConfirmClose(false)}>继续协作</button><button type="button" data-tone="danger" disabled={state.busy} onClick={() => void service.close()}>确认结束协作</button></div></div> : <button type="button" data-tone="danger" disabled={state.busy} onClick={() => setConfirmClose(true)}>结束所有人的协作</button>)}
      </details>
    </>}
    <p className="collaborationNetworkHint"><NodeIcon name="info" size={14} /><span>对方需能打开同一 OpenCinema 服务和工程。邀请不会自动开放外网访问，也不会传输另一台电脑上的本地文件。</span></p>
    {(error || state.error) && <p role="alert" className="collaborationError">{error || state.error}</p>}
  </section>;
}
