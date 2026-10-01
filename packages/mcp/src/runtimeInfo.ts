import { constants, open } from "@toonflow/file";
import { isAbsolute } from "node:path";
import { z } from "zod";

const runtimeSchema = z.object({
  pid: z.number().int().positive(), url: z.url(), token: z.string().min(1),
  revision: z.string().optional(), instanceId: z.string().optional(),
});
const ownerSchema = z.object({
  pid: z.number().int().positive(), instanceId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  revision: z.string(), runtimeInfo: z.string(),
});

async function readPrivateJson(path: string) {
  if (!isAbsolute(path)) throw new Error("运行信息必须使用绝对路径");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 65536) throw new Error("运行信息文件无效");
    if (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())) {
      throw new Error("运行信息文件必须属于当前用户，且仅允许当前用户访问（chmod 600）");
    }
    try { return JSON.parse(await handle.readFile("utf8")) as unknown; }
    catch { throw new Error("运行信息文件格式无效"); }
  } finally { await handle.close(); }
}

export async function readRuntimeInfo(path: string) {
  const result = runtimeSchema.safeParse(await readPrivateJson(path));
  if (!result.success) throw new Error("运行信息文件格式无效");
  const runtime = result.data;
  const url = new URL(runtime.url);
  if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || !/^\/mcp\/?$/.test(url.pathname)) {
    throw new Error("运行信息只允许指向本机 OpenCinema MCP");
  }
  process.kill(runtime.pid, 0);
  return { ...runtime, url: url.href };
}

export async function readRuntimeOwner(path: string) {
  const result = ownerSchema.safeParse(await readPrivateJson(path));
  if (!result.success) throw new Error("OpenCinema 数据目录的进程锁无效，请保留现场后处理");
  process.kill(result.data.pid, 0);
  return result.data;
}
