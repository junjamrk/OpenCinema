import { openCinema, version } from "../package.json";
import { z } from "zod";
import type { NodePluginDefinition } from "@toonflow/nodes-scaffold/contracts";
import type { WorkspaceDocuments } from "@toonflow/nodes-scaffold/workspaceDocuments";
import type { WorkspaceFiles } from "@toonflow/nodes-scaffold/nodeFiles";
import CollaborationPanel from "./reactView";
import { createService } from "./reactService";

export default {
  ...openCinema,
  version,
  apiVersion: 1,
  renderer: "react",
  scope: openCinema.scope as "workspace",
  view: CollaborationPanel,
  activate(context) {
    const service = createService({
      documents: context.getService<WorkspaceDocuments>("workspaceDocuments"),
      signal: context.signal,
      state: context.getService<Map<string, unknown>>("state"),
      getFiles: () => context.getService<WorkspaceFiles>("files"),
    });
    const snapshot = () => {
      const { invite: _invite, ...state } = service.state;
      return { ...state };
    };
    const stateSchema = z.strictObject({ status: z.string(), error: z.string(), role: z.string(), roomId: z.string(), inviteRole: z.string(), inviteExpiresAt: z.number(), expiresAt: z.number(), lastSyncedAt: z.number(), busy: z.boolean(), conflict: z.boolean() });
    async function action(callback: () => Promise<void>) {
      await callback();
      if (service.state.error) throw new Error(service.state.error);
      return snapshot();
    }
    context.registerTool({
      name: "getCollaborationState",
      description: "读取当前工作区真实协作连接状态、角色、期限与冲突；不返回邀请凭据。",
      parameters: z.strictObject({}),
      outputSchema: stateSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      execute: snapshot,
    });
    context.registerTool({
      name: "openCollaboration",
      description: "开启或恢复当前工作区协作，接入权威保存与历史。",
      parameters: z.strictObject({}),
      outputSchema: stateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      execute: () => action(service.open),
    });
    context.registerTool({
      name: "joinCollaboration",
      description: "使用此工作区明确提供的限时邀请加入协作。",
      parameters: z.strictObject({ roomId: z.string().min(1), token: z.string().min(1) }),
      outputSchema: stateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      execute: (args) => action(() => service.join(args.roomId, args.token)),
    });
    context.registerTool({
      name: "inviteCollaborator",
      description: "创建当前工作区编辑或只读邀请；仅所有者可用。返回邀请应仅交付被邀请者。",
      parameters: z.strictObject({ role: z.enum(["editor", "viewer"]) }),
      outputSchema: z.strictObject({ invitation: z.string(), invitationText: z.string(), expiresAt: z.number() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      async execute(args) {
        await action(() => service.invite(args.role));
        return { invitation: service.state.invite, invitationText: service.invitationText, expiresAt: service.state.inviteExpiresAt };
      },
    });
    for (const [name, callback, description] of [
      ["resumeCollaboration", service.resume, "恢复已暂停的同步并重用已有命令 ID。"],
      ["recoverCollaborationDraft", service.recoverDraft, "明确另存本地草稿后采用远端基线。"],
      ["leaveCollaboration", service.leave, "离开协作并保全未确认的本地草稿。"],
      ["closeCollaboration", service.close, "结束当前工作区协作，仅所有者可用。"],
      ["revokeCollaborationInvite", service.revoke, "撤销最近创建的限时邀请。"],
    ] as const)
      context.registerTool({
        name,
        description,
        parameters: z.strictObject({}),
        outputSchema: stateSchema,
        annotations: { readOnlyHint: false, destructiveHint: name !== "resumeCollaboration", idempotentHint: false, openWorldHint: true },
        execute: () => action(callback),
      });
    return { service, dispose: service.dispose };
  },
} satisfies NodePluginDefinition<typeof CollaborationPanel>;
