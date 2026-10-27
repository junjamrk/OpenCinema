# 宿主入口与验收

Codex、Claude 和其他 MCP Agent 共用 Go 服务、React runtime 和同一插件业务。通用 AI 由当前宿主提供。服务在线、工具可用、专业渲染可执行和 Widget 已挂载是不同状态。

当前 Go 协商 MCP `2025-03-26`、`2025-06-18`、`2025-11-25`，其他请求版本回应 `2025-11-25`，客户端仍须确认接受；服务不声明 MCP Tasks。`getAppState` 的 `protocolVersions`、`providerRequired` 和 `availability` 说明运行条件；不假定 latest 文档中的 Tasks 或逐请求能力已实现。

## Codex 原生 Widget

先确认当前聊天实际发现 `openCinemaStudio` 的工具，再调用 `getAppState` 核对 `runtimeRevision` 与连接。宿主支持 MCP Apps 时，`renderOpenCinema` 打开明确的已有工程。不能从已安装、资源 URI 或 HTTP 页面推断 Widget 已打开。

Widget 选择更新上下文；底部显式发送通过 SDK `sendMessage` 进入当前聊天并冻结当次目标。`accepted` 仅为消息接收，不代表节点修改或保存。原生链路分别取得界面选区、当前聊天消息、实际修改、保存和回读证据，无需再注册另一个轮询 Agent。

无新工具或 `connections:[]` 时如实说明。按宿主正常入口连接或重载插件；不改 cache、不转发旧工具、不使用私有 IPC、假宿主或普通浏览器冒充原生挂载。

## Claude Code 与可视化宿主

本插件用 `.claude-plugin/plugin.json` 加 `.mcp.json` 发布同一 stdio 入口与 Skill。安装或本地加载使用**构建后的** `build/openCinema` 目录，入口为 Node 的 `start.js`，不把源码 `start.ts` 当作发行入口。环境需 Node.js 22+。

[Claude Code 官方 MCP 文档](https://code.claude.com/docs/en/mcp)说明本地 stdio 与 image tool results。`readWorkspaceImage` 的标准 image block 可供该宿主感知；实际可用仍需在真实登录会话调用验证。只校验 manifest 不算验收。

Claude Code 会在普通发现列表隐藏 `ui://` / `text/html;profile=mcp-app` 资源；这不能证明它能渲染 OpenCinema Widget。Claude Code 工具联调使用同一已连接 React Web provider。Claude 可视化产品需另核对具体产品和版本，再验证实际 Widget；其他 Claude 产品的 interactive connector 文档不能替代 Code 的能力证明。

分别核对独立 CLI 与桌面端 Code 会话的实际登录和工具状态；桌面已登录不代表独立 CLI 已登录，CLI 未登录也不能替代对桌面会话的检查。登录失败时保留对应宿主原始错误，不替用户登录或改认证目录；另起 app-server 或直接 HTTP 结果不能算作真实 Claude 执行。

## 普通 React Web 的宿主 Agent

仅启动 Go 或建立 MCP 连接，不代表 Web 的 Agent 在线。作为实际宿主，先发现所需工具，再调用 `registerHost({args:{name,directory,requests:["edit"],leaseSeconds:300}})`，保存返回 `id` 为 `sessionId`。`leaseSeconds` 是 60–900 的整数，新会话省略时为 60 秒；需要交互审批的 Claude 会话建议 300 秒，以免首次工具许可和模型思考耗尽短租约。按实时 Schema 调用，不向旧后端传未公布字段。持续 `pollHostRequests({args:{sessionId}})` 领取请求并按返回的 `leaseSeconds` 续租，仍建议每 20 秒轮询，长任务执行中也续租。普通节点和保存工具不续 Host 租约。

请求箱按创建时间和 ID 稳定分页，沿 `hasMore/nextCursor` 续读，`queryRevision` 只保护该次队列读取。单页最多 64 KiB；`inputOmitted:true` 表示正文/固定上下文未返回，必须先用 `getHostRequest` 读取对应 `section`，不能拿摘要执行。该工具返回 `encoding:"jsonUtf8"` 的 `content` 分段，沿 `nextOffset` 并带回 `contentRevision`；拼接全部段后解析 JSON。`inputRevision` 绑定原冻结输入，结果分段另有自己的内容修订。原租约过期仍可用原 `sessionId/requestId` 只读查询，返回 `session:null/leaseExpired:true`；这不会续租、复活请求或允许旧会话回填。

按 `requestId` 去重，使用请求冻结的 `context/metadata` 和节点范围。先以 `completeHostRequest` 报告 `running`，再读取真实目标、执行、保存和回读，最终使用相同 ID 回填 `completed/failed/cancelled` 与实际结果。`progress` 可为字符串或 JSON 对象。重复轮询到运行中请求不能再次执行。

`cancelRequested` 仅为请求；专业执行状态未知时保留原 ID，不能直接报告取消完成。租约过期、网络异常或宿主消失均不能证明远端副作用已停止。Host 的 `requestId`、通用工具 `operationId` 与专业任务 ID 分别跟踪。

## 启动、升级与凭据

默认启动器只复用同一发行构建的本机 Go 实例并持有独立租约，React provider 仍须通过真实 Widget 或 Web 连接。0.4.0 新增配置 API，不兼容仅升级 Widget 的旧 Go；其他活实例持锁时保留其连接，等待正常释放，不抢锁或强停。`getAppState.runtimeRevision` 保留真实 Go 构建；以实际资源 URI 和 MCP serverInfo 分别核对 UI 与适配器身份。`OPENCINEMA_RUNTIME` 只连接明确外部实例，不管理其生命周期，也不替换其 Widget 资源。配置中不嵌入令牌。

升级后让宿主正常加载新入口；兼容实例保留旧聊天的连接，不兼容实例待原租约正常释放退出后再接入。保留数据目录与工程，不杀其他聊天进程、抢锁或更换 data 目录绕过冲突。

验收只使用已授权的隔离工程；不重新创建或导入原工程。供应商密钥、收费媒体生成、上传与部署需对应授权。构建、安装、CLI 工具调用、普通 Web 和原生 Widget 分项报告。
