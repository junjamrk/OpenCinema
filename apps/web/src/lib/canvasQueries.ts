import { canvasSchemas, type CanvasToolCall } from "@toonflow/tool-canvas/runtime";
import { isCanvasRead } from "./workbenchTools";
import type { NodeToolsContext } from "@toonflow/tools-scaffold/runtime";

export type CanvasQueryNode = { id: string; type?: string; label?: unknown; position: { x: number; y: number }; parentId?: string; parentNode?: string; origin?: unknown; extent?: unknown; hidden?: unknown; draggable?: unknown; resizable?: unknown; deletable?: unknown; selectable?: unknown; connectable?: unknown; width?: number; height?: number; selected?: boolean; data?: Record<string, unknown> };
export type CanvasQueryEdge = { id: string; source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null };
type ValueOptions = { textOffset: number; textLimit: number; valueOffset: number; valueLimit: number };
type OmittedValue = { path: string[]; reason: string; total?: number; nextOffset?: number };
export type CanvasQueryAvailability = {
  status: "available" | "unavailable" | "unknown";
  code: string;
  reason: string;
  requires: Record<string, number>;
  requirementsDeclared: boolean;
  missingCapabilities: { name: string; requiredVersion: number; providedVersion: number }[];
  recovery: { action: string; message: string; tool?: string; args?: Record<string, unknown> };
};
export type CanvasQueryRuntime = { renderer: "react"; provider: "reactWeb" | "nativeWidget"; declaredCapabilities: Readonly<Record<string, number>>; scope: string; executionDependencies: { webGl: "unknown"; models: "unknown"; mediaTools: "unknown"; observeTool: "getModelStatus" } };
const encoder = new TextEncoder();
const responseBytes = 64 * 1024;
const pageBytes = 52 * 1024;
const scanLimit = 2000;
export { isCanvasRead } from "./workbenchTools";

export function canvasNodePosition(node: CanvasQueryNode, findNode: (id: string) => CanvasQueryNode | undefined, absoluteAncestors?: ReadonlyMap<string, { x: number; y: number }>) {
  const point = { ...node.position }, visited = new Set([node.id]);
  let parentId = node.parentId ?? node.parentNode;
  while (parentId) {
    if (visited.has(parentId)) throw new Error("节点分组存在循环引用");
    visited.add(parentId);
    const parent = findNode(parentId);
    if (!parent) throw new Error(`父分组不存在：${parentId}`);
    const origin = Array.isArray(parent.origin) && parent.origin.length === 2 && parent.origin.every(value => typeof value === "number" && Number.isFinite(value)) ? parent.origin : [0, 0];
    if ((origin[0] && !parent.width) || (origin[1] && !parent.height)) throw new Error(`父分组 ${parentId} 尺寸尚未就绪`);
    const absolute = absoluteAncestors?.get(parentId), position = absolute ?? parent.position;
    point.x += position.x - origin[0] * (parent.width ?? 0);
    point.y += position.y - origin[1] * (parent.height ?? 0);
    if (absolute) break;
    parentId = parent.parentId ?? parent.parentNode;
  }
  return point;
}

function jsonSize(value: unknown, limit = responseBytes) {
  let remaining = limit;
  const ancestors = new Set<object>();
  function measure(value: unknown, depth: number) {
    if (remaining < 0) return;
    if (typeof value === "string") {
      if (value.length > remaining) { remaining = -1; return; }
      remaining -= encoder.encode(JSON.stringify(value)).length;
    } else if (value === null || typeof value !== "object") {
      remaining -= (JSON.stringify(value) ?? "null").length;
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (depth > 64 || ancestors.has(value) || typeof Reflect.get(value, "toJSON") === "function"
        || (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)) { remaining = -1; return; }
      ancestors.add(value);
      remaining -= 2;
      let count = 0;
      if (Array.isArray(value)) {
        if (value.length > remaining) remaining = -1;
        else for (let index = 0; index < value.length && remaining >= 0; index++) {
          if (index) remaining--;
          measure(value[index], depth + 1);
        }
      } else {
        for (const key in value) {
          if (!Object.hasOwn(value, key)) continue;
          const entry = Reflect.get(value, key);
          if (entry === undefined || typeof entry === "function") continue;
          if (count++) remaining--;
          measure(key, depth + 1);
          remaining--;
          measure(entry, depth + 1);
          if (remaining < 0) break;
        }
      }
      ancestors.delete(value);
    }
  }
  measure(value, 0);
  return limit - remaining;
}

