import { createNodeConfig } from "@toonflow/nodes-scaffold";

export default createNodeConfig({
  name: "collaborationExtension", displayName: "多人协作", author: "Toonflow", github: "https://github.com/HBAI-Ltd/Toonflow-app",
  scope: "workspace",
  requires: { workspaceExtensions: 1, workspaceDocuments: 1, collaboration: 1 },
}, import.meta.url);
