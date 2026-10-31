import { openCinema, version } from "../package.json";
import type { NodePluginDefinition } from "@toonflow/nodes-scaffold/contracts";
import DirectorNodeView from "./reactView";
import { createDirectorService } from "./reactService";
export default {
  ...openCinema,
  version,
  apiVersion: 1,
  renderer: "react",
  view: DirectorNodeView,
  composer: { label: "创作导演方案", placeholder: "描述这个场景的摄影与表演意图…", tool: "requestDirectorPlan" },
  cloneData(data) {
    const { exportProgress: _exportProgress, directorHostOperation: _directorHostOperation, ...copy } = data;
    return structuredClone(copy);
  },
  createData: () => ({
    label: openCinema.name,
    handles: [
      { id: "in", type: "target", dataType: ["STRING", "IMAGE", "VIDEO"], label: "参考输入" },
      { id: "image", type: "source", dataType: "IMAGE", label: "关键帧" },
      { id: "video", type: "source", dataType: "VIDEO", label: "场景动画" },
    ],
    historyFields: [
      "modelPath",
      "selectedPlanId",
      "lighting",
      "sceneSettings",
      "anchors",
      "outputs",
    ],
  }),
  activate(context) {
    return { service: createDirectorService(context) };
  },
} satisfies NodePluginDefinition<typeof DirectorNodeView>;
