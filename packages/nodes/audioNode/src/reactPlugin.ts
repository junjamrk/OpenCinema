import { openCinema, version } from "../package.json";
import { registerMediaEditingTools } from "@toonflow/node-shared/reactMediaActions";
import { cloneMediaNodeData, registerMediaTools } from "@toonflow/node-shared/reactNode";
import type { NodePluginDefinition } from "@toonflow/nodes-scaffold/contracts";
import AudioNodeView from "./reactView";

const plugin: NodePluginDefinition<typeof AudioNodeView> = {
  cloneData: cloneMediaNodeData,
  ...openCinema, version, apiVersion: 1, renderer: "react", view: AudioNodeView,
  activate(context) { registerMediaTools(context, "audio"); registerMediaEditingTools(context, "audio"); },
  createData: () => ({ label: openCinema.name, handles: [
    { id: "audio", type: "source", dataType: "AUDIO", label: "输出" },
  ], outputs: {} }),
};

export default plugin;
