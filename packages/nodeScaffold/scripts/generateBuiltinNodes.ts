import { readFile, readdir, writeAtomic } from "@toonflow/file";
import { join, resolve } from "node:path";
import { nodeMetadataSchema } from "../src/nodeCapabilities.ts";

// 内置节点的唯一来源是 packages/nodes/*/package.json；根目录 dev*、build:web、build:server 会先执行本脚本，
// 产物提交入库，所以直接 go run、go vet 或 tsc 不依赖 Bun。改 openCinema 块后执行 bun run generate:nodes。
const root = resolve(import.meta.dirname, "../../..");
const nodesRoot = join(root, "packages/nodes");
const webDependencies = JSON.parse(await readFile(join(root, "apps/web/package.json"), "utf8")).dependencies as Record<string, string>;
const nodes = await Promise.all((await readdir(nodesRoot)).map(async directory => {
  const path = join(nodesRoot, directory, "package.json");
  const info = JSON.parse(await readFile(path, "utf8"));
  const { order, name: displayName, ...metadata } = nodeMetadataSchema.parse(info.openCinema);
  if (order === undefined) throw new Error(`内置节点须声明 openCinema.order：${path}`);
  if (metadata.id !== directory) throw new Error(`内置节点 ID 须与目录同名：${path}`);
  if (!webDependencies[info.name]) throw new Error(`apps/web/package.json 缺少依赖 ${info.name}`);
  if (!info.exports?.["./reactPlugin"]) throw new Error(`内置节点须导出 ./reactPlugin：${path}`);
  return { order, packageName: info.name as string, entry: { ...metadata, displayName, scope: metadata.scope ?? "node", version: info.version as string } };
}));
nodes.sort((left, right) => left.order - right.order);
if (new Set(nodes.map(node => node.order)).size !== nodes.length) throw new Error("内置节点 openCinema.order 不能重复");

const entries = nodes.map(node => node.entry);
const webEntries = nodes.map(({ packageName, entry }) => `  ${entry.id}: ${JSON.stringify(entry).slice(0, -1)},"load":() => import(${JSON.stringify(`${packageName}/reactPlugin`)})},`);
await writeAtomic(join(root, "apps/server/go/builtinNodes.json"), `${JSON.stringify(entries, null, 2)}\n`);
await writeAtomic(join(root, "apps/web/src/lib/builtinNodes.ts"), `// 由 packages/nodeScaffold/scripts/generateBuiltinNodes.ts 从 packages/nodes/*/package.json 生成，不要手工修改。\nexport const builtinNodes = {\n${webEntries.join("\n")}\n};\n`);
