# 工具契约与恢复

先读实时工具 Schema；本页说明字段之间的关系，不替代插件发现结果。

## 固定目标与版本

业务入口通常接收 `{target:{connectionId,directory,canvasId},args:{...},operationId?}`。`directory` 为工程绝对目录，画布、文件和素材路径为工程内相对路径。`getAppState` 等少数工具有独立输入；以该工具实际 Schema 为准。导航的目的画布和当前 `target.canvasId` 不混用。

| 字段 | 正确用途 |
| --- | --- |
| `runtimeRevision` | 已运行发行构建的身份；用于核对实际加载版本 |
| `catalogRevision` | 扩展工作台静态操作目录的 SHA；`getWorkbenchTools` 分页与 `workbenchTools` 调用时带回，不代替作品或插件修订 |
| `documentRevision` | 当前编辑会话的作品修订；画布写入传为 `args.expectedRevision` |
| `toolCatalogVersion` | `getNodeTools` / `getWorkspaceTools` 的发现版本；动态调用原样带回 |
| `fileRevision` | 文件或目录快照身份；覆盖、删除、改名使用读取到的值 |
| `sourceRevision` / `currentSourceRevision` | 图片、音视频源素材的分段读取身份；绑定草稿/选区并检测同路径覆盖，不能代替内容 SHA |
| `queryRevision` / cursor | 分页失效保护；继续同一次查询，不能当作编辑修订 |
| 专业资源 `revision` / `draftRevision` | Blockout、Director、编辑草稿等所属资源的冲突保护；按该插件 Schema 使用 |

每次请求冻结工程、连接、画布、节点和相关版本；用户后来切选区不能改变在途请求目标。目录变更先重新发现，冲突先读取实际修订。无画布的文件或工作区插件操作不硬塞无关的作品修订。

## 输出和错误

普通 MCP 成功结果的 `structuredContent` 是 `{result:...}`；静态工具 `outputSchema` 描述该包装。动态插件发现的 `outputSchema` 描述具体函数的原始结果，由插件 runtime 实际执行 Zod 校验。缺少声明的第三方工具不能被当作已有精确输出契约。

业务失败保留 `isError:true`，详情包含 `code`、`message`、`phase`、`target`、`executionState` 与 `recovery`；冲突可带 `actualRevision` / `expectedRevision`，目录失效可带实际 `toolCatalogVersion`。按机器码与恢复动作处理，不匹配中文文本来猜能否重试。

宿主请求的 `requestId` 与通用 `operationId` 分别保留。提供商配置只读取脱敏字段（如专用配置工具的 `credentialConfigured`，以实际 Schema 为准）；已配置凭据不表示供应商鉴权、预算、收费授权或真实生成已经通过。

`notDispatched` 可按恢复建议修正；派发后的 `unknown` 先查原操作。`invalidToolResult` 表示执行已经返回而结果不符合声明，不能自动重做有副作用的操作。`annotations.readOnlyHint`、`destructiveHint`、`idempotentHint` 和 `openWorldHint` 是发现提示，服务端仍执行真实授权。

## 本地 ComfyUI 连接与工作流

通过 `getWorkbenchTools` 搜索 `LocalVideoConnection`，按同一 `catalogRevision` 调用三个扩展操作。`getLocalVideoConnection` 只读非秘密连接与独立 `configRevision`；`setLocalVideoConnection` 仅允许修改 `enabled` 和明确的本机／局域网 ComfyUI `endpoint`，传入该配置修订和外层稳定 `operationId`。端点不允许凭据、查询令牌、公网地址或 shell；保存连接不发起推理。

`inspectLocalVideoConnection` 按 `expectedRevision` 访问已配置服务，返回实际系统和每个已导入工作流缺少的节点。`ready` 只说明服务可用且节点齐全，模型文件和显存在提交时由 ComfyUI 校验。

ComfyUI 工作流是 `comfyui` 供应商的模型。启用连接后，它和其他模型一样出现在节点 `getConfig`，用 `generateImage`、`generateVideo` 或 `generateAudio` 生成，生成请求不能携带工作流。工作流会在 ComfyUI 上执行，只能由用户在设置页导入。`setProviderModels` 可以改名或移除已有工作流，新增或修改图会被拒绝，`manageMediaProviders` 也不能通过清单写入工作流。

## 统一视频 Provider

视频节点 `generateVideo` 可同时接收 `providerId`、`modelId`、prompt 与模型支持的参数，也可沿用配置。先 `getConfig` 读取 execution、参考模式、时长／分辨率／音轨能力；目录存在不等于真实生成已验证。视频 `getGenerationStatus` 可能恢复原任务观察和产物回收，按实时 annotations 提供外层 operationId，不重发生成。`resultReady` 用 `applyGenerationResult` 核对原节点绑定后采用；失败与 unknown 保留 taskId。`cancelMode:none` 不代表能够停止远端 GPU。供应商配置沿既有授权和凭据保密边界。

## 原视频转深度白模

从实时 `getCanvas` 节点目录发现视频深度白模（`videoDepthNode`），接入一路普通 RGB 视频，再通过 `getNodeTools` 查询实际工具。`getDepthModel` 只读真实依赖；未准备时显式调用 `prepareDepthModel` 并查询原准备状态，它会下载固定 Small 权重、源码并准备独立 Python 环境，不上传原片。不要在用户只要求连接 H3 时顺带下载或运行其他模型。

