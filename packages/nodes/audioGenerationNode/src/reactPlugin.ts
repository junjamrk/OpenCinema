import { cloneMediaNodeData } from "@toonflow/node-shared/reactNode";
import { registerMediaEditingTools } from "@toonflow/node-shared/reactMediaActions";
import type { NodePluginDefinition } from "@toonflow/nodes-scaffold/contracts";
import { getTargetValues } from "@toonflow/nodes-scaffold/nodePortValues";
import { isTypeCompatible } from "@toonflow/nodes-scaffold/connection";
import { getGenerationComposerState, registerGenerationTools } from "@toonflow/node-shared/reactGeneration";
import AudioGenerationNodeView from "./reactView";

const plugin: NodePluginDefinition<typeof AudioGenerationNodeView> = {
  cloneData: cloneMediaNodeData,
  apiVersion: 1, id: "audioGenerationNode", name: "音频生成", version: "2.0.0", renderer: "react", view: AudioGenerationNodeView,
  composer: { label: "生成音频", placeholder: "描述声音、配乐或需要朗读的内容…", tool: "generateAudio", defaultAction: true, getState: getGenerationComposerState },
  canConnect(connection, context) {
    const edges = context.edges.filter(edge => edge.source !== connection.source || edge.sourceHandle !== connection.sourceHandle || edge.target !== connection.target || edge.targetHandle !== connection.targetHandle);
    return getTargetValues(connection.target, "in", context.nodes, [...edges, connection]).filter(item => isTypeCompatible(item.dataType, ["IMAGE", "AUDIO"])).length <= 1;
  },
  createData: () => ({ label: "音频生成", prompt: "", model: "", handles: [
    { id: "in", type: "target", dataType: ["STRING", "IMAGE", "VIDEO", "AUDIO"], label: "参考输入" },
    { id: "audio", type: "source", dataType: "AUDIO", label: "输出" },
  ], outputs: {} }),
  activate(context) { registerGenerationTools(context, "audio"); registerMediaEditingTools(context, "audio"); },
};

export default plugin;
