type CanvasDocument = { toonflowCanvas: true; nodes: unknown[]; edges: unknown[]; [key: string]: unknown };
const presentationFields = new Set(["selected", "initialized", "dimensions", "computedPosition", "handleBounds", "isParent", "resizing", "dragging", "events", "sourceNode", "targetNode", "sourceX", "sourceY", "targetX", "targetY"]);

export function canvasContent(document: CanvasDocument, includeOutputs = true, includeTextMetadata = true) {
  const element = (value: unknown) => {
    const fields = Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !presentationFields.has(key)));
    if (fields.data) {
      const data = { ...fields.data as Record<string, unknown> };
      if (!includeOutputs) delete data.outputs;
      if (!includeTextMetadata && fields.type === "remote-textNode") { delete data.studioTextSha256; delete data.studioTextVersioned; }
      fields.data = data;
    }
    return fields;
  };
  const { viewport, toonflowStudio, ...content } = document;
  return { ...content, nodes: document.nodes.map(element), edges: document.edges.map(element) };
}

export function preserveCanvasPresentation(restored: CanvasDocument, current: CanvasDocument): CanvasDocument {
  const preserve = (values: unknown[], previous: unknown[]) => {
    const byId = new Map(previous.map(value => [(value as { id: string }).id, value as Record<string, unknown>]));
    return values.map(value => {
      const fields = { ...value as Record<string, unknown> };
      const existing = byId.get(fields.id as string);
      for (const key of presentationFields) { delete fields[key]; if (existing && Object.hasOwn(existing, key)) fields[key] = existing[key]; }
      if (existing && fields.data) {
        const outputs = (existing.data as { outputs?: unknown } | undefined)?.outputs;
        const data = { ...fields.data as Record<string, unknown> };
        if (outputs === undefined) delete data.outputs;
        else data.outputs = outputs;
        fields.data = data;
      }
      return fields;
    });
  };
  return { ...restored, viewport: current.viewport, nodes: preserve(restored.nodes, current.nodes), edges: preserve(restored.edges, current.edges) };
}

export function rebaseCanvasOutputs(document: CanvasDocument, base: CanvasDocument, current: CanvasDocument): CanvasDocument | undefined {
  const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  if (canonical(canvasContent(base, false, false)) !== canonical(canvasContent(current, false, false))) return;
  const outputs = (value: unknown) => (value as { data?: { outputs?: Record<string, unknown> } } | undefined)?.data?.outputs ?? {};
  const previous = new Map(base.nodes.map(node => [(node as { id: string }).id, outputs(node)]));
  const latest = new Map(current.nodes.map(node => [(node as { id: string }).id, outputs(node)]));
  const merged = JSON.parse(JSON.stringify(document)) as CanvasDocument;
  for (const value of merged.nodes) {
    const node = value as { id: string; type?: string; data?: { studioShotId?: string; outputs?: Record<string, unknown> } };
    const before = previous.get(node.id) ?? {}, after = latest.get(node.id) ?? {}, local = outputs(node);
    for (const handle of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (canonical(before[handle]) === canonical(after[handle])) continue;
      const authoritative = node.data?.studioShotId && ["remote-director3dNode", "remote-motionAnalysisNode"].includes(node.type ?? "");
      if (!authoritative && canonical(local[handle]) !== canonical(before[handle]) && canonical(local[handle]) !== canonical(after[handle])) return;
      node.data ??= {}; node.data.outputs ??= {};
      if (after[handle] === undefined) delete node.data.outputs[handle];
      else node.data.outputs[handle] = after[handle];
    }
  }
  return merged;
}

export { isNodeOutput } from "@toonflow/nodes-scaffold/values";
