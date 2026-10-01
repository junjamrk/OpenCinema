import { $ } from "bun";
import { mkdir } from "@toonflow/file";
import { join, resolve } from "node:path";

const projectDirectory = resolve(import.meta.dirname, "../../..");
const serverDirectory = join(projectDirectory, "apps/server");
const outputDirectory = join(projectDirectory, "build/server");
const platformOs = process.platform === "win32" ? "windows" : process.platform;
const platformArch = process.arch === "x64" ? "amd64" : process.arch;
if (process.env.GOOS && process.env.GOOS !== platformOs || process.env.GOARCH && process.env.GOARCH !== platformArch) throw new Error("当前发行脚本仅构建本机 Go，不支持跨平台发布");
const binaryName = process.platform === "win32" ? "openCinema.exe" : "openCinema";

await mkdir(outputDirectory, { recursive: true });
await $`go build -trimpath -o ${join(outputDirectory, binaryName)} ./go`.cwd(serverDirectory);
