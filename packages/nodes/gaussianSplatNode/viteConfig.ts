import { createNodeConfig } from "@toonflow/nodes-scaffold";

// 本插件不是内置节点：它通过插件市场或“安装插件包”安装，用来验证 OpenCinema 的插件链路能承载完整的 3D 能力。
export default createNodeConfig({
  name: "gaussianSplatNode", displayName: "Gaussian Splat", author: "OpenCinema", github: "https://github.com/junjamrk/OpenCinema",
  description: "在画布中查看 3D Gaussian Splatting 扫描（PLY / SPLAT / KSPLAT / SPZ），设定机位，渲染静帧与环绕视频作为参考。",
  license: "MIT", homepage: "https://opencinema.site/market/", tags: ["3d", "gaussian-splatting", "viewer", "reference", "render"],
  outDir: "../../../build/market/gaussianSplatNode",
  requires: { workspaceFiles: 1, workspaceReadRange: 1, nodeHistory: 1, ffmpeg: 1, worker: 1 },
}, import.meta.url);
