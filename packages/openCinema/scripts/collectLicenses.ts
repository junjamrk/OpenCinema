import { lstat, mkdir, readFile, readdir, realpath, writeAtomic } from "@toonflow/file";
import { createHash } from "node:crypto";
import { extname, join, relative, resolve, sep } from "node:path";

type LicenseFile = { sourcePath: string; path: string; sha256: string; size: number };
type PackageLicenses = { name: string; version: string | null; license: string | string[] | null; private: boolean; files: LicenseFile[] };

const licenseName = /^(?:licen[cs]e|copying|notice|third[-_]?party[-_]?(?:notice(?:s|text)?|licen[cs]es?))(?:[._-].*)?$/i;
const licenseDirectory = /^(?:licen[cs]es?|notices?)$/i;
const textExtensions = new Set(["", ".txt", ".md", ".rst", ".html", ".markdown"]);

async function optionalDirectory(path: string) {
  try { return await readdir(path, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

function packageLicense(metadata: Record<string, unknown>): string | string[] | null {
  if (typeof metadata.license === "string") return metadata.license;
  if (metadata.license && typeof metadata.license === "object" && typeof (metadata.license as Record<string, unknown>).type === "string") return (metadata.license as { type: string }).type;
  if (!Array.isArray(metadata.licenses)) return null;
  return metadata.licenses.flatMap(value => typeof value === "string" ? [value] : value && typeof value === "object" && typeof value.type === "string" ? [value.type as string] : []);
}

/** ACT: Collect the installed dependency superset, including dev/workspace packages, not exact bundle attribution. */
export async function collectLicenses(repositoryRoot: string, outputDirectory: string) {
  const sourceRoot = resolve(repositoryRoot);
  const outputRoot = resolve(outputDirectory);
  const rootModules = join(sourceRoot, "node_modules");
  await readdir(rootModules);
  const visitedModules = new Set<string>(), visitedPackages = new Set<string>();
  const packages: PackageLicenses[] = [];
  const licenseRoot = join(outputRoot, "licenses");
  await mkdir(outputRoot, { recursive: true });
  await mkdir(licenseRoot);

  async function collectPackage(path: string) {
    const packageRoot = await realpath(path);
    if (visitedPackages.has(packageRoot)) return;
    visitedPackages.add(packageRoot);
    let metadata: Record<string, unknown>;
    try { metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (!metadata || typeof metadata !== "object" || typeof metadata.name !== "string" || !metadata.name) return;
    const item: PackageLicenses = { name: metadata.name, version: typeof metadata.version === "string" ? metadata.version : null, license: packageLicense(metadata), private: metadata.private === true, files: [] };
    packages.push(item);
    const folder = "package" + packages.length;
    const visitedLicenseDirectories = new Set<string>();
    async function collectFiles(directory: string, inLicenseDirectory = false) {
      const canonical = await realpath(directory);
      if ((canonical !== packageRoot && !canonical.startsWith(packageRoot + sep)) || visitedLicenseDirectories.has(canonical)) return;
      visitedLicenseDirectories.add(canonical);
      for (const entry of (await readdir(canonical, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith(".")) continue;
        const fullPath = join(canonical, entry.name);
        const info = entry.isSymbolicLink() ? await lstat(await realpath(fullPath)) : entry;
        const resolved = entry.isSymbolicLink() ? await realpath(fullPath) : fullPath;
        if (!resolved.startsWith(packageRoot + sep)) continue;
        if (info.isDirectory()) {
          if (inLicenseDirectory || licenseDirectory.test(entry.name)) await collectFiles(resolved, true);
          continue;
        }
        if (!info.isFile() || !(licenseName.test(entry.name) || inLicenseDirectory && textExtensions.has(extname(entry.name).toLowerCase()))) continue;
        const bytes = await readFile(resolved);
        if (!item.files.length) await mkdir(join(licenseRoot, folder));
        const outputPath = "licenses/" + folder + "/license" + (item.files.length + 1) + ".txt";
        await writeAtomic(join(outputRoot, outputPath), bytes, { exclusive: true });
        item.files.push({ sourcePath: relative(packageRoot, resolved).split(sep).join("/"), path: outputPath, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length });
      }
    }
    await collectFiles(packageRoot);
    await visitModules(join(packageRoot, "node_modules"));
  }

  async function visitModules(path: string) {
    const entries = await optionalDirectory(path);
    if (!entries.length) return;
    const canonical = await realpath(path);
    if (visitedModules.has(canonical)) return;
    visitedModules.add(canonical);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const fullPath = join(canonical, entry.name);
      if (entry.name === ".bun") {
        for (const stored of (await optionalDirectory(fullPath)).sort((a, b) => a.name.localeCompare(b.name))) {
          if (stored.isDirectory() || stored.isSymbolicLink()) await visitModules(stored.name === "node_modules" ? join(fullPath, stored.name) : join(fullPath, stored.name, "node_modules"));
        }
      } else if (entry.name.startsWith("@")) {
        for (const scoped of (await optionalDirectory(fullPath)).sort((a, b) => a.name.localeCompare(b.name))) {
          if (scoped.isDirectory() || scoped.isSymbolicLink()) await collectPackage(join(fullPath, scoped.name));
        }
      } else if (!entry.name.startsWith(".")) await collectPackage(fullPath);
    }
  }

  await visitModules(rootModules);
  packages.sort((a, b) => a.name.localeCompare(b.name) || (a.version ?? "").localeCompare(b.version ?? ""));
  const catalog = {
    schema: "openCinema-installed-license-catalog-v1",
    scope: "Installed dependency superset; may include development and workspace packages. This is not exact bundle attribution or a legal compatibility assessment.",
    packages,
    missingLicenseFiles: packages.filter(item => !item.files.length).map(({ name, version, license, private: isPrivate }) => ({ name, version, license, private: isPrivate })),
  };
  await writeAtomic(join(outputRoot, "licenseCatalog.json"), JSON.stringify(catalog, null, 2) + "\n", { exclusive: true });
  return catalog;
}
