import { applyPatch, compare } from "fast-json-patch";
import type { WorkspaceCanvas } from "@toonflow/nodes-scaffold/workspaceDocuments";

const presentationFields = new Set(["selected", "initialized", "dimensions", "computedPosition", "handleBounds", "isParent", "resizing", "dragging", "events", "sourceNode", "targetNode", "sourceX", "sourceY", "targetX", "targetY"]);
export function canvasContent(document: WorkspaceCanvas) {
  const elements = (values: Record<string, any>[]) => Object.fromEntries(values.map(value => [value.id,
    Object.fromEntries(Object.entries(value).filter(([key]) => !presentationFields.has(key))),
  ]));
  return JSON.parse(JSON.stringify({ nodes: elements(document.nodes), edges: elements(document.edges) })) as { nodes: Record<string, Record<string, any>>; edges: Record<string, Record<string, any>> };
}
export type CanvasContent = ReturnType<typeof canvasContent>;
export function sameCanvasContent(left: CanvasContent, right: CanvasContent) {
  return compare(left, right).length === 0;
}
export function canvasDocument(content: CanvasContent, viewport: WorkspaceCanvas["viewport"]): WorkspaceCanvas {
  return { toonflowCanvas: true, nodes: Object.values(content.nodes), edges: Object.values(content.edges), viewport };
}
export function mergeCanvas(base: CanvasContent, document: CanvasContent, current: CanvasContent) {
  // ACT: 节点/连线是本阶段的冲突单位；数组及插件私有数据不猜测合并语义。
  const keys = new Set(compare(base, document).map(change => change.path.split("/").slice(1, 3).join("/")));
  for (const key of keys) {
    const [collection, escaped] = key.split("/");
    const id = escaped!.replaceAll("~1", "/").replaceAll("~0", "~");
    const values = collection as keyof CanvasContent;
    const before = base[values]?.[id], after = document[values]?.[id], latest = current[values]?.[id];
    const same = (left: unknown, right: unknown) => compare({ value: left }, { value: right }).length === 0;
    if (!same(before, latest) && !same(after, latest)) throw new Error("此节点已被其他会话修改");
  }
  const result = JSON.parse(JSON.stringify(current)) as CanvasContent;
  for (const key of keys) {
    const [collection, escaped] = key.split("/");
    const id = escaped!.replaceAll("~1", "/").replaceAll("~0", "~");
    const values = collection as keyof CanvasContent;
    if (Object.hasOwn(document[values], id)) result[values][id] = document[values][id]!;
    else delete result[values][id];
  }
  return applyPatch(current, compare(current, result, true), true, false, true).newDocument;
}