// ACT: 投影只遍历有界的字段和字符串，不调用节点自定义 toJSON，也不复制整幅画布。
function projectValue(value: unknown, options: ValueOptions, path: string[] = []) {
  const truncated: OmittedValue[] = [];
  let remaining = 36 * 1024;
  let visited = 0;
  const ancestors = new Set<object>();
  function omit(path: string[], reason: string, extra: Partial<OmittedValue> = {}) {
    const entry = { path, reason, ...extra };
    truncated.push(entry);
    remaining -= jsonSize(entry) + 1;
    return null;
  }
  function copy(value: unknown, path: string[], depth: number): unknown {
    if (jsonSize(path, 2048) > 2048) return omit(path.slice(0, -1), "pathBytesLimit");
    const reserve = jsonSize(path) + 1024;
    if (remaining < reserve || ++visited > 256) return omit(path, "budget");
    if (typeof value === "string") {
      const offset = options.textOffset;
      const end = Math.min(value.length, offset + options.textLimit, offset + Math.floor((remaining - reserve) / 6));
      const text = value.slice(offset, end);
      remaining -= jsonSize(text);
      if (offset > 0 || end < value.length) omit(path, "text", { total: value.length, ...(end < value.length ? { nextOffset: end } : {}) });
      return text;
    }
    if (value === null || typeof value === "number" || typeof value === "boolean") { remaining -= 32; return value; }
    if (typeof value !== "object") return null;
    if (path.length >= 64) return omit(path, "pathDepthLimit");
    if (depth >= 6) return omit(path, "depth");
    if (ancestors.has(value)) return omit(path, "circular");
    ancestors.add(value);
    const offset = depth === 0 ? options.valueOffset : 0;
    const result: unknown[] | Record<string, unknown> = Array.isArray(value) ? [] : Object.create(null);
    let count = 0;
    if (Array.isArray(value)) {
      for (let index = offset; index < value.length; index++) {
        if (count >= options.valueLimit || remaining < reserve || visited >= 256) {
          omit(path, "entries", { total: value.length, nextOffset: index });
          break;
        }
        (result as unknown[]).push(copy(value[index], [...path, String(index)], depth + 1));
        count++;
      }
      if (offset > 0 && offset + count >= value.length) omit(path, "entries", { total: value.length });
    } else {
      let index = 0;
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        if (index++ < offset) continue;
        if (count >= options.valueLimit || remaining < reserve || visited >= 256) {
          omit(path, "entries", { nextOffset: index - 1 });
          break;
        }
        if (key.length > 256) { omit(path, "keyTooLong", { nextOffset: index }); break; }
        remaining -= jsonSize(key) + 2;
        (result as Record<string, unknown>)[key] = copy(Reflect.get(value, key), [...path, key], depth + 1);
        count++;
      }
      if (offset > 0 && !truncated.some(item => item.path === path)) omit(path, "entries");
    }
    ancestors.delete(value);
    return result;
  }
  return { value: copy(value, path, 0), truncated };
}

export function canvasNodeSummary(node: CanvasQueryNode) {
  const label = typeof node.data?.label === "string" ? node.data.label : typeof node.label === "string" ? node.label : node.id;
  return { id: node.id, type: node.type, label: label.slice(0, 512), ...(label.length > 512 ? { labelTruncated: true } : {}), selected: !!node.selected };
}

function nodeLayout(node: CanvasQueryNode) {
  const origin = Array.isArray(node.origin) && node.origin.length === 2 && node.origin.every(value => typeof value === "number" && Number.isFinite(value)) ? [...node.origin] : [0, 0];
  const extent = node.extent == null ? null : node.extent === "parent" ? "parent" : Array.isArray(node.extent) && node.extent.length === 2 && node.extent.every(point => Array.isArray(point) && point.length === 2 && point.every(value => typeof value === "number" && Number.isFinite(value))) ? node.extent.map(point => [...point]) : "invalid";
  return { origin, extent, hidden: node.hidden === true, draggable: node.draggable !== false, resizable: node.resizable !== false, deletable: node.deletable !== false, selectable: node.selectable !== false, connectable: node.connectable !== false };
}

export function canvasEdgeSummary(edge: CanvasQueryEdge) {
  return { id: edge.id, source: edge.source, target: edge.target, sourceHandle: edge.sourceHandle, targetHandle: edge.targetHandle };
}

