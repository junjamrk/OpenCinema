# OpenCinema Studio

**让 Agent 操作完整的视频创作工作台。**

[English](readmeEn.md) · [Claude 接入](docs/claudeSetup.md) · [开发与贡献](contributing.md) · [发行说明](docs/releaseGuide.md) · [变更记录](changelog.md) · [MIT](LICENSE)

OpenCinema 是面向 Codex、Claude Code 和其他 MCP Agent 的本地视频画布。宿主负责规划与对话；React 工作台负责作品、节点、媒体编辑和历史，Go 服务负责文件授权、持久化与任务。没有另一个必需的独立桌面端，也不在插件里重复实现通用聊天模型。

> 当前版本 **0.4.0，未正式发布**。可从源码构建，或使用维护者为相同操作系统／CPU 架构提供的完整发行包。

## 可以做什么

- **节点画布**：文本、图片、视频、音频与生成节点；多选、分组、连线、对齐、撤销重做、保存与协作入口。
- **专业编辑**：图片局部编辑台，音视频预览、截取、变速、关键帧和媒体信息；手工与 Agent 共用业务工具。
- **白模与动作参考**：Blockout 场景、Take、摄影机与完整预演；按镜固定 RGB／Depth 参考，视频深度白模与动作分析。
- **逐镜制作**：生成计划明确参考职责、请求槽位与源版本；候选审片、2–16 镜剪辑计划、局部换镜、音轨混合／替换与完整成片导出。
- **可扩展**：14 个内置节点／扩展发行包，公开节点与工作区工具契约，按需发现 Schema、执行状态与恢复方式。

画布是作品，不是模型连线样例。一次可靠操作包括：发现当前能力 → 固定目标和版本 → 执行 → 观察实际产物 → 保存 → 回读。技术任务完成不自动表示审片通过。

## 选择运行方式

| 入口 | 需要什么 | 说明 |
| --- | --- | --- |
| Claude Code 插件 | Node.js 22+、已登录的 Claude Code、完整发行目录 | 标准 MCP 工具；可视化依赖同一 React Web provider。 |
| Codex 插件 | Node.js 22+、支持插件的 Codex、完整发行目录 | 支持 MCP Apps 的宿主可打开原生 Widget，须实际确认工具和连接。 |
| 普通 Web + MCP Agent | Go Web 服务或发行启动器、浏览器、MCP 客户端 | 画布底部输入需要实际宿主接收与处理；仅打开网页不等于 Agent 在线。 |

Claude Code、Claude 桌面端的 Code 会话、claude.ai／Cowork 和 Codex Widget 的支持情况不可互相推断。详细步骤见 [Claude 接入](docs/claudeSetup.md)。

## 从源码启动 Web

需要 **Bun 1.3.14+、Go 1.26+**；运行插件另需 **Node.js 22+**。以下命令在仓库根目录执行：

```sh
bun install --frozen-lockfile
bun run build
bun start
```

