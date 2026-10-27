<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/logoDark.png">
    <img src="assets/brand/logoLight.png" alt="OpenCinema" width="460">
  </picture>
</p>

<h3 align="center">从想法到成片，与 Agent 一起掌镜。</h3>

<p align="center">
  在 Codex 或 Claude 中对话，在 OpenCinema 中看见、编辑并完成作品。<br>
  一张画布，连接分镜、素材、白模参考与最终剪辑。
</p>

<p align="center">
  <a href="readmeEn.md">English</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="docs/claudeSetup.md">Claude 接入</a> ·
  <a href="contributing.md">参与开发</a> ·
  <a href="LICENSE">MIT</a>
</p>

<p align="center">
  <a href="assets/promo/openCinemaPromo.mp4">
    <img src="assets/promo/promoPreview.gif" alt="OpenCinema：AI 工具闭环、多节点画布、多 Provider 与插件扩展" width="960">
  </a>
</p>

<p align="center">
  <a href="assets/promo/openCinemaPromo.mp4">观看完整宣传片 · 58 秒 · 1080p</a> ·
  <a href="assets/promo/promoPoster.jpg">高清封面</a>
</p>

<p align="center"><sub>产品动效演绎；实际生成效果依所选模型、参考与审片结果而定。</sub></p>

## 一张画布，贯穿创作全程

- **选中，即是创作范围。** 选择一个节点精修细节，或选择一组节点组织整段创作。
- **与熟悉的 Agent 一起创作。** 在 Codex、Claude 或其他 MCP 宿主中发出指令，画布展示实际结果。
- **素材编辑，就在画布里。** 图片局部编辑台与音视频工具，保留手工操作的精细控制。
- **先看清镜头，再开始生成。** 用 Blockout 编排走位、摄影机与预演，固定每一镜的 RGB／Depth 参考。
- **保留好镜头，只返修需要的部分。** 审阅候选、调整采用范围、替换单镜，再输出完整剪辑。
- **你的模型，你的工具。** 通过公开 MCP 与插件接口扩展工作台，连接明确配置的生成服务。

## 创作，从一次对话开始

1. **圈定目标。** 打开工程，选择一个节点或一组镜头，在底部写下创作要求。
2. **边看边改。** Agent 操作同一张画布；你随时打开局部编辑台、调整参考或保留一个满意版本。
3. **审阅并完成。** 检查实际画面，只返修需要的镜头，保存剪辑计划并导出成片。

深入了解：[镜头工作流](docs/videoShotWorkflow.md) · [视频供应商](docs/videoProvider.md)。

## 快速开始

当前版本 **0.4.0 · 开发中**。从源码运行需要 **Bun 1.3.14+、Go 1.26+**；插件运行需要 **Node.js 22+**。

~~~sh
git clone https://github.com/junjamrk/OpenCinema.git
cd OpenCinema
bun install --frozen-lockfile
bun run build
bun start
~~~

打开 [本地工作台](http://127.0.0.1:47920)，选择工程目录即可开始。开发模式见 [贡献指南](contributing.md)，完整平台归档见 [发行指南](docs/releaseGuide.md)。

### Claude Code

在完成构建的仓库中，为当前会话加载：

~~~sh
claude --plugin-dir ./build/openCinema
~~~

也可安装为当前工程的插件：

~~~sh
claude plugin marketplace add ./ --scope local
claude plugin install opencinema@openCinemaStandalone --scope local
~~~

调用 <code>/opencinema:opencinema</code>，先读取 <code>getAppState</code>，再打开已有工程。更多连接方式见 [Claude 接入](docs/claudeSetup.md)。

### Codex

在完成构建的仓库中：

~~~sh
codex plugin marketplace add . --json
codex plugin add opencinema@openCinemaStandalone --json
~~~

启用 **OpenCinema Studio**，通过 <code>getAppState</code> 读取当前连接；支持 MCP Apps 的宿主可用 <code>renderOpenCinema</code> 打开工作台。

<details>
<summary>运行方式与模型说明</summary>

- Codex、Claude Code 和其他 MCP Agent 提供规划与对话，React 工作台负责编辑，Go 服务负责授权、文件和任务。普通 Web 的底部输入需要在线 Host 接收与处理。
- 源码 marketplace 引用构建目录；先构建再安装，或使用匹配本机系统与架构的完整发行包。插件工具与可视化 Widget 的支持取决于具体宿主。
- 专用生成服务独立配置，可能计费；宿主订阅不包含所有视频模型。凭据留在本机，不进入工程或版本库。
- 本地处理使用显式配置的 FFmpeg／FFprobe。Video Depth Anything Small 需要 Python 3.10–3.12，以及显式准备的运行环境和权重；构建不会自动下载模型。
- 白模与相对深度用于预演和参考；普通视频参考不保证模型严格复现运动。当前剪辑计划支持 2–16 镜及单条外部音轨混合／替换。

</details>

## 为创作扩展工具

Go 服务、React 画布、框架无关编辑会话和节点 SDK 共同构成工作台。14 个内置节点／扩展共享手工与 Agent 操作；通过实际 Schema 发现工具，并保留修订、撤销重做、保存与回读。

[开发与贡献](contributing.md) · [节点 SDK](packages/nodeScaffold/readme.md) · [MCP SDK](packages/mcp/README.md) · [插件说明](packages/openCinema/readme.md) · [变更记录](changelog.md)

[问题反馈](https://github.com/junjamrk/OpenCinema/issues) · [安全说明](security.md) · [行为准则](codeOfConduct.md)

## 许可与致谢

[MIT](LICENSE)，保留 HBAI-Ltd 原版权。Blockout、Motion、字体、图标等保留各自许可；模型权重、FFmpeg 构建及用户素材遵循各自条款。详见 [第三方声明](thirdPartyNotices.md)。

插件分发与文档结构参考 [Cowart](https://github.com/zhongerxin/Cowart)。
