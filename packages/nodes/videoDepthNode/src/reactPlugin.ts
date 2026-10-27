import type { NodePluginDefinition } from "@toonflow/nodes-scaffold/contracts";
import VideoDepthView from "./reactView";
import { createVideoDepthData, createVideoDepthService } from "./reactService";

export default {
  apiVersion: 1, id: "videoDepthNode", name: "视频深度白模", version: "1.0.0", renderer: "react", view: VideoDepthView,
  cloneData(data) { const { depthPending: _pending, ...copy } = data; return structuredClone(copy); },
  createData: createVideoDepthData,
  activate(context) { return { service: createVideoDepthService(context) }; },
} satisfies NodePluginDefinition<typeof VideoDepthView>;
