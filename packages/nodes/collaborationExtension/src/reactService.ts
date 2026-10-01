import type { WorkspaceFiles } from "@toonflow/nodes-scaffold/nodeFiles";
import type { WorkspaceDocuments } from "@toonflow/nodes-scaffold/workspaceDocuments";
import { z } from "zod";
type CollaborationContext = {
  documents: WorkspaceDocuments;
  signal: AbortSignal;
  state?: Map<string, unknown>;
  getFiles(): WorkspaceFiles;
};
import type {
  WorkspaceCanvas,
  WorkspaceDocumentAdapter,
  WorkspaceDocumentProvider,
} from "@toonflow/nodes-scaffold/workspaceDocuments";
import { canvasContent, canvasDocument, mergeCanvas, sameCanvasContent } from "./document";

type Session = {
  roomId: string;
  token: string;
  role: "owner" | "editor" | "viewer";
  expiresAt: number;
  directory: string;
};
type Snapshot = { document: WorkspaceCanvas; history: { undoCount: number; redoCount: number } };
type Binding = {
  adapter: WorkspaceDocumentAdapter;
  base: WorkspaceCanvas;
  history: Snapshot["history"];
};
const invitationSchema = z.object({
  roomId: z.string().min(1).max(200),
  token: z.string().min(1).max(1000),
  directory: z.string().min(1).max(4096).optional(),
});
export function createService(context: CollaborationContext) {
  const documents = context.documents;
  if (!documents) throw new Error("宿主没有工作区文档接口");
  const listeners = new Set<() => void>();
  const state = new Proxy(
    {
      status: "未加入协作",
      error: "",
      role: "",
      roomId: "",
      invite: "",
      inviteRole: "",
      inviteExpiresAt: 0,
      expiresAt: 0,
      lastSyncedAt: 0,
      busy: false,
      conflict: false,
    },
    {
      set(target, key, value) {
        Reflect.set(target, key, value);
        listeners.forEach((listener) => listener());
        return true;
      },
    },
  );
  const bindings = new Map<string, Binding>();
  let session: Session | undefined;
  const cached = context.state?.get("collaboration") as
    | { session?: Session; pending?: typeof pending; bases?: Record<string, WorkspaceCanvas> }
    | undefined;
  let release: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue = Promise.resolve();
  let pending:
    | { command: Record<string, unknown>; submitted?: WorkspaceCanvas; path: string }
    | undefined;
  let paused = false;
  let polling = false;
  if (cached?.session) {
    session = cached.session;
    pending = cached.pending;
    paused = true;
    state.role = session.role;
    state.roomId = session.roomId;
    state.expiresAt = session.expiresAt;
    state.status = "待恢复协作";
  }
  const headers = () => ({
    "Content-Type": "application/json",
    "x-toonflow-workspace": "1",
    "x-toonflow-collaboration": session?.token ?? "",
  });
  async function request<T>(
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<T> {
    const suffix = query ? `?${new URLSearchParams(query)}` : "";
    const response = await fetch(`/api/collaboration/${path}${suffix}`, {
      method: body === undefined ? "GET" : "POST",
      headers: headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([context.signal, AbortSignal.timeout(15000)]),
      cache: "no-store",
    });
    const value = await response.json();
    if (!response.ok || value.code !== 200)
      throw Object.assign(new Error(value.message || `协作请求失败（${response.status}）`), {
        status: response.status,
        code: value.data?.code,
      });
    return value.data;
  }
  function fail(error: unknown) {
    paused = true;
    state.status = "同步已暂停";
    state.conflict = (error as { code?: string })?.code === "ECONFLICT";
    state.error =
      error instanceof TypeError || error instanceof Error && error.name === "TimeoutError"
        ? "协作连接中断或响应超时，本地草稿与未确认命令已保留；连接恢复后点击继续同步。"
        : error instanceof Error
          ? error.message
          : "协作连接中断，草稿与命令ID保留";
  }
  function enqueue<T>(action: () => Promise<T>) {
    const result = queue.then(action);
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  async function apply(path: string, snapshot: Snapshot, submitted?: WorkspaceCanvas) {
    const binding = bindings.get(path);
    if (!binding) return;
    const current = binding.adapter.read();
    const base = submitted ?? binding.base;
    let merged: ReturnType<typeof canvasContent>;
    try {
      merged = mergeCanvas(
        canvasContent(base),
        canvasContent(current),
        canvasContent(snapshot.document),
      );
    } catch {
      throw Object.assign(new Error("远端与本地修改同一内容，草稿保留；请另存后重新同步"), {
        status: 409,
        code: "ECONFLICT",
      });
    }
    if (!sameCanvasContent(canvasContent(current), merged))
      await binding.adapter.apply(canvasDocument(merged, current.viewport), snapshot.document);
    binding.base = snapshot.document;
    binding.history = snapshot.history;
  }
  async function sendPending() {
    if (!pending || !session) return;
    const command = pending;
    const result = await request<Snapshot>("command", {
      roomId: session.roomId,
      command: command.command,
    });
    // 服务端已确认；即使视图恢复失败也不将这条命令再次当成新编辑。
    pending = undefined;
    await apply(command.path, result, command.submitted);
    state.lastSyncedAt = Date.now();
  }
  async function refresh() {
    if (!session || paused || polling || pending || context.signal.aborted) return;
    polling = true;
    try {
      await enqueue(async () => {
        if (pending || paused || !session) return;
        for (const [path, binding] of bindings) {
          if (binding.adapter.busy()) continue;
          const snapshot = await request<Snapshot>("document", undefined, {
            roomId: session.roomId,
            path,
          });
          if (binding.adapter.busy()) continue;
          await apply(path, snapshot);
          state.lastSyncedAt = Date.now();
        }
      });
    } catch (error) {
      if (!context.signal.aborted) fail(error);
    } finally {
      polling = false;
    }
  }
  function schedule() {
    clearTimeout(timer);
    if (context.signal.aborted) return;
    timer = setTimeout(async () => {
      await refresh();
      schedule();
    }, 1000);
  }
  const provider: WorkspaceDocumentProvider = {
    get readOnly() {
      return state.role === "viewer";
    },
    canHistory(path, direction) {
      return (
        !paused &&
        state.role !== "viewer" &&
        (bindings.get(path)?.history[direction === "undo" ? "undoCount" : "redoCount"] ?? 0) > 0
      );
    },
    observe(path, adapter) {
      const binding: Binding = {
        adapter,
        base: cached?.bases?.[path] ?? adapter.base(),
        history: { undoCount: 0, redoCount: 0 },
      };
      bindings.set(path, binding);
      void refresh();
      return () => {
        bindings.delete(path);
      };
    },
    save(path, document, runtimeUpdates = []) {
      const submittedRuntime = structuredClone(runtimeUpdates);
      const submittedBinding = bindings.get(path);
      const submittedBase = submittedBinding
        ? canvasContent(submittedBinding.base)
        : undefined;
      return enqueue(async () => {
        if (!session || paused || pending)
          throw new Error("协作已暂停，草稿保留；请在协作面板继续同步");
        if (session.role === "viewer") throw new Error("当前会话只读");
        const binding = bindings.get(path);
        if (!binding) throw new Error("画布文档尚未绑定");
        // 排队期间远端可能合入新内容，旧快照不能按新基线解释为删除。
        if (
          binding !== submittedBinding ||
          !submittedBase || !sameCanvasContent(canvasContent(binding.base), submittedBase)
        )
          throw new Error("协作基线已变化，本地编辑已保留，请重新保存");
        if (sameCanvasContent(canvasContent(binding.base), canvasContent(document)))
          return binding.base;
        pending = {
          path,
          submitted: document,
          command: {
            type: "edit",
            path,
            commandId: crypto.randomUUID(),
            base: binding.base,
            document,
            runtimeUpdates: submittedRuntime,
          },
        };
        try {
          await sendPending();
          return binding.base;
        } catch (error) {
          fail(error);
          throw error;
        }
      });
    },
    history(path, direction) {
      return enqueue(async () => {
        if (!session || paused || pending) throw new Error("请先完成或恢复当前协作保存");
        const binding = bindings.get(path);
        if (!binding) throw new Error("画布文档尚未绑定");
        if (
          !sameCanvasContent(canvasContent(binding.adapter.read()), canvasContent(binding.base))
        )
          throw new Error("请等待当前编辑保存后撤销或重做");
        pending = {
          path,
          submitted: binding.adapter.read(),
          command: { type: direction, path, commandId: crypto.randomUUID() },
        };
        try {
          await sendPending();
        } catch (error) {
          fail(error);
          throw error;
        }
      });
    },
    async flush() {
      await queue;
      if (pending || paused) throw new Error("协作有未确认修改，请先继续同步");
    },
  };
  function connect(value: Session) {
    if (value.directory !== documents!.directory)
      throw new Error("邀请不属于当前工作区，请先打开对应工作区");
    session = value;
    state.role = value.role;
    state.roomId = value.roomId;
    state.expiresAt = value.expiresAt;
    state.lastSyncedAt = 0;
    paused = false;
    state.error = "";
    state.conflict = false;
    state.status = "正在同步";
    release = documents!.connect(provider);
    if (cached) delete cached.bases;
    schedule();
    state.status = "协作中";
  }
  async function action(callback: () => Promise<void>) {
    if (state.busy) return;
    state.busy = true;
    state.error = "";
    try {
      await callback();
    } catch (error) {
      state.error = error instanceof TypeError || error instanceof Error && error.name === "TimeoutError"
        ? "协作服务无法连接或响应超时，请确认服务地址可以访问后重试。当前编辑已保留。"
        : error instanceof Error ? error.message : "协作操作失败";
    } finally {
      state.busy = false;
    }
  }
  async function prepareJoin() {
    try {
      await documents!.flush();
    } catch (error) {
      if ((error as { response?: { status?: number } }).response?.status !== 409) throw error;
    }
  }
  async function joinSession(roomId: string, token: string) {
    if (session) return;
    await prepareJoin();
    connect(await request<Session>("session", { roomId, token }));
    await documents.flush();
  }
  return {
    state,
    directory: documents.directory,
    get paused() { return paused; },
    get invitationText() {
      if (!state.invite) return "";
      const value = invitationSchema.parse(JSON.parse(state.invite));
      return ["oc1", value.roomId, value.token, documents.directory].map(encodeURIComponent).join(":");
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open: () =>
      action(async () => {
        if (session) return;
        await prepareJoin();
        connect(await request<Session>("open", { directory: documents.directory }));
        await documents.flush();
      }),
    join: (roomId: string, token: string) => action(() => joinSession(roomId, token)),
    joinInvitation: (invitation: string) => action(async () => {
      let value: z.infer<typeof invitationSchema>;
      try {
        const text = z.string().trim().min(1).max(16000).parse(invitation);
        if (text.startsWith("oc1:")) {
          const parts = text.split(":").map(decodeURIComponent);
          if (parts.length !== 4) throw new Error();
          value = invitationSchema.parse({ roomId: parts[1], token: parts[2], directory: parts[3] });
        } else value = invitationSchema.parse(JSON.parse(text));
      } catch { throw new Error("邀请内容不完整，请重新复制对方发来的完整邀请。"); }
      if (value.directory && value.directory !== documents.directory) throw new Error("邀请属于另一个工程，请先打开对方邀请的工程，再粘贴邀请加入。");
      await joinSession(value.roomId, value.token);
    }),
    invite: (role: "editor" | "viewer") =>
      action(async () => {
        if (!session) return;
        const invitation = await request<Session>("invite", { roomId: session.roomId, role });
        state.invite = JSON.stringify({ roomId: invitation.roomId, token: invitation.token });
        state.inviteRole = invitation.role;
        state.inviteExpiresAt = invitation.expiresAt;
      }),
    revoke: () =>
      action(async () => {
        if (!session || !state.invite) return;
        await request("revoke", {
          roomId: session.roomId,
          invitation: JSON.parse(state.invite).token,
        });
        state.invite = "";
        state.inviteRole = "";
        state.inviteExpiresAt = 0;
      }),
    resume: () =>
      action(async () => {
        if (!session) return;
        if (!release) connect(session);
        try {
          await enqueue(sendPending);
          paused = false;
          state.conflict = false;
          state.status = "协作中";
          await refresh();
          await documents.flush();
        } catch (error) {
          fail(error);
        }
      }),
    recoverDraft: () =>
      action(async () => {
        if (!session || !state.conflict) return;
        for (const [path, binding] of bindings) {
          await context
            .getFiles()
            .writeJson(
              `协作草稿${Date.now()}${crypto.randomUUID().slice(0, 8)}.json`,
              binding.adapter.read(),
              true,
            );
          const snapshot = await request<Snapshot>("document", undefined, {
            roomId: session.roomId,
            path,
          });
          await binding.adapter.apply(snapshot.document, snapshot.document);
          binding.base = snapshot.document;
          binding.history = snapshot.history;
          state.lastSyncedAt = Date.now();
        }
        pending = undefined;
        paused = false;
        state.conflict = false;
        state.status = "协作中";
        await documents.flush();
      }),
    leave: () =>
      action(async () => {
        await queue;
        paused = true;
        for (const [path, binding] of bindings) {
          const draft = binding.adapter.read();
          if (
            pending?.path === path ||
            !sameCanvasContent(canvasContent(draft), canvasContent(binding.base))
          ) {
            await context
              .getFiles()
              .writeJson(
                `协作草稿${Date.now()}${crypto.randomUUID().slice(0, 8)}.json`,
                draft,
                true,
              );
          }
          const latest = await context.getFiles().readJson<WorkspaceCanvas>(path);
          if (
            latest?.toonflowCanvas !== true ||
            !Array.isArray(latest.nodes) ||
            !Array.isArray(latest.edges) ||
            !latest.viewport
          )
            throw new Error("磁盘画布无效，草稿已保留，请先检查文件");
          await binding.adapter.apply(latest, latest);
        }
        release?.();
        release = undefined;
        session = undefined;
        pending = undefined;
        bindings.clear();
        clearTimeout(timer);
        context.state?.delete("collaboration");
        state.role = "";
        state.roomId = "";
        state.invite = "";
        state.inviteRole = "";
        state.inviteExpiresAt = 0;
        state.lastSyncedAt = 0;
        state.conflict = false;
        state.status = "已离开协作";
        await documents.flush();
      }),
    close: () =>
      action(async () => {
        if (!session) return;
        await documents.flush();
        await provider.flush();
        await request("close", { roomId: session.roomId });
        release?.();
        release = undefined;
        session = undefined;
        bindings.clear();
        clearTimeout(timer);
        state.status = "已结束协作";
        state.role = "";
        state.roomId = "";
        state.invite = "";
        state.inviteRole = "";
        state.inviteExpiresAt = 0;
        state.lastSyncedAt = 0;
        context.state?.delete("collaboration");
      }),
    dispose() {
      if (session)
        context.state?.set("collaboration", {
          session,
          pending,
          bases: Object.fromEntries([...bindings].map(([path, binding]) => [path, binding.base])),
        });
      clearTimeout(timer);
      release?.();
      release = undefined;
      bindings.clear();
    },
  };
}
export type CollaborationService = ReturnType<typeof createService>;