export function createCanvasQueries(source: {
  nodes(): readonly CanvasQueryNode[];
  edges(): readonly CanvasQueryEdge[];
  findNode(id: string): CanvasQueryNode | undefined;
  viewport(): { x: number; y: number; zoom: number };
  selectedCount(): number;
  nodeRevision(): number;
  edgeRevision(): number;
  documentRevision(): number;
  canvases(signal?: AbortSignal): Promise<{ id: string; name: string }[]>;
  nodeTypes(): { type: string; label: string; supported?: boolean; requires?: Record<string, number>; availability?: CanvasQueryAvailability }[];
  nodeAvailability(ids: string[]): ({ nodeId: string; pluginId: string } & CanvasQueryAvailability)[];
  runtime(): CanvasQueryRuntime;
  nodeTools(): NodeToolsContext;
}) {
  const sessionId = crypto.randomUUID();
  function findNode(id: string) {
    const node = source.findNode(id);
    if (!node) throw new Error(`节点不存在：${id}`);
    return node;
  }

  return async function read(request: CanvasToolCall, canvasId: string, signal: AbortSignal) {
    if (!isCanvasRead(request.name)) throw new Error("未知画布查询");
    const name = request.name as "getCanvas" | "findCanvasNodes" | "getCanvasNodes" | "getCanvasEdges" | "getNodeTools";
    const args = canvasSchemas[name].parse(request.args);
    if (args.canvasId !== undefined && args.canvasId !== canvasId) throw new Error("目标画布已切换，请重新查询画布");
    const { cursor, ...filters } = args;
    const metadata = name === "getCanvas" ? {
      canvases: (args as { include?: string[] }).include?.includes("canvases") ? await source.canvases(signal) : [],
      types: (args as { include?: string[] }).include?.includes("nodeTypes") ? source.nodeTypes() : [],
    } : undefined;
    const nodeState = name === "getNodeTools" ? { availability: source.nodeAvailability((args as { nodeIds: string[] }).nodeIds), runtime: source.runtime() } : undefined;
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify([name, filters, metadata, nodeState])));
    signal.throwIfAborted();
    const key = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    const revision = name === "getCanvasEdges" ? source.edgeRevision() : name === "getNodeTools" ? `${source.nodeRevision()}:${source.nodeTools().version}` : source.nodeRevision();
    let offset = 0;
    if (cursor) {
      let page: unknown;
      try { page = JSON.parse(cursor); } catch { throw new Error("分页游标无效，请重新查询"); }
      if (!Array.isArray(page) || page.length !== 6 || page[0] !== sessionId || page[1] !== canvasId || page[2] !== revision || page[3] !== key || !Number.isSafeInteger(page[4]) || page[4] < 0 || page[5] !== name) {
        throw new Error("画布结构或查询参数已变化，分页游标失效，请重新查询");
      }
      offset = page[4];
    }
    const items: unknown[] = [];
    let bytes = nodeState ? jsonSize(nodeState) : 0;
    if (bytes > pageBytes) throw new Error("节点可用性摘要超过预算，请减少nodeIds");
    function append(value: unknown) {
      const size = jsonSize(value) + 1;
      if (bytes + size > pageBytes) {
        if (!items.length) throw new Error("单项结果超过读取预算，请缩小nodeIds、fields、dataKeys、names或textLimit；函数参数定义不会截断");
        return false;
      }
      bytes += size;
      items.push(value);
      return true;
    }
    function finish(field: string, hasMore: boolean, extra: Record<string, unknown> = {}) {
      const result = { canvasId, documentRevision: source.documentRevision(), queryRevision: revision, toolCatalogVersion: source.nodeTools().version,
        ...(field ? { [field]: items } : {}), ...nodeState, ...extra, hasMore, nextCursor: hasMore ? JSON.stringify([sessionId, canvasId, revision, key, offset, name]) : null };
      if (jsonSize(result) > responseBytes) throw new Error("读取结果超过 64 KiB，请缩小查询范围");
      return result;
    }

    switch (name) {
      case "getCanvas": {
        const args = canvasSchemas.getCanvas.parse(request.args);
        const canvases = metadata!.canvases;
        const types = metadata!.types;
        const total = Math.max(canvases.length, types.length);
        const canvasItems: unknown[] = [];
        const typeItems: unknown[] = [];
        while (offset < total && items.length < args.limit) {
          const canvas = canvases[offset];
          const type = types[offset];
          const pair = { ...(canvas ? { canvas } : {}), ...(type ? { type } : {}) };
          if (!append(pair)) break;
          if (canvas) canvasItems.push(canvas);
          if (type) typeItems.push(type);
          offset++;
        }
        return finish("", offset < total, {
          id: canvasId, nodeCount: source.nodes().length, edgeCount: source.edges().length,
          selectedCount: source.selectedCount(), viewport: { ...source.viewport() },
          ...(args.include?.includes("canvases") ? { canvases: canvasItems, canvasCount: canvases.length } : {}),
          ...(args.include?.includes("nodeTypes") ? { availableNodeTypes: typeItems, nodeTypeCount: types.length } : {}),
        });
      }
      case "findCanvasNodes": {
        const args = canvasSchemas.findCanvasNodes.parse(request.args);
        const nodes = source.nodes();
        const keyword = args.query?.trim().toLocaleLowerCase();
        const types = args.types?.length ? new Set(args.types) : undefined;
        const start = offset;
        // ACT: ID 读取复用原生索引；关键词检索按 2000 条分段扫描，频繁全图检索时再维护名称索引。
        while (offset < nodes.length && offset - start < scanLimit && items.length < args.limit) {
          const node = nodes[offset]!;
          const summary = canvasNodeSummary(node);
          const label = typeof node.data?.label === "string" ? node.data.label : typeof node.label === "string" ? node.label : node.id;
          if ((!types || types.has(node.type ?? "")) && (!args.selectedOnly || node.selected) && (!keyword || `${node.id} ${label}`.toLocaleLowerCase().includes(keyword))) {
            if (!append(summary)) break;
          }
          offset++;
        }
        return finish("nodes", offset < nodes.length, { scanned: offset - start, totalNodes: nodes.length });
      }
      case "getCanvasNodes": {
        const args = canvasSchemas.getCanvasNodes.parse(request.args);
        const ids = [...new Set(args.nodeIds)];
        const children = new Map<string, string[]>();
        if (args.fields.includes("children") || args.path?.[0] === "children") for (const child of source.nodes()) {
          const parentId = child.parentId ?? child.parentNode;
          if (!parentId) continue;
          const siblings = children.get(parentId) ?? [];
          siblings.push(child.id); children.set(parentId, siblings);
        }
        while (offset < ids.length) {
          const node = findNode(ids[offset]!);
          const summary = canvasNodeSummary(node);
          const data = node.data ?? {};
          const fields: Record<string, unknown> = {
            label: typeof data.label === "string" ? data.label : node.label ?? node.id,
            type: node.type, position: { x: node.position.x, y: node.position.y },
            parentId: node.parentId ?? node.parentNode ?? null, children: children.get(node.id) ?? [],
            ...((args.fields.includes("absolutePosition") || args.path?.[0] === "absolutePosition") ? { absolutePosition: canvasNodePosition(node, source.findNode) } : {}),
            width: node.width ?? null, height: node.height ?? null,
            layout: nodeLayout(node),
            ports: data.handles ?? [], outputs: data.outputs ?? {}, data,
          };
          let projected: unknown;
          let path: string[] = [];
          if (args.path) {
            path = args.path;
            projected = fields;
            for (const part of path) {
              if (!projected || typeof projected !== "object" || !Object.hasOwn(projected, part)) throw new Error(`节点 ${node.id} 不存在路径 ${path.join(".")}`);
              projected = Reflect.get(projected, part);
            }
            if (args.textOffset > 0 && typeof projected !== "string") throw new Error("textOffset 仅用于字符串路径");
            if (args.valueOffset > 0 && (!projected || typeof projected !== "object")) throw new Error("valueOffset 仅用于数组或对象路径");
          } else {
            projected = Object.create(null);
            for (const field of args.fields) {
              (projected as Record<string, unknown>)[field] = field === "data" && args.dataKeys
                ? Object.fromEntries(args.dataKeys.filter(key => Object.hasOwn(data, key)).map(key => [key, data[key]])) : fields[field];
            }
          }
          const preview = projectValue(projected, args, path);
          if (!args.path) {
            preview.truncated = preview.truncated.flatMap(item => item.path.length ? [item]
              : args.fields.slice(item.nextOffset ?? 0).map(field => ({ path: [field], reason: "budget" })));
          }
          const value = args.path ? { id: node.id, path, value: preview.value, truncated: preview.truncated }
            : { id: node.id, ...(preview.value as object), selected: summary.selected, truncated: preview.truncated };
          if (!append(value)) break;
          offset++;
        }
        return finish("nodes", offset < ids.length);
      }
      case "getCanvasEdges": {
        const args = canvasSchemas.getCanvasEdges.parse(request.args);
        const ids = args.nodeIds ? new Set(args.nodeIds) : undefined;
        ids?.forEach(findNode);
        const edges = source.edges();
        const start = offset;
        while (offset < edges.length && offset - start < scanLimit && items.length < args.limit) {
          const edge = edges[offset]!;
          if (!ids || (args.direction !== "incoming" && ids.has(edge.source)) || (args.direction !== "outgoing" && ids.has(edge.target))) {
            if (!append(canvasEdgeSummary(edge))) break;
          }
          offset++;
        }
        return finish("edges", offset < edges.length, { scanned: offset - start, totalEdges: edges.length });
      }
      case "getNodeTools": {
        const args = canvasSchemas.getNodeTools.parse(request.args);
        args.nodeIds.forEach(findNode);
        let index = 0;
        for (const tool of source.nodeTools().list(args.nodeIds, args.names)) {
          if (index++ < offset) continue;
          if (items.length >= args.limit || !append(tool)) return finish("nodeTools", true);
          offset++;
        }
        return finish("nodeTools", false);
      }
    }
  };
}
