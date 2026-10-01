import { createNodeConfig } from "@toonflow/nodes-scaffold";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export default createNodeConfig({
  name: "motionAnalysisNode", displayName: "Motion 运动分析", author: "Toonflow", github: "https://github.com/HBAI-Ltd/Toonflow-app",
  requires: { pluginResources: 1, worker: 1, webAssembly: 1, workspaceFiles: 1, nodeHistory: 1 },
  resources: {
    poseModel: { path: "resources/poseLite.task", version: "float16/1", mimeType: "application/octet-stream", license: "Apache-2.0", source: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task", sha256: "59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a" },
    visionWasm: { path: require.resolve("@mediapipe/tasks-vision/vision_wasm_internal.wasm"), version: "1.1.1", mimeType: "application/wasm", license: "Apache-2.0", source: "https://www.npmjs.com/package/@mediapipe/tasks-vision/v/1.1.1", sha256: "0e101a010e262ef8e78f22e3c95b60a9705fd06962753c9acd6356d9fb56b7bd" },
    visionLoader: { path: require.resolve("@mediapipe/tasks-vision/vision_wasm_internal.js"), version: "1.1.1", mimeType: "text/javascript", license: "Apache-2.0", source: "https://www.npmjs.com/package/@mediapipe/tasks-vision/v/1.1.1", sha256: "6522286aa32dd93eff17c3da002b0649516f87abfec7a80b5bfe5c9625caa5f8" },
  },
}, import.meta.url);
