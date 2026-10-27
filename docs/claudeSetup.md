# Claude 接入 OpenCinema Studio

适用版本：OpenCinema 0.4.0。标准 MCP 服务名 openCinemaStudio。先区分 Claude Code CLI、Claude 桌面端 Code、本地普通 Web 和可视化 Widget；工具、安装、界面、媒体任务与作品保存分别取证。

## 安装入口

从源码构建需要 Bun 1.3.14+、Go 1.26+；完整发行包运行需要 Node.js 22+。发行包的操作系统和 CPU 架构必须匹配本机，不需要运行时 bun install。

```sh
bun install --frozen-lockfile
bun run build
claude plugin validate ./build/openCinema --strict
claude --plugin-dir ./build/openCinema
```

上面最后一步仅当前会话加载插件。固定到当前源码工程：

```sh
claude plugin marketplace add ./ --scope local
claude plugin install opencinema@openCinemaStandalone --scope local
```

Claude 的本地路径使用 ./ 或绝对路径，CLI 不接受单独的 . 作为 marketplace source。只在当前工程安装，不改其他项目的插件设置。新会话加载，或在原会话通过官方 /reload-plugins 后重新发现工具。不要改插件缓存。

确认：
```sh
claude plugin validate ./build/openCinema --strict
claude plugin list --json
claude mcp list
claude auth status
```

这些是独立观察：插件校验不证明连接；Connected 不证明 Agent 已调用业务；CLI 登录与桌面端 Code 登录各自确认。没有登录时保留官方错误，不读取或复制认证文件。

## 在桌面端 Code 使用

在 Claude 的 Code 入口选择实际源码工程或创作工程。CLI 与桌面端共享的配置范围以宿主版本为准；可通过 + → Plugins／Connectors 管理已安装能力。仅看到技能或安装记录不代表 MCP 工具已加载。

先让 Claude 搜索 openCinemaStudio，再调用 getAppState。没有工具时查看同一会话的 MCP 服务和明确加载错误；不要用 Bash 内另建 MCP 客户端来冒充本会话原生调用。重新加载后仍缺失时，新会话必须重新发现，而不是从上次回复复制连接状态。

