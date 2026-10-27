import { z } from "zod";
import { canvasDocumentSchema, canvasEdgeSchema, canvasNodeSchema, nodeIdSchema, parseCanvasDocument, viewportSchema } from "./canvasDocument";
import type { CanvasDocument, JsonObject } from "./canvasDocument";

const idsSchema = z.array(nodeIdSchema).min(1).max(10000);
const changesSchema = z.record(z.string(), z.json()).refine(changes => !Object.hasOwn(changes, "id"), "不能通过补丁修改 ID");

export const commandSchemas = {
  addNodes: z.strictObject({ nodes: z.array(canvasNodeSchema).min(1).max(10000) }),
  updateNodes: z.strictObject({ updates: z.array(z.strictObject({ id: nodeIdSchema, changes: changesSchema })).min(1).max(10000) }),
  updateRuntimeData: z.strictObject({ updates: z.array(z.strictObject({ id: nodeIdSchema, data: z.record(z.string(), z.json()) })).min(1).max(10000) }),
  removeNodes: z.strictObject({ ids: idsSchema }),
  addEdges: z.strictObject({ edges: z.array(canvasEdgeSchema).min(1).max(20000) }),
  removeEdges: z.strictObject({ ids: z.array(z.string().min(1).max(512)).min(1).max(20000) }),
  setViewport: z.strictObject({ viewport: viewportSchema }),
  setNodeText: z.strictObject({ id: nodeIdSchema, text: z.string().max(10000000) }),
  replaceDocument: z.strictObject({ document: canvasDocumentSchema }),
};

type CommandSchemas = typeof commandSchemas;
export type DocumentOperation = {
  [Name in keyof CommandSchemas]: { name: Name; args: z.infer<CommandSchemas[Name]> }
}[keyof CommandSchemas];
export type DocumentCommand = (DocumentOperation | { name: "batch"; args: { commands: DocumentOperation[] } }) & { expectedRevision?: number };

const operationSchema = z.discriminatedUnion("name", [
  z.strictObject({ name: z.literal("addNodes"), args: commandSchemas.addNodes }),
  z.strictObject({ name: z.literal("updateNodes"), args: commandSchemas.updateNodes }),
  z.strictObject({ name: z.literal("updateRuntimeData"), args: commandSchemas.updateRuntimeData }),
  z.strictObject({ name: z.literal("removeNodes"), args: commandSchemas.removeNodes }),
  z.strictObject({ name: z.literal("addEdges"), args: commandSchemas.addEdges }),
  z.strictObject({ name: z.literal("removeEdges"), args: commandSchemas.removeEdges }),
  z.strictObject({ name: z.literal("setViewport"), args: commandSchemas.setViewport }),
  z.strictObject({ name: z.literal("setNodeText"), args: commandSchemas.setNodeText }),
  z.strictObject({ name: z.literal("replaceDocument"), args: commandSchemas.replaceDocument }),
]);
export const batchCommandSchema = z.strictObject({ commands: z.array(operationSchema).min(1).max(1000) });
const commandEnvelopeSchema = z.strictObject({
  name: z.enum([...Object.keys(commandSchemas) as (keyof CommandSchemas)[], "batch"]),
  args: z.unknown(),
  expectedRevision: z.number().int().nonnegative().optional(),
});

export function parseDocumentCommand(input: unknown): DocumentCommand {
  const command = commandEnvelopeSchema.parse(input);
  const args = command.name === "batch" ? batchCommandSchema.parse(command.args) : commandSchemas[command.name].parse(command.args);
  return { ...command, args } as DocumentCommand;
}

export function applyDocumentCommand(document: CanvasDocument, command: DocumentCommand): CanvasDocument {
  const operations = command.name === "batch" ? command.args.commands : [command];
  let result = document;
  for (const operation of operations) result = applyOperation(result, operation);
  return parseCanvasDocument(result);
}

function applyOperation(document: CanvasDocument, command: DocumentOperation): CanvasDocument {
  switch (command.name) {
    case "updateRuntimeData": {
      requireIds(document.nodes, command.args.updates.map(update => update.id));
      const updates = new Map(command.args.updates.map(update => [update.id, update.data]));
      return { ...document, nodes: document.nodes.map(node => updates.has(node.id) ? { ...node, data: { ...node.data, ...updates.get(node.id) } } : node) };
    }
    case "addNodes":
      return { ...document, nodes: [...document.nodes, ...command.args.nodes] } as CanvasDocument;
    case "updateNodes": {
      const updates = new Map(command.args.updates.map(update => [update.id, update.changes]));
      if (updates.size !== command.args.updates.length) throw new Error("同一命令不能重复修改节点");
      requireIds(document.nodes, [...updates.keys()]);
      return { ...document, nodes: document.nodes.map(node => {
        const changes = updates.get(node.id);
        if (!changes) return node;
        const next = { ...node, ...changes };
        if (changes.data && typeof changes.data === "object" && !Array.isArray(changes.data)) next.data = { ...node.data, ...changes.data };
        return next;
      }) } as CanvasDocument;
    }
    case "removeNodes": {
      requireIds(document.nodes, command.args.ids);
      const ids = new Set(command.args.ids);
      return { ...document, nodes: document.nodes.filter(node => !ids.has(node.id)), edges: document.edges.filter(edge => !ids.has(edge.source) && !ids.has(edge.target)) };
    }
    case "addEdges":
      return { ...document, edges: [...document.edges, ...command.args.edges] } as CanvasDocument;
    case "removeEdges": {
      requireIds(document.edges, command.args.ids);
      const ids = new Set(command.args.ids);
      return { ...document, edges: document.edges.filter(edge => !ids.has(edge.id)) };
    }
    case "setViewport":
      return { ...document, viewport: command.args.viewport } as CanvasDocument;
    case "setNodeText": {
      requireIds(document.nodes, [command.args.id]);
      const node = document.nodes.find(node => node.id === command.args.id)!;
      if (Object.hasOwn(node.data ?? {}, "textPath")) throw new Error("此节点正文保存在外部文件，请使用节点文本能力更新，不能改为内联正文");
      return { ...document, nodes: document.nodes.map(node => node.id === command.args.id ? { ...node, data: { ...node.data, text: command.args.text } as JsonObject } : node) };
    }
    case "replaceDocument":
      return command.args.document as CanvasDocument;
  }
}

function requireIds(values: { id: string }[], ids: string[]) {
  if (new Set(ids).size !== ids.length) throw new Error("同一命令包含重复 ID");
  const existing = new Set(values.map(value => value.id));
  for (const id of ids) if (!existing.has(id)) throw new Error(`目标不存在：${id}`);
}
