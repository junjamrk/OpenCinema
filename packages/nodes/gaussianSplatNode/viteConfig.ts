import { createNodeConfig } from "@toonflow/nodes-scaffold/reactBuild";

// 本插件不是内置节点：它通过插件市场或“安装插件包”安装，用来验证 OpenCinema 的插件链路能承载完整的 3D 能力。
export default createNodeConfig({
  author: "OpenCinema", github: "https://github.com/junjamrk/OpenCinema",
  license: "MIT", homepage: "https://opencinema.site/market/", tags: ["3d", "gaussian-splatting", "viewer", "reference", "render"],
  outDir: "../../../build/market/gaussianSplatNode",
}, import.meta.url);