打开 [本地工作台](http://127.0.0.1:47920)，选择自己的工程目录。已有画布保持原文件格式，素材位于工程内。构建不会安装模型、下载权重或发起媒体生成。

开发时先显式构建内置插件，再分终端运行：

```sh
bun run build:nodes
bun run dev:server
```

```sh
bun run dev:web
```

Vite 默认代理到本机 Go 的 47920 端口。每次修改源码后按对应包重新构建；开发服务不会悄悄安装依赖或运行检查。

## 在 Claude Code 使用

完整构建后，可只为当前会话加载：

```sh
claude plugin validate ./build/openCinema --strict
claude --plugin-dir ./build/openCinema
```

也可将此仓库注册为本地 marketplace，然后只在当前工程安装：

```sh
claude plugin marketplace add ./ --scope local
claude plugin install opencinema@openCinemaStandalone --scope local
```

旧运行实例仍由其他聊天使用时，可通过插件runtimeInfo可选项显式接入该实例，保持真实后端版本；详见[实例连接](docs/claudeSetup.md)。

加载后调用 `/opencinema:opencinema`，先让 Claude 读取 `getAppState`，再指定已有工程。未登录时，Claude Code 官方 CLI 的 `claude auth status` 会说明；桌面端登录不代表另装的 CLI 已登录。不要复制或共享认证文件。

插件使用 **build/openCinema**，不要把未打包的 packages/openCinema 源码目录当成 Node 发行包。安装后按宿主官方入口重新加载插件；不要改缓存、抢锁或强停其他聊天。

## 在 Codex 使用

在当前已完整构建的源码目录中：

```sh
codex plugin marketplace add . --json
codex plugin add opencinema@openCinemaStandalone --json
```

选择 **OpenCinema Studio**，确认实际存在 `openCinemaStudio` 工具，再读取 `getAppState`；支持 MCP Apps 时调用 `renderOpenCinema`。源码 marketplace 引用被 Git 忽略的 build/openCinema，所以**不能把源码 Git URL 当作无需构建的现成安装源**。面向新用户应分发完整平台归档，见 [发行指南](docs/releaseGuide.md)。

## 一次最小创作流程

1. 打开已有工程与画布，选择一个或一组节点。
2. 在底部输入创作要求。单选约束到该节点，多选约束到所选组；宿主按当次冻结目标执行。
3. Agent 读取实际节点和工具 Schema，再修改或提交已授权任务；节点与专业编辑台展示同一状态。
4. 播放真实候选，记录采用范围与审片结论。拒收保留原片；仅返修对应镜头。
5. 保存完整剪辑计划，处理逐镜阻塞，再导出新成片；保存并回读工程与实际文件。

更多：[镜头工作流](docs/videoShotWorkflow.md) · [视频供应商](docs/videoProvider.md)。

## 模型与可选工具

通用规划、文本和宿主具备的生成能力由宿主 Agent 提供。专用视频供应商及本地模型使用明确配置和授权；**Codex／Claude 登录不等于拥有所有视频模型或免费生成额度**。

- FFmpeg／FFprobe 用于本地处理，在设置中配置并确认实际可用版本。
- Video Depth Anything **Small** 是原视频转相对深度的独立处理链，需要 Python 3.10–3.12 和用户显式准备的运行环境／权重；不是普通灰度滤镜，也不随发行包附送权重。
- 白模 Depth 可作为参考媒体；供应商未声明专用 Depth Control 时仍是普通视频软参考，不能保证严格复现运动。
- 真实生成可能计费，需要用户自己的可用服务和凭据。凭据只在本机配置，不进画布、文档、日志或插件 manifest；欠费等明确拒绝不循环重试。

## 开发与架构

| 路径 | 职责 |
| --- | --- |
| apps/web | React 工作台、画布会话、宿主适配 |
| apps/server/go | Go HTTP／MCP、授权、原子文件与媒体任务 |
| packages/workbenchCore | 框架无关会话、命令与协议 |
| packages/nodeScaffold / nodeShared | 节点 SDK 与共享媒体交互 |
| packages/nodes | 14 个内置业务节点／扩展 |
| packages/mcp / openCinema | MCP、Widget、宿主 manifest 与自包含发行 |
| packages/file | TypeScript 统一文件原语 |

`@toonflow/*` 包名及 `toonflowCanvas` 标记保留文件格式兼容，不依赖原仓库目录。开发规范见 [贡献指南](contributing.md)。

```sh
bun run typecheck
bun run build
bun run release
```

最后一步只将已有 build/openCinema 打成平台 ZIP，输出 SHA-256 和发行清单，不隐式安装、构建或发布。当前归档命令支持有系统 zip 的 macOS／Linux；其他系统的运行与打包须分别验证。

## 当前边界与反馈

- 普通 Web 的底部对话需要实际在线 Host；Go 服务不另造画布执行器。
- Claude Code 的工具连通不能证明 Claude 可视化 Widget 已挂载。
- 当前剪辑计划为 2–16 镜、单条外部音轨混合／替换；不是完整多轨声音编辑器。
- 白模预演、技术合成和商业影片质量是不同交付，不能以几秒功能片段或成功回执冒充完整影片。
- [问题反馈模板](docs/issueTemplate.md) · [PR 模板](docs/pullRequestTemplate.md) · [安全说明](security.md) · [行为准则](codeOfConduct.md)。

## 许可与致谢

本项目采用 [MIT](LICENSE)，保留 HBAI-Ltd 原版权。Blockout／Motion 等第三方组件、图标和字体另遵其原许可；模型权重、FFmpeg 构建及用户素材不自动归入本项目 MIT。见 [第三方声明](thirdPartyNotices.md)，发行包同时附带本机安装依赖许可清单与可获得的原许可文件。

插件分发与文档结构参考 [Cowart](https://github.com/zhongerxin/Cowart)；OpenCinema 保留自己的 Go／React、MCP 与视频制作边界，不复制其认证或运行数据。
