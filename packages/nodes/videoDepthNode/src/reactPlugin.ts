import { openCinema, version } from "../package.json";
import type { NodePluginDefinition } from "@toonflow/nodes-scaffold/contracts";
import VideoDepthView from "./reactView";
import { createVideoDepthData, createVideoDepthService } from "./reactService";

export default {
  ...openCinema, version, apiVersion: 1, renderer: "react", view: VideoDepthView,
  cloneData(data) { const { depthPending: _pending, ...copy } = data; return structuredClone(copy); },
  createData: createVideoDepthData,
  activate(context) { return { service: createVideoDepthService(context) }; },
} satisfies NodePluginDefinition<typeof VideoDepthView>;
