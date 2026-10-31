const lockReasons = {
  local: "无法确认上次任务是否结束，此节点已暂停媒体操作。FFmpeg 通常随连接断开而停止；若服务曾异常退出，它可能在后台跑完，但只写入该任务自己的目录，原素材不受影响。",
  host: "无法确认 Agent 是否已停止这项任务，此节点已暂停媒体操作。Agent 迟到的结果只会生成新内容，不覆盖原素材。",
};

export function TaskLockNotice({ owner, disabled, onRelease }: { owner: keyof typeof lockReasons; disabled?: boolean; onRelease(): void }) {
  return <div className="nodeNotice" role="status"><p>{lockReasons[owner]}</p><button type="button" disabled={disabled} onClick={onRelease}>解除锁定</button></div>;
}
