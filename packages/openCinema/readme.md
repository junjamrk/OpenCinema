# OpenCinema Studio 0.4.0

独立 Go 服务端与 React 工作台，通过标准 MCP 将画布、节点和插件接入当前宿主 Agent，并为支持 MCP Apps 的宿主提供可选界面。标准入口是 `plugin.json` / `mcp.json`，同时提供 Codex / Claude 兼容入口。MCP 连接名为 `openCinemaStudio`，与旧版 `openCinema` 连接隔离。

在仓库根目录显式执行 `bun install`、`bun run build`，将 `build/openCinema` 作为插件安装包。产物包含当前平台 Go 二进制、Web、单文件 Widget、14 个内置插件发行包及已打包的 stdio SDK 适配器；运行需要 Node.js 22 或更新版本，不在插件启动时安装依赖，也不启动旧 TypeScript 服务。构建包只适用于构建机的平台与架构。

## 从完整发行包开始

需要Node.js22+。解压与本机系统／CPU匹配的完整ZIP，然后以包含start.js的openCinema目录作为插件根目录，不在缓存中安装开发依赖：

```sh
claude plugin validate /绝对路径/openCinema --strict
claude --plugin-dir /绝对路径/openCinema
```

调用 /opencinema:opencinema 后，先getAppState并指定已有工程。Claude Code需要同一实例的React Web provider；不把工具连接等同于可视化Widget挂载。源码开发者也可从仓库根的Claude marketplace安装已构建的build/openCinema。

供应商凭据、FFmpeg和模型运行环境均由用户明确配置，归档不含个人工程或API Key。随包thirdPartyNotices.md、licenseCatalog.json及licenses/保留第三方许可；后者是本机安装依赖的保守集合，不是精确bundle归因。

本地 Codex marketplace 的安装标识是 `opencinema@openCinemaStandalone`。先构建再注册仓库 marketplace；安装与启用、宿主实际加载工具、Widget 实际连接分别核验。旧扩展不需要覆盖或卸载。

0.4.0 新增画布偏好、FFmpeg 配置和供应商管理 API，必须由同一发行构建的 Go 与 React 一起运行。启动器只复用完全相同的后端 revision；已有旧版实例须正常释放租约后才能升级，不能仅替换 Widget 声称新能力可用。不会终止其他聊天、抢锁或切换用户数据目录。

默认无需环境变量。启动器将运行资源按完整产物的 SHA-256 revision 复制到独立数据目录的 `runtimeBuilds/<revision>`，再自动启动或复用同版本及明确兼容的 Go 实例。macOS 默认目录为 `~/Library/Application Support/openCinema/standalone/data`；Windows 使用 `%LOCALAPPDATA%/openCinema/standalone/data`；Linux 使用 `$XDG_DATA_HOME/openCinema/standalone/data`（缺省 `~/.local/share`）。`OPENCINEMA_DATA_DIR` 可设为另一个绝对路径。用户工程仍由 `renderOpenCinema` 的 `directory` 明确指定，不自动导入或迁移旧工程。

Go 仅监听本机随机端口。运行信息 `runtime.json` 和 `.runtimeLock/owner.json` 仅当前用户可读写；启动器核对 PID、instanceId、revision 与运行信息路径后复用，不终止其他版本。Go 进程崩溃或被强杀后，下次启动由 Go 确认持有者已退出再回收残锁；无法确认或上次退出时后台任务未收尾的锁不会自动回收。每个 stdio 连接持有独立租约，每 20 秒续租；所有连接结束或租约过期后，由 Go 延迟安全退出。多聊天共享同版本实例，单个聊天关闭不会终止其他聊天的实例。

如需连接已启动的外部实例，设置 `OPENCINEMA_RUNTIME` 为其运行信息文件的绝对路径。该文件须属于当前用户且权限为 `0600`，地址只能指向本机 `/mcp`。显式外部模式不启动 Go、不持租约，也不终止外部进程。配置中不填写令牌。

Widget HTML 按最终内容 hash 生成资源 URI，完整 React 工作台在同一沙箱内加载，通过 app-only `openCinemaTransport` 访问 Go API，无需本机 HTTP iframe。受管模式由当前 stdio 发布已校验的 Widget 资源，仅替换渲染工具的资源声明；业务 Schema、目录版本、授权和执行结果仍由真实 Go 返回，`getAppState.runtimeRevision` 始终指后端构建。响应和短期会话在 `_meta` 中传输，真实控制令牌留在本机。底部输入通过 SDK `sendMessage` 发给当前宿主对话并固定本次目标；`accepted` 仅表示宿主收到消息，结果仍需通过真实节点工具和 `taskId` 写回。保存、历史、协作和插件权限继续由工作台处理。

