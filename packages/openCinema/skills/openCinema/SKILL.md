---
name: opencinema
description: 通过 Codex、Claude 等 MCP Agent 操作已有 OpenCinema 工程、节点和插件，发现真实能力并验证编辑、媒体任务与保存结果。
---

OpenCinema Studio 的 MCP 连接名为 `openCinemaStudio`。Go 提供服务与文件保护；画布和插件调用需要同一 React runtime provider。

先调用 `getAppState`，固定已打开工程的 `directory`、`connectionId`、`canvasId` 与实际节点 ID。复用用户工程；聊天输出目录不是创作工程。多个页面不猜目标。无连接时解释需要打开同一工作台；不直接改画布 JSON。

按需读取 `getCanvas` / `getCanvasNodes` / `getCanvasEdges`，沿返回游标分页。同一 connection 的画布和插件调用串行执行，避免与正在执行的控制命令冲突。写画布使用读取到的 `documentRevision` 作为 `args.expectedRevision`；查询游标、文件修订和工具目录版本各有用途，不能互换。

先 `getNodeTools` 或 `getWorkspaceTools`，再按发现的输入 Schema、`outputSchema` 和 `annotations` 调用 `nodeTools` / `workspaceTools`，带回该次发现的 `toolCatalogVersion`。专业参数、状态和取消函数实时发现，不预载全部插件 Schema。broker 整体可能写入或访问外部服务，不能据其名称推断只读。

`nodeTools.args.expectedRevision` 是外层画布数字修订；`nodeTools.args.args.expectedRevision` 按节点函数 Schema 解释，Director / Blockout 等函数可能要求专业资源字符串版本，必须从对应读取函数取得。不要把外层数字覆盖到内层资源版本；局部草稿和视图另有独立版本。

顶层保留打开界面与常用编辑入口。分组、排列、素材、供应商及插件管理等扩展操作先通过 `getWorkbenchTools` 发现；未知名称时用 `query` 按名称或描述子串搜索（忽略大小写），已知名称用 `names` 精确筛选。分页保留筛选条件与 `catalogRevision`，该修订仅绑定此目录。使用 `workbenchTools({target, operationId?, args:{name, catalogRevision, arguments}})`，`arguments` 按发现的 `parameters` 填写；写操作必须提供外层稳定 operationId。执行仍复用原操作的权限、文档修订、保存和恢复，不以目录版本替代原操作所需版本。

调用格式以实时 Schema 为准。创建、复制、撤销重做、文件写入及未确认只读的动态 broker 需要外层 `operationId` UUID；同一次写调用重试保持 ID、目标和参数一致。每次有意再撤销或重做一步才使用新的 ID。已发现且目录版本一致的只读函数直接读取实时状态，不缓存轮询。超时或断线先 `getOperation` 查询原写调用 ID；`unknown`、`cancelRequested` 均不能证明副作用停止。媒体任务另按插件的 `taskId` / 状态 / 取消契约核实产物。

修改、保存与回读分别取证。正文或专业草稿先读取并显式采用，再确认保存与真实产物；消息 `accepted`、工具调用完成、专业任务完成均独立。保存失败保留草稿，撤销重做复用同一历史入口。

需要向用户展示生成节点的完整编辑区时，先发现 `getNodeEditorView/setNodeEditorView`，按独立 `viewRevision` 展开并确认 `ready`，再调用节点的媒体或专业视图工具。音频 `getMediaView/setMediaView` 控制同一波形剪辑台；试听须确认 `clip.ready`。`getMediaDraft` 的 `history` 与手工撤销重做同源，音频 groups 非空时按组采用，`applyMediaDraft` 才实际处理并生成新文件；草稿仍是会话内存状态，`saveWorkspace` 不等于已采用草稿。

- 涉及版本、文件、图像感知、重试或错误恢复时，读取 [toolContract.md](references/toolContract.md)。图片必须通过 `readWorkspaceImage` 取得真正的 MCP image 内容；路径或 base64 文字不代表已看见图像。
- 接入 Codex Widget、Claude Code、普通 Web Agent 或升级插件时，读取 [hostModes.md](references/hostModes.md)。安装、工具连接、Widget 挂载与真实操作分别验收。

沿用户已有授权执行编辑。供应商收费、素材上传、部署、插件安装与凭据操作需要对应授权；当前移植验收不发起付费生成。不输出 API Key、控制令牌、会话票据，不通过另一套后端、直接写文件或操作宿主私有接口绕过连接、权限或冲突。
