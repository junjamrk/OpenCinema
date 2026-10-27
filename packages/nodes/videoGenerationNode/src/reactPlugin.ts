import { cloneMediaNodeData } from "@toonflow/node-shared/reactNode";
import { registerMediaEditingTools } from "@toonflow/node-shared/reactMediaActions";
import type { NodePluginDefinition } from "@toonflow/nodes-scaffold/contracts";
import { getGenerationComposerState, registerGenerationTools } from "@toonflow/node-shared/reactGeneration";
import { registerVideoDepthSourceTool } from "@toonflow/node-video-depth/reactSourceActions";
import VideoGenerationNodeView from "./reactView";

const plugin: NodePluginDefinition<typeof VideoGenerationNodeView> = {
  cloneData: cloneMediaNodeData,
  apiVersion: 1, id: "videoGenerationNode", name: "视频生成", version: "2.0.0", renderer: "react", view: VideoGenerationNodeView,
  composer: { label: "生成视频", placeholder: "描述镜头、动作、运镜或画面如何变化…", tool: "generateVideo", defaultAction: true, getState: getGenerationComposerState },
  createData: () => ({ label: "视频生成", prompt: "", model: "", handles: [
    { id: "in", type: "target", dataType: ["STRING", "IMAGE", "VIDEO", "AUDIO"], label: "参考输入" },
    { id: "video", type: "source", dataType: "VIDEO", label: "输出" },
  ], outputs: {} }),
  activate(context) { registerGenerationTools(context, "video"); registerMediaEditingTools(context, "video"); registerVideoDepthSourceTool(context); },
};

export default plugin;
