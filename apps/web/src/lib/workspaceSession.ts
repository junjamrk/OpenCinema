import type { WorkspaceDocumentAdapter, WorkspaceDocumentProvider, WorkspaceDocuments } from "@toonflow/nodes-scaffold/workspaceDocuments";

export function createWorkspaceSession(directory: string, options: { flush(): Promise<void>; changed(): void }) {
  let provider: WorkspaceDocumentProvider | undefined;
  const bindings = new Map<string, { adapter: WorkspaceDocumentAdapter; release?: () => void }>();
  const documents: WorkspaceDocuments = {
    directory,
    async flush() { await options.flush(); await provider?.flush(); },
    connect(next) {
      if (provider && provider !== next) throw new Error("当前工作区已连接文档服务");
      provider = next;
      for (const [path, binding] of bindings) { binding.release?.(); binding.release = next.observe(path, binding.adapter); }
      options.changed();
      return () => {
        if (provider !== next) return;
        for (const binding of bindings.values()) { binding.release?.(); binding.release = undefined; }
        provider = undefined;
        options.changed();
      };
    },
  };
  return {
    documents,
    state: new Map<string, unknown>(),
    get provider() { return provider; },
    observe(path: string, adapter: WorkspaceDocumentAdapter) {
      const binding = { adapter, release: provider?.observe(path, adapter) };
      bindings.set(path, binding);
      return () => { if (bindings.get(path) === binding) { binding.release?.(); bindings.delete(path); } };
    },
    dispose() {
      for (const binding of bindings.values()) binding.release?.();
      bindings.clear(); provider = undefined;
    },
  };
}

export type WorkspaceSession = ReturnType<typeof createWorkspaceSession>;
