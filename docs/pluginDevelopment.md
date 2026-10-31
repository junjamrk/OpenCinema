# 插件开发指南

OpenCinema 的每个节点都是一个插件：一个包，导出一份插件定义，注册带 Zod Schema 的工具，附带一个 React 视图。内置节点、第三方节点与插件市场里的节点走完全相同的链路，没有特权 API。本文说明约定、合同与发布方式；英文版见 [pluginDevelopmentEn.md](pluginDevelopmentEn.md)。

## 设计原则

把 Unix 哲学搬到画布上：

| 原则 | 在节点里的含义 |
| --- | --- |
| 一个程序只做一件事 | 一个节点一个职责。查看扫描是一个节点，生成视频是另一个节点；需要组合时用连线，不堆开关。 |
| 用文本流（这里是类型化端口）组合 | 节点之间只通过端口传值：`STRING`、`INT`、`FLOAT`、`BOOLEAN`、`IMAGE`、`VIDEO`、`AUDIO`、`FILE`、`MASK`。媒体值是 `{ url, mimeType }` 的工作区相对路径，不是 Blob。 |
| 让工具可被程序调用 | 每个能力都是一个工具：Zod 输入、Zod 输出、副作用标注。界面按钮调用的就是 Agent 调用的同一个函数。 |
| 沉默是金 | 读工具不改状态，写工具返回新的修订；失败抛出带错误码与恢复动作的错误，不留下半成品。 |
| 可靠胜于聪明 | 不自动重试、不自动降级、不悄悄换模型；长任务先返回 `taskId`，再由状态工具报告真实终态。 |

对 Agent 友好的具体做法：

- **小动词工具**：`get*` 读状态、`set*` 改状态、`run*` / 动词做事、`get*Status` 看进度、`cancel*` 取消。名字小驼峰，1 到 64 个字符。
- **描述写给调用者**：一句话说清做什么、前置条件、返回什么、不做什么。描述里出现的参数名和返回字段要与 Schema 一致。
- **`annotations` 诚实**：`readOnlyHint`、`destructiveHint`、`idempotentHint`、`openWorldHint` 决定 Agent 是否需要外层 `operationId` 与确认。
- **输出有 Schema**：`outputSchema` 让宿主校验返回值，Agent 可据此解析。
- **修订保护**：写工具接受可选 `expectedRevision`（画布 `documentRevision`），用 `workbench.assertWritable(expectedRevision)` 校验；长任务完成时按当时修订写入。
- **一份 `agent.md`**：写给 Agent 的操作顺序与边界，随 manifest 发行，Agent 通过 `getPluginConfiguration({ pluginId })` 读到 `agentGuide`。

## 从零开始

```bash
bun packages/nodeScaffold/scripts/createNode.ts depthSliceNode "深度切片" --description "把深度图切成前中后三层蒙版。"
bun install
cd packages/nodes/depthSliceNode && bun run typecheck && bun run build
```

脚手架生成：

```
packages/nodes/depthSliceNode/
├── package.json        openCinema 块声明 id、显示名、描述、能力要求；依赖 @toonflow/nodes-scaffold、@toonflow/node-shared、zod
├── tsconfig.json
├── viteConfig.ts       createNodeConfig(...)：作者、许可、标签、输出目录
├── readme.md           给人看的说明；进入 manifest.readme
├── agent.md            给 Agent 看的指南；进入 manifest.agentGuide（≤ 16 KiB）
└── src/
    ├── reactPlugin.ts  NodePluginDefinition：createData、activate、registerTool
    └── reactView.tsx   节点内的 React 视图
```

这个脚手架用于仓库内开发。仓库外开发用 `createOpenCinemaPlugin`，步骤见 [README](../readmeZh.md)。`@toonflow/nodes-scaffold` 还没发布到 npm，所以 `--scaffold` 是必填项，要指向 `npm pack` 生成的 tgz。生成的工程同样带 `readme.md` 和 `agent.md`。

### 边改边装

开两个终端。一个运行 `npm run dev` 监听构建，另一个把每次构建的 `install.json` 提交给本机工作台：

```bash
npm run devInstall -- --server http://127.0.0.1:47920
```

仓库内的插件没有这个脚本，直接运行 `bun packages/nodeScaffold/scripts/devInstall.ts <install.json 路径> --server <工作台地址>`。提交后在 **设置 → 插件** 点 **刷新目录**，工作台就加载新版本。

## 插件定义

```ts
const plugin: NodePluginDefinition<typeof View> = {
  apiVersion: 1, id: "depthSliceNode", name: "深度切片", version: "0.1.0", renderer: "react", icon: "image", view: View,
  createData: () => ({ label: "深度切片", handles: [
    { id: "depth", type: "target", dataType: "IMAGE", label: "深度图" },
    { id: "near", type: "source", dataType: "MASK", label: "前景蒙版" },
  ], outputs: {} }),
  activate(context) {
    const { id, document, workbench } = pluginServices(context);
    context.registerTool({ name: "getState", /* … */ });
    context.registerTool({ name: "slice", /* … */ });
    context.onDispose(() => { /* 释放 Worker、WebGL、临时 URL */ });
  },
};
export default plugin;
```

