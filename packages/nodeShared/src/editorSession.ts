import { useSyncExternalStore } from "react";
import type { NodeWorkbenchService } from "@toonflow/nodes-scaffold/workbenchServices";

// 仅存局部编辑台尚未采用的视图状态；作品仍由原 document service 保存。
const sessions = new WeakMap<NodeWorkbenchService, Map<string, EditorSession<unknown>>>();
export type EditorSession<T> = ReturnType<typeof createSession<T>>;

function createSession<T>(initial: T) {
  let snapshot = { value: structuredClone(initial), revision: 0 };
  const listeners = new Set<() => void>();
  return {
    read: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    replace(value: T, expectedRevision?: number) {
      if (expectedRevision !== undefined && expectedRevision !== snapshot.revision) throw Object.assign(new Error("编辑台草稿已变化，请重新读取后协调"), { code: "draftRevisionConflict", actualRevision: snapshot.revision });
      if (JSON.stringify(value) === JSON.stringify(snapshot.value)) return snapshot;
      snapshot = { value: structuredClone(value), revision: snapshot.revision + 1 };
      for (const listener of listeners) listener();
      return snapshot;
    },
  };
}

export function editorSession<T>(workbench: NodeWorkbenchService, key: string, initial: T): EditorSession<T> {
  let entries = sessions.get(workbench);
  if (!entries) { entries = new Map(); sessions.set(workbench, entries); }
  let session = entries.get(key);
  if (!session) { session = createSession(initial); entries.set(key, session); }
  return session as EditorSession<T>;
}

export function useEditorSession<T>(session: EditorSession<T>) {
  return useSyncExternalStore(session.subscribe, session.read, session.read);
}
