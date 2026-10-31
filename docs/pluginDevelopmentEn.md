# Plugin development guide

Every OpenCinema node is a plugin: one package that exports a plugin definition, registers Zod-typed tools and ships a React view. Built-in nodes, third-party nodes and nodes from the plugin market all go through the same path; there is no privileged API. This guide covers the conventions, the contract and how to publish. 中文版见 [pluginDevelopment.md](pluginDevelopment.md)。

## Design principles

The Unix philosophy, applied to a canvas:

| Principle | What it means for a node |
| --- | --- |
| Do one thing well | One node, one job. Viewing a scan is one node; generating video is another. Compose with edges, not with mode switches. |
| Compose through streams (here: typed ports) | Nodes only exchange port values: `STRING`, `INT`, `FLOAT`, `BOOLEAN`, `IMAGE`, `VIDEO`, `AUDIO`, `FILE`, `MASK`. Media values are `{ url, mimeType }` with a workspace-relative path, never a Blob. |
| Make everything scriptable | Every capability is a tool: Zod input, Zod output, side-effect annotations. The button in the UI calls the same function the agent calls. |
| Silence is golden | Read tools change nothing; write tools return the new revision; failures throw errors with a code and a recovery action, and never leave half-finished state. |
| Reliability over cleverness | No silent retries, no silent downgrades, no model swaps. Long work returns a `taskId` first; a status tool reports the real terminal state. |

Agent-friendly specifics:

- **Small verb tools**: `get*` reads, `set*` changes, `run*` / a verb does the work, `get*Status` reports progress, `cancel*` stops. Lower camel case, 1 to 64 characters.
- **Descriptions written for the caller**: one sentence on what it does, its preconditions, what it returns and what it does not do. Parameter and result names in the text must match the schema.
- **Honest `annotations`**: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` decide whether the agent needs an outer `operationId` and a confirmation.
- **Typed output**: `outputSchema` lets the host validate the result and the agent parse it.
- **Revision guards**: write tools accept an optional `expectedRevision` (the canvas `documentRevision`) and check it with `workbench.assertWritable(expectedRevision)`; long tasks write with the revision current at completion.
- **An `agent.md`**: the operating order and the limits, written for agents and shipped in the manifest. Agents read it as `agentGuide` from `getPluginConfiguration({ pluginId })`.

## Start from scratch

```bash
bun packages/nodeScaffold/scripts/createNode.ts depthSliceNode "Depth slice" --description "Split a depth map into near, mid and far masks."
bun install
cd packages/nodes/depthSliceNode && bun run typecheck && bun run build
```

The scaffold produces:

```
packages/nodes/depthSliceNode/
├── package.json        openCinema block with id, display name, description and requirements; depends on @toonflow/nodes-scaffold, @toonflow/node-shared, zod
├── tsconfig.json
├── viteConfig.ts       createNodeConfig(...): author, license, tags, output directory
├── readme.md           for people; becomes manifest.readme
├── agent.md            for agents; becomes manifest.agentGuide (≤ 16 KiB)
└── src/
    ├── reactPlugin.ts  NodePluginDefinition: createData, activate, registerTool
    └── reactView.tsx   the React view rendered inside the node
