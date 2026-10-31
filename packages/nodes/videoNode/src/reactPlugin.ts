import { openCinema, version } from "../package.json";
import { registerMediaEditingTools } from "@toonflow/node-shared/reactMediaActions";
import { cloneMediaNodeData, registerMediaTools } from "@toonflow/node-shared/reactNode";
import { registerVideoDepthSourceTool } from "@toonflow/node-video-depth/reactSourceActions";
import type { NodePluginDefinition } from "@toonflow/nodes-scaffold/contracts";
import VideoNodeView from "./reactView";

const plugin: NodePluginDefinition<typeof VideoNodeView> = {
  cloneData: cloneMediaNodeData,
  ...openCinema, version, apiVersion: 1, renderer: "react", view: VideoNodeView,
  activate(context) { registerMediaTools(context, "video"); registerMediaEditingTools(context, "video"); registerVideoDepthSourceTool(context); },
  createData: () => ({ label: openCinema.name, handles: [
    { id: "in", type: "target", dataType: "VIDEO", label: "AI候选输入" },
    { id: "video", type: "source", dataType: "VIDEO", label: "输出" },
  ], outputs: {} }),
};

export default plugin;
