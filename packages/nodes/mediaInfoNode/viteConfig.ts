import { createNodeConfig } from "@toonflow/nodes-scaffold";

export default createNodeConfig({
  name: "mediaInfoNode", displayName: "媒体信息检查", author: "Toonflow", github: "https://github.com/HBAI-Ltd/Toonflow-app",
  requires: { workspaceFiles: 1, workspaceReadRange: 1, nodeHistory: 1, webAssembly: 1 },
}, import.meta.url);
