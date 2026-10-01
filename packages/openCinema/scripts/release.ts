import { createReadStream, existsSync, mkdir, mkdtemp, readFile, rename, rm, stat, writeAtomic } from "@toonflow/file";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { createRuntimeRelease } from "../runtimeBundle";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const buildRoot = resolve(repositoryRoot, "build");
const pluginRoot = resolve(buildRoot, "openCinema");
const releaseRoot = resolve(buildRoot, "releases");
if (!["darwin", "linux"].includes(process.platform)) {
  throw new Error("当前归档命令支持 macOS / Linux，需要系统 zip；其他平台请先提供对应归档工具，不能复用另一平台二进制。");
}
for (const path of ["start.js", "package.json", "plugin.json", ".codex-plugin/plugin.json", ".claude-plugin/plugin.json", ".mcp.json", "mcp.json", "LICENSE", "thirdPartyNotices.md", "runtime/release.json"]) {
  if (!existsSync(resolve(pluginRoot, path)) || !(await stat(resolve(pluginRoot, path))).isFile()) throw new Error(`发行文件缺失：${path}。请先显式执行 bun run build。`);
}
const metadata = JSON.parse(await readFile(resolve(pluginRoot, "package.json"), "utf8"));
const rootMetadata = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));
if (typeof metadata.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(metadata.version) || metadata.version !== rootMetadata.version) {
  throw new Error("发行包版本与当前源码不一致，请先显式执行 bun run build。");
}
const runtime = JSON.parse(await readFile(resolve(pluginRoot, "runtime/release.json"), "utf8"));
const actual = await createRuntimeRelease(resolve(pluginRoot, "runtime"));
if (runtime.revision !== actual.revision || runtime.version !== metadata.version || runtime.platform !== process.platform || runtime.arch !== process.arch) {
  throw new Error("运行包内容、版本或平台与发行清单不一致，请先显式执行 bun run build。");
}
await mkdir(releaseRoot, { recursive: true });
const staging = await mkdtemp(resolve(releaseRoot, ".packaging"));
const filename = `openCinema-${metadata.version}-${process.platform}-${process.arch}.zip`;
const archive = resolve(staging, filename);
try {
  const child = Bun.spawn(["zip", "-q", "-r", archive, "openCinema"], { cwd: buildRoot, stdout: "inherit", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`zip 归档失败（${exitCode}）：${stderr.trim()}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  const sha256 = hash.digest("hex");
  const bytes = (await stat(archive)).size;
  await rename(archive, resolve(releaseRoot, filename));
  await writeAtomic(resolve(releaseRoot, "checksums.txt"), `${sha256}  ${filename}\n`);
  await writeAtomic(resolve(releaseRoot, "releaseManifest.json"), JSON.stringify({
    version: metadata.version,
    platform: process.platform,
    arch: process.arch,
    filename,
    bytes,
    sha256,
    runtimeRevision: runtime.revision,
  }, null, 2) + "\n");
  console.log(`已生成 ${resolve(releaseRoot, filename)}（${bytes} 字节，SHA-256 ${sha256}）`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