`activate` 在每个节点实例上运行一次，拿到的 `context` 提供：

| 成员 | 用途 |
| --- | --- |
| `getService("document")` | 读节点、读修订、`updateData`（进入历史）、`updateRuntimeData`（运行态，不进入历史）、`save` |
| `getService("workbench")` | `files`（工作区文件）、`getInputs(handle)`、`updateData`、`createNodes`、`ffmpeg()`、`hostRequest()`、`assertWritable()` |
| `registerTool(definition)` | 发布一个工具；返回注销函数 |
| `onBeforeChange(prepare)` | 节点将进入历史操作或被删除前中止任务 |
| `onDispose(dispose)` | 节点卸载或插件停用时释放资源 |
| `signal` | 插件生命周期信号 |
| `config` / `capabilities` | 用户配置（按 `configRules`）与宿主能力版本 |

数据模型约定：

- 进入历史的状态放在 `data` 顶层（例如来源、参数、机位），用 `workbench.updateData`。
- 运行态（进度、`taskId`、错误）用 `workbench.updateRuntimeData`，重载后由状态工具判断是否已中断。
- 产物写到 `assets/<节点 ID>/`（`uploadNodeFile` 已处理目录与随机文件名），端口 `outputs.<handle> = { dataType, value }`。
- 清除一个键写 `null`；`cloneData` 里删除正在运行的任务状态，复制的节点不会假装在运行。

## 长任务

同步工具默认 120 秒超时。超过的工作按下面的模式：

1. `run*` 校验参数、拿到依赖（例如 `await workbench.ffmpeg()` 先于排队，FFmpeg 缺失时立刻失败），生成 `taskId`，立即返回 `{ status: "queued", taskId, executionSettled: false }`。
2. 任务在后台推进，用 `updateRuntimeData` 写 `status: "running"`、`phase`、`progress`。
3. `get*Status` 返回真实状态；页面重载后 `running` 但没有活任务要报告为 `interrupted`。
4. `cancel*` 中止 `AbortController`；任务自己清理临时目录。编码器尚未确认退出时保留临时文件，不删除可能仍在使用的输入。

[Gaussian Splat 节点](../packages/nodes/gaussianSplatNode/src/reactPlugin.ts) 的 `renderTurntable` / `getRenderStatus` / `cancelRender` 是这一模式的完整示例。

## 视图

视图是普通 React 组件，props 为 `NodeViewProps`：`node`（`id`、`data`）、`controller`、`readOnly`。`controller.callNodeTool(node.id, name, args)` 调用本节点工具，`controller.getNodeService(node.id)` 取工作台服务，`controller.acquireMedia(path)` 换取临时 URL。用 `@toonflow/node-shared/nodeControls` 的类名（`nodeControls`、`nodeActions`、`nodePrimary`、`nodeStatus`、`nodeError`、`nodeUploadArea`）即可获得工作台样式；画布交互区域加 `nodrag nopan nowheel`。

React、react-dom 与 zod 由宿主通过 `/pluginSdk.js` 提供，不会打进你的包；three.js、WASM 等专业依赖会被打包进 ESM 或作为资产随包发行。

## manifest 与安装包

插件身份写在 `package.json` 的 `openCinema` 块：