普通 Web 的宿主接入使用同一 MCP：Agent 先 `registerHost`，在 `args` 中声明名称、工程绝对目录及支持的请求类型（画布编辑为 `requests:["edit"]`），将返回的 `id` 作为后续 `sessionId`。租约默认 60 秒，可显式设为 60–900 秒整数；交互审批建议 300 秒，仍每约 20 秒调用 `pollHostRequests` 续租。按 `requestId` 去重，先以 `completeHostRequest` 报告 `running` 和可选进度，再按冻结目标编辑、保存和回读；完成后用同一请求 ID 回填 `completed/failed/cancelled`，text 为完成摘要，result 为结构化结果。重复轮询不重复执行，取消或网络异常保留真实状态与原 ID。

Go 自动启动只提供运行服务，普通 Web 仍需要上述实际在线 Agent。原生 Widget 使用当前宿主对话直接接收 SDK 消息，无需再注册另一个轮询 Agent；两种入口共享真实画布工具与保存边界。

所有画布、节点与工作区插件工具仍需要真实 React runtime provider；Go 不另起画布执行器。先读 `getAppState` 固定连接、工程和画布，再发现实际函数。静态顶层工具与动态插件发现分别公布输入/输出 Schema 和 annotations；插件声明的输出由 runtime 实际校验。未知第三方输出保持未知。

Go 支持协商 MCP `2025-03-26`、`2025-06-18`、`2025-11-25`；不支持的请求版本回应 `2025-11-25`，由客户端判断是否接受，服务不声明 MCP Tasks。`getAppState` 公布支持版本、provider 必要性和能力摘要；构建身份与宿主实际协商仍分别核对。

作品写入用 `documentRevision → args.expectedRevision`，动态调用带发现的 `toolCatalogVersion`，文件覆盖/改名/删除用 `fileRevision`，构建身份用 `runtimeRevision`；`queryRevision` 和 cursor 仅管理分页。四类版本不能互换。文件写入默认只新建，画布文档只能使用既有画布命令。

有重复副作用的调用使用外层 `operationId` UUID，同 ID、目标和参数重放原记录；超时先 `getOperation`，不能换 ID 重做。已发现且目录版本一致的只读动态函数直接读取实时状态，不要求 ID、不缓存轮询。`cancelOperation` 只请求停止等待与控制调用，专业后台任务仍按节点状态/取消函数追踪。通用记录观察工具调用；媒体任务终态还须真实产物、必要写回、保存及回读。

`readWorkspaceImage` 返回真正的 MCP image 内容和源尺寸、文件修订；文字路径与 base64 不算图像观察。默认读少量缩略图，视频使用插件已导出的关键帧。图片/音视频/Motion 等草稿工具与用户编辑台共享状态，读取、修改、采用和保存分别遵守各插件契约。

随包 Skill 使用短入口，按需加载 [工具与恢复契约](skills/openCinema/references/toolContract.md)和[宿主接入](skills/openCinema/references/hostModes.md)。专业参数始终实时发现，不将内置插件的全部 Schema 放入启动上下文。

原生验收先确认实际工具存在，再调用 `getAppState`、`renderOpenCinema`，读取所选节点并验证实际操作和保存。构建、安装成功或手工 stdio 连接不代表原生 Widget、媒体供应商或协作已经验收。

Claude 包装使用 `.claude-plugin/plugin.json` 和 `.mcp.json` 的 `${CLAUDE_PLUGIN_ROOT}`；Codex/通用入口使用 `mcp.json` 的 `${PLUGIN_ROOT}`，构建后均指向同一 `start.js`。加载 `build/openCinema` 发行目录；源码入口与兼容 manifest 不代表宿主操作已验收。

[Claude Code MCP 文档](https://code.claude.com/docs/en/mcp)确认本地 stdio、标准 image tool results，并隐藏普通发现中的 UI 资源；Code 可使用同一 React Web provider。Claude 可视化产品的 Widget 支持仍须按具体产品和版本实测。原生验收、工具/CLI验收和付费供应商验收各自记录，不能互相代替。其他参考：[OpenAI 插件文档](https://developers.openai.com/plugins/build/plugins)、[MCP Apps UI](https://developers.openai.com/plugins/build/chatgpt-ui)、[Claude 插件清单](https://code.claude.com/docs/en/plugins-reference)。
