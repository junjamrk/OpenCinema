// Build the static plugin market: site/market/index.json plus one immutable
// install.json per plugin version under site/market/plugins/<id>/<version>/.
//   node site/buildMarket.mjs
// Sources are listed in src/marketCatalog.json. A version is never overwritten
// with different bytes: bump the plugin version instead.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "..");
const marketRoot = path.join(here, "market");
const pluginId = /^[a-z][a-zA-Z0-9]{0,95}$/;
const hostVersion = /^\d+\.\d+\.\d+$/;
const hostCapabilities = JSON.parse(readFileSync(path.join(repositoryRoot, "packages/nodeScaffold/src/hostCapabilities.json"), "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function buildMarket({ log = console.log } = {}) {
  const catalog = JSON.parse(readFileSync(path.join(here, "src/marketCatalog.json"), "utf8"));
  const plugins = [];
  for (const entry of catalog) {
    if (!pluginId.test(entry.id)) throw new Error(`invalid plugin id: ${entry.id}`);
    if (!entry.description?.en) throw new Error(`${entry.id}: description.en is required`);
    const sourcePath = path.join(repositoryRoot, entry.source);
    let bytes, manifest;
    if (existsSync(sourcePath)) {
      bytes = readFileSync(sourcePath);
      manifest = JSON.parse(bytes.toString("utf8")).manifest;
    } else {
      // No fresh build on this machine: reuse the newest version already published in the market.
      const publishedRoot = path.join(marketRoot, "plugins", entry.id);
      if (!existsSync(publishedRoot)) throw new Error(`${entry.id}: build it first (${entry.source}) or publish a version under ${path.relative(here, publishedRoot)}`);
      const versions = JSON.parse(readFileSync(path.join(publishedRoot, "versions.json"), "utf8"));
      const version = versions.at(-1);
      bytes = readFileSync(path.join(publishedRoot, version, "install.json"));
      manifest = JSON.parse(bytes.toString("utf8")).manifest;
      log(`${entry.id}: no local build, reusing published ${version}`);
    }
    if (manifest.id !== entry.id) throw new Error(`${entry.id}: package manifest id is ${manifest.id}`);
    if (manifest.apiVersion !== 1 || manifest.renderer !== "react") throw new Error(`${entry.id}: unsupported package`);
    if (entry.minHost !== undefined && !hostVersion.test(entry.minHost)) throw new Error(`${entry.id}: minHost must look like 0.4.0, got ${entry.minHost}`);
    for (const [name, version] of Object.entries(manifest.requires ?? {})) {
      if (!Number.isInteger(version) || version < 1 || version > (hostCapabilities[name]?.version ?? 0)) throw new Error(`${entry.id}: the host does not provide ${name}@${version}`);
    }
    const versionRoot = path.join(marketRoot, "plugins", entry.id, manifest.version);
    const target = path.join(versionRoot, "install.json");
    const digest = sha256(bytes);
    if (existsSync(target) && sha256(readFileSync(target)) !== digest) throw new Error(`${entry.id}@${manifest.version} is already published with different bytes; bump the version`);
    mkdirSync(versionRoot, { recursive: true });
    writeFileSync(target, bytes);
    const versionsPath = path.join(marketRoot, "plugins", entry.id, "versions.json");
    const versions = existsSync(versionsPath) ? JSON.parse(readFileSync(versionsPath, "utf8")) : [];
    if (!versions.includes(manifest.version)) versions.push(manifest.version);
    writeFileSync(versionsPath, `${JSON.stringify(versions)}\n`);
    plugins.push({
      id: entry.id, name: manifest.displayName ?? manifest.name, displayName: entry.displayName, version: manifest.version,
      description: entry.description, author: manifest.author ?? "", license: manifest.license ?? "", homepage: entry.homepage ?? manifest.homepage, repository: entry.repository ?? manifest.github,
      tags: manifest.tags ?? [], scope: manifest.scope ?? "node", requires: manifest.requires ?? {},
      url: `plugins/${entry.id}/${manifest.version}/install.json`, sha256: digest, size: bytes.length,
      publishedAt: entry.publishedAt, minHost: entry.minHost, agentGuide: typeof manifest.agentGuide === "string" && manifest.agentGuide.length > 0,
    });
    log(`${entry.id}@${manifest.version}: ${(bytes.length / 1024 ** 2).toFixed(2)} MiB, sha256 ${digest.slice(0, 16)}…`);
  }
  plugins.sort((a, b) => a.id.localeCompare(b.id));
  const index = { schema: "openCinema-pluginMarket-v1", name: "OpenCinema Plugin Market", generatedAt: new Date().toISOString(), plugins };
  mkdirSync(marketRoot, { recursive: true });
  writeFileSync(path.join(marketRoot, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  log(`wrote market/index.json (${plugins.length} plugin${plugins.length === 1 ? "" : "s"})`);
  return index;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildMarket();