| 字段 | 说明 |
| --- | --- |
| `id` | 插件 ID，小驼峰；也是节点类型 |
| `name` | 显示名 |
| `description` | 一句话说明；进入节点菜单、市场与 Agent 的 `availableNodeTypes` |
| `category`、`icon` | 节点菜单的分类与图标 |
| `requires` | 需要的宿主服务与能力版本，例如 `{ document: 1, workbench: 1, workspaceFiles: 1, ffmpeg: 1, worker: 1 }`；`getService` 只能取到这里声明过的服务，完整清单见[宿主能力](#宿主能力) |
| `scope` | `node`（默认）或 `workspace` |
| `order` | 只有内置节点声明；没有 `order` 的插件不进内置清单 |

`createNodeConfig` 接收：

| 字段 | 说明 |
| --- | --- |
| `author`、`github` | 基本信息 |
| `license`、`homepage`、`tags` | SPDX 许可、主页、小写标签，供市场筛选 |
| `configRules` | 用户配置字段；Agent 通过 `getPluginConfiguration` / `setPluginConfiguration` 读写非秘密字段 |
| `providers` | 插件提供的生成服务，格式同供应商清单 |
| `resources` | 随包发行的大文件（模型、WASM），带 SHA-256 |
| `outDir` | 输出目录；默认是插件目录下的 `dist`，市场插件写到 `build/market/<id>` |

构建输出 `index.js`、`manifest.json` 与 `install.json`。`install.json` 是安装包：`{ manifest, source, assets[] }`，每个资产带 SHA-256，JSON Schema 见 [installPackage.schema.json](../packages/nodeScaffold/schema/installPackage.schema.json)。安装入口：

- 设置 → 插件 → 安装插件包（本地文件）；
- 设置 → 插件 → 插件市场（静态目录，下载后按 SHA-256 校验）；
- Agent：`reviewPluginPackage` / `installPluginPackage`（工程内文件）或 `getPluginMarket` / `installMarketplacePlugin`（市场）。

安装后插件由本机 Go 服务按版本目录提供，Web 通过 import map 加载，React 与 zod 复用宿主实例。

Go 服务在安装时校验 `version`、`requires`、`displayName`、`author`、`license`、`homepage`、`tags` 和 `configRules` 的类型，不合规的包直接拒绝。工作台安装后立即加载模块，并在每次进入插件页时探测已启用的已安装插件。加载失败的原因显示在插件卡片上，卡片提供 **重试加载** 按钮。已安装插件的清单损坏时，工程照常打开，这个插件在设置页标为损坏，用户可以卸载或重新下载。

## 宿主能力

`requires` 里的名字和最高版本来自 [hostCapabilities.json](../packages/nodeScaffold/src/hostCapabilities.json)。名字写错或版本过高时，`vite build`、`generate:nodes` 和 `site/build.mjs` 都会失败。

| 能力 | 版本 | 用途 |
| --- | --- | --- |
| `document` | 1 | 读写当前节点的数据 |
| `workbench` | 1 | 使用工作台服务（文件、FFmpeg、宿主 Agent） |
| `files` | 1 | 读写工程文件 |
| `inputs` | 1 | 读取上游节点的输入 |
| `state` | 1 | 使用工程内共享的运行状态 |
| `documentEditing` | 1 | 编辑节点文档 |
| `workspaceFiles` | 1 | 读写工程文件 |
| `workspaceReadRange` | 1 | 按范围读取工程内的大文件 |
| `nodeHistory` | 1 | 写入画布历史 |
| `workspaceDocuments` | 1 | 读写工程内的画布 |
| `workspaceExtensions` | 1 | 扩展工程功能 |
| `collaboration` | 1 | 参与多人协作 |
| `pluginResources` | 1 | 加载随包发行的模型和资源 |
| `ffmpeg` | 1 | 调用 FFmpeg 处理音视频 |
| `webAssembly` | 1 | 运行 WebAssembly |
| `worker` | 1 | 在后台线程运行任务 |

`webAssembly` 和 `worker` 只在运行环境支持时提供。

`requires` 是兼容性声明，不是沙箱。插件和工作台在同一个页面环境里运行，能直接发同源请求和操作 DOM，因此可以读写工程文件、读取已保存的 API Key、向外部地址发送数据。安装前的复核卡片会向用户说明这一点。

## 发布到插件市场

市场是 [opencinema.site/market](https://opencinema.site/market/) 下的静态目录，目前仅支持安装、不支持上传。发布一个版本：

1. 构建插件，确认 `install.json` 在你声明的 `outDir`。
2. 在 `site/src/marketCatalog.json` 添加条目：`id`、`source`（install.json 相对仓库根目录的路径）、英文与中文 `description`、`homepage`、`repository`、`publishedAt`。可选的 `minHost` 是能运行这个包的最低工作台版本，格式如 `0.4.0`，高于当前版本时界面禁用安装。
3. 运行 `node site/build.mjs`。脚本把包复制到 `site/market/plugins/<id>/<version>/install.json`，计算 SHA-256 与大小，重写 `site/market/index.json` 与市场页面。同一版本不能用不同字节覆盖，改动请升级版本。`requires` 里有宿主不提供的能力时，脚本直接失败。
4. 提交 Pull Request。目录格式见 [marketIndex.schema.json](../packages/nodeScaffold/schema/marketIndex.schema.json)。

工作台逐条解析目录，一条无效记录只跳过它自己，设置页显示跳过的数量。版本按数字段比较，不处理预发布版本，`1.0.0-beta` 和 `1.0.0` 的先后不保证。

## 检查清单

- [ ] 一个节点一个职责；端口类型准确，`canConnect` 只在类型不足以表达时才用。
- [ ] 每个工具：小动词名、准确描述、Zod 输入与输出、诚实的 `annotations`。
- [ ] 写工具支持 `expectedRevision`；长任务用 queued 模式并可取消。
- [ ] 失败不留半成品；临时文件自己清理；`onDispose` 释放一切。
- [ ] `readme.md` 写给人，`agent.md` 写给 Agent；第三方许可随包分发（`licenses/`）。
- [ ] `bun run typecheck` 与 `bun run build` 通过；在工作台里实际安装并操作过一遍。
