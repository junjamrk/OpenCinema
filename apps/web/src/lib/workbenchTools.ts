import { z } from "zod";
import { canvasOperations } from "@toonflow/tool-canvas/runtime";
import { providerModelSchema, ffmpegConfigurationSchema, ffmpegStatusSchema, ffmpegProgressSchema, localVideoConnectionChangesSchema, localVideoConnectionSchema, localVideoConnectionInspectionInputSchema, localVideoConnectionInspectionSchema } from "./workbenchSettingsClient";

export const nodeId = z.string().min(1).max(256);
export const revisionSchema = z.number().int().nonnegative();
export const textSchema = z.string().max(1000000);
export const relativePathSchema = z.string().min(1).max(4096).refine(value => !/^(?:[\\/]|[a-z][a-z\d+.-]*:)/i.test(value) && !value.includes("\0") && value.replaceAll("\\", "/").split("/").every(part => !!part && part !== "." && part !== ".."), "路径必须是库或工程内的相对路径");
const positionSchema = z.strictObject({ x: z.number().finite(), y: z.number().finite() });
const viewportValueSchema = z.strictObject({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().finite().positive() });
const viewportSchema = viewportValueSchema.extend({ zoom: z.number().finite().min(0.15).max(8) });
const pageSchema = { offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(30) };
const fileRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
const directorySchema = z.string().min(1).max(4096);
const selectionIdsSchema = z.array(nodeId).min(1).max(100).refine(ids => new Set(ids).size === ids.length, "节点 ID 不能重复");
export const connectionEndpointSchema = z.strictObject({ nodeId, handleId: nodeId, direction: z.enum(["source", "target"]) });
const canvasViewOptionsSchema = z.strictObject({ miniMap: z.boolean(), snapEnabled: z.boolean(), showEdges: z.boolean(), highlight: z.enum(["none", "upstream", "downstream", "both"]) });
const nodeEditorViewSchema = z.strictObject({ nodeId, open: z.boolean(), phase: z.enum(["inline", "opening", "open", "closing"]), viewRevision: revisionSchema, ready: z.boolean(), available: z.boolean() });
const canvasPreferencesSchema = z.strictObject({ nodeMenu: z.array(z.json()).max(512).optional(), canvasShortcuts: z.record(z.string(), z.string().max(512)).optional(), canvasEdgeAnimationEnabled: z.boolean().optional(), canvasEdgeColorMode: z.enum(["none", "theme", "custom"]).optional(), canvasEdgeColor: z.string().regex(/^#(?:[a-f\d]{3}|[a-f\d]{4}|[a-f\d]{6}|[a-f\d]{8})$/i).optional() });
const canvasManagementSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("createCanvas"), directory: directorySchema, path: z.union([z.literal(""), relativePathSchema]).optional(), name: z.string().trim().min(1).max(120).optional() }),
  z.strictObject({ kind: z.literal("createFolder"), directory: directorySchema, path: z.union([z.literal(""), relativePathSchema]).optional(), name: z.string().trim().min(1).max(120).optional() }),
  z.strictObject({ kind: z.literal("copy"), directory: directorySchema, path: relativePathSchema, target: relativePathSchema, fileRevision: fileRevisionSchema }),
  z.strictObject({ kind: z.literal("rename"), directory: directorySchema, path: relativePathSchema, target: relativePathSchema, fileRevision: fileRevisionSchema }),
  z.strictObject({ kind: z.literal("move"), directory: directorySchema, path: relativePathSchema, target: relativePathSchema, fileRevision: fileRevisionSchema }),
  z.strictObject({ kind: z.literal("remove"), directory: directorySchema, path: relativePathSchema, fileRevision: fileRevisionSchema }),
]);
export const connectionSchema = z.strictObject({ source: nodeId, target: nodeId, sourceHandle: nodeId, targetHandle: nodeId });
export const workspaceToolSchemas = {
  getWorkspaceTools: z.strictObject({ pluginId: nodeId.optional(), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(50).default(20), version: revisionSchema.optional(), toolCatalogVersion: revisionSchema.optional() }),
  workspaceTools: z.strictObject({ pluginId: nodeId, name: z.string().regex(/^[a-z][a-zA-Z0-9]{0,63}$/), toolCatalogVersion: revisionSchema, args: z.record(z.string(), z.json()) }),
};
export const uiSchemas = {
  moveNodes: z.strictObject({ nodes: z.array(z.strictObject({ id: nodeId, position: z.strictObject({ x: z.number().finite(), y: z.number().finite() }) })).min(1).max(10000) }),
  renameNode: z.strictObject({ id: nodeId, label: z.string().trim().min(1).max(200) }),
  resizeNode: z.strictObject({ id: nodeId, width: z.number().finite().min(220).max(20000), height: z.number().finite().min(120).max(20000), position: z.strictObject({ x: z.number().finite(), y: z.number().finite() }) }),
  removeElements: z.strictObject({ nodeIds: z.array(nodeId).max(10000).default([]), edgeIds: z.array(nodeId).max(20000).default([]) }),
  duplicateNodes: z.strictObject({ nodeIds: z.array(nodeId).min(1).max(100).refine(ids => new Set(ids).size === ids.length, "节点 ID 不能重复"), withEdges: z.boolean().optional(), reparent: z.boolean().optional(), offset: z.strictObject({ x: z.number().finite(), y: z.number().finite() }).optional() }),
};
export const additionalCanvasOperations = [
  { name: "getCompatibleNodeTypes", description: "从指定输入或输出端口发现可连接的新节点类型；source发现下游、target发现上游，复用手工拖线的真实端口和插件规则，不创建节点。", parameters: connectionEndpointSchema.extend({ canvasId: nodeId.optional() }) },
  { name: "addConnectedNode", description: "从指定输入或输出端口原子创建并连接新节点；endpoint.direction为source时创建下游，target时创建上游。type先从getCompatibleNodeTypes发现，校验失败不留下节点或连线，成功纳入统一历史并保存。", parameters: z.strictObject({ type: nodeId, position: positionSchema, endpoint: connectionEndpointSchema }) },
  { name: "getCompatibleSelectionNodeTypes", description: "发现可承接整个选区（含分组内节点）的节点类型；复用实际端口和插件接收规则，不创建节点。", parameters: z.strictObject({ nodeIds: selectionIdsSchema, canvasId: nodeId.optional() }) },
  { name: "addConnectedSelectionNode", description: "一次创建目标节点并批量连接选区的兼容输出；整批验证失败不留下节点或部分连线。成功纳入统一历史并保存。", parameters: z.strictObject({ nodeIds: selectionIdsSchema, type: nodeId, position: positionSchema }) },
  { name: "getCanvasFolders", description: "分页读取当前工程画布目录，含空目录；offset从0开始，hasMore时用nextOffset继续。", parameters: z.strictObject({ offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(30) }) },
  { name: "groupNodes", description: "将选中节点及子树成组，保留绝对位置；跨父分组时创建顶层分组。", parameters: uiSchemas.duplicateNodes.pick({ nodeIds: true }) },
  { name: "ungroupNodes", description: "拆除指定画布分组，将子节点提升到最近未拆父分组，保留位置和素材。", parameters: uiSchemas.duplicateNodes.pick({ nodeIds: true }) },
  { name: "mergeGroups", description: "将至少两个分组合并，保留首组和子节点的绝对位置。", parameters: uiSchemas.duplicateNodes.pick({ nodeIds: true }) },
  { name: "reparentNodes", description: "将指定节点及子树移入明确parentId分组，或以null移到顶层；批量保留画布绝对位置，不根据相交区域猜分组、不自动调整分组尺寸。同批父子只移动根节点，循环/后代/非分组目标和锁定、隐藏或extent受限节点整体拒绝。先读取layout、parentId和absolutePosition。", parameters: z.strictObject({ nodeIds: selectionIdsSchema, parentId: nodeId.nullable() }) },
  { name: "duplicateNodes", description: "复制节点及子树、独立素材与内部参考，剥离任务绑定；默认保留输入连线，withEdges=false不复制连线。", parameters: uiSchemas.duplicateNodes },
  { name: "arrangeSelection", description: "按横向、纵向或网格排列选区，贴合原分组边界，不按相交关系重新归组。", parameters: z.strictObject({ nodeIds: z.array(nodeId).min(2).max(100), mode: z.enum(["horizontal", "vertical", "grid"]) }) },
  { name: "connectSelection", description: "将选中节点或分组子树批量连接到指定目标；每个来源匹配一个兼容输出端口，整批校验后原子连接，已有连接不重复添加。", parameters: z.strictObject({ nodeIds: z.array(nodeId).min(1).max(100), target: nodeId, targetHandle: nodeId.optional() }) },
  { name: "manageCanvas", description: "管理明确directory内的画布和文件夹。创建时path为父目录，不需要文档修订；创建画布会先保存旧会话再导航。复制/改名/移动/删除须先保存有关画布、用workspaceFiles stat读取源fileRevision；path与target为完整相对路径，服务端锁内保护。文件修订是内容hash、目录修订是子树元数据，均不使用documentRevision。删除仅画布或空目录且保留素材。", parameters: canvasManagementSchema },
  { name: "renameProject", description: "设置明确directory的当前工程显示名称，不需要画布或文档修订；浏览器保存到最近工程缓存，原生宿主保留在当前会话中，不移动磁盘目录。", parameters: z.strictObject({ directory: directorySchema, name: z.string().trim().min(1).max(120) }) },
  { name: "resizeNodes", description: "批量设置节点宽高，单位为画布像素；保持各节点位置，任一节点不可调整则整体拒绝，完成后保存。", parameters: z.strictObject({ sizes: z.array(z.strictObject({ nodeId, width: z.number().finite().min(220).max(20000), height: z.number().finite().min(120).max(20000) })).min(1).max(64).refine(value => new Set(value.map(item => item.nodeId)).size === value.length, "节点 ID 不能重复") }) },
  { name: "setCanvasViewport", description: "设置精确画布视口并保存；x/y 为屏幕像素平移，zoom 为缩放倍数，与界面一致为0.15到8；不会移动节点。", parameters: z.strictObject({ viewport: viewportSchema }) },
];