参考：[Claude 官方桌面端配置](https://code.claude.com/docs/en/desktop)、[插件本地加载](https://code.claude.com/docs/en/plugins/create)、[MCP 接入](https://code.claude.com/docs/en/mcp)。

## 已有运行实例与版本冲突

默认启动器只复用相同／明确兼容的运行包。其他聊天仍持有旧实例时，新包可能在 stdio 初始化前明确拒绝。保留其他连接、工程和锁，待原实例正常释放；不能强杀、删除锁、换一个数据目录逃避冲突或把新 Widget 接到不兼容 Go 上。

如果目的就是操作已经存在的实例，可在Claude插件的runtimeInfo可选配置中选择该实例，使用官方配置入口，不需要创建另一条同名MCP：

```sh
claude plugin install opencinema@openCinemaStandalone --scope local \
  --config 'runtimeInfo={运行信息绝对路径}'
```

该配置仅Claude包装使用；缺省为空，仍走默认受管启动。实际运行信息文件须本机0600且属于当前用户。只有打算连接既有实例时才填写，不把它当作兼容性校验的替代。

没有插件管理器的标准MCP客户端也可显式采用公开的外部模式。用真实路径替换示例中的大括号：

```sh
claude mcp add openCinemaStudio --scope local --transport stdio \
  --env 'OPENCINEMA_RUNTIME={运行信息绝对路径}' \
  -- node '{完整发行目录}/start.js'
```

该文件只在本机、属于当前用户且为0600，包含本机 /mcp 地址与控制信息；配置只引用路径，不复制令牌。启动器不管理外部实例生命周期。getAppState.runtimeRevision 必须保持真实后端版本，不能宣称外部旧实例等同于刚构建的新包。MCP tool schemas 与实际 React provider 能力仍实时读取。

需要移除这条明确的本地直连时：
```sh
claude mcp remove openCinemaStudio --scope local
```

此操作只移除该本地声明，不卸载其他插件或停止运行实例。

## 独立运行完整发行包

将匹配本机平台的完整 ZIP 解压，可用 `OPENCINEMA_DATA_DIR` 指定独立数据目录，不填写外部 runtimeInfo。独立实例不迁移旧数据目录；同一工程不要同时由两个实例编辑。

```sh
claude mcp add openCinemaRelease --scope local --transport stdio \
  --env 'OPENCINEMA_DATA_DIR={独立数据目录绝对路径}' \
  --env 'OPENCINEMA_RUNTIME=' \
  -- node '{完整发行目录}/start.js'
```

示例中的目录都须替换为真实绝对路径；在目标项目目录运行，以限定 local 声明范围。完整包无需安装依赖。建立该项目的新 Claude Code 会话后，发现 `openCinemaRelease` 并调用 getAppState 核对实际版本。Web 地址从该 data 的 `runtime.json` 中公开 url 字段取得，将 `/mcp` 换为 `/`；不输出或复制其中控制信息。打开同一实例的 React provider 后再操作。`/reload-plugins` 不保证已有会话重新发现新加的 local MCP server；多个入口并存时明确选择目标，不混用连接。

保留发行目录和 data 才可继续使用，临时解压目录不作为长期安装位置。需要持续接收底部指令时，宿主必须按租约轮询；停止 poll 后 Host 会自然离线。

## 操作与保存

先打开目标工程。画布编辑使用公开工具，不直接改画布 JSON。

1. 调用 getAppState，固定 directory、connectionId、canvasId、实际 runtimeRevision。connections 为空时，打开同一实例的 React Web 工作台；不能以任意另一端口页面代替。
2. 通过 getCanvas／getCanvasNodes／getCanvasEdges 读取节点，按实时 Schema 执行；插件函数先 getNodeTools，工作台扩展先 getWorkbenchTools。
3. 在明确范围内创建／编辑文本，单选／多选、分组和撤销重做；所有写入保留 operationId，并使用当时 documentRevision／toolCatalogVersion。未知先 getOperation。
4. 使用 saveWorkspace，随后从工具回读节点并只读核对工程磁盘快照。实际 UI 应看见相同正文、选区与保存状态。
5. Web 底部对话另需实际 Host：先发现工具，再由 Claude registerHost；实时 Schema 支持时为交互审批传 `leaseSeconds:300`（默认 60，可设 60–900 秒）。按返回 sessionId 每约 20 秒轮询续租；普通节点／保存工具不续租。领取冻结 requestId 后先回填 running，再编辑、保存、回读，最后用原 ID 回填 completed；text 填用户可读的完成摘要，result 填节点、文件、修订和保存结果，底部显示实际摘要。仅显示在线或消息 accepted 不代表处理完成；过期变为 unknown 时保留原请求，不自动换 ID 重派。详细协议在随包 Skill 的 hostModes.md。
6. 媒体流程先读现有视频／参考／计划和审片，播放真实产物；无明确生成授权时不发起收费任务。欠费明确拒绝不循环提交。

## 常见失败

| 现象 | 首要核对 |
| --- | --- |
| Not logged in | 当前被调用的 CLI 的官方 auth status；不要从桌面登录推断 CLI 登录。 |
| tools 缺失 | 同一会话实际加载的 plugin／MCP server，是否正确使用 build/openCinema。 |
| CONNECTION_CLOSED | 启动器 stderr、Node版本、同目录运行包冲突；不要先反复重装。 |
| connections:[] | 真实 React provider 是否打开、是否同一 Go 实例。 |
| 版本冲突 | 回读新修订和实际Schema，保留原operationId查询，不新派同一副作用。 |
| Widget 没出现 | 当前具体 Claude 产品是否支持并实际挂载该UI；Code工具通过不能替代。 |
