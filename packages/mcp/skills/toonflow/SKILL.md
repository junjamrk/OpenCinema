---
name: toonflow
description: 通过 OpenCinema MCP 操作已有实时画布与插件，发现参数和副作用，固定目标并核实任务、文件和保存回执。
---

这是保留 `toonflow` 名称的 OpenCinema SDK 兼容入口。先 `getAppState` 固定现有工程、连接、画布和节点；无 React provider 时不能离线执行画布。复用用户工程，按需分页读取，不直接改画布 JSON。

先 `getNodeTools` / `getWorkspaceTools`，按实际输入、输出 Schema 与 annotations 调用动态 broker，并带回 `toolCatalogVersion`。画布写入使用读取到的 `documentRevision` 作为 `args.expectedRevision`；文件使用 `fileRevision`，游标仅用于分页。专业参数实时发现。

业务调用通常为 `{target:{connectionId,directory,canvasId},args:{...},operationId?}`。有重复副作用的调用和未确认只读的动态 broker 按 Schema 提供外层 UUID；同一次写调用重试保留 ID、目标和参数，未知先 `getOperation`，不更换 ID 重做。已发现且目录版本一致的只读函数直接读取实时状态，不要求 ID、不缓存轮询。`cancelRequested`、消息 `accepted` 和异步任务完成分别处理。

图片通过 `readWorkspaceImage` 取得真实 MCP image 内容；路径或 base64 文字不算图像观察。采用草稿、执行、保存、产物与回读分别取证，失败保留草稿。媒体生成、上传、部署、安装与凭据操作遵循已有对应授权，不输出密钥或会话凭证。

涉及运行方式、文件、错误恢复、通用操作记录与专业任务的关系时，按需读取随 SDK 发布的 [README](../../README.md)。Codex Widget、Claude Code 工具与 Claude 可视化宿主分别验收；原生 Widget 无需另注册轮询 Agent，普通 Web 的宿主须注册并持续领取请求。
