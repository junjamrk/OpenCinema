import { constants, lstat, mkdir, open } from "@toonflow/file";
import { readRuntimeInfo, readRuntimeOwner } from "@toonflow/mcp/runtimeInfo";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { prepareRuntimeBundle } from "./runtimeBundle";

type RuntimeInfo = Awaited<ReturnType<typeof readRuntimeInfo>>;
const leaseSchema = z.object({ code: z.literal(200), data: z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{43}$/), expiresAt: z.number().int().positive() }) });
const pluginRoot = dirname(fileURLToPath(import.meta.url));

function dataDirectory() {
  const override = process.env.OPENCINEMA_DATA_DIR;
  if (override && !isAbsolute(override)) throw new Error("OPENCINEMA_DATA_DIR 必须是绝对路径");
  const userData = process.platform === "darwin" ? join(homedir(), "Library/Application Support")
    : process.platform === "win32" ? process.env.LOCALAPPDATA || join(homedir(), "AppData/Local")
      : process.env.XDG_DATA_HOME || join(homedir(), ".local/share");
  return override || join(userData, "openCinema/standalone/data");
}

async function lease(runtime: RuntimeInfo, action: "attach" | "heartbeat" | "release", id?: string) {
  const response = await fetch(new URL("/api/runtime/lease", runtime.url), {
    method: "POST", headers: { Authorization: "Bearer " + runtime.token, "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...(id ? { id } : {}) }), signal: AbortSignal.timeout(5000), redirect: "error",
  });
  if (!response.ok) throw new Error("OpenCinema 运行实例租约连接失败，请重新连接插件");
  const result = leaseSchema.safeParse(await response.json());
  if (!result.success) throw new Error("OpenCinema 运行实例租约响应无效");
  return result.data.data.id;
}

async function managedRuntime(directory: string, bundle: Awaited<ReturnType<typeof prepareRuntimeBundle>>) {
  const runtimePath = join(directory, "runtime.json");
  const lockPath = join(directory, ".runtimeLock");
  const ownerPath = join(lockPath, "owner.json");
  async function currentRuntime() {
    const owner = await readRuntimeOwner(ownerPath);
    // ACT: 画布偏好和媒体配置依赖新版 Go API，仅复用同一构建，避免发布后端不存在的能力。
    if (owner.revision !== bundle.release.revision) throw new Error("此数据目录由不兼容版本的 OpenCinema 使用，当前插件无法复用。保留现有连接与工程，待原实例正常释放租约后重试");
    const runtime = await readRuntimeInfo(runtimePath);
    if (runtime.pid !== owner.pid || runtime.instanceId !== owner.instanceId || runtime.revision !== owner.revision || owner.runtimeInfo !== runtimePath) {
      throw new Error("OpenCinema 运行信息与数据目录进程锁不匹配，请保留现场后处理");
    }
    if (runtime.token.length < 32 || !/^[A-Za-z0-9_-]{43}$/.test(runtime.instanceId ?? "")) throw new Error("OpenCinema 受管运行信息无效");
    return runtime;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let locked = false;
  try {
    const info = await lstat(lockPath);
    if (!info.isDirectory() || process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())) throw new Error("OpenCinema 数据目录进程锁无效");
    locked = true;
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let childError: Error | undefined;
  let started = false;
  async function startServer() {
    started = true;
    const log = await open(join(directory, "runtime.log"), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      const logInfo = await log.stat();
      if (!logInfo.isFile() || process.platform !== "win32" && ((logInfo.mode & 0o077) !== 0 || logInfo.uid !== process.getuid?.())) throw new Error("OpenCinema 运行日志须为当前用户私有文件");
      const child = spawn(join(bundle.directory, "server", process.platform === "win32" ? "openCinema.exe" : "openCinema"), [
        "-listen", "127.0.0.1:0", "-webRoot", join(bundle.directory, "web"), "-dataDirectory", directory,
        "-runtimeInfo", runtimePath, "-runtimeRevision", bundle.release.revision, "-managed=true", "-widgetResource", join(bundle.directory, "widgetResource.json"),
      ], { detached: true, stdio: ["ignore", "ignore", log.fd], windowsHide: true });
      child.once("error", error => { childError = error; });
      child.unref();
    } finally { await log.close(); }
  }
  if (!locked) await startServer();
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (childError) throw new Error("OpenCinema Go 服务无法启动：" + childError.message);
    try {
      const runtime = await currentRuntime();
      return { runtime, runtimePath, id: await lease(runtime, "attach") };
    }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // ACT: 残锁只由 Go 判定与回收：持有者 PID 已消失、属于他人（EPERM）或连接被拒（fetch 抛 TypeError）时拉起 Go，存活实例会被 Go 拒绝。
      const unreachable = code === "ESRCH" || code === "EPERM" || error instanceof TypeError;
      if (code !== "ENOENT" && !unreachable) throw error;
      if (unreachable && !started) await startServer();
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error("OpenCinema Go 服务未就绪；请检查数据目录的 runtime.log。未知残留进程锁不会自动删除");
}

async function main() {
  const external = process.env.OPENCINEMA_RUNTIME;
  let runtimePath: string;
  let entry: string;
  let widgetPath: string | undefined;
  let managed: { runtime: RuntimeInfo; id: string } | undefined;
  if (external) {
    await readRuntimeInfo(external);
    runtimePath = external;
    entry = resolve(pluginRoot, "runtime/stdio.js");
  } else {
    const directory = dataDirectory();
    const bundle = await prepareRuntimeBundle(join(pluginRoot, "runtime"), join(directory, "runtimeBuilds"));
    const ready = await managedRuntime(directory, bundle);
    managed = { runtime: ready.runtime, id: ready.id };
    runtimePath = ready.runtimePath;
    entry = join(bundle.directory, "stdio.js");
    widgetPath = join(bundle.directory, "widgetResource.json");
  }
  const child = spawn(process.execPath, [entry, "--runtime", runtimePath, ...(widgetPath ? ["--widget-resource", widgetPath] : [])], { stdio: "inherit", windowsHide: true });
  let closing = false;
  let heartbeatBusy = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let forceClose: ReturnType<typeof setTimeout> | undefined;
  const close = async (signal?: NodeJS.Signals) => {
    if (closing) return;
    closing = true;
    if (heartbeat) clearInterval(heartbeat);
    if (signal) {
      child.kill(signal);
      forceClose = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 5000);
      forceClose.unref();
    }
    if (managed) await lease(managed.runtime, "release", managed.id).catch(() => console.error("OpenCinema 连接租约释放失败，将在超时后自动回收"));
  };
  if (managed) heartbeat = setInterval(() => {
    if (closing || heartbeatBusy) return;
    heartbeatBusy = true;
    void lease(managed!.runtime, "heartbeat", managed!.id).catch(() => {
      console.error("OpenCinema 运行连接已中断，请重新连接插件");
      process.exitCode = 1;
      return close("SIGTERM");
    }).finally(() => { heartbeatBusy = false; });
  }, 20_000);
  child.once("error", error => { console.error("OpenCinema MCP 无法启动：" + error.message); process.exitCode = 1; void close(); });
  child.once("exit", (code, signal) => { if (forceClose) clearTimeout(forceClose); process.exitCode ??= code ?? (signal ? 1 : 0); void close(); });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void close(signal); });
}

main().catch(error => { console.error(error instanceof Error ? error.message : "OpenCinema MCP 无法启动"); process.exitCode = 1; });
