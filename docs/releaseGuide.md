# 发行归档

当前版本按构建机的系统和 CPU 架构发行。开发者先安装 Bun 1.3.14、Go 1.26 和 Node.js 22+；macOS / Linux 的归档步骤还需要系统 `zip` 命令。

在仓库根目录显式执行：

```sh
bun install --frozen-lockfile
bun run build
bun run release
```

`release` 只打包已存在的 `build/openCinema`，不会安装依赖或补做构建；缺文件、运行包损坏、版本或平台不符会报错。归档输出到 `build/releases`：

- `openCinema-<version>-<platform>-<arch>.zip`：包含顶层 `openCinema/` 及完整插件、运行包、许可和第三方声明。
- `checksums.txt`：本次归档的 SHA-256。
- `releaseManifest.json`：版本、系统、架构、文件名、大小、SHA-256 和真实 runtimeRevision。

只分发完整目录或归档；不能从 macOS 包中拿单个 Go 二进制给 Linux 使用。Windows 归档目前明确不支持，不能以其他平台归档代替验收。此归档不包含用户工程、运行配置、凭据或模型权重；可选 FFmpeg / 深度模型按所属功能单独准备。解压后运行插件只需要 Node.js 22+，无需 Bun、Go、源码仓库或运行时安装 node_modules。

## 安装解压后的包

Claude Code 的单次会话直接加载解压目录：

```sh
claude --plugin-dir /absolute/path/to/openCinema
```

本地源码 marketplace 必须先完成构建：

```sh
claude plugin validate ./build/openCinema --strict
claude plugin marketplace add ./ --scope local
claude plugin install opencinema@openCinemaStandalone --scope local
```

源码 marketplace 指向被 Git 忽略的本机构建目录。远程安装须先发布相应平台的完整发行物并配置发行入口；只推源码不能免构建安装。插件加载、工具连接、React provider 和任务保存按 [宿主接入](../packages/openCinema/skills/openCinema/references/hostModes.md)分别核实。

## 手动生产打包任务

`.github/workflows/package.yml` 仅在维护者手动触发 `workflow_dispatch` 时运行，分别在 macOS 和 Linux 原生 runner 上安装固定构建工具、显式执行安装／构建／打包，并把归档与校验文件保留为 Actions artifact。文件名中的 CPU 架构取实际运行环境，不从 runner 标签猜测。权限仅 `contents: read`；任务不运行测试、不打 tag、不推送、不创建 GitHub Release、不部署，也不需要仓库 secrets。

运行后检查实际平台、架构、归档内容和目标宿主操作，再选择正式发布的文件。Actions artifact 保留 14 天，正式版本须另行发布并保留校验清单。

Actions 固定到完整 commit SHA，具体版本见工作流文件。

## 依赖许可与发布前状态

发行包附带licenseCatalog.json和licenses/，记录当前已安装依赖可获得的许可／NOTICE原文与SHA。这是包含开发／workspace包的保守集合，不是精确bundle归因或法律兼容结论。未提供原文的包明确列入missingLicenseFiles，发布前按实际分发内容核对，不能凭SPDX字段捏造正文。根thirdPartyNotices.md可离线阅读已核验的Blockout／Motion、MediaInfo、图标与字体声明。

0.4.0目前Unreleased。源码仓库为 [junjamrk/OpenCinema](https://github.com/junjamrk/OpenCinema)，package.json 已声明 repository／bugs／homepage。公开发布前核对目标远端，配置security.md中的私密安全渠道，在承诺的平台完成真实宿主操作、媒体播放、保存回读，记录源码commit、运行包revision与归档SHA。当前有未提交修改时不能声称对应干净release tag。源码Git marketplace仍依赖忽略的build目录，不能作为免构建安装源。

参见 [贡献指南](../contributing.md)、[问题模板](issueTemplate.md) 和 [PR 模板](pullRequestTemplate.md)。模板保存为 camelCase 文档，不由 GitHub 自动识别；打包任务不替代功能验收。