```

This scaffold is for development inside the repository. To work outside it, use `createOpenCinemaPlugin`, as described in the [README](../readme.md). `@toonflow/nodes-scaffold` is not on npm yet, so `--scaffold` is required and must point at the tgz that `npm pack` produces. The generated project includes `readme.md` and `agent.md`.

### Install while you edit

Open two terminals. Run `npm run dev` in one to watch the build. In the other, post each new `install.json` to the local workbench:

```bash
npm run devInstall -- --server http://127.0.0.1:47920
```

Plugins inside the repository do not have that script. Run `bun packages/nodeScaffold/scripts/devInstall.ts <path to install.json> --server <workbench address>` instead. After a post, click **Refresh catalog** under **Settings → Plugins** to load the new version.

## The plugin definition

```ts
const plugin: NodePluginDefinition<typeof View> = {
  apiVersion: 1, id: "depthSliceNode", name: "Depth slice", version: "0.1.0", renderer: "react", icon: "image", view: View,
  createData: () => ({ label: "Depth slice", handles: [
    { id: "depth", type: "target", dataType: "IMAGE", label: "Depth map" },
    { id: "near", type: "source", dataType: "MASK", label: "Near mask" },
  ], outputs: {} }),
  activate(context) {
    const { id, document, workbench } = pluginServices(context);
    context.registerTool({ name: "getState", /* … */ });
    context.registerTool({ name: "slice", /* … */ });
    context.onDispose(() => { /* release workers, WebGL, object URLs */ });
  },
};
export default plugin;
```

`activate` runs once per node instance. Its `context` provides:

| Member | Purpose |
| --- | --- |
| `getService("document")` | read a node, read the revision, `updateData` (enters history), `updateRuntimeData` (runtime state, no history), `save` |
| `getService("workbench")` | `files` (workspace files), `getInputs(handle)`, `updateData`, `createNodes`, `ffmpeg()`, `hostRequest()`, `assertWritable()` |
| `registerTool(definition)` | publish a tool; returns an unregister function |
| `onBeforeChange(prepare)` | abort work before the node enters a history operation or is deleted |
| `onDispose(dispose)` | release resources when the node unloads or the plugin is disabled |
| `signal` | the plugin lifetime signal |
| `config` / `capabilities` | user configuration (per `configRules`) and host capability versions |

Data model conventions:

- State that belongs in history (sources, parameters, a camera) lives at the top level of `data` and is written with `workbench.updateData`.
- Runtime state (progress, `taskId`, errors) is written with `workbench.updateRuntimeData`; after a reload the status tool decides whether a task was interrupted.
- Outputs go to `assets/<nodeId>/` (`uploadNodeFile` handles the directory and a random file name); ports are `outputs.<handle> = { dataType, value }`.
- Write `null` to clear a key; drop running task state in `cloneData` so a duplicated node never pretends to be busy.

## Long-running work

Synchronous tools time out after 120 seconds by default. Anything longer follows this pattern:

1. `run*` validates its input, acquires dependencies up front (for example `await workbench.ffmpeg()` before queuing, so a missing FFmpeg fails immediately), creates a `taskId` and returns `{ status: "queued", taskId, executionSettled: false }` at once.
2. The task progresses in the background and writes `status: "running"`, `phase` and `progress` with `updateRuntimeData`.
3. `get*Status` returns the real state; `running` without a live task after a reload is reported as `interrupted`.
4. `cancel*` aborts an `AbortController`; the task cleans up its temporary directory itself. While an encoder has not confirmed exit, temporary files are kept rather than deleted under a process that may still read them.

`renderTurntable` / `getRenderStatus` / `cancelRender` in the [Gaussian Splat node](../packages/nodes/gaussianSplatNode/src/reactPlugin.ts) are a complete example.

## The view

The view is a plain React component with `NodeViewProps`: `node` (`id`, `data`), `controller`, `readOnly`. `controller.callNodeTool(node.id, name, args)` calls this node's tools, `controller.getNodeService(node.id)` returns the workbench service, `controller.acquireMedia(path)` exchanges a path for a temporary URL. The class names from `@toonflow/node-shared/nodeControls` (`nodeControls`, `nodeActions`, `nodePrimary`, `nodeStatus`, `nodeError`, `nodeUploadArea`) give you the workbench look; interactive canvas areas get `nodrag nopan nowheel`.

React, react-dom and zod come from the host through `/pluginSdk.js` and are not bundled; specialised dependencies such as three.js or WASM are bundled into the ESM or shipped as package assets.

## Manifest and install package

Plugin identity lives in the `openCinema` block of `package.json`:

| Field | Meaning |
| --- | --- |
| `id` | Plugin ID in lowerCamelCase; also the node type |
| `name` | Display name |
| `description` | One sentence; shown in the node menu, the market and the agent's `availableNodeTypes` |
| `category`, `icon` | Node menu category and icon |
| `requires` | Host services and capability versions, for example `{ document: 1, workbench: 1, workspaceFiles: 1, ffmpeg: 1, worker: 1 }`. `getService` only returns services declared here. See [host capabilities](#host-capabilities) for the full list |
| `scope` | `node` (default) or `workspace` |
| `order` | Built-in nodes only; a plugin without `order` stays out of the built-in list |

`createNodeConfig` takes:

| Field | Meaning |
| --- | --- |
| `author`, `github` | Basic information |
| `license`, `homepage`, `tags` | SPDX license, homepage and lowercase tags for market filtering |
| `configRules` | User configuration fields; agents read and write non-secret fields through `getPluginConfiguration` / `setPluginConfiguration` |
| `providers` | Generation services the plugin provides, in the provider manifest format |
| `resources` | Large files shipped with the package (models, WASM), each with a SHA-256 |
| `outDir` | Output directory. The default is `dist` in the plugin folder; market plugins write to `build/market/<id>` |

The build writes `index.js`, `manifest.json` and `install.json`. `install.json` is the install package, `{ manifest, source, assets[] }` with a SHA-256 per asset; the JSON Schema is [installPackage.schema.json](../packages/nodeScaffold/schema/installPackage.schema.json). Install paths:

- Settings → Plugins → Install plugin package (a local file);
- Settings → Plugins → Plugin market (a static catalog, downloaded and verified by SHA-256);
- agents: `reviewPluginPackage` / `installPluginPackage` (a file inside the project) or `getPluginMarket` / `installMarketplacePlugin` (the market).

Installed plugins are served by the local Go server from a versioned directory; the web app loads them through an import map and shares its React and zod instances.

At install time the Go server checks the types of `version`, `requires`, `displayName`, `author`, `license`, `homepage`, `tags`, and `configRules`, and rejects a package that fails. The workbench loads the module right after install and probes enabled installed plugins each time the plugin page opens. A load failure appears on the plugin card with a **Retry** button. If an installed manifest is damaged, projects still open and the settings page marks that plugin as damaged so the user can uninstall or download it again.

## Host capabilities

The names and highest versions allowed in `requires` come from [hostCapabilities.json](../packages/nodeScaffold/src/hostCapabilities.json). A wrong name or a version that is too high fails `vite build`, `generate:nodes`, and `site/build.mjs`.

| Capability | Version | Use |
| --- | --- | --- |
| `document` | 1 | Read and write the current node's data |
| `workbench` | 1 | Use workbench services: files, FFmpeg, and host agent requests |
| `files` | 1 | Read and write project files |
| `inputs` | 1 | Read upstream node inputs |
| `state` | 1 | Use shared runtime state inside the project |
| `documentEditing` | 1 | Edit node documents |
| `workspaceFiles` | 1 | Read and write project files |
| `workspaceReadRange` | 1 | Read ranges of large project files |
| `nodeHistory` | 1 | Write to the canvas history |
| `workspaceDocuments` | 1 | Read and write canvases in the project |
| `workspaceExtensions` | 1 | Extend project features |
| `collaboration` | 1 | Take part in collaboration |
| `pluginResources` | 1 | Load models and resources shipped with the package |
| `ffmpeg` | 1 | Run FFmpeg on audio and video |
| `webAssembly` | 1 | Run WebAssembly |
| `worker` | 1 | Run work on a background thread |

The host provides `webAssembly` and `worker` only when the runtime supports them.

`requires` declares compatibility. It is not a sandbox. A plugin runs in the same page as the workbench and can send same-origin requests and touch the DOM, so it can read and write project files, read saved API keys, and send data to outside addresses. The review card tells the user this before install.

## Publishing to the plugin market

The market is a static catalog under [opencinema.site/market](https://opencinema.site/market/). It is install-only for now; there is no upload. To publish a version:

1. Build the plugin and confirm `install.json` is in the `outDir` you declared.
2. Add an entry to `site/src/marketCatalog.json`: `id`, `source` (path of the install.json relative to the repository root), English and Chinese `description`, `homepage`, `repository`, `publishedAt`. The optional `minHost` is the lowest workbench version that runs this package, written like `0.4.0`. The UI disables install when `minHost` is above the current version.
3. Run `node site/build.mjs`. It copies the package to `site/market/plugins/<id>/<version>/install.json`, computes SHA-256 and size, and rewrites `site/market/index.json` and the market pages. A version is never overwritten with different bytes: bump the version instead. The script fails if `requires` names a capability the host does not provide.
4. Open a pull request. The index format is [marketIndex.schema.json](../packages/nodeScaffold/schema/marketIndex.schema.json).

The workbench parses the catalog entry by entry. An invalid record skips only itself, and the settings page shows how many records it skipped. Versions compare by numeric segments without prerelease handling, so the order of `1.0.0-beta` and `1.0.0` is not guaranteed.

## Checklist

- [ ] One node, one job; accurate port types; `canConnect` only where types cannot express the rule.
- [ ] Every tool: a small verb name, an accurate description, Zod input and output, honest `annotations`.
- [ ] Write tools honor `expectedRevision`; long tasks use the queued pattern and can be cancelled.
- [ ] Failures leave nothing half-done; temporary files are cleaned up; `onDispose` releases everything.
- [ ] `readme.md` for people, `agent.md` for agents; third-party licenses ship in `licenses/`.
- [ ] `bun run typecheck` and `bun run build` pass; you installed and operated the node in the workbench once.
