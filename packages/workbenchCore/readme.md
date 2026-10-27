# 工程编辑会话

`@toonflow/workbench-core` 只处理作品 JSON、修订、编辑历史与保存队列，不依赖 React、Vue、Flow 或宿主 Agent。

```ts
import { createDocumentSession } from "@toonflow/workbench-core";

const session = createDocumentSession({
  directory,
  canvasId,
  document,
  save: (document, binding) => files.writeSnapshot(binding.canvasId, document),
});

session.execute({
  name: "updateNodes",
  expectedRevision: session.getSnapshot().revision,
  args: { updates: [{ id: nodeId, changes: { position: { x: 100, y: 200 } } }] },
});
await session.flushSave();
```

示例中的 `files.writeSnapshot` 是调用方提供的持久化回调。Web 的真实适配使用 `createWorkspaceFiles(directory).writeTextSnapshot`，携带读取时取得的 SHA 修订与编码；内核不自行选择目录或磁盘接口。

入口校验重复 ID、悬空连线和分组循环，保留合法的未知 JSON 字段。`batch` 全部校验成功才提交，产生一条历史。`expectedRevision` 防止旧调用覆盖新状态；只读会话拒绝编辑和历史恢复。最多保留 100 个 JSON 历史快照，媒体不复制到内存历史。

`getSnapshot` / `subscribe` 供 UI 或其他适配器订阅；`undo` / `redo` 与手工、Agent 命令共用历史。选择与拖动预览属于 UI，不能写进另一份作品状态。

`dirty` 表示作品与最后保存快照不同，`saving` 表示持久化回调正在执行。并发 `flushSave` 共用队列；保存中新增修改会继续保存最新版本。写入失败保留 dirty、内容与错误，调用方必须向用户呈现。`dispose` 不代替保存；切换前必须等待保存成功，失败时保留原会话。

文本文件和插件业务留在调用方。React 控制器为正文创建不可变版本文件，再通过同一会话更新引用；撤销恢复旧引用。路径授权、原子写入、文件锁与 SHA 冲突仍由既有工作区服务负责。
