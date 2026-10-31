import type { ComponentType } from "react";
import type { ReactNodeServices, NodeWorkbenchService } from "@toonflow/nodes-scaffold/workbenchServices";
import type { HostResponse, NodePluginDefinition } from "@toonflow/nodes-scaffold/contracts";
import type { CanvasManagementAction } from "@/lib/workspaceCanvasManager";

export type WorkbenchPosition = { x: number; y: number };

export type CanvasViewOptions = {
  miniMap: boolean;
  snapEnabled: boolean;
  showEdges: boolean;
  highlight: "none" | "upstream" | "downstream" | "both";
};

export type WorkbenchHandle = {
  id: string;
  type: "source" | "target";
  label?: string;
  dataType?: string | string[];
};

export type WorkbenchNode = {
  id: string;
  type?: string;
  position: WorkbenchPosition;
  data?: {
    label?: string;
    handles?: WorkbenchHandle[];
    [key: string]: unknown;
  };
  parentNode?: string;
  parentId?: string;
  width?: number;
  height?: number;
  [key: string]: unknown;
};

export type WorkbenchEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  [key: string]: unknown;
};

export type WorkbenchDocument = {
  nodes: WorkbenchNode[];
  edges: WorkbenchEdge[];
  viewport?: { x: number; y: number; zoom: number };
  [key: string]: unknown;
};

export type WorkbenchPlugin = {
  type: string;
  label: string;
  category?: string;
  description?: string;
  icon?: string;
  composer?: NodePluginDefinition["composer"];
  supported?: boolean;
};

export type WorkbenchSnapshot = {
  canvasView?: CanvasViewOptions;
  document: WorkbenchDocument | null;
  directory: string | null;
  canvasId: string | null;
  revision: number | string;
  dirty: boolean;
  saving: boolean;
  readOnly: boolean;
  transitioning: boolean;
  error: string | null;
  canUndo: boolean;
  canRedo: boolean;
  projectName: string;
  canvasFiles: { path: string; name: string }[];
  canvasFolders: string[];
  plugins: WorkbenchPlugin[];
  workspacePlugins: { id: string; label: string; enabled: boolean }[];
  host: { name: string; connected: boolean; canSend: boolean };
  selectedIds: string[];
};

export type WorkbenchNodeViewProps = {
  node: WorkbenchNode;
  controller: WorkbenchController;
  readOnly?: boolean;
  toolbarMount?: HTMLElement;
};

export type NodeEditorViewState = {
  nodeId: string;
  open: boolean;
  phase: "inline" | "opening" | "open" | "closing";
  viewRevision: number;
  ready: boolean;
  available: boolean;
};

export type NodeEditorViewAdapter = {
  read(): NodeEditorViewState;
  set(input: { open: boolean; expectedViewRevision: number }, signal?: AbortSignal): Promise<NodeEditorViewState>;
};

export type WorkbenchController = ReactNodeServices & {
  getPluginService(nodeId: string): unknown;
  importMedia(files: File[], position: WorkbenchPosition): Promise<void>;
  getWorkspacePlugin(id: string): { view: ComponentType<{ service: unknown }>; service: unknown } | undefined;
  attachCanvasView(view: { fit(nodeIds?: string[]): Promise<{ x: number; y: number; zoom: number }>; measure(id: string): { width: number; height: number } | undefined; getOptions?(): CanvasViewOptions; setOptions?(options: Partial<CanvasViewOptions>): void }): () => void;
  attachNodeEditorView(nodeId: string, adapter: NodeEditorViewAdapter): () => void;
  attachComposer(listener: (input: { nodeId: string } & NonNullable<Parameters<NodeWorkbenchService["focusComposer"]>[0]>) => void): () => void;
  addCanvas(name?: string): Promise<void>;
  renameCanvas(name: string, fileRevision?: string): Promise<void>;
  manageCanvas(action: CanvasManagementAction): Promise<void>;
  renameProject(name: string): Promise<void>;
  refreshPlugins(): Promise<void>;
  /** 立即加载插件模块，返回加载失败的原因；成功时返回 undefined。 */
  probePlugin(id: string): Promise<string | undefined>;
  getPluginError(id: string): string | undefined;
  getCapabilities(): Readonly<Record<string, number>>;
  setPluginEnabled(id: string, enabled: boolean): Promise<void>;
  getHistory(): { mode: "local" | "collaboration"; revision: number; savedRevision: number; entries: { direction: "undo" | "redo"; steps: number; nodes: number; edges: number }[] };
  asOneHistoryStep<T>(operation: (step: <R>(run: () => Promise<R>) => Promise<R>) => Promise<T>): Promise<T>;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => WorkbenchSnapshot;
  openProject: (directory: string, initialCanvasId?: string) => Promise<void>;
  switchCanvas: (path: string, signal?: AbortSignal) => Promise<void>;
  execute: (name: string, args: Record<string, unknown>) => unknown | Promise<unknown>;
  validateConnection(connection: { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }): boolean;
  select: (ids: string[]) => void;
  save: () => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  sendPrompt: (prompt: string, options?: { nodeIds?: string[]; action?: { nodeId: string; tool: string } }) => Promise<HostResponse>;
  addNode: (type: string, position: WorkbenchPosition) => Promise<unknown>;
  compatibleNodeTypes: (nodeId: string, handleId: string, direction: "source" | "target") => Promise<string[]>;
  addConnectedNode: (type: string, position: WorkbenchPosition, endpoint: { nodeId: string; handleId: string; direction: "source" | "target" }) => Promise<void>;
  exportProject: () => Promise<void>;
  acquireMedia: (path: string, mimeType?: string) => Promise<{ url: string; release: () => void }>;
  readNodeText: (nodeId: string) => Promise<string>;
  reloadNodeText: (nodeId: string) => Promise<string>;
  stageNodeText: (nodeId: string, text: string) => void;
  writeNodeText: (nodeId: string, text: string) => Promise<void>;
  getNodeView?: (type: string) => ComponentType<WorkbenchNodeViewProps> | undefined;
  getNodeError?: (nodeId: string) => string | undefined;
};
