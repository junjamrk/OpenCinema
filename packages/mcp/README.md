# @toonflow/mcp

OpenCinema Studio 的官方 MCP SDK 薄适配层。HTTP MCP、工作区、文件、媒体与插件业务统一由 `apps/server/go` 实现；本包不包含 Express 服务端。

`bun run --filter @toonflow/mcp build` 显式构建 React 单文件 Widget、stdio 适配器与 `build/mcp/widgetResource.json`。资源文件包含 HTML `contents`、与 React 工作台共用的工具输入/输出 Schema、annotations 和 `renderToolMeta`，由 Go 在启动时读取。HTML 内容 hash 构成资源 URI；Go 给普通业务入口附加 `{target,args,operationId?}`，提供 `renderOpenCinema` 和仅供界面使用的 `openCinemaTransport`。`getAppState`、Host 请求箱等入口按各自实际 Schema 调用。

Widget 与完整 React 工作台在同一文档中运行，API 请求、上传、二进制和进度流通过官方 MCP Apps bridge 传输。会话绑定工程目录，关闭前等待工作区保存；取消请求不自动重发结果未知的写操作。选择更新模型上下文，底部显式发送才通过 SDK `sendMessage` 发到当前对话。每次发送固定目标，消息接收与任务完成分开，任务输出使用节点工具公布的 `taskId` 契约写回。

独立插件 `packages/openCinema` 管理 Go 实例与租约；stdio 本身只读取本机私有运行信息，通过 SDK Streamable HTTP 转发工具与资源，保留结果 `_meta`、取消信号和错误状态，不解释或伪造任务回执。

普通 Web 的执行宿主先调用 `registerHost`（`args` 包含 `name`、工程 `directory`、实际支持的 `requests`，普通编辑为 `["edit"]`），保存返回的 `id` 为 `sessionId`；持续以 `pollHostRequests` 领取请求并续期 60 秒租约，建议每 20 秒轮询，长任务期间也续租。按 `requestId` 去重，先用 `completeHostRequest` 报告 `running`，再按照请求冻结的上下文调用真实画布/节点工具、保存并回读，最后回填真实终态和结果。进度支持字符串或 JSON 对象；网络中断或租约过期不能当成远端已停止，不重建请求替代查询。

`pollHostRequests` 按创建时间/ID 稳定排序，`cursor` 绑定 session、队列 `queryRevision` 与 max，单页最多 64 KiB。超大单项返回 `inputOmitted:true/readTool:getHostRequest`；未取得完整冻结上下文前不执行。`getHostRequest` 按 input/prompt/context/metadata/result 分段读取 JSON UTF-8，`content` 沿 nextOffset 续读并携带 contentRevision，全部拼接后再解析。原租约过期可用原 sessionId/requestId 只读查询，返回 session:null/leaseExpired:true，不续租或复活旧请求。大完成回执同样用 resultOmitted 标明省略，原结果可聚焦读取。

Go 或 stdio 在线不等于普通 Web 的 Agent 在线。原生 Widget 的输入由 SDK `sendMessage` 直接交给当前宿主对话，不需要另注册一个轮询 Agent；消息接收与实际执行完成仍分别处理。

```sh
node build/mcp/stdio.js --runtime /absolute/path/runtime.json
```

运行信息 `{pid,url,token,revision?,instanceId?}` 必须属于当前用户且权限为 `0600`，地址只能指向本机 `/mcp`，进程必须存在。也支持 `--url https://example.com/mcp --token-env OPENCINEMA_MCP_TOKEN`，令牌从指定环境变量读取。stdout 仅输出 MCP 消息，错误写入 stderr；业务调用失败不自动重试。连接远程实例必须使用 HTTPS。

Agent 先调用 `getAppState`，用明确的 `target.connectionId/directory/canvasId` 定位实时画布。画布、节点与工作区扩展通过同一 React runtime provider 执行；Go 在线时仍可能没有可用 provider。没有连接时解释如何打开同一 Widget 或 React Web，不以后台改文件替代实时工具。

节点能力通过 `getNodeTools` 发现，工作区扩展通过 `getWorkspaceTools` 发现；动态调用须带回发现回执的 `toolCatalogVersion`。发现包含实际输入 Schema、可选输出 Schema 和 annotations，具体插件结果由 runtime 按其 Zod 输出声明校验。第三方插件未声明时保留未知，不能编造输出。静态顶层工具沿 `listWorkbenchTools → widgetResource.json → Go → stdio` 发布；动态专业工具沿 plugin runtime 与发现回执发布，二者不是另建的 registry。

