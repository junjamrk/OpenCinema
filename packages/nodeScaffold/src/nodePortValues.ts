import { isTypeCompatible, type NodeData, type NodeHandle } from "./connection";
import { isNodeOutput, type NodeInputValue, type NodeOutput } from "./values";

export type PortNode = { id: string; data?: NodeData };
export type PortEdge = { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null };
type Nodes<T extends PortNode> = readonly T[] | ReadonlyMap<string, T>;

function findNode<T extends PortNode>(nodes: Nodes<T>, id: string): T | undefined {
  return Array.isArray(nodes) ? nodes.find(node => node.id === id) : (nodes as ReadonlyMap<string, T>).get(id);
}

export function getTargetSources<T extends PortNode>(targetId: string, targetHandleId: string, nodes: Nodes<T>, edges: readonly PortEdge[]) {
  const target = findNode(nodes, targetId)?.data?.handles?.find(handle => handle.type === "target" && handle.id === targetHandleId);
  if (!target) return [];
  return edges.filter(edge => edge.target === targetId && edge.targetHandle === targetHandleId).flatMap(edge => {
    const node = findNode(nodes, edge.source);
    const handle = node?.data?.handles?.find(handle => handle.type === "source" && handle.id === edge.sourceHandle);
    return node && handle && isTypeCompatible(handle.dataType, target.dataType) ? [{ node, handle }] : [];
  });
}

function readSourceValue(node: PortNode, handle: NodeHandle): NodeOutput | undefined {
  const outputs = node.data?.outputs;
  if (!outputs || !Object.hasOwn(outputs, handle.id) || outputs[handle.id] === undefined) return;
  const output = outputs[handle.id];
  if (!isNodeOutput(output) || !isTypeCompatible(output.dataType, handle.dataType)) throw new Error(`节点 ${node.id} 的输出端口 ${handle.id} 值不符合类型声明`);
  return output;
}

export function getSourceValue<T extends PortNode>(sourceId: string, sourceHandleId: string, nodes: Nodes<T>): NodeOutput | undefined {
  const node = findNode(nodes, sourceId);
  const handle = node?.data?.handles?.find(handle => handle.type === "source" && handle.id === sourceHandleId);
  return node && handle ? readSourceValue(node, handle) : undefined;
}

export function getTargetValues<T extends PortNode>(targetId: string, targetHandleId: string, nodes: Nodes<T>, edges: readonly PortEdge[]): NodeInputValue[] {
  const target = findNode(nodes, targetId)?.data?.handles?.find(handle => handle.type === "target" && handle.id === targetHandleId);
  if (!target) return [];
  return getTargetSources(targetId, targetHandleId, nodes, edges).flatMap<NodeInputValue>(({ node, handle }) => {
    const output = readSourceValue(node, handle);
    if (!output) return [{ source: node.id, sourceHandle: handle.id, dataType: handle.dataType, value: undefined }];
    return isTypeCompatible(output.dataType, target.dataType) ? [{ ...output, source: node.id, sourceHandle: handle.id }] : [];
  });
}