export const peripheralToolSchemas = {
  getCanvasPreferences: z.strictObject({}),
  setCanvasPreferences: z.strictObject({ changes: canvasPreferencesSchema.refine(value => Object.keys(value).length > 0, "至少修改一项偏好"), expectedRevision: fileRevisionSchema }),
  getMediaToolsConfiguration: z.strictObject({}),
  setMediaToolsConfiguration: z.strictObject({ changes: z.strictObject({ mode: z.enum(["auto", "download", "system"]).optional(), source: nodeId.optional() }).refine(value => Object.keys(value).length > 0, "至少修改一项配置"), expectedRevision: fileRevisionSchema }),
  prepareMediaToolsDownload: z.strictObject({ source: nodeId }),
  cancelMediaToolsDownload: z.strictObject({}),
  getProviderModels: z.strictObject({ providerId: nodeId, ...pageSchema, providerRevision: fileRevisionSchema.optional() }),
  setProviderModels: z.strictObject({ providerId: nodeId, models: z.array(providerModelSchema).max(2000), expectedRevision: fileRevisionSchema }),
  refreshProviderModels: z.strictObject({ providerId: nodeId, expectedRevision: fileRevisionSchema }),
  manageMediaProviders: z.discriminatedUnion("action", [
    z.strictObject({ action: z.literal("restoreBuiltin"), builtinId: nodeId }),
    z.strictObject({ action: z.literal("importManifest"), path: relativePathSchema, fileRevision: fileRevisionSchema }),
    z.strictObject({ action: z.literal("remove"), providerId: nodeId, expectedRevision: fileRevisionSchema }),
  ]),
  exportPluginPackage: z.strictObject({ pluginId: nodeId, pluginRevision: fileRevisionSchema, path: relativePathSchema, canvasId: nodeId, expectedRevision: revisionSchema }),
  getCanvasView: z.strictObject({ canvasId: nodeId.optional() }),
  getNodeEditorView: z.strictObject({ canvasId: nodeId, nodeId }),
  setNodeEditorView: z.strictObject({ canvasId: nodeId, nodeId, open: z.boolean(), expectedViewRevision: revisionSchema }),
  setCanvasView: canvasViewOptionsSchema.partial().extend({ canvasId: nodeId.optional() }).refine(value => Object.keys(value).some(key => key !== "canvasId"), "至少修改一个视图选项"),
  getCanvasViewport: z.strictObject({ canvasId: nodeId.optional() }),
  getCanvasHistory: z.strictObject({ canvasId: nodeId.optional(), ...pageSchema }),
  getAssetLibrary: z.strictObject({ path: z.union([z.literal("."), relativePathSchema]).default("."), query: z.string().max(200).optional(), kind: z.enum(["all", "image", "video", "audio", "other", "directory"]).default("all"), ...pageSchema, queryRevision: z.string().regex(/^[a-f0-9]{64}$/).optional() }),
  getAssetInfo: z.strictObject({ path: relativePathSchema }),
  manageAssetLibrary: z.discriminatedUnion("action", [
    z.strictObject({ action: z.literal("createFolder"), path: relativePathSchema }),
    z.strictObject({ action: z.literal("rename"), path: relativePathSchema, target: relativePathSchema, fileRevision: fileRevisionSchema }),
    z.strictObject({ action: z.literal("remove"), path: relativePathSchema, fileRevision: fileRevisionSchema }),
    z.strictObject({ action: z.literal("saveNodeOutput"), path: relativePathSchema, nodeId, handle: nodeId, canvasId: nodeId, expectedRevision: revisionSchema }),
    z.strictObject({ action: z.literal("importAsset"), path: relativePathSchema, fileRevision: fileRevisionSchema, position: positionSchema, canvasId: nodeId, expectedRevision: revisionSchema }),
  ]),
  getPluginConfiguration: z.strictObject({ pluginId: nodeId.optional(), ...pageSchema }),
  setPluginConfiguration: z.strictObject({ pluginId: nodeId, toolCatalogVersion: revisionSchema, expectedRevision: fileRevisionSchema, changes: z.record(z.string().min(1).max(256), z.union([z.string().max(16384), z.number().finite(), z.boolean(), z.null()])).refine(value => Object.keys(value).length >= 1 && Object.keys(value).length <= 100, "每次修改1到100个配置项") }),
  setPluginEnabled: z.strictObject({ pluginId: nodeId, enabled: z.boolean(), toolCatalogVersion: revisionSchema }),
  reviewPluginPackage: z.strictObject({ path: relativePathSchema }),
  installPluginPackage: z.strictObject({ path: relativePathSchema, fileRevision: z.string().regex(/^[a-f0-9]{64}$/), replaceExisting: z.boolean().default(false), replaceBuiltin: z.boolean().default(false) }),
  uninstallPluginPackage: z.strictObject({ pluginId: nodeId, toolCatalogVersion: revisionSchema, restoreBuiltin: z.boolean().default(false) }),
  getPluginMarket: z.strictObject({ query: z.string().max(200).optional(), ...pageSchema }),
  installMarketplacePlugin: z.strictObject({ pluginId: nodeId, version: z.string().min(1).max(64), sha256: fileRevisionSchema, replaceExisting: z.boolean().default(false), replaceBuiltin: z.boolean().default(false) }),
  getFileTransferCapabilities: z.strictObject({}),
  importWorkspaceMedia: z.strictObject({ files: z.array(z.strictObject({ path: relativePathSchema, fileRevision: fileRevisionSchema })).min(1).max(20), position: positionSchema, canvasId: nodeId, expectedRevision: revisionSchema }),
  getModelStatus: z.strictObject({ providerId: nodeId.optional(), ...pageSchema }),
  getProviderConfiguration: z.strictObject({ providerId: nodeId }),
  setProviderConfiguration: z.strictObject({ providerId: nodeId, expectedRevision: fileRevisionSchema, changes: z.record(z.string().min(1).max(256), z.union([z.string().max(16384), z.number().finite(), z.boolean()])).refine(value => Object.keys(value).length >= 1 && Object.keys(value).length <= 100, "每次修改1到100个配置项") }),
  getLocalVideoConnection: z.strictObject({}),
  setLocalVideoConnection: z.strictObject({ changes: localVideoConnectionChangesSchema, expectedRevision: fileRevisionSchema }),
  inspectLocalVideoConnection: localVideoConnectionInspectionInputSchema,
  prepareDepthModel: z.strictObject({}),
  cancelDepthModelPreparation: z.strictObject({}),
  exportProject: z.strictObject({ path: relativePathSchema.refine(path => path.toLowerCase().endsWith(".zip"), "导出路径须以.zip结尾"), canvasId: nodeId, expectedRevision: revisionSchema }),
};
const peripheralDescriptions: Record<keyof typeof peripheralToolSchemas, string> = {
  getCanvasPreferences: "读取持久化的节点菜单三级分组/顺序/别名/隐藏、快捷键和连线动画/颜色，以及独立configRevision；不读取凭据。",
  setCanvasPreferences: "保存节点菜单和画布偏好。changes仅合并提供字段，expectedRevision来自getCanvasPreferences的configRevision；nodeMenu沿用字符串节点或{type,alias?,hidden?}及{id:'group:...',label,children,hidden?}三级结构，空数组恢复默认。刷新真实界面，不改作品历史。",
  getMediaToolsConfiguration: "读取FFmpeg/ffprobe真实可用路径、版本、下载状态和独立配置修订；不下载文件。",
  setMediaToolsConfiguration: "按独立configRevision修改FFmpeg的auto/download/system方式或已发现线路；只保存配置，不启动下载。",
  prepareMediaToolsDownload: "明确从getMediaToolsConfiguration发现的线路下载FFmpeg，返回启动状态；随后重复读取状态确认真实终态，需operationId。",
  cancelMediaToolsDownload: "请求取消FFmpeg下载，返回真实进度；cancelling不等于终态，继续读取getMediaToolsConfiguration。",
  getProviderModels: "分页读取媒体供应商完整模型定义与独立providerRevision，保留模型能力声明；后续页须传相同providerRevision。不读取Key或发起远端请求。",
  setProviderModels: "按providerRevision完整替换媒体模型清单，手工模型管理与Agent共用锁内原子保存；保留高级能力字段，不发起生成或计费。",
  refreshProviderModels: "明确请求供应商远端模型目录并按providerRevision保存，复用手工获取模型入口；会访问供应商并使用已配置连接，不能在只需本地读目录时调用。不发起媒体生成。",
  manageMediaProviders: "恢复明确的内置供应商、导入工作区内已复核SHA256的HTTP JSON manifest，或按providerRevision删除供应商。不会读取/写入凭据或执行旧TypeScript脚本，不发起远端请求。",
  exportPluginPackage: "将已安装React插件及assets导出到工程相对路径，按pluginRevision读取并排他保存、SHA256回读。原始内置插件无发行包时明确拒绝；不改变当前插件，不覆盖文件。",
  getCanvasView: "读取当前画布界面的MiniMap、网格吸附、连线可见性和一跳上下游高亮；纯会话视图，不写作品或历史。",
  getNodeEditorView: "读取节点通用展开编辑器的实际开关、动画阶段、就绪状态与viewRevision；与手工展开编辑器共用同一视图。",
  setNodeEditorView: "打开或关闭节点完整编辑器，与手工操作共用同一入口，等待真实视图迁移与动画完成。先getNodeEditorView取得expectedViewRevision；纯会话视图，不修改作品、生成或导出媒体。",
  setCanvasView: "设置当前画布会话的MiniMap、网格吸附、连线可见性和高亮方向；手工与Agent共用实际视图状态，不移动节点，不写作品或撤销历史。",
  getCanvasViewport: "读取当前视口的精确x/y像素平移及zoom倍数；返回documentRevision供后续写入。",
  getCanvasHistory: "分页读取现有统一编辑会话的撤销/重做历史及savedRevision。协作模式仅报告协作历史是否可用，不伪造本地历史条目。",
  getAssetLibrary: "分页搜索全局素材库的一层目录，返回文件类型和稳定路径；queryRevision仅绑定目录查询，offset大于0时须沿用上一页版本，不是作品修订。",
  getAssetInfo: "读取全局素材的size与fileRevision；文件版本为内容hash，目录版本为子树元数据快照。改名/删除/导入必须使用此版本，目录快照不代替文件内容hash。",
  manageAssetLibrary: "操作既有全局素材库：新建文件夹、改名/移动、删除文件或空目录、保存节点输出、导入素材为节点。保存输出和导入必须固定画布和documentRevision；写入不覆盖同名素材。创建/保存/导入需外层operationId以安全重放。",
  getPluginConfiguration: "分页发现插件启用状态、实际configRules和脱敏非秘密配置；凭据仅返回configured状态。没有声明字段的插件不可通过此入口改任意配置。同时返回插件 description 与 tags；指定 pluginId 时附带 agentGuide（插件作者写给 Agent 的操作指南，先读它再调用节点函数）。",
  setPluginConfiguration: "按getPluginConfiguration发现的非秘密configRules修改字段；expectedRevision必须为该插件configRevision（与toolCatalogVersion/文档修订独立），服务端锁内校验后原子保存。保留其他配置并重载现有插件，不读写凭据或任意settings JSON。",
  setPluginEnabled: "启停已发现的插件；停用前通过现有会话保存，保留作品和素材。操作会更新toolCatalogVersion，后续动态调用须重新发现。",
  reviewPluginPackage: "读取工程内插件JSON包并返回id/version/当前版本/作者/许可/requires/providers/资源数量/替换影响/不兼容原因和fileRevision供安装复核；providers的地址会收到用户填写的API Key，须告知用户。不执行插件代码，不在上下文返回源码和资源base64。",
  installPluginPackage: "安装已reviewPluginPackage复核的同一工程文件，fileRevision必须一致；覆盖已装插件及内置版本分别要求replaceExisting/replaceBuiltin。安装会执行插件代码并重载目录，需外层operationId。",
  uninstallPluginPackage: "卸载已安装的React插件，先保存有关节点，不删除节点和素材；恢复已安装的内置更新必须明确restoreBuiltin:true，原始内置能力不允许删除。需固定toolCatalogVersion与外层operationId，后续工具须重新发现。",
  getPluginMarket: "读取插件市场静态目录（默认 opencinema.site，可在设置中更改）并标注每项的已安装版本、缺失能力和不兼容原因；incompatibilities 非空时不要安装，安装会返回 pluginIncompatible。query 按 id、名称、描述、标签子串筛选。只读网络请求，不下载安装包、不执行代码。",
  installMarketplacePlugin: "按 getPluginMarket 返回的 pluginId、version 与 sha256 下载 install.json，校验大小与 SHA-256、包内 id/版本一致后经本机服务安装并重载目录；覆盖已装插件或内置版本分别须 replaceExisting/replaceBuiltin。安装会执行插件代码，需外层 operationId，后续工具须重新发现。",
  getFileTransferCapabilities: "读取本宿主现有文件传输方式与字节限额；大文件先通过workspaceFiles importMedia从授权本机路径导入，再由importWorkspaceMedia创建节点，文件内容不会进入Agent上下文。",
  importWorkspaceMedia: "将工程已有图片/音频/视频/文本导入为节点；files[].fileRevision是workspaceFiles stat给出的内容SHA256。先预检全部内容修订与大小，内部另冻结range的sourceRevision分段身份，最多8MiB逐段读取并最终复核内容SHA，全部完成后才创建节点。最多20文件、每文件及整批总量最多100MiB，文本最多1MB；固定画布/文档修订，需外层operationId。",
  getModelStatus: "分页发现媒体供应商及模型目录、脱敏credentialConfigured状态、可恢复的builtinProviders目录和本地Depth准备状态；不返回API Key，不发起生成或计费。目录存在不代表供应商生成已验证。",
  getProviderConfiguration: "发现指定媒体供应商的真实rules、非秘密config、configRevision和凭据是否已配置；不会读取API Key到Agent上下文，不鉴权或生成。",
  setProviderConfiguration: "只修改getProviderConfiguration已声明的非秘密string/boolean/number字段；expectedRevision为独立configRevision，服务端锁内校验并原子保存。禁止读取或修改凭据，不执行鉴权、媒体生成或计费。",
  getLocalVideoConnection: "读取本地ComfyUI连接的enabled、endpoint和独立configRevision；仅非秘密配置，不访问后端或发起生成。生成走comfyui供应商的模型与节点生成工具。",
  setLocalVideoConnection: "按getLocalVideoConnection的独立configRevision原子修改enabled或endpoint；仅允许localhost/明确局域网的ComfyUI地址，不接受凭据、任意workflow或shell。需外层operationId；保存不代表服务可达、模型已加载或生成成功，随后调用inspectLocalVideoConnection。",
  inspectLocalVideoConnection: "按configRevision探测已配置本地/局域网ComfyUI，读取真实系统，并核对已导入工作流的节点是否存在；不安装模型或发起生成。ready只表示服务可用且节点齐全，模型文件和显存在提交时由ComfyUI校验。",
  prepareDepthModel: "通过既有服务准备固定版本的本地Depth模型（下载约27.5MB）；返回准备状态，随后用getModelStatus观察真实终态。需外层operationId。",
  cancelDepthModelPreparation: "请求取消Depth模型准备；cancelling仅代表取消请求，随后用getModelStatus确认cancelled/ready/failed终态。",
  exportProject: "保存当前作品后复用现有工程ZIP导出，将真实归档排他写入指定工程相对路径并回读校验；artifact.fileRevision为内容SHA256，sourceRevision仅为range分段身份，不能混用。不会覆盖同名文件，归档包含工程内已有文件（含旧ZIP）；需外层operationId。",
};

