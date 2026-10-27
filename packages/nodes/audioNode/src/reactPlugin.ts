import { registerMediaEditingTools } from "@toonflow/node-shared/reactMediaActions";
import { cloneMediaNodeData, registerMediaTools } from "@toonflow/node-shared/reactNode";
import type { NodePluginDefinition } from "@toonflow/nodes-scaffold/contracts";
import AudioNodeView from "./reactView";

const plugin: NodePluginDefinition<typeof AudioNodeView> = {
  cloneData: cloneMediaNodeData,
  apiVersion: 1, id: "audioNode", name: "音频", version: "1.0.0", renderer: "react", view: AudioNodeView,
  activate(context) { registerMediaTools(context, "audio"); registerMediaEditingTools(context, "audio"); },
  createData: () => ({ label: "音频", handles: [
    { id: "audio", type: "source", dataType: "AUDIO", label: "输出" },
  ], outputs: {} }),
};

export default plugin;
