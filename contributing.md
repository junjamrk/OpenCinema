# 参与 OpenCinema

感谢提交可复现的问题、文档修正和小范围改进。当前版本为 0.4.0 开发版；功能、宿主连接和影片内容质量分别验证，不因一次构建通过而宣称全部可用。

## 开始开发

先阅读 [readmeZh.md](readmeZh.md) 和 [插件说明](packages/openCinema/readme.md)。以 `package.json`、`apps/server/go.mod`、`bun.lock` 中的实际版本和命令为准。

在仓库根目录分别执行：

```sh
bun install --frozen-lockfile
bun run typecheck
bun run build
bun start
```

不要把安装依赖、下载模型或验证命令隐式加入开发和构建流程。修改节点后，显式执行相应包已存在的 `typecheck` 命令；完整构建会生成当前机器系统与 CPU 架构的发行包。跨平台构建成功和在该平台实际运行是两项证据。

开发 Web 使用 `bun run dev:web`，Go 源码服务使用 `bun run dev:server`。不要用旧 TypeScript 服务代替 Go 后端。数据、工程和媒体应放在 Git 忽略的运行目录或仓库外，不提交个人工作区。

## 实现边界

- 先复用已有工具、Store 和标准库，再增加实现；普通变量、文件、目录、DOM 类名和 props 使用小驼峰，React 组件定义、绑定和 JSX 标签使用 PascalCase；第三方导出保留原名。
- 插件业务属于相应插件；跨插件业务在 `packages/nodeShared`，通用脚手架在 `packages/nodeScaffold`。不绕过公开包导出。
- TypeScript 磁盘操作复用 `@toonflow/file`；完整快照显式原子写入。目录授权、版本冲突、路径边界和写入失败不能省略。
- 画布编辑使用公开命令或 MCP 工具，不直接改工程 JSON 来冒充 Agent 操作。操作前固定连接、目录、画布与修订；动态工具先发现 Schema，写入保留稳定 operationId，未知结果先查询原操作。
- 本仓库不新增测试模块、自检脚本、测试依赖、测试命令或测试 CI。沿用已有类型检查、构建和必要真实手工验证；运行时业务校验必须保留。

## 提交问题

使用仓库的问题模板（若已配置）或直接提供以下信息：

1. 问题与预期结果，以及最短操作步骤。
2. 版本或 commit、操作系统／CPU、Bun／Go／Node 版本；涉及 Claude、Codex 时提供宿主名称与版本。
3. 使用独立 Web、Claude Code、Codex Widget 还是其他宿主；连接／工具发现失败与画布操作失败应分开描述。
4. 脱敏后的错误码、operationId／taskId、终态和必要截图。记录文件是否产生、是否保存、重开后是否一致。
5. 与问题直接相关且有权共享的最小工程或媒体。不要附完整 settings、runtime、凭据、个人素材或私人对话。

安全漏洞按 [security.md](security.md) 处理，不在公开问题中披露利用细节或凭据。

## 提交改动

PR 应说明具体问题、最终行为、涉及的用户入口和边界，列出实际执行的命令和真实操作证据。UI 改动附前后截图；Agent 能力附发现、调用、保存和回读结果；媒体任务附真实产物规格及终态。付费生成、素材上传和部署必须有相应授权，不能为了验证默认触发。

说明未完成的验证、兼容性影响、是否变更文件格式以及恢复方式。不要自动批准审片来让门槛变绿，不用 CLI 或独立 Web 的结果代替原生宿主验收。

提交前自行检查差异，避免夹带无关改动、生成包、缓存、凭据和机器绝对路径。提交拥有权利的代码和素材，保留 [第三方声明](thirdPartyNotices.md) 与原有版权；不把第三方文件统一改成 MIT。新增依赖说明实际必要性和许可，保留锁文件。参与讨论请遵守 [行为准则](codeOfConduct.md)。
