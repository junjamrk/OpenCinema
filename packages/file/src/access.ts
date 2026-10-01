import { Semaphore } from "async-mutex";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PathLike } from "node:fs";

type AccessKind = "read" | "write";
type Entry = { queue: Semaphore; readers: number; writers: number };
// ACT: 同文件最多同时读取 64 次；写入占满许可，FIFO 防止后到读写插队。
const readCapacity = 64;
const entries = new Map<string, Entry>();

function accessKeys(paths: PathLike[]) {
  return [...new Set(paths.map(path => {
    const key = resolve(path instanceof URL ? fileURLToPath(path) : String(path));
    return process.platform === "win32" ? key.toLowerCase() : key;
  }))].sort();
}

function waitForAccess(entry: Entry, kind: AccessKind, signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => { settled = true; reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    entry.queue.acquire(kind === "read" ? 1 : readCapacity).then(([, release]) => {
      signal.removeEventListener("abort", abort);
      if (settled) release();
      else { settled = true; resolve(release); }
    }, error => { signal.removeEventListener("abort", abort); if (!settled) { settled = true; reject(error); } });
  });
}

// ACT: 单进程、规范化的文件路径队列；realpath/目录事务/业务锁由模块负责。
export async function acquireFileAccess(paths: PathLike[], kind: AccessKind, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const requests = accessKeys(paths).map(key => {
    let entry = entries.get(key);
    if (!entry) entries.set(key, entry = { queue: new Semaphore(readCapacity), readers: 0, writers: 0 });
    if (kind === "read") entry.readers++; else entry.writers++;
    return { key, entry };
  });
  const handles: (() => void)[] = [];
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    for (const dispose of handles.reverse()) dispose();
    for (const { key, entry } of requests) {
      if (kind === "read") entry.readers--; else entry.writers--;
      if (!entry.readers && !entry.writers) entries.delete(key);
    }
  };
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(Object.assign(new Error("文件正在使用，等待操作超时"), { code: "EBUSY" })), 30000);
  timer.unref?.();
  try {
    for (const { entry } of requests) handles.push(await waitForAccess(entry, kind, controller.signal));
    controller.signal.throwIfAborted();
    return release;
  } catch (error) { release(); throw error; }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

export async function withFileAccess<T>(paths: PathLike[], kind: AccessKind, action: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
  const release = await acquireFileAccess(paths, kind, signal);
  try { signal?.throwIfAborted(); return await action(); }
  finally { release(); }
}

export function withSyncFileAccess<T>(paths: PathLike[], kind: AccessKind, action: () => T): T {
  // 同步操作不能阻塞等待本进程异步句柄，否则事件循环无法关闭句柄。
  for (const key of accessKeys(paths)) {
    const entry = entries.get(key);
    if (entry && (entry.writers || kind === "write" && entry.readers)) {
      throw Object.assign(new Error(`文件正在使用：${String(paths[0])}`), { code: "EBUSY", path: paths[0] });
    }
  }
  return action();
}
