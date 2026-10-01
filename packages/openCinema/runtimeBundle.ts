import { chmod, cp, createReadStream, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeAtomic } from "@toonflow/file";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";

const fileSchema = z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative(), executable: z.boolean() });
const releaseSchema = z.object({ version: z.literal("0.4.0"), platform: z.string(), arch: z.string(), revision: z.string().regex(/^[a-f0-9]{64}$/), files: z.array(fileSchema).min(1) });
export type RuntimeRelease = z.infer<typeof releaseSchema>;

function releaseRevision(release: Omit<RuntimeRelease, "revision">) {
  return createHash("sha256").update(JSON.stringify(release)).digest("hex");
}

async function hashFile(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function releasePath(root: string, path: string) {
  const target = resolve(root, path);
  if (isAbsolute(path) || path.includes("\\") || path.split("/").some(part => !part || part === "." || part === "..") || !target.startsWith(root + sep)) {
    throw new Error("OpenCinema 运行包包含非法路径");
  }
  return target;
}

export async function createRuntimeRelease(root: string): Promise<RuntimeRelease> {
  const files: RuntimeRelease["files"] = [];
  async function visit(relative: string) {
    for (const name of (await readdir(join(root, relative))).sort()) {
      const path = relative ? relative + "/" + name : name;
      if (path === "release.json") continue;
      const fullPath = releasePath(root, path);
      const info = await lstat(fullPath);
      if (info.isDirectory()) await visit(path);
      else if (info.isFile()) files.push({ path, sha256: await hashFile(fullPath), size: info.size, executable: (info.mode & 0o111) !== 0 });
      else throw new Error("OpenCinema 运行包不允许符号链接或特殊文件");
    }
  }
  await visit("");
  const release = { version: "0.4.0" as const, platform: process.platform, arch: process.arch, files };
  return { ...release, revision: releaseRevision(release) };
}

async function verifyBundle(root: string, release: RuntimeRelease) {
  for (const file of release.files) {
    const path = releasePath(root, file.path);
    const info = await lstat(path);
    if (!info.isFile() || info.size !== file.size || await hashFile(path) !== file.sha256) throw new Error("OpenCinema 运行包校验失败，请重新构建或安装插件");
  }
}

export async function prepareRuntimeBundle(source: string, cacheRoot: string) {
  const release = releaseSchema.parse(JSON.parse(await readFile(join(source, "release.json"), "utf8")));
  const { revision, ...details } = release;
  if (releaseRevision(details) !== revision || release.platform !== process.platform || release.arch !== process.arch) {
    throw new Error("OpenCinema 插件运行包与当前平台不匹配或已损坏");
  }
  const destination = join(cacheRoot, revision);
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  try { await verifyBundle(destination, release); return { directory: destination, release }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await verifyBundle(source, release);
  const staging = await mkdtemp(join(cacheRoot, ".preparing"));
  try {
    for (const file of release.files) {
      const target = releasePath(staging, file.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await cp(releasePath(source, file.path), target, { force: false, errorOnExist: true });
      await chmod(target, file.executable ? 0o700 : 0o600);
    }
    await writeAtomic(join(staging, "release.json"), JSON.stringify(release), { mode: 0o600 });
    try { await rename(staging, destination); }
    catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    await verifyBundle(destination, release);
  } finally { await rm(staging, { recursive: true, force: true }); }
  return { directory: destination, release };
}