`setDepthSettings` 设置开始、结束秒数与整数采样率；内层 `expectedRevision` 取自 `getDepthStatus.revision`，外层画布修订和目录版本沿实时发现回执。当前支持不超过 30 秒、2–12 fps、最长边 384 的本地相对逆深度，非米制测距；不把旧单图 Depth Anything 或纯去色当作 Video Depth Anything 时序结果。

`runDepth` 返回已登记的专业 `operationId`，不等于结果完成。沿 `getDepthStatus` 查询同一任务；成功且执行已收尾后，`applyDepthResult` 核对原片 SHA、完整清单及产物 SHA，采用到节点并保存。随后再调用 `saveWorkspace`，回读输出和文件。`cancelDepth` 只取消原任务，必须确认 `executionSettled:true`；取消后已采用的旧结果保留。未知终态不换 ID 重派。修改范围、撤销、删除或切换画布都须等原任务确认收尾。

## operationId 与专业任务

需要防重复副作用的调用在外层传 UUID `operationId`。同 ID、同工具、同目标和同参数返回原记录；换参数需先确认原操作状态，再作为新意图使用新 ID。不要为了绕过冲突、未知或取消状态更换 ID 重试。

`changeCanvasHistory` 每次撤销或重做一步都必须带外层 `operationId`，即使只操作当前会话的历史。回执丢失时同 ID 重放只回读原结果，不会再移动一步历史；只有用户或 Agent 明确要再执行一步时才创建新 ID。先读取当前 `documentRevision` 并按实时 Schema 调用，结果未知先查 `getOperation`，再用 `getCanvasHistory` 和画布/节点读取确认当前历史位置，不能换 ID 试探。

`getOperation({target:{directory:原工程目录},args:{operationId:原ID}})` 返回冻结目标、`status`、`result/error`、`cancelRequested`、`executionSettled` 和持久化范围。此处 ID 在查询的 `args` 内；发起写操作的 ID 在工具参数外层。记录保存在本机 data 目录，不自动重放或过期；服务重启后未收尾的记录为 `unknown`，目前最多 10000 条。

`cancelOperation` 请求停止等待和 React 控制调用；已经派发的专业后台任务仍应调用插件公布的 cancel，再查询真实状态。仅有 `cancelRequested:true` 或 `executionSettled:false` 不能报告“已取消完成”。

通用操作记录的 `scope:"toolInvocation"` 只证明工具调用结果。若结果启动了异步媒体任务，还要继续按插件返回的 `taskId` / 专业 `operationId` 查询产物与写回。Go 从真实发现回执绑定目标、目录版本和 `annotations.readOnlyHint`：已发现的只读 broker 调用读取实时状态，不要求 ID、不重放旧观察；未确认只读或写函数保守要求外层 ID。版本过期先重新发现，不靠换 ID 绕过。

## 文件与真实图像感知

`workspaceFiles` 的 `action` 逐项有 Schema：`list`、`stat`、`readText`、`readBinary`、`mkdir`、`importMedia`、`remove`、`rename`、`writeText`、`writeBinary`。先列目录或读取明确路径；`list` 按 `hasMore/nextCursor` 续读，`readText` 按 `hasMore/nextOffset` 续读并带回 `fileRevision`。偏移是解码后 UTF-8 字节位置，直接使用回执。

本机大媒体使用 `importMedia`：明确来源绝对路径 `sourcePath` 和目标工程相对路径 `path`，提供外层 `operationId`；流式复制最多 100 MiB 的可识别图片/视频/音频，目标排他新建，保留来源，不上传远端。

`stat` / 读取返回 `fileRevision`。写入默认 `exclusive:true` 仅新建；覆盖显式 `exclusive:false` 并传旧 `fileRevision`，删除和改名同样需要该修订。画布文档只能通过实时画布命令编辑，不能用文件工具绕过历史、协作或草稿。

`readWorkspaceImage` 接收真实工作区 `path`，可带 `fileRevision`，默认 `mode:"thumbnail"`、`maxDimension:1024`。返回 MCP `content` 中的 `type:"image"` 与元数据，才能对图像内容作观察结论。元数据同时给出源文件内容 SHA `fileRevision` 和与 range 读取一致的 `sourceRevision`：后者与 getDraft 的源身份对应，前者用于文件覆盖保护；两个值不能互换。路径、文件字节 base64 文本或导出清单不等同于看见图像。

当前支持 PNG/JPEG/GIF；其他格式先使用已有媒体工具导出 PNG。源图最多 20 MiB / 32 MP / 16384 像素边长，单次返回图像最多 4 MiB；缩略图可选最长边 64–2048 像素。先少量缩略图，需要局部细节再按真实素材处理。元数据给出 `sourceWidth/sourceHeight` 和返回的 `width/height`；坐标还原到源图像素，专业草稿的归一化坐标按其 Schema 转换。源图变化后重新读取和建立选区。

getDraft 同时读取 `sourceRevision`、`currentSourceRevision` 与 `draftRevision`。setDraft 按实际 Schema 带回明确源版本；采用/剪辑前后沿同一源身份复验。若同路径已被覆盖，保留草稿并拒绝使用旧选区，不能把新源图套到旧蒙版或裁剪坐标上。

视频先读元数据和插件已输出的关键帧相对路径，再对指定帧调用图像感知；不假称此入口能够任意时刻解码完整视频。产物路径与源节点、时间位置之间的关系以该插件结果为准。
