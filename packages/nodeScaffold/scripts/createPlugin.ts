#!/usr/bin/env node
import { mkdir, readFile, writeAtomic } from "@toonflow/file";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { nodeMetadataSchema } from "../src/nodeCapabilities.ts";

const usage = "用法：createOpenCinemaPlugin <小驼峰插件ID> [--directory 目录] [--name 显示名] [--scaffold 脚手架依赖版本或 file: 路径]";
const { values, positionals } = parseArgs({ allowPositionals: true, options: { directory: { type: "string" }, name: { type: "string" }, scaffold: { type: "string" } } });
const id = nodeMetadataSchema.shape.id.safeParse(positionals[0]);
if (!id.success) throw new Error(usage);

const own = JSON.parse(await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
const target = resolve(values.directory ?? id.data);
const files: Record<string, string> = {
  "package.json": `${JSON.stringify({
    name: `opencinema-plugin-${id.data.toLowerCase()}`,
    version: "0.1.0",
    private: true,
    type: "module",
    openCinema: { id: id.data, name: values.name ?? id.data, requires: { document: 1 } },
    scripts: { build: "vite build --config viteConfig.ts", typecheck: "tsc --noEmit" },
    dependencies: { "@toonflow/nodes-scaffold": values.scaffold ?? `^${own.version}`, zod: own.dependencies.zod },
    devDependencies: { ...own.peerDependencies, "@types/react": own.devDependencies["@types/react"], typescript: own.devDependencies.typescript },
  }, null, 2)}\n`,
  "tsconfig.json": `${JSON.stringify({
    compilerOptions: { target: "ESNext", lib: ["ESNext", "DOM", "DOM.Iterable"], module: "Preserve", moduleResolution: "Bundler", moduleDetection: "force", jsx: "react-jsx", types: ["vite/client"], allowImportingTsExtensions: true, resolveJsonModule: true, verbatimModuleSyntax: true, noEmit: true, strict: true, skipLibCheck: true },
    include: ["src"],
  }, null, 2)}\n`,
  ".gitignore": "node_modules/\ndist/\n",
  "viteConfig.ts": `import { createNodeConfig } from "@toonflow/nodes-scaffold";

export default createNodeConfig({ author: "", github: "" }, import.meta.url);
`,
  "src/reactPlugin.ts": `import { z } from "zod";
import type { NodePluginDefinition } from "@toonflow/nodes-scaffold/contracts";
import type { NodeDocumentService } from "@toonflow/nodes-scaffold/react";
import { openCinema, version } from "../package.json";
import PluginView from "./reactView";

const plugin: NodePluginDefinition<typeof PluginView> = {
  ...openCinema, version, apiVersion: 1, renderer: "react", view: PluginView,
  createData: () => ({ label: openCinema.name }),
  activate(context) {
    // getService 只能取到 package.json 的 openCinema.requires 声明过的服务。
    const document = context.getService<NodeDocumentService>("document");
    context.registerTool({
      name: "readNode",
      description: "读取当前节点数据",
      parameters: z.strictObject({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      execute: () => ({ node: document.readNode(context.nodeId!) as Record<string, unknown> }),
    });
  },
};

export default plugin;
`,
  "src/reactView.tsx": `import { useState } from "react";
import type { ReactNodeViewProps } from "@toonflow/nodes-scaffold/react";

export default function PluginView({ node, controller }: ReactNodeViewProps) {
  const [result, setResult] = useState("");
  const call = () => controller.callNodeTool(node.id, "readNode", {}).then(value => setResult(JSON.stringify(value)), error => setResult(String(error)));
  return <div className="nodrag"><button type="button" onClick={() => void call()}>readNode</button><output>{result}</output></div>;
}
`,
};
for (const [path, content] of Object.entries(files)) {
  await mkdir(dirname(join(target, path)), { recursive: true });
  await writeAtomic(join(target, path), content, { exclusive: true });
}
console.log(`已生成 ${target}：npm install 后执行 npm run build，产物 dist/install.json 可在设置页安装`);
