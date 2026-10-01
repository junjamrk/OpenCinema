import type { ReactNodeServices } from "./workbenchServices";

export type NodeDocumentService = {
  readNode(nodeId: string): unknown;
  getRevision(): number;
  readText(nodeId: string): Promise<string>;
  writeText(nodeId: string, text: string, expectedRevision?: number, signal?: AbortSignal): Promise<void>;
  updateData(data: Record<string, unknown>, expectedRevision?: number, signal?: AbortSignal): Promise<void>;
  updateRuntimeData(data: Record<string, unknown>, signal?: AbortSignal): Promise<void>;
  save(): Promise<void>;
};

export type ReactNodeViewProps = {
  readOnly?: boolean;
  toolbarMount?: HTMLElement;
  node: { id: string; data?: Record<string, unknown> };
  controller: ReactNodeServices & {
    getPluginService(nodeId: string): unknown;
    readNodeText(nodeId: string): Promise<string>;
    reloadNodeText(nodeId: string): Promise<string>;
    stageNodeText(nodeId: string, text: string): void;
    writeNodeText(nodeId: string, text: string): Promise<void>;
    acquireMedia(path: string, mimeType?: string): Promise<{ url: string; release(): void }>;
  };
};
