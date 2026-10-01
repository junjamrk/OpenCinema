import type { NodeOutputs } from "./values";

export type NodeDataType = "STRING" | "INT" | "FLOAT" | "BOOLEAN" | "IMAGE" | "MASK" | "LATENT"
  | "AUDIO" | "VIDEO" | "FILE" | "MODEL" | "CLIP" | "VAE" | "CONDITIONING" | "*" | (string & {});

export type NodeHandle = {
  id: string;
  type: "source" | "target";
  dataType: NodeDataType | NodeDataType[];
  label?: string;
};

export type NodeConnectionFeedback = {
  nodeId: string;
  handles: Pick<NodeHandle, "id" | "type">[];
  status: "valid" | "invalid";
};

export type NodeData = {
  label?: string;
  handles?: NodeHandle[];
  outputs?: NodeOutputs;
  historyFields?: string[];
};

function getDataTypes(dataType: NodeHandle["dataType"]) {
  const types = Array.isArray(dataType) ? dataType : [dataType];
  return types.every(type => typeof type === "string")
    ? types.flatMap(type => type.split(",")).map(type => type.trim()).filter(Boolean)
    : [];
}

export function isTypeCompatible(sourceType: NodeHandle["dataType"], targetType: NodeHandle["dataType"]) {
  const sourceTypes = getDataTypes(sourceType);
  const targetTypes = getDataTypes(targetType);
  return sourceTypes.length > 0 && targetTypes.length > 0
    && (sourceTypes.includes("*") || targetTypes.includes("*") || sourceTypes.some(type => targetTypes.includes(type)));
}
