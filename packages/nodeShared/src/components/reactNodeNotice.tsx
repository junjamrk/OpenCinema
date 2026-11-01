import { errorText } from "../reactNode";
import "../theme/nodeControls.scss";

const settingsRoutes = [
  { tab: "ffmpeg", codes: ["FFMPEG_REQUIRED"], text: /需要 FFmpeg|配置可用的 FFmpeg/ },
  { tab: "models", codes: ["MODEL_NOT_READY"], text: /Video Depth Anything|深度模型|准备模型/ },
  { tab: "host", codes: [] as string[], text: /宿主.*(未连接|尚未连接|尚未提供)|连接.*宿主/ },
];

function settingsTab(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  return (settingsRoutes.find(route => route.codes.includes(code)) ?? settingsRoutes.find(route => route.text.test(errorText(error))))?.tab;
}

export function openSettings(tab: string) { window.dispatchEvent(new CustomEvent("openCinema:open-settings", { detail: { tab } })); }

export default function NodeError({ error, className = "nodeError" }: { error: unknown; className?: string }) {
  if (!error) return null;
  const tab = settingsTab(error);
  return <p className={className} role="alert">{errorText(error)}{tab && <button type="button" className="nodeErrorAction" onClick={() => openSettings(tab)}>打开设置</button>}</p>;
}

const lockReasons = {
  local: "无法确认上次任务是否结束，此节点已暂停媒体操作。FFmpeg 通常随连接断开而停止；若服务曾异常退出，它可能在后台跑完，但只写入该任务自己的目录，原素材不受影响。",
  host: "无法确认 Agent 是否已停止这项任务，此节点已暂停媒体操作。Agent 迟到的结果只会生成新内容，不覆盖原素材。",
};

export function TaskLockNotice({ owner, disabled, onRelease }: { owner: keyof typeof lockReasons; disabled?: boolean; onRelease(): void }) {
  return <div className="nodeNotice" role="status"><p>{lockReasons[owner]}</p><button type="button" disabled={disabled} onClick={onRelease}>解除锁定</button></div>;
}
