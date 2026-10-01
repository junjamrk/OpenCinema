# React 节点脚手架

OpenCinema 仅提供 Go 服务端与 React Web 工作台。脚手架负责插件合同、ESM 构建、宿主能力与通用节点服务；节点专属 UI、预设和专业操作留在所属插件，共享业务放在 @toonflow/node-shared。

## 插件入口

每个节点以 src/reactPlugin.ts 导出 NodePluginDefinition。插件声明稳定的 id、apiVersion: 1、renderer: "react"、version、view 与 activate；工作区扩展声明 scope: "workspace"。activate 通过 getService 获取文档、文件、宿主等已有服务，registerTool 发布带 Zod 参数校验的真实工具，onDispose 释放资源。

React 组件使用 @toonflow/nodes-scaffold/react 的 ReactNodeViewProps；框架无关合同由 contracts、pluginRuntime、hostAdapter、workspaceDocuments、workbenchServices、values、connection 等公开子路径导出。运行时拒绝不兼容的 renderer 或能力版本，不把视图跨框架挂载。

## 构建

vite.config.ts 或 viteConfig.ts 调用 createNodeConfig（等同 createReactNodeConfig），传入 name、displayName、author、github、requires、可选 scope/configRules/resources。执行包内已有 build 脚本生成 build/nodes/<id>/index.js、manifest.json、样式和 install.json。

插件通过宿主 /pluginSdk.js 共用 React 与 Zod；第三方专业库按真实依赖打包。manifest 与安装资产包含版本、资源 MIME、SHA256 和大小，构建检查单项与总量边界。资源从本地依赖或插件目录解析，运行时不自动换模型。

## 编辑与 Agent 边界

composer 描述节点在唯一底部输入区的任务名称、占位说明和原插件工具。节点展示结果、必要结构化参数、真实状态与直接编辑；自然语言创作意图只从底部发送。focusComposer 只聚焦/插入草稿，不发请求。

文档会话管理修订、撤销重做与保存；插件工具负责自己的任务与产物。宿主适配器处理 Agent 连接、请求和取消，不能把 accepted/queued 当作 completed。媒体执行器保留真实任务查询与终态确认，取消不确定时保留原请求 ID 和产物。

## 文件与资源

nodeFiles、nodeResources、nodePortValues 复用现有工作区入口和端口类型，不绕过路径授权。前端只持久化工作区相对路径，临时 Blob URL 在最后一个使用者释放时回收。跨 await 固定工作目录，完整快照由宿主原子保存。

修改后可执行已有 typecheck 与 build；编译通过不代表宿主或节点交互已经验收。
