export type WorkspaceCanvas = { toonflowCanvas: true; nodes: Record<string, any>[]; edges: Record<string, any>[]; viewport: { x: number; y: number; zoom: number } };
export type WorkspaceRuntimeUpdate = Readonly<{ id: string; data: Readonly<Record<string, unknown>> }>;
export type WorkspaceDocumentAdapter = {
  read(): WorkspaceCanvas;
  base(): WorkspaceCanvas;
  apply(document: WorkspaceCanvas, baseline?: WorkspaceCanvas): Promise<void>;
  busy(): boolean;
};
export type WorkspaceDocumentProvider = {
  readonly readOnly: boolean;
  canHistory(path: string, direction: "undo" | "redo"): boolean;
  save(path: string, document: WorkspaceCanvas, runtimeUpdates?: readonly WorkspaceRuntimeUpdate[]): Promise<WorkspaceCanvas>;
  observe(path: string, adapter: WorkspaceDocumentAdapter): () => void;
  history(path: string, direction: "undo" | "redo"): Promise<void>;
  flush(): Promise<void>;
};
export type WorkspaceDocuments = {
  directory: string;
  flush(): Promise<void>;
  connect(provider: WorkspaceDocumentProvider): () => void;
};
