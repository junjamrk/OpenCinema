import { createBrowserFfmpeg } from "@toonflow/ffmpeg/browser";
import { getTargetValues, type PortNode, type PortEdge } from "@toonflow/nodes-scaffold/nodePortValues";
import type { NodeDocumentService } from "@toonflow/nodes-scaffold/react";
import type { NodeWorkbenchService } from "@toonflow/nodes-scaffold/workbenchServices";
import type { CanvasDocument } from "@toonflow/workbench-core";
import { createWorkspaceFiles } from "./workspaceFileClient";

export function createNodeWorkbench(options: {
  directory: string;
  canvasId: string;
  nodeId: string;
  signal: AbortSignal;
  document: NodeDocumentService;
  readCanvas(): CanvasDocument;
  assertWritable(expectedRevision?: number): void;
  createNodes: NodeWorkbenchService["createNodes"];
  updateNodes: NodeWorkbenchService["updateNodes"];
  disconnectInput: NodeWorkbenchService["disconnectInput"];
  hostRequest: NodeWorkbenchService["hostRequest"];
  focusComposer: NodeWorkbenchService["focusComposer"];
  selectNodes: NodeWorkbenchService["selectNodes"];
  getLayout: NodeWorkbenchService["getLayout"];
}): NodeWorkbenchService {
  const source = createWorkspaceFiles(options.directory);
  const signal = (value?: AbortSignal) => AbortSignal.any([options.signal, ...(value ? [value] : [])]);
  function read() { options.signal.throwIfAborted(); options.document.readNode(options.nodeId); }
  function write() { read(); options.assertWritable(); }
  const files: NodeWorkbenchService["files"] = {
    async list(path) { read(); return source.list(path, options.signal); },
    async read(path, maxBytes, requestSignal) { read(); return source.read(path, maxBytes, signal(requestSignal)); },
    async readRange(path, offset, length, revision, requestSignal) { read(); return source.readRange(path, offset, length, revision, signal(requestSignal)); },
    acquireUrl(path, mimeType) { read(); return source.acquireUrl(path, mimeType); },
    async readText(path) { read(); return source.readText(path, undefined, options.signal); },
    async readJson<T>(path: string) { read(); return source.readJson<T>(path, options.signal); },
    async readTextSnapshot(path) { read(); return source.readTextSnapshot(path, { signal: options.signal }); },
    async writeTextSnapshot(path, text, snapshot) { write(); return source.writeTextSnapshot(path, text, snapshot); },
    async write(path, content, exclusive) { write(); await source.write(path, content, exclusive, options.signal); read(); },
    async writeJson(path, value, exclusive) { write(); await source.write(path, `${JSON.stringify(value, null, 2)}\n`, exclusive, options.signal); read(); },
    async rename(path, target) { write(); await source.rename(path, target); read(); },
    async remove(path, recursive) { write(); await source.remove(path, recursive); read(); },
    async mkdir(path) { write(); await source.mkdir(path); read(); },
    async saveProjectArchive(path, requestSignal) { write(); const artifact = await source.saveProjectArchive(path, signal(requestSignal)); read(); return artifact; },
  };
  return {
    directory: options.directory,
    canvasId: options.canvasId,
    files,
    assertWritable: options.assertWritable,
    getInputs(handleId) {
      read();
      const canvas = options.readCanvas();
      const nodes = canvas.nodes as unknown as PortNode[], edges = canvas.edges as unknown as PortEdge[];
      const node = nodes.find(node => node.id === options.nodeId);
      const handles = Array.isArray(node?.data?.handles) ? node.data.handles.filter(handle => handle.type === "target" && (!handleId || handle.id === handleId)) : [];
      return handles.flatMap(handle => getTargetValues(options.nodeId, handle.id, nodes, edges));
    },
    readNodes() { read(); return structuredClone(options.readCanvas().nodes.map(node => ({ id: node.id, ...(node.type ? { type: node.type } : {}), data: node.data ?? {} }))); },
    updateData: options.document.updateData,
    updateRuntimeData: options.document.updateRuntimeData,
    createNodes: options.createNodes,
    updateNodes: options.updateNodes,
    disconnectInput: options.disconnectInput,
    async ffmpeg(requestSignal) { write(); return createBrowserFfmpeg(options.directory, signal(requestSignal)); },
    hostRequest: options.hostRequest,
    focusComposer(input) { write(); options.focusComposer(input); },
    selectNodes(nodeIds) { write(); options.selectNodes(nodeIds); },
    getLayout() { read(); return options.getLayout(); },
  };
}
