import { acquireFileAccess, withFileAccess } from "./access.ts";
import type { PathLike } from "node:fs";

type FileContent = string | Blob | ArrayBufferLike | NodeJS.TypedArray | Bun.BlobPart[];
type WriteOptions = { mode?: number; createPath?: boolean };
type ManagedFile = Omit<Bun.BunFile, "writer" | "slice" | "write"> & {
  writer: never;
  write(content: FileContent, options?: WriteOptions): Promise<number>;
  slice(begin?: number, end?: number, contentType?: string): ManagedFile;
  slice(begin?: number, contentType?: string): ManagedFile;
  slice(contentType?: string): ManagedFile;
};
const filePaths = new WeakMap<object, PathLike>();

function pathKey(value: unknown): PathLike | undefined {
  if (typeof value === "string" || value instanceof URL) return value;
  if (ArrayBuffer.isView(value)) return Buffer.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) return Buffer.from(new Uint8Array(value));
  return typeof value === "object" && value ? filePaths.get(value) : undefined;
}

function wrapFile(value: Bun.BunFile, path?: PathLike): ManagedFile {
  if (!path) return value as ManagedFile;
  filePaths.set(value, path);
  // 保留真实 Blob 品牌，Response/Bun.write 等原生消费者不能接收 Proxy。
  const slice = value.slice.bind(value);
  Object.defineProperty(value, "slice", { value: (...args: Parameters<Bun.BunFile["slice"]>) => wrapFile(slice(...args) as Bun.BunFile, path) });
  for (const name of ["text", "json", "arrayBuffer", "bytes", "formData", "exists"] as const) {
    const read = value[name].bind(value);
    Object.defineProperty(value, name, { value: () => withFileAccess([path], "read", read) });
  }
  for (const name of ["delete", "unlink"] as const) {
    const remove = value[name].bind(value);
    Object.defineProperty(value, name, { value: () => withFileAccess([path], "write", remove) });
  }
  Object.defineProperty(value, "write", { value: (...args: any[]) => Reflect.apply(write, undefined, [value, ...args]) });
  // 同步 FileSink 无法等待异步队列；流写统一使用 createWriteStream。
  Object.defineProperty(value, "writer", { value: () => { throw new TypeError("请使用 @toonflow/file 的 createWriteStream 进行流式写入"); } });
  const stream = value.stream.bind(value);
  Object.defineProperty(value, "stream", { value: () => {
    let reader: { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(reason?: unknown): Promise<void> } | undefined;
    let release: (() => void) | undefined;
    let cancelled = false;
    const cancellation = new AbortController();
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          release = await acquireFileAccess([path], "read", cancellation.signal);
          if (cancelled) { release(); return; }
          reader = stream().getReader();
        } catch (error) { release?.(); if (!cancelled) controller.error(error); }
      },
      async pull(controller) {
        if (!reader) return;
        try {
          const result = await reader.read();
          if (result.done) { release?.(); controller.close(); }
          else if (result.value) controller.enqueue(result.value);
        } catch (error) { release?.(); controller.error(error); }
      },
      async cancel(reason) {
        cancelled = true;
        cancellation.abort(reason);
        try { await reader?.cancel(reason); } finally { release?.(); }
      },
    });
  } });
  return value as ManagedFile;
}

export function file(path: string | URL | ArrayBufferLike | Uint8Array<ArrayBuffer>, options?: BlobPropertyBag): ManagedFile {
  if (typeof path === "number") throw new TypeError("文件对象不接受外部 fd；请使用 open 返回的句柄");
  return wrapFile(Bun.file(path as string, options), pathKey(path));
}

export async function write(destination: string | URL | ArrayBufferLike | NodeJS.TypedArray | ManagedFile, content: FileContent, options?: WriteOptions): Promise<number> {
  // ACT: Bun 1.3.14 在部分错误输入流上不会结束 Promise；流写用标准 pipeline/createWriteStream。
  if (content instanceof Response || content instanceof Request || content instanceof ReadableStream) {
    throw new TypeError("流式写入请使用 @toonflow/file 的 createWriteStream 和 pipeline");
  }
  // 固定数组成员，确保排队后写入的文件与本次收集的锁路径一致。
  if (Array.isArray(content)) content = [...content];
  const paths = [destination, ...(Array.isArray(content) ? content : [content])].flatMap((value, index) => {
    const path = index === 0 ? pathKey(value) : typeof value === "object" && value ? filePaths.get(value) : undefined;
    return path === undefined ? [] : [path];
  });
  const args = [destination, content, options];
  return paths.length ? withFileAccess(paths, "write", () => Reflect.apply(Bun.write, Bun, args)) : Reflect.apply(Bun.write, Bun, args);
}
