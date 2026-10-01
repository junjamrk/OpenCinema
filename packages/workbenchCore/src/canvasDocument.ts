import { z } from "zod";

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };
export type CanvasPosition = JsonObject & { x: number; y: number };
export type CanvasViewport = CanvasPosition & { zoom: number };
export type CanvasNode = JsonObject & {
  id: string;
  position: CanvasPosition;
  type?: string;
  data?: JsonObject;
  parentNode?: string;
  parentId?: string;
};
export type CanvasEdge = JsonObject & { id: string; source: string; target: string };
export type CanvasDocument = JsonObject & {
  toonflowCanvas: true;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport: CanvasViewport;
};

export const nodeIdSchema = z.string().min(1).max(256).refine(value => !/[\\/\0]/.test(value) && value !== "." && value !== "..", "节点 ID 无效");
export const positionSchema = z.looseObject({ x: z.number().finite(), y: z.number().finite() }).catchall(z.json());
export const viewportSchema = positionSchema.extend({ zoom: z.number().finite().positive() });
const handleSchema = z.object({ id: z.string().min(1).max(256), type: z.enum(["source", "target"]), dataType: z.union([z.string().min(1).max(128), z.array(z.string().min(1).max(128)).min(1).max(32)]), label: z.string().optional() }).passthrough();
export const canvasNodeSchema = z.looseObject({
  id: nodeIdSchema,
  position: positionSchema,
  type: z.string().min(1).optional(),
  data: z.record(z.string(), z.json()).optional(),
  parentNode: nodeIdSchema.optional(),
  parentId: nodeIdSchema.optional(),
}).catchall(z.json());
export const canvasEdgeSchema = z.looseObject({
  id: z.string().min(1).max(512).refine(value => !value.includes("\0"), "连线 ID 无效"),
  source: nodeIdSchema,
  target: nodeIdSchema,
}).catchall(z.json());
export const canvasDocumentSchema = z.looseObject({
  toonflowCanvas: z.literal(true),
  nodes: z.array(canvasNodeSchema).max(10000),
  edges: z.array(canvasEdgeSchema).max(20000),
  viewport: viewportSchema,
}).catchall(z.json());

export function parseCanvasDocument(input: unknown): CanvasDocument {
  const document = canvasDocumentSchema.parse(z.json().parse(input)) as CanvasDocument;
  const nodes = new Map(document.nodes.map(node => [node.id, node]));
  if (nodes.size !== document.nodes.length) throw new Error("画布中存在重复节点 ID");
  if (new Set(document.edges.map(edge => edge.id)).size !== document.edges.length) throw new Error("画布中存在重复连线 ID");
  for (const edge of document.edges) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) throw new Error(`连线 ${edge.id} 引用了不存在的节点`);
  }
  const visited = new Set<string>();
  for (const node of document.nodes) {
    if (node.data?.handles !== undefined) {
      const handles = z.array(handleSchema).max(256).parse(node.data.handles);
      if (new Set(handles.map(handle => `${handle.type}:${handle.id}`)).size !== handles.length) throw new Error(`节点 ${node.id} 包含重复端口`);
    }
    const ancestors = new Set<string>();
    let current: CanvasNode | undefined = node;
    while (current && !visited.has(current.id)) {
      if (ancestors.has(current.id)) throw new Error("节点分组存在循环引用");
      ancestors.add(current.id);
      if (current.parentNode && current.parentId && current.parentNode !== current.parentId) throw new Error(`节点 ${current.id} 的分组关系冲突`);
      const parent: string | undefined = current.parentNode ?? current.parentId;
      if (parent && !nodes.has(parent)) throw new Error(`节点 ${current.id} 引用了不存在的分组`);
      current = parent ? nodes.get(parent) : undefined;
    }
    for (const id of ancestors) visited.add(id);
  }
  return document;
}
