import { z } from "zod";
import { isCanvasFile } from "@/lib/canvasFile";
import { copyCanvasFiles } from "@/lib/canvasFiles";
import type { WorkspaceFilesClient } from "./workspaceFileClient";

export type CanvasManagementAction = { kind: "createCanvas" | "createFolder" | "copy" | "rename" | "move" | "remove"; directory?: string; path?: string; target?: string; name?: string; fileRevision?: string };
export type CanvasManagementResult = { canvasFiles: { path: string; name: string }[]; canvasFolders: string[]; previousPath?: string; nextPath?: string; openPath?: string; removed?: boolean };

export async function discoverWorkspaceCanvases(files: WorkspaceFilesClient, signal?: AbortSignal) {
  const canvasFiles: { path: string; name: string }[] = [];
  const canvasFolders: string[] = [];
  const pending = [""];
  for (let index = 0; index < pending.length; index++) {
    signal?.throwIfAborted();
    const { entries } = await files.list(pending[index], signal);
    for (const entry of entries) {
      if (entry.type === "directory") {
        if (entry.name.toLowerCase() === "assets" || /^\.toonflow/i.test(entry.name)) continue;
        canvasFolders.push(entry.path);
        pending.push(entry.path);
      } else if (/\.json$/i.test(entry.name) && !/^\.toonflow/i.test(entry.name) && await isCanvasFile(files, entry.path, signal)) {
        canvasFiles.push({ path: entry.path, name: entry.name.slice(0, -5) });
      }
    }
  }
  const compare = (left: string, right: string) => left.localeCompare(right, "zh-CN", { numeric: true });
  return { canvasFiles: canvasFiles.sort((left, right) => compare(left.path, right.path)), canvasFolders: canvasFolders.sort(compare) };
}

function entryName(input: string) {
  const name = z.string().trim().min(1).max(120).parse(input);
  if (/[\\/:*?"<>|\0]/.test(name) || name === "." || name === ".." || /^\.toonflow/i.test(name) || name.toLowerCase() === "assets") throw new Error("名称包含无效或保留字符");
  return name;
}

function relativeEntry(input: string, allowRoot = false) {
  if (allowRoot && !input) return "";
  if (!input || input.startsWith("/") || input.includes("\\") || input.split("/").some(part => entryName(part) !== part)) throw new Error("请选择工作区内的有效路径");
  return input;
}

export function createCanvasManager(files: WorkspaceFilesClient, hooks: {
  beforeChange(action: CanvasManagementAction): Promise<void>;
  afterChange(result: CanvasManagementResult): Promise<void>;
  cloneData?: Parameters<typeof copyCanvasFiles>[3];
}) {
  return {
    async apply(input: CanvasManagementAction) {
      const action = z.strictObject({ kind: z.enum(["createCanvas", "createFolder", "copy", "rename", "move", "remove"]), directory: z.string().optional(), path: z.string().optional(), target: z.string().optional(), name: z.string().optional(), fileRevision: z.string().regex(/^[a-f0-9]{64}$/).optional() }).parse(input);
      const path = relativeEntry(action.path ?? "", action.kind === "createCanvas" || action.kind === "createFolder");
      let target = action.target === undefined ? undefined : relativeEntry(action.target);
      await hooks.beforeChange(action);
      const listing = await discoverWorkspaceCanvases(files);
      const result: Omit<CanvasManagementResult, "canvasFiles" | "canvasFolders"> = {};
      if (action.kind === "createCanvas" || action.kind === "createFolder") {
        if (path && !listing.canvasFolders.includes(path)) throw new Error("目标文件夹不存在");
        const name = entryName(action.name ?? (action.kind === "createFolder" ? "新建文件夹" : "新建画布"));
        if (action.kind === "createCanvas" && !name.replace(/\.json$/i, "")) throw new Error("请输入画布名称");
        target = [path, action.kind === "createCanvas" ? name.replace(/\.json$/i, "") + ".json" : name].filter(Boolean).join("/");
        if (action.kind === "createFolder") await files.mkdir(target);
        else {
          await files.writeJson(target, { toonflowCanvas: true, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }, true);
          result.openPath = target;
        }
      } else {
        const canvas = listing.canvasFiles.find(entry => entry.path === path);
        const isFolder = listing.canvasFolders.includes(path);
        if (!canvas && !isFolder) throw new Error("画布或文件夹不存在，请重新选择");
        if (action.kind === "remove") {
          if (isFolder && (await files.list(path)).entries.length) throw new Error("请先移出或删除文件夹内的内容");
          if (canvas && listing.canvasFiles.length === 1) throw new Error("请至少保留一张画布；先新建画布后再删除");
          await files.remove(path, false, action.fileRevision);
          result.removed = true;
        } else {
          if (!target) throw new Error("请选择目标路径");
          if (target === path) return;
          if (isFolder && target.startsWith(path + "/")) throw new Error("不能把文件夹放入自身子目录");
          const parent = target.split("/").slice(0, -1).join("/");
          if (parent && !listing.canvasFolders.includes(parent)) throw new Error("目标文件夹不存在");
          if (canvas && !/\.json$/i.test(target)) throw new Error("画布文件须保留 .json 扩展名");
          if (action.kind === "copy") {
            const copies = await copyCanvasFiles(files, path, target, hooks.cloneData, action.fileRevision);
            if (canvas) result.openPath = copies[0]?.id;
          } else {
            await files.rename(path, target, action.fileRevision);
            result.nextPath = target;
          }
        }
        result.previousPath = path;
      }
      // ACT: 删除只移除用户确认的文件；素材保留给其他画布和撤销历史，避免按当前快照误删。
      const next = { ...await discoverWorkspaceCanvases(files), ...result };
      await hooks.afterChange(next);
      return next;
    },
  };
}
