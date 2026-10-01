# 画布与媒体工具合同

此包只通过 @toonflow/tools-scaffold/runtime 导出框架无关的 TypeScript 合同：节点工具发现和调用、画布上下文、媒体模型、参考素材与媒体生成请求/结果。

实际工具 schema 位于 @toonflow/tool-canvas/runtime；Web 的完整可调用工具清单由 apps/web/src/lib/workbenchTools.ts 提供，Go/MCP 构建复用同一清单。节点工具由 React 插件自行注册和校验。

此包不包含工具 UI 构建器、内置 Agent 执行器、桌面入口或服务实现。执行结果与持久化由所属工作台/插件/Go 模块负责。