const canvasReadNames = new Set(["getCanvas", "findCanvasNodes", "getCanvasNodes", "getCanvasEdges", "getNodeTools"]);

export function isCanvasRead(name: string) {
  return canvasReadNames.has(name);
}

const jsonValueSchema = z.toJSONSchema(z.json());
const paginationResult = { total: z.number().int().nonnegative(), hasMore: z.boolean(), nextOffset: z.number().int().nonnegative().optional() };
const canvasResult = { canvasId: z.string().nullable(), documentRevision: revisionSchema, dirty: z.boolean() };
const nodeLayoutSchema = z.strictObject({ origin: z.array(z.number().finite().nullable()).max(2).nullable(), extent: z.union([z.null(), z.enum(["parent", "invalid"]), z.array(z.array(z.number().finite().nullable()).max(2).nullable()).max(2)]), hidden: z.boolean().nullable(), draggable: z.boolean().nullable(), resizable: z.boolean().nullable(), deletable: z.boolean().nullable(), selectable: z.boolean().nullable(), connectable: z.boolean().nullable() }).partial().nullable();
const peripheralResults = {
  getCanvasPreferences: z.object({ general: canvasPreferencesSchema, configRevision: fileRevisionSchema }),
  setCanvasPreferences: z.object({ general: canvasPreferencesSchema, configRevision: fileRevisionSchema, saved: z.literal(true) }),
  getMediaToolsConfiguration: z.object({ ...ffmpegConfigurationSchema.shape, status: ffmpegStatusSchema }),
  setMediaToolsConfiguration: ffmpegConfigurationSchema.extend({ saved: z.literal(true) }),
  prepareMediaToolsDownload: z.object({ progress: ffmpegProgressSchema, observe: z.literal("getMediaToolsConfiguration") }),
  cancelMediaToolsDownload: z.object({ progress: ffmpegProgressSchema, observe: z.literal("getMediaToolsConfiguration") }),
  getProviderModels: z.object({ ...paginationResult, providerId: nodeId, providerRevision: fileRevisionSchema, models: z.array(providerModelSchema) }),
  setProviderModels: z.object({ providerId: nodeId, providerRevision: fileRevisionSchema, modelCount: z.number().int().nonnegative(), saved: z.literal(true) }),
  refreshProviderModels: z.object({ providerId: nodeId, providerRevision: fileRevisionSchema, modelCount: z.number().int().nonnegative(), saved: z.literal(true) }),
  manageMediaProviders: z.object({ action: z.enum(["restoreBuiltin", "importManifest", "remove"]), providerId: nodeId, providerRevision: fileRevisionSchema.optional(), completed: z.literal(true) }),
  exportPluginPackage: z.object({ pluginId: nodeId, pluginRevision: fileRevisionSchema, artifact: z.object({ path: relativePathSchema, size: z.number().int(), fileRevision: fileRevisionSchema }), saved: z.literal(true) }),
  getCompatibleSelectionNodeTypes: z.object({ ...canvasResult, types: z.array(nodeId), unavailable: z.array(z.object({ type: nodeId, reason: z.string().max(1024) })) }),
  getCompatibleNodeTypes: z.object({ ...canvasResult, toolCatalogVersion: revisionSchema, types: z.array(nodeId), unavailable: z.array(z.object({ type: nodeId, reason: z.string().max(1024) })) }),
  addConnectedNode: z.object({ ...canvasResult, revision: revisionSchema, node: z.object({ id: nodeId, type: nodeId, position: positionSchema }).passthrough(), edges: z.array(connectionSchema.extend({ id: nodeId })).length(1), saved: z.literal(true) }),
  reparentNodes: z.object({ ...canvasResult, revision: revisionSchema, parentId: nodeId.nullable(), reparentedNodeIds: z.array(nodeId).min(1).max(100), selectedIds: z.array(nodeId), saved: z.literal(true) }),
  getCanvasView: z.object({ ...canvasResult, options: canvasViewOptionsSchema, persistence: z.literal("session") }),
  getNodeEditorView: z.object({ view: nodeEditorViewSchema, persistence: z.literal("session") }),
  setNodeEditorView: z.object({ view: nodeEditorViewSchema, persistence: z.literal("session") }),
  setCanvasView: z.object({ ...canvasResult, options: canvasViewOptionsSchema, persistence: z.literal("session") }),
  getCanvasViewport: z.object({ ...canvasResult, viewport: viewportValueSchema, units: z.object({ x: z.literal("screenPixels"), y: z.literal("screenPixels"), zoom: z.literal("ratio") }) }),
  fitCanvas: z.object({ ...canvasResult, fitted: z.boolean(), viewport: viewportValueSchema, nodeCount: z.number().int().nonnegative(), nodeIds: z.array(z.string()).optional(), truncated: z.boolean().optional() }),
  getCanvasHistory: z.object({ ...canvasResult, ...paginationResult, mode: z.enum(["local", "collaboration"]), revision: revisionSchema, savedRevision: z.number().int(), entries: z.array(z.object({ direction: z.enum(["undo", "redo"]), steps: z.number().int(), nodes: z.number().int(), edges: z.number().int() })), canUndo: z.boolean(), canRedo: z.boolean() }),
  getAssetLibrary: z.object({ ...paginationResult, path: z.string(), queryRevision: z.string(), entries: z.array(z.object({ name: z.string(), path: z.string(), type: z.enum(["file", "directory"]), kind: z.enum(["image", "video", "audio", "other"]).optional() })) }),
  getAssetInfo: z.object({ path: z.string(), type: z.enum(["file", "directory"]), size: z.number().int(), fileRevision: fileRevisionSchema, revisionScope: z.enum(["fileContent", "directoryMetadata"]) }),
  manageAssetLibrary: z.object({ action: z.enum(["createFolder", "rename", "remove", "saveNodeOutput", "importAsset"]), path: z.string(), completed: z.literal(true) }),
  getPluginConfiguration: z.object({ ...paginationResult, toolCatalogVersion: revisionSchema, plugins: z.array(z.object({ id: z.string(), label: z.string(), version: z.string().optional(), scope: z.enum(["node", "workspace"]), builtin: z.boolean(), installed: z.boolean(), enabled: z.boolean(), configRevision: fileRevisionSchema, loadError: z.string().optional(), configRules: z.array(z.record(z.string(), z.json())), configuration: z.record(z.string(), z.union([z.object({ configured: z.boolean(), secret: z.literal(true) }), z.object({ value: z.json(), secret: z.literal(false) })])), description: z.string().optional(), tags: z.array(z.string()).optional(), license: z.string().optional(), homepage: z.string().optional(), agentGuide: z.string().optional() })) }),
  getPluginMarket: z.object({ ...paginationResult, marketUrl: z.string(), generatedAt: z.string(), hostVersion: z.string(), skippedEntries: z.number().int(), toolCatalogVersion: revisionSchema, plugins: z.array(z.object({ id: z.string(), name: z.string(), version: z.string(), description: z.record(z.string(), z.string()), author: z.string(), license: z.string(), homepage: z.string().optional(), tags: z.array(z.string()), scope: z.enum(["node", "workspace"]), requires: z.record(z.string(), z.number()), minHost: z.string().optional(), size: z.number().int(), sha256: fileRevisionSchema, url: z.string(), installed: z.object({ version: z.string().optional(), builtin: z.boolean(), enabled: z.boolean() }).nullable(), missingCapabilities: z.array(z.object({ name: z.string(), requiredVersion: z.number(), providedVersion: z.number() })), incompatibilities: z.array(z.string()) })) }),
  installMarketplacePlugin: z.object({ installed: z.literal(true), pluginId: z.string(), version: z.string(), sha256: fileRevisionSchema, toolCatalogVersion: revisionSchema }),
  setPluginConfiguration: z.object({ pluginId: z.string(), changedFields: z.array(z.string()), saved: z.literal(true), configRevision: fileRevisionSchema, toolCatalogVersion: revisionSchema }),
  setPluginEnabled: z.object({ pluginId: z.string(), enabled: z.boolean(), saved: z.literal(true), toolCatalogVersion: revisionSchema }),
  reviewPluginPackage: z.object({ path: z.string(), fileRevision: z.string(), size: z.number().int(), pluginId: z.string(), name: z.string().optional(), version: z.string(), renderer: z.literal("react"), assets: z.number().int(), replacesExisting: z.boolean(), replacesBuiltin: z.boolean(), currentVersion: z.string().optional(), author: z.string().optional(), license: z.string().optional(), requires: z.record(z.string(), z.number()), providers: z.array(z.object({ id: z.string(), label: z.string(), apiUrl: z.string(), modelsUrl: z.string().optional() })), incompatibilities: z.array(z.string()) }),
  installPluginPackage: z.object({ installed: z.literal(true), pluginId: z.string(), version: z.string(), fileRevision: z.string(), toolCatalogVersion: revisionSchema }),
  uninstallPluginPackage: z.object({ uninstalled: z.literal(true), pluginId: z.string(), restoredBuiltin: z.boolean(), toolCatalogVersion: revisionSchema }),
  getFileTransferCapabilities: z.object({ provider: z.enum(["reactWeb", "nativeWidget"]), workspaceWriteMaxBytes: z.number().int(), workspaceRangeMaxBytes: z.number().int(), agentInlineMaxBytes: z.number().int(), assetMaxBytes: z.number().int(), mediaImportMaxBytes: z.number().int(), mediaImportBatchMaxBytes: z.number().int(), mediaImportMaxFiles: z.number().int(), textImportMaxBytes: z.number().int(), savedArchiveMaxBytes: z.number().int(), nativeUpload: z.literal("stagedChunks"), largeFileImport: z.literal("workspaceFiles.importMedia → importWorkspaceMedia"), contentInAgentContext: z.literal(false) }),
  importWorkspaceMedia: z.object({ imported: z.array(z.object({ path: z.string(), fileRevision: fileRevisionSchema, size: z.number().int() })), createdNodeIds: z.array(z.string()), saved: z.literal(true) }),
  getModelStatus: z.object({ ...paginationResult, builtinProviders: z.array(z.object({ id: nodeId, label: z.string(), installed: z.boolean() })), providers: z.array(z.object({ id: z.string(), label: z.string(), revision: z.string().optional(), credentialConfigured: z.boolean().nullable(), models: z.array(z.object({ id: z.string(), label: z.string(), type: z.enum(["image", "video", "audio"]) })) })), depth: z.object({ available: z.boolean(), runtimeAvailable: z.boolean(), mediaToolsAvailable: z.boolean().optional(), message: z.string(), phase: z.string().optional(), preparationProgress: z.object({ phase: z.string(), received: z.number(), total: z.number(), error: z.string().optional() }).nullable().optional() }).nullable() }),
  getProviderConfiguration: z.object({ providerId: z.string(), rules: z.array(z.record(z.string(), z.json())), config: z.record(z.string(), z.json()), credentialConfigured: z.record(z.string(), z.boolean()), configRevision: fileRevisionSchema, scope: z.string() }),
  setProviderConfiguration: z.object({ providerId: z.string(), rules: z.array(z.record(z.string(), z.json())), config: z.record(z.string(), z.json()), credentialConfigured: z.record(z.string(), z.boolean()), configRevision: fileRevisionSchema, scope: z.string() }),
  getLocalVideoConnection: localVideoConnectionSchema,
  setLocalVideoConnection: localVideoConnectionSchema,
  inspectLocalVideoConnection: localVideoConnectionInspectionSchema,
  prepareDepthModel: z.object({ preparation: z.object({ phase: z.string(), received: z.number(), total: z.number(), error: z.string().optional() }), cancelRequested: z.boolean(), executionSettled: z.boolean(), observe: z.literal("getModelStatus") }),
  cancelDepthModelPreparation: z.object({ preparation: z.object({ phase: z.string(), received: z.number(), total: z.number(), error: z.string().optional() }), cancelRequested: z.boolean(), executionSettled: z.boolean(), observe: z.literal("getModelStatus") }),
  exportProject: z.object({ saved: z.literal(true), artifact: z.object({ path: z.string(), size: z.number().int(), fileRevision: fileRevisionSchema, sourceRevision: fileRevisionSchema, mimeType: z.literal("application/zip") }) }),
};
const queryResult = { canvasId: { type: "string" }, documentRevision: { type: "integer", minimum: 0 }, queryRevision: { type: ["integer", "string"] }, toolCatalogVersion: { type: "integer", minimum: 0 }, hasMore: { type: "boolean" }, nextCursor: { type: ["string", "null"] } };
const requirementsResult = { type: "object", additionalProperties: { type: "integer", minimum: 1 } };
const availabilityResult = { type: "object", properties: { status: { type: "string", enum: ["available", "unavailable", "unknown"] }, code: { type: "string" }, reason: { type: "string" }, requires: requirementsResult, requirementsDeclared: { type: "boolean" }, missingCapabilities: { type: "array", items: { type: "object", properties: { name: { type: "string" }, requiredVersion: { type: "integer" }, providedVersion: { type: "integer" } }, required: ["name", "requiredVersion", "providedVersion"] } }, recovery: { type: "object", properties: { action: { type: "string" }, message: { type: "string" }, tool: { type: "string" }, args: { type: "object" } }, required: ["action", "message"] } }, required: ["status", "code", "reason", "requires", "requirementsDeclared", "missingCapabilities", "recovery"] };
const runtimeResult = { type: "object", properties: { renderer: { const: "react" }, provider: { type: "string", enum: ["reactWeb", "nativeWidget"] }, declaredCapabilities: requirementsResult, scope: { type: "string" }, executionDependencies: { type: "object", properties: { webGl: { const: "unknown" }, models: { const: "unknown" }, mediaTools: { const: "unknown" }, observeTool: { const: "getModelStatus" } }, required: ["webGl", "models", "mediaTools", "observeTool"] } }, required: ["renderer", "provider", "declaredCapabilities", "scope", "executionDependencies"] };
const resultSchemas: Record<string, Record<string, unknown>> = {
  getCanvas: { type: "object", properties: { ...queryResult, id: { type: "string" }, nodeCount: { type: "integer" }, edgeCount: { type: "integer" }, selectedCount: { type: "integer" }, viewport: z.toJSONSchema(viewportValueSchema), canvases: { type: "array", items: { type: "object" } }, availableNodeTypes: { type: "array", items: { type: "object", properties: { type: { type: "string" }, label: { type: "string" }, description: { type: "string" }, category: { type: "string" }, supported: { type: "boolean" }, requires: requirementsResult, availability: availabilityResult }, required: ["type", "label", "requires", "availability"] } } }, required: [...Object.keys(queryResult), "id", "nodeCount", "edgeCount", "selectedCount", "viewport"] },
  findCanvasNodes: { type: "object", properties: { ...queryResult, nodes: { type: "array", items: { type: "object", properties: { id: { type: "string" }, type: { type: "string" }, label: { type: "string" }, selected: { type: "boolean" } }, required: ["id", "label", "selected"] } }, scanned: { type: "integer" }, totalNodes: { type: "integer" } }, required: [...Object.keys(queryResult), "nodes", "scanned", "totalNodes"] },
  getCanvasNodes: { type: "object", properties: { ...queryResult, nodes: { type: "array", items: { type: "object", properties: { id: { type: "string" }, parentId: { type: ["string", "null"] }, children: { type: ["array", "null"], items: { type: "string" } }, absolutePosition: { type: ["object", "null"], properties: { x: { type: ["number", "null"] }, y: { type: ["number", "null"] } } }, width: { type: ["number", "null"] }, height: { type: ["number", "null"] }, layout: z.toJSONSchema(nodeLayoutSchema), truncated: { type: "array", items: { type: "object", properties: { path: { type: "array", items: { type: "string" } }, reason: { type: "string" }, nextOffset: { type: "integer" }, total: { type: "integer" } }, required: ["path", "reason"] } } }, required: ["id", "truncated"] } } }, required: [...Object.keys(queryResult), "nodes"] },
  getCanvasEdges: { type: "object", properties: { ...queryResult, edges: { type: "array", items: { type: "object", properties: { id: { type: "string" }, source: { type: "string" }, target: { type: "string" }, sourceHandle: { type: ["string", "null"] }, targetHandle: { type: ["string", "null"] } }, required: ["id", "source", "target"] } }, scanned: { type: "integer" }, totalEdges: { type: "integer" } }, required: [...Object.keys(queryResult), "edges", "scanned", "totalEdges"] },
  getNodeTools: { type: "object", properties: { canvasId: { type: "string" }, documentRevision: { type: "integer" }, queryRevision: {}, toolCatalogVersion: { type: "integer" }, nodeTools: { type: "array", items: { type: "object", required: ["nodeId", "name", "description", "parameters"], properties: { nodeId: { type: "string" }, name: { type: "string" }, description: { type: "string" }, parameters: { type: "object" }, outputSchema: { type: "object" }, annotations: { type: "object" }, requires: requirementsResult } } }, availability: { type: "array", maxItems: 20, items: { ...availabilityResult, properties: { ...availabilityResult.properties, nodeId: { type: "string" }, pluginId: { type: "string" } }, required: [...availabilityResult.required, "nodeId", "pluginId"] } }, runtime: runtimeResult, hasMore: { type: "boolean" }, nextCursor: { type: ["string", "null"] } }, required: ["canvasId", "documentRevision", "queryRevision", "toolCatalogVersion", "nodeTools", "availability", "runtime", "hasMore", "nextCursor"] },
  getWorkspaceTools: { type: "object", properties: { tools: { type: "array", items: { type: "object" } }, version: { type: "integer" }, toolCatalogVersion: { type: "integer" }, hasMore: { type: "boolean" }, nextOffset: { type: "integer" } }, required: ["tools", "version", "toolCatalogVersion", "hasMore"] },
  nodeTools: jsonValueSchema,
  workspaceTools: jsonValueSchema,
  ...Object.fromEntries(Object.entries(peripheralResults).map(([name, schema]) => [name, z.toJSONSchema(schema)])),
};