Go 协商 MCP `2025-03-26`、`2025-06-18`、`2025-11-25`，其他请求版本回应 `2025-11-25`，客户端需确认接受；没有声明 MCP Tasks。`getAppState` 返回支持版本、provider 必要性和可用性摘要，避免默认复制完整工具 Schema。SDK 适配层保留实际协商，不因当前 Tasks 文档而发布未实现的 wire 行为。

| 字段 | 作用 |
| --- | --- |
| `runtimeRevision` | 实际运行构建的身份 |
| `documentRevision` | 当前编辑会话修订；写画布时传为 `args.expectedRevision` |
| `toolCatalogVersion` | 动态工具发现与调用的版本绑定 |
| `fileRevision` | 文件或目录快照的冲突保护 |
| `queryRevision` / cursor | 分页连续性与失效保护，不能当作编辑修订 |

普通成功 `structuredContent` 为 `{result:...}`，顶层 `outputSchema` 描述此包装；动态插件 `outputSchema` 描述具体函数原始结果。业务失败为 `isError:true`，错误详情在 `{error:{code,message,phase,target,executionState,recovery,...}}` 中保留。只根据稳定机器码与恢复动作决定下一步；派发后未知不当作未执行。annotations 说明只读、破坏性、安全重放和外部访问提示，权限继续由服务端与既有编辑会话校验。

供应商状态仅给脱敏配置摘要（如 `credentialsConfigured`）；这不等于鉴权已通过、已授权收费或生成可执行。Host `requestId`、通用工具 `operationId` 与专业任务 ID 各自保留，不相互替代。

创建、复制、文件写入、导出等按工具要求提供外层 `operationId` UUID；同一次写调用的重试保持 ID、目标、参数完全一致。`getOperation` / `cancelOperation` 的原 ID 则放在 `args.operationId`，并带原 `target.directory`。操作记录冻结执行目标，保存在本机 data 目录，不自动重放或过期；重启时未收尾为 `unknown`，当前最多 10000 条。已发现且目录版本一致、`readOnlyHint:true` 的动态函数直接读取实时状态，不要求 ID、不重放旧轮询；未知或写 broker 保守要求 ID。

通用操作状态的 `scope:"toolInvocation"` 观察一次工具调用。工具返回专业异步 `taskId` 时，另按插件状态、产物及取消契约追踪。`accepted/running/completed/failed/cancelled/unknown`、`cancelRequested` 和 `executionSettled` 各自保留含义；取消等待不能证明后台已停止，unknown 时查询原 ID 与实际目标后再决定重试。

`workspaceFiles` 按 action 公布强类型字段。`list` 和 `readText` 分页，分别沿 `nextCursor` / `nextOffset` 续读。`stat`、读取和写入回执提供 `fileRevision`；写入默认仅新建，覆盖须 `exclusive:false` 加旧修订，改名和删除同样带旧修订。画布 JSON 仍禁止经文件工具修改。大文本和二进制上限以运行时 Schema 为准，文件字节不默认注入上下文。

本机媒体 `importMedia` 使用明确来源绝对路径 `sourcePath`、工程内目的 `path` 和外层 `operationId`，流式排他复制最多 100 MiB 的可识别图片/视频/音频；保留来源，不传整段 base64，不上传远端。

`readWorkspaceImage` 返回真正的 MCP image block 及 `fileRevision`、源图和返回图尺寸，默认最长边 1024 像素缩略图，可选 64–2048；支持 PNG/JPEG/GIF，源图最多 20 MiB / 32 MP / 16384 像素边长，返回图最多 4 MiB。其他格式先用已有媒体工具导出 PNG；视频读取插件已输出的关键帧路径，不假称能任意时刻解码。路径或 base64 文本不是图像观察，坐标按源图尺寸换算，源变更后重新读取选区。

Codex 原生 Widget、Claude Code 工具调用和 Claude 可视化宿主分别验收。[Claude Code 官方文档](https://code.claude.com/docs/en/mcp)说明本地 stdio 与 image tool results，并在普通资源列表隐藏 MCP Apps UI 资源；这不能证明 Code 可渲染 Widget。Claude Code 可使用同一已连接 React Web provider。安装兼容 manifest、构建或普通 HTTP 往返均不能代替真实登录宿主的工具、保存及回读证据。
