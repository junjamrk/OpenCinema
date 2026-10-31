import { openCinema, version } from "../package.json";
import type { NodePluginDefinition } from "@toonflow/nodes-scaffold/contracts";
import MotionNodeView from "./reactView";
import { createMotionService } from "./reactService";
export default {
  ...openCinema,
  version,
  apiVersion: 1,
  renderer: "react",
  view: MotionNodeView,
  cloneData(data) {
    const { motionDepthPending: _motionDepthPending, exportProgress: _exportProgress, ...copy } = data;
    return structuredClone(copy);
  },
  createData: () => ({
    label: openCinema.name,
    analysisSettings: { start: 0, end: 1, sampleFps: 6 },
    handles: [
      { id: "input", type: "target", dataType: "VIDEO", label: "RGB参考视频" },
      ...[
        ["analysis", "FILE"],
        ["summary", "STRING"],
        ["video", "VIDEO"],
        ["openPose", "FILE"],
        ["poseControl", "FILE"],
        ["depth", "VIDEO"],
        ["exportManifest", "FILE"],
        ["cameraMotion", "FILE"],
        ["edges", "FILE"],
        ["lineart", "FILE"],
        ["contactSheet", "FILE"],
        ["frameDifferenceMask", "FILE"],
        ["normalsProxy", "FILE"],
        ["combinedReview", "FILE"],
        ["productionPack", "FILE"],
        ["shotPlan", "FILE"],
      ].map(([id, dataType]) => ({ id, type: "source", dataType, label: id })),
    ],
    historyFields: ["analysisSettings", "analysisInput", "outputs", "productionPlan"],
  }),
  activate(context) {
    return { service: createMotionService(context) };
  },
} satisfies NodePluginDefinition<typeof MotionNodeView>;
