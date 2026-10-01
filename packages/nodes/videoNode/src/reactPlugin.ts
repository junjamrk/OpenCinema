import { registerMediaEditingTools } from "@toonflow/node-shared/reactMediaActions";
import { cloneMediaNodeData, registerMediaTools } from "@toonflow/node-shared/reactNode";
import { registerVideoDepthSourceTool } from "@toonflow/node-video-depth/reactSourceActions";
import type { NodePluginDefinition } from "@toonflow/nodes-scaffold/contracts";
import VideoNodeView from "./reactView";

const plugin: NodePluginDefinition<typeof VideoNodeView> = {
  cloneData: cloneMediaNodeData,
  apiVersion: 1, id: "videoNode", name: "视频", version: "1.0.0", renderer: "react", view: VideoNodeView,
  activate(context) { registerMediaTools(context, "video"); registerMediaEditingTools(context, "video"); registerVideoDepthSourceTool(context); },
  createData: () => ({ label: "视频", handles: [
    { id: "in", type: "target", dataType: "VIDEO", label: "AI候选输入" },
    { id: "video", type: "source", dataType: "VIDEO", label: "输出" },
  ], outputs: {} }),
};

export default plugin;