function toolMetadata(name: string) {
  const readOnlyHint = isCanvasRead(name) || ["getCanvasPreferences", "getMediaToolsConfiguration", "getProviderModels", "getCompatibleNodeTypes", "getCompatibleSelectionNodeTypes", "getCanvasView", "getNodeEditorView", "getWorkspaceTools", "getCanvasFolders", "getCanvasViewport", "getCanvasHistory", "getAssetLibrary", "getAssetInfo", "getFileTransferCapabilities", "getPluginConfiguration", "reviewPluginPackage", "getPluginMarket", "getModelStatus", "getProviderConfiguration", "getLocalVideoConnection", "inspectLocalVideoConnection"].includes(name);
  const broker = name === "nodeTools" || name === "workspaceTools";
  const peripheral = peripheralResults[name as keyof typeof peripheralResults];
  return {
    outputSchema: broker ? z.toJSONSchema(z.strictObject({ result: z.json() })) : peripheral ? z.toJSONSchema(z.strictObject({ result: peripheral })) : { type: "object", properties: { result: resultSchemas[name] ?? { type: "object", properties: { canvasId: { type: ["string", "null"] }, documentRevision: { type: "integer", minimum: 0 }, revision: { type: "integer", minimum: 0 }, dirty: { type: "boolean" }, saved: { type: "boolean" }, selectedIds: { type: "array", items: { type: "string" } }, node: { type: "object" }, edges: { type: "array", items: { type: "object" } }, folders: { type: "array", items: { type: "string" } } }, required: ["canvasId", "documentRevision", "dirty"] } }, required: ["result"], additionalProperties: false },
    annotations: { readOnlyHint, destructiveHint: !readOnlyHint && (broker || ["deleteNodes", "deleteEdges", "manageCanvas", "changeCanvasHistory", "manageAssetLibrary", "installPluginPackage", "installMarketplacePlugin", "uninstallPluginPackage", "manageMediaProviders"].includes(name)), idempotentHint: readOnlyHint || ["saveCanvas", "saveWorkspace", "selectNodes", "fitCanvas", "moveNodes", "renameNodes", "renameProject", "resizeNodes", "setCanvasViewport", "cancelDepthModelPreparation"].includes(name), openWorldHint: broker || ["installPluginPackage", "installMarketplacePlugin", "getPluginMarket", "uninstallPluginPackage", "prepareDepthModel", "prepareMediaToolsDownload", "refreshProviderModels", "setPluginConfiguration", "setPluginEnabled", "manageMediaProviders", "inspectLocalVideoConnection"].includes(name) },
  };
}

