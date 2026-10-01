import { chmod, cp, existsSync, mkdir, readFile, readdir, rm, writeAtomic } from "@toonflow/file";
import { resolve } from "node:path";
import { createRuntimeRelease } from "../runtimeBundle";
import { collectLicenses } from "./collectLicenses";

const packageRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(packageRoot, "../..");
const output = resolve(repositoryRoot, "build/openCinema");
const mcp = resolve(repositoryRoot, "build/mcp");
const serverName = process.platform === "win32" ? "openCinema.exe" : "openCinema";
const server = resolve(repositoryRoot, "build/server", serverName);
for (const path of [resolve(mcp, "stdio.js"), resolve(mcp, "widgetResource.json"), server, resolve(repositoryRoot, "build/web/index.html"), resolve(repositoryRoot, "thirdPartyNotices.md")]) {
  if (!existsSync(path)) throw new Error("请先显式构建 Web、MCP、Go 服务和节点，并保留 thirdPartyNotices.md，再构建 OpenCinema 插件");
}
const nodes = resolve(repositoryRoot, "build/nodes");
const nodeBundles = (await readdir(nodes, { withFileTypes: true })).filter(entry => entry.isDirectory());
if (nodeBundles.length !== 14 || nodeBundles.some(entry => !existsSync(resolve(nodes, entry.name, "install.json")))) {
  throw new Error("OpenCinema 插件需要完整的 14 个内置插件发行包");
}
await rm(output, { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: [resolve(packageRoot, "start.ts")], outdir: output, target: "node", format: "esm", minify: true,
  // ACT: Node 发行包使用标准文件原语，不打包移动端 Bun FFI；平台校验仍读取真实运行环境。
  define: { "process.env.TOONFLOW_PLATFORM": '""' },
  external: [resolve(repositoryRoot, "packages/file/src/renameExclusive.ts")],
});
if (!result.success) throw new AggregateError(result.logs, "OpenCinema 插件构建失败");
await collectLicenses(repositoryRoot, output);
const runtime = resolve(output, "runtime");
await mkdir(runtime, { recursive: true });
await cp(resolve(repositoryRoot, "build/server"), resolve(runtime, "server"), { recursive: true, dereference: true });
await chmod(resolve(runtime, "server", serverName), 0o755);
await cp(resolve(repositoryRoot, "build/web"), resolve(runtime, "web"), { recursive: true });
await cp(nodes, resolve(runtime, "nodes"), { recursive: true });
for (const name of ["stdio.js", "widgetResource.json"]) await cp(resolve(mcp, name), resolve(runtime, name));
const release = await createRuntimeRelease(runtime);
await writeAtomic(resolve(runtime, "release.json"), JSON.stringify(release, null, 2));
for (const name of ["plugin.json", ".codex-plugin", ".claude-plugin", "skills", "readme.md"]) await cp(resolve(packageRoot, name), resolve(output, name), { recursive: true });
for (const name of ["LICENSE", "thirdPartyNotices.md"]) await cp(resolve(repositoryRoot, name), resolve(output, name));
for (const name of ["mcp.json", ".mcp.json", ".claude-plugin/plugin.json"]) {
  const manifest = JSON.parse(await readFile(resolve(packageRoot, name), "utf8"));
  for (const server of Object.values(manifest.mcpServers) as { args: string[] }[]) {
    server.args = server.args.map(arg => arg.replace("/start.ts", "/start.js"));
  }
  await writeAtomic(resolve(output, name), JSON.stringify(manifest, null, 2));
}
const metadata = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
await writeAtomic(resolve(output, "package.json"), JSON.stringify({ name: metadata.name, version: metadata.version, type: "module", private: true, license: "MIT", engines: { node: ">=22" } }, null, 2));
console.log(`OpenCinema Studio ${release.version} (${process.platform}/${process.arch}, ${release.revision.slice(0, 12)}) 已构建到 ${output}`);