const resultValidators = new Map<string, z.ZodType>();
export function validateWorkbenchToolResult(name: string, result: unknown) {
  if (name === "nodeTools" || name === "workspaceTools" || name === "getAppState") return;
  let validator = resultValidators.get(name);
  if (!validator) {
    const tool = listWorkbenchTools().find(tool => tool.name === name);
    const schema = tool?.outputSchema;
    if (!schema) return;
    validator = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
    resultValidators.set(name, validator);
  }
  validator.parse({ result });
}

function createWorkbenchTools() {
  return [{ name: "saveWorkspace", description: "等待当前画布及节点正文通过统一编辑会话实际保存完成；失败保留草稿并抛错，不发起生成。", inputSchema: z.toJSONSchema(z.strictObject({})), ...toolMetadata("saveWorkspace") }, ...[...canvasOperations, ...additionalCanvasOperations].map(tool => {
      const inputSchema = { ...z.toJSONSchema(tool.parameters, { io: "input" }), type: "object" as const };
      if (!isCanvasRead(tool.name) && !["getCompatibleNodeTypes", "getCompatibleSelectionNodeTypes", "switchCanvas", "addCanvas", "getCanvasFolders", "manageCanvas", "renameProject", "renameCanvas"].includes(tool.name)) {
        inputSchema.properties = { ...inputSchema.properties, canvasId: { type: "string", minLength: 1 }, expectedRevision: { type: "integer", minimum: 0 } };
        inputSchema.required = [...new Set([...(inputSchema.required ?? []), "canvasId", ...(tool.name === "nodeTools" ? [] : ["expectedRevision"])])];
      }
      if (tool.name === "renameCanvas") { inputSchema.properties = { ...inputSchema.properties, canvasId: { type: "string", minLength: 1 }, fileRevision: { type: "string", pattern: "^[a-f0-9]{64}$" } }; inputSchema.required = [...new Set([...(inputSchema.required ?? []), "canvasId", "fileRevision"])]; }
      if (tool.name === "nodeTools") { inputSchema.properties = { ...inputSchema.properties, toolCatalogVersion: { type: "integer", minimum: 0 } }; inputSchema.required = [...(inputSchema.required ?? []), "toolCatalogVersion"]; }
      const note = isCanvasRead(tool.name) || ["getCompatibleNodeTypes", "getCompatibleSelectionNodeTypes"].includes(tool.name) ? `documentRevision用于后续写入，queryRevision仅用于分页，toolCatalogVersion绑定动态调用。${tool.name === "getCanvas" ? "availableNodeTypes保留停用/不可用项，检查requires与availability后决定下一步。" : tool.name === "getNodeTools" ? "同时返回所请求nodeIds的availability与runtime摘要，即使函数为空也会说明失败或未知原因；声明的服务版本不等于WebGL/模型/媒体工具已可执行。可用性摘要占同一64KiB预算，需要时减少nodeIds。" : ""}` : tool.name === "nodeTools" ? "必须传入发现回执的 toolCatalogVersion；写函数外层expectedRevision是画布documentRevision，内层args.expectedRevision按节点Schema解释，专业资源字符串版本须来自对应读取函数，不能用画布数字替换。" : ["manageCanvas", "renameProject", "getCanvasFolders", "switchCanvas", "addCanvas"].includes(tool.name) ? "按公布Schema固定工程或导航目标，不需要无关的文档修订。" : tool.name === "renameCanvas" ? "先保存画布并用workspaceFiles stat读取fileRevision；此处按源文件修订保护，不使用documentRevision。" : "画布写入须传入读取到的 canvasId 与 expectedRevision；修订冲突先重新读取。";
      return { name: tool.name, description: `${tool.description} ${note}`, inputSchema, ...toolMetadata(tool.name) };
    }), ...Object.entries(workspaceToolSchemas).map(([name, schema]) => ({ name, description: name === "getWorkspaceTools" ? "分页发现工作区插件的实际工具及完整输入/输出Schema和副作用声明；按toolCatalogVersion继续分页；调用前先发现，禁止猜函数。" : "调用已发现的工作区插件工具；pluginId、name、args和toolCatalogVersion必须来自getWorkspaceTools，不要求无关的画布修订。", inputSchema: z.toJSONSchema(schema, { io: "input" }), ...toolMetadata(name) })),
    ...Object.entries(peripheralToolSchemas).map(([name, schema]) => ({ name, description: peripheralDescriptions[name as keyof typeof peripheralToolSchemas], inputSchema: { ...z.toJSONSchema(schema, { io: "input" }), type: "object" as const }, ...toolMetadata(name) }))];
}

let publishedWorkbenchTools: ReturnType<typeof createWorkbenchTools> | undefined;
export function listWorkbenchTools() {
  return publishedWorkbenchTools ??= createWorkbenchTools();
}
