/**
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Sam Wasserman (Wasserman Productions / Wasserman.ai).
 * Adapted from Motion Previs Studio planningData, usage documents and Blender templates,
 * commit 95e7d0ff1d4cc546f7eb09a74ccbd084988a19bc. Modified for selected real
 * members, schema-aware readers and non-destructive illustrative imports.
 * No model, provider or Blender execution.
 */
import { z } from "zod";

export const exportLayers = [
  { id: "rgb", label: "RGB 片段", file: "video.mp4", purpose: "裁剪后的外观、取景与运动参考；普通RGB视频" },
  { id: "camera", label: "Camera 二维运动", file: "cameraMotion.json", purpose: "图像平面平移、缩放、旋转估计；没有三维位置、场景尺度或标定" },
  { id: "pose", label: "OpenPose 姿态", file: "pose.mp4", purpose: "人体骨架控制；须使用专用条件接口，不是普通RGB参考" },
  { id: "depth", label: "Depth 相对深度", file: "relativeDepth.mp4", purpose: "已有CPU模型的逐帧相对逆深度，无米制尺度；须使用专用条件接口" },
  { id: "edges", label: "Edges 边缘", file: "edges.mp4", purpose: "FFmpeg edgedetect 的二维轮廓；不是深度或语义边界" },
  { id: "lineart", label: "Lineart 线稿", file: "lineart.mp4", purpose: "灰度Sobel反相与对比度过滤得到的二维线稿；不是模型推理或法线" },
  { id: "contactSheet", label: "Contact sheet", file: "contactSheet.jpg", purpose: "1fps、240px宽、5×2格的源片采样索引；有效格与空格以实际采样数为准" },
  { id: "frameDifferenceMask", label: "frameDifferenceMask（运动差分遮罩）", file: "frameDifferenceMask.mp4", purpose: "相邻采样帧的绝对差；相机运动也会激活，不是人像或语义分割" },
  { id: "normalsProxy", label: "Normals proxy（亮度梯度代理）", file: "normalsProxy.mp4", purpose: "亮度代理经Sobel得到的灰度梯度；非XYZ表面法线、非真实Depth，不可当作法线模型输出" },
  { id: "combinedReview", label: "Combined review（三路审阅）", file: "combinedReview.mp4", purpose: "仅供审阅的RGB / Relative Depth / Pose横排视频；须同时显式选择三层，不是生成条件或精确校准同步" },
] as const;
export const referenceModes = [
  { id: "cameraOnly", label: "只参考运镜" },
  { id: "actorMotion", label: "人物动作" },
  { id: "objectMotion", label: "物体运动" },
  { id: "fullScene", label: "完整场景" },
] as const;
export const productionPlanSchema = z.strictObject({
  shotTitle: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000),
  cameraIntent: z.string().trim().max(1000),
  visualStyle: z.string().trim().max(1000),
  referenceMode: z.enum(["cameraOnly", "actorMotion", "objectMotion", "fullScene"]),
  layers: z.array(z.enum(["rgb", "camera", "pose", "depth", "edges", "lineart", "contactSheet", "frameDifferenceMask", "normalsProxy", "combinedReview"])).min(1).max(10),
}).refine(value => new Set(value.layers).size === value.layers.length, "导出层不能重复")
  .refine(value => !value.layers.includes("combinedReview") || (["rgb", "pose", "depth"] as const).every(layer => value.layers.includes(layer)), { message: "Combined review要求同时显式选择RGB、Pose和真实Depth层", path: ["layers"] });
export type ProductionPlan = z.infer<typeof productionPlanSchema>;

export type ProductionArtifact = { role: string; path: string; mimeType: string };

export function productionDocuments(plan: ProductionPlan, mapping: { sourceTimeOffset: number; clipTimeScale: number }, duration: number) {
  const mode = referenceModes.find(value => value.id === plan.referenceMode)!.label;
  const selected = exportLayers.filter(value => plan.layers.includes(value.id));
  const prompt = [
    `# ${plan.shotTitle}`, `参考模式：${mode}`, `镜头时长：${duration} 秒；源片起点：${mapping.sourceTimeOffset} 秒。`,
    plan.description && `创作意图：${plan.description}`, plan.cameraIntent && `运镜意图：${plan.cameraIntent}`, plan.visualStyle && `视觉风格：${plan.visualStyle}`,
    plan.referenceMode === "cameraOnly" && "仅迁移运镜与节奏；人物、物体身份和外观不作为创作要求。若另选RGB/姿态，文件仍可能包含这些信息，使用前须明确选择。",
    plan.referenceMode === "objectMotion" && "人物姿态不描述物体运动；本包不进行物体身份或轨迹跟踪。",
    "## 实际导出层", ...selected.map(value => `- ${value.file}：${value.purpose}`),
    plan.layers.includes("pose") && "姿态另附 openPose.json。",
    plan.layers.includes("contactSheet") && "Contact sheet最多十格；采样结果不足十格时，剩余格为空，不表示额外采样。有效格数、源范围和采样限制见manifest的image记录。",
    plan.layers.includes("normalsProxy") && "Normals proxy只复用上游亮度代理与Sobel的过滤意图，合并为单条过滤链，与上游先编码proxy再编码梯度的两次H264不保证像素一致；没有真实Depth或XYZ法线推理。",
    plan.layers.includes("combinedReview") && "Combined review只组合显式选择的已有RGB、真实相对Depth和Pose视频，左中右标签与letterbox保留画面；按分析时钟重采样用于人工对照，RGB原采样策略和保持边界另列，不表示精确校准同步，也不能作为普通RGB或专用控制提交。",
    "只使用包内实际存在的文件；不向任何供应商提交，不保证模型支持这些条件协议。",
    `Camera 为二维图像估计，不能作为真实三维相机恢复。${plan.layers.includes("depth") ? "Depth 为逐帧归一化的相对逆深度，无米制尺度；只复制已有模型产物，不重新推理。" : "Depth 未包含。"}Lineart是二维过滤器，运动差分遮罩不是语义分割。`,
    "按 manifest.json 的文件大小与 SHA-256 核对后使用。起点+t是名义选区时间，不表示逐帧原PTS精确相等：新RGB将start之后首个解码帧归零，按源r_frame_rate编码CFR，VFR会重采样，末帧最多保持一个源标称帧间隔；具体采样策略及实读边界见各视频metadata，旧产物不可据本文假定已采用该策略。",
  ].filter(Boolean).join("\n\n");
  return {
    "shotBible.json": JSON.stringify({ schema: "openCinema-motion-shot-v1", ...plan, duration, mapping }, null, 2),
    "promptPack.md": prompt,
    "controlLayers.json": JSON.stringify({ schema: "openCinema-motion-controls-v1", layers: selected,
      depth: plan.layers.includes("depth") ? { available: true, normalization: "per-frame min/max; relative inverse depth, no metric calibration", provenanceFile: "depthProvenance.json" }
        : { available: false, reason: "未选择已有真实 Depth 层" },
      cameraSpace: "image2d", maskKind: "frameDifferenceMask", normalsProxyKind: "luminanceGradientNotSurfaceNormals", reviewOnly: plan.layers.includes("combinedReview") ? ["combinedReview"] : [], automaticProviderSubmission: false }, null, 2),
  };
}

export function productionUsageDocuments(plan: ProductionPlan, mapping: { sourceTimeOffset: number; clipTimeScale: number }, duration: number, availableArtifacts: readonly ProductionArtifact[]): Record<string, string> {
  plan = productionPlanSchema.parse(plan);
  mapping = z.object({ sourceTimeOffset: z.number().finite().min(0), clipTimeScale: z.literal(1) }).parse(mapping);
  z.number().finite().positive().max(30).parse(duration);
  // ACT: 当前两类生产包都是扁平成员；不接受外部路径或任意脚本引用。
  const artifacts = z.array(z.strictObject({ role: z.string().min(1).max(128), path: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*\.(json|mp4|png|jpg|md)$/), mimeType: z.string().min(1).max(128) })).max(64).parse(availableArtifacts);
  if (new Set(artifacts.map(file => file.path)).size !== artifacts.length) throw new Error("生产包成员路径不能重复");
  const has = (path: string, mimeType: string) => artifacts.some(file => file.path === path && file.mimeType === mimeType);
  const selected = exportLayers.filter(layer => plan.layers.includes(layer.id));
  for (const layer of selected) {
    const mimeType = layer.id === "camera" ? "application/json" : layer.id === "contactSheet" ? "image/jpeg" : "video/mp4";
    if (!has(layer.file, mimeType)) throw new Error("所选层尚无真实生产包成员：" + layer.file);
  }
  if (!has("analysis.json", "application/json")) throw new Error("生产包缺少已有分析JSON，未生成使用说明");
  if (plan.layers.includes("pose") && !has("openPose.json", "application/json")) throw new Error("所选姿态层缺少已有OpenPose JSON");
  if (plan.layers.includes("depth") && !has("depthProvenance.json", "application/json")) throw new Error("所选Depth层缺少已有来源记录");
  const camera = plan.layers.includes("camera"), pose = plan.layers.includes("pose");
  const plates = selected.filter(layer => ["rgb", "depth", "edges", "lineart", "frameDifferenceMask", "normalsProxy"].includes(layer.id));
  const templates = [...(camera ? ["blenderCamera.py"] : []), ...(pose ? ["blenderPose.py"] : []), ...(camera || pose || plates.length ? ["blenderScene.py"] : [])];
  const inputs = selected.filter(layer => layer.id !== "combinedReview").map(layer => ({ role: layer.id, file: layer.file, mimeType: artifacts.find(file => file.path === layer.file)!.mimeType, note: layer.purpose }));
  const reviewFiles = selected.filter(layer => layer.id === "combinedReview").map(layer => ({ role: layer.id, file: layer.file, note: layer.purpose }));
  const supportingFiles = artifacts.filter(file => ["analysis.json", "openPose.json", "depthProvenance.json", "relativeDepth.json", "relativeDepth.png"].includes(file.path));
  const names = (ids: readonly string[]) => selected.filter(layer => ids.includes(layer.id)).map(layer => layer.file);
  const guidance = "仅为固定上游的静态手工使用建议，不是可执行工作流或当前供应商兼容承诺；先核对manifest.json的SHA及接收方协议。";
  const source = { name: "Motion Previs Studio", version: "4.1.0", commit: "95e7d0ff1d4cc546f7eb09a74ccbd084988a19bc", date: "2026-07-20", license: "Apache-2.0", modified: true };
  const promptFiles = has("promptPack.md", "text/markdown") ? ["promptPack.md"] : [];
  const documents: Record<string, string> = {
    "comfyManifest.json": JSON.stringify({ schema: "openCinema-comfy-reference-manifest-v1", name: plan.shotTitle, status: "staticUsageGuidance", executableWorkflow: false, automaticSubmission: false,
      source, mapping, duration, referenceMode: plan.referenceMode, recommendedInputs: inputs, supportingFiles, reviewFiles,
      notes: [guidance, "RGB可作普通视频参考；Pose/Depth及二维控制须单独接入明确支持的条件分支。", "Camera JSON只记录二维估计；本清单没有nodes/class_type或可执行graph。", "未导出的层不会在使用阶段自动推理或补编码。"] }, null, 2),
    "modelPresets.json": JSON.stringify({ schema: "openCinema-motion-usage-presets-v1", status: "staticUpstreamUsageGuidance", source, automaticSubmission: false, providerCompatibilityVerified: false,
      mapping, duration, referenceMode: plan.referenceMode, guidance,
      presets: {
        seedance: { primaryInputs: names(["rgb", "camera", "pose", "depth"]), guidance: "固定上游使用说明；专用控制须自行核对当前接口，不默认推荐或提交。" },
        comfyui: { primaryInputs: names(["rgb", "camera", "pose", "depth", "edges", "lineart", "frameDifferenceMask", "normalsProxy"]), guidance: "仅将接收方支持的控制分别接线；灰度normalsProxy不可按XYZ法线解读，Combined review不作控制输入；没有可执行graph。" },
        blender: { primaryInputs: templates, guidance: "手工运行示意模板；二维Camera、33球非rig，无米制尺度，不保存blend。" },
        runway: { primaryInputs: [...names(["rgb", "camera"]), ...promptFiles], guidance: "固定上游的提示词使用建议，未验证当前服务接口。" },
        kling: { primaryInputs: [...names(["rgb", "depth"]), ...promptFiles], guidance: "固定上游的参考使用建议；是否支持控制须由接收方确认。" },
      } }, null, 2),
    "usageGuide.md": [
      "# " + plan.shotTitle + "：手工使用说明",
      "仅列本包真实成员。名义选区时间为 " + mapping.sourceTimeOffset + " + 包内时间（秒），选区时长 " + duration + " 秒，不表示逐帧原PTS精确相等。新RGB将start之后首个解码帧归零，按源r_frame_rate编码CFR，VFR会重采样，末帧最多保持一个源标称帧间隔；具体策略、实读起点/时长/帧率/帧数与保持边界见manifest.json，旧产物不可据本文假定已采用新策略。",
      "先核对manifest中的大小与SHA-256，再使用相对文件。本包不附模型权重、不下载、不上传、不调用供应商。",
      ...inputs.map(input => "- " + input.file + "：" + input.note),
      ...reviewFiles.map(input => "- " + input.file + "：" + input.note),
      plan.layers.includes("normalsProxy") && "normalsProxy.mp4是灰度亮度梯度；单条过滤链保留上游处理意图，与上游两次H264编码不保证像素一致，不提供XYZ法线或真实Depth。",
      plan.layers.includes("combinedReview") && "combinedReview.mp4左中右依次为RGB、Relative Depth、Pose，顶部标签不覆盖画面。三个等尺寸cell按比例letterbox，统一分析采样时钟并保留原始各视频实读fps/时长/hold；RGB重采样可重复已有帧，详见manifest的review记录。它只作人工审阅，不是精确校准同步、生成条件或额外实测帧。",
      "comfyManifest.json与modelPresets.json是固定上游的静态使用建议，不是可执行ComfyUI graph、默认推荐或当前模型兼容承诺。",
      templates.length ? "Blender模板：" + templates.join("、") + "。先解压整个包，在Blender文本编辑器打开并手工运行。模板只读同目录文件，新建集合，不删除旧对象、不更换已有活动相机、不改场景帧率、不自动保存或覆盖blend；请自行另存。" : "本次未选Camera、Pose或视频参考板，不生成无数据的Blender模板。",
      camera && "Camera模板分别识别普通包cameraMotion与Studio包camera封套。35mm与固定运动系数仅复现二维启发式示意，不是真实三维相机、场景尺度或焦距恢复。",
      pose && "Pose读取analysis.json的33点；模型世界点为髋部相对估计，图像点回退另标来源，不是角色rig。缺失帧隐藏，filled补帧保留来源与颜色标记；常值采样不新增检测。",
      plates.length && "Scene把所选真实视频放在分离参考平面，保持manifest中的宽高比，保留实际fps/时长/hold说明。电影贴图使用Blender当前时间轴，帧率不一致时须手工核对；不是已校准的同步Combined Review或三维重建。",
      "模板仅生成文本，未运行Blender；具体版本和用户场景须实际验收。保留本包附带的作者NOTICE、Apache-2.0全文和修改说明。",
    ].filter(Boolean).join("\n\n"),
  };
  if (camera) documents["blenderCamera.py"] = blenderCameraScript();
  if (pose) documents["blenderPose.py"] = blenderPoseScript();
  if (templates.includes("blenderScene.py")) documents["blenderScene.py"] = blenderSceneScript(camera, pose, plates.map(layer => ({ file: layer.file, label: layer.label })));
  return documents;
}

const blenderTemplateHeader = String.raw`# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sam Wasserman (Wasserman Productions / Wasserman.ai).
# Adapted from Motion Previs Studio 95e7d0ff1d4cc546f7eb09a74ccbd084988a19bc.
# Modified for selected real files and non-destructive illustrative imports.
# Generated only; not executed in Blender. Preserve bundled NOTICE/LICENSE.
import json
import math
from pathlib import Path
import bpy

def bundleFile(name):
    folder = Path(__file__).resolve().parent
    path = (folder / name).resolve()
    if path.parent != folder or not path.is_file():
        raise ValueError("Missing or external bundle member: " + name)
    return path

def readDocument(name):
    path = bundleFile(name)
    if path.stat().st_size > 16 * 1024 * 1024:
        raise ValueError("JSON member exceeds 16 MiB: " + name)
    with path.open("r", encoding="utf-8") as source:
        value = json.load(source)
    if not isinstance(value, dict):
        raise ValueError("Expected JSON object: " + name)
    return value

def finiteNumber(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError("Expected finite numeric sample")
    return value

def sceneFps():
    value = bpy.context.scene.render.fps / bpy.context.scene.render.fps_base
    if not math.isfinite(value) or value <= 0:
        raise ValueError("Current scene FPS is invalid")
    return value

def createCollection(name):
    collection = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(collection)
    return collection

def setInterpolation(animated, mode):
    animation = animated.animation_data
    if not animation or not animation.action:
        return
    action = animation.action
    slot = getattr(animation, "action_slot", None)
    if slot is None:
        curves = action.fcurves
    else:
        curves = []
        for layer in action.layers:
            for strip in layer.strips:
                if strip.type == "KEYFRAME":
                    channelbag = strip.channelbag(slot)
                    if channelbag:
                        curves.extend(channelbag.fcurves)
    for curve in curves:
        for point in curve.keyframe_points:
            point.interpolation = mode

`;

function blenderCameraScript() {
  return blenderTemplateHeader + String.raw`def main():
    envelope = readDocument("cameraMotion.json")
    if envelope.get("space") != "image2d":
        raise ValueError("Camera is not an image2d report")
    if envelope.get("schema") == "openCinema-image-motion-v1":
        data = envelope.get("cameraMotion")
    elif envelope.get("schema") == "openCinema-camera-motion-v1":
        data = envelope.get("camera")
    else:
        raise ValueError("Unsupported camera envelope schema")
    if not isinstance(data, dict):
        raise ValueError("Missing camera samples")
    frames = data.get("frames")
    duration = finiteNumber(data.get("duration"))
    if not isinstance(frames, list) or not 1 <= len(frames) <= 360 or not 0 < duration <= 30:
        raise ValueError("Invalid camera sample range")
    samples = []
    previous = -1
    for item in frames:
        time = finiteNumber(item.get("time"))
        move = item.get("cameraMove", {})
        values = [finiteNumber(move.get(key)) for key in ("pan", "tilt", "dollyZoom", "roll")]
        if time <= previous or time < 0 or time > duration + 0.001 or values[2] <= 0:
            raise ValueError("Invalid camera time or zoom")
        samples.append((time, values))
        previous = time
    fps = sceneFps()
    collection = createCollection("OpenCinema Camera 2D Illustration")
    collection["sourceMapping"] = json.dumps(envelope.get("mapping", {}))
    collection["limitations"] = "2D heuristic; arbitrary scale and 35mm lens; not a recovered 3D camera"
    cameraData = bpy.data.cameras.new("OpenCinema Illustrative Camera")
    camera = bpy.data.objects.new("OpenCinema Illustrative Camera", cameraData)
    collection.objects.link(camera)
    for time, (pan, tilt, zoom, roll) in samples:
        frame = 1 + time * fps
        zoom = max(0.2, zoom)
        camera.location = (pan * 3.5, -6 / zoom, 1.6 + tilt * 2.2)
        camera.rotation_euler = (math.radians(78) + tilt * 0.22, pan * 0.18, roll)
        cameraData.lens = 35 * zoom
        camera.keyframe_insert(data_path="location", frame=frame)
        camera.keyframe_insert(data_path="rotation_euler", frame=frame)
        cameraData.keyframe_insert(data_path="lens", frame=frame)
    setInterpolation(camera, "LINEAR")
    setInterpolation(cameraData, "LINEAR")
    if bpy.context.scene.camera is None:
        bpy.context.scene.camera = camera
    bpy.context.scene.frame_set(bpy.context.scene.frame_current)
    print("Created illustrative 2D camera; existing camera, FPS and files preserved.")
    return collection

if __name__ == "__main__":
    main()
`;
}

function blenderPoseScript() {
  return blenderTemplateHeader + String.raw`import bmesh

def main():
    envelope = readDocument("analysis.json")
    if envelope.get("schema") != "openCinema-portable-motion-analysis-v1" or envelope.get("space") != "image2d":
        raise ValueError("Unsupported portable analysis schema")
    data = envelope.get("pose")
    if not isinstance(data, dict) or not isinstance(data.get("frames"), list) or not 1 <= len(data["frames"]) <= 360:
        raise ValueError("No actual pose samples in this package")
    duration = finiteNumber(data.get("duration"))
    if not 0 < duration <= 30:
        raise ValueError("Invalid pose duration")
    samples = []
    previous = -1
    for item in data["frames"]:
        time = finiteNumber(item.get("time"))
        source = item.get("source")
        if source not in (None, "detected", "filled", "missing") or time <= previous or time < 0 or time > duration + 0.001:
            raise ValueError("Invalid pose time or source")
        world = item.get("worldLandmarks") or []
        image = item.get("landmarks") or []
        if not isinstance(world, list) or not isinstance(image, list) or len(world) not in (0, 33) or len(image) not in (0, 33):
            raise ValueError("Expected zero or 33 pose landmarks")
        points = world or image
        coordinates = [(finiteNumber(point.get("x")), finiteNumber(point.get("y")), finiteNumber(point.get("z"))) for point in points]
        kind = "filled" if item.get("filled") or source == "filled" else source or "unspecified"
        samples.append((time, [] if source == "missing" else coordinates, kind, "modelEstimatedHipRelative" if world else "imageNormalized"))
        previous = time
    fps = sceneFps()
    collection = createCollection("OpenCinema Pose 33 Spheres Illustration")
    collection["limitations"] = "33 joint spheres, not a rig; arbitrary scale; no world or metric calibration"
    collection["sourceMapping"] = json.dumps(envelope.get("mapping", {}))
    collection["sampleSources"] = json.dumps([{"time": time, "source": kind, "space": space} for time, points, kind, space in samples])
    collection["poseProvenance"] = json.dumps([{"time": item["time"], "source": item.get("source", "unspecified"), "filled": bool(item.get("filled")), "smoothed": bool(item.get("smoothed"))} for item in data["frames"]])
    mesh = bpy.data.meshes.new("OpenCinema Joint Sphere")
    sphere = bmesh.new()
    bmesh.ops.create_uvsphere(sphere, u_segments=12, v_segments=6, radius=0.035)
    sphere.to_mesh(mesh)
    sphere.free()
    joints = [bpy.data.objects.new("OpenCinema Joint %02d" % index, mesh) for index in range(33)]
    for joint in joints:
        collection.objects.link(joint)
    for time, points, kind, space in samples:
        frame = 1 + time * fps
        for index, joint in enumerate(joints):
            visible = len(points) == 33
            joint.hide_viewport = not visible
            joint.hide_render = not visible
            joint["poseFilled"] = 1 if kind == "filled" else 0
            joint.color = (1.0, 0.55, 0.1, 1.0) if kind == "filled" else (0.1, 0.8, 0.5, 1.0)
            if visible:
                x, y, z = points[index]
                joint.location = (x * 2.5, -z * 2.5, -y * 2.5)
                joint.keyframe_insert(data_path="location", frame=frame)
            for path in ("hide_viewport", "hide_render", "color", '["poseFilled"]'):
                joint.keyframe_insert(data_path=path, frame=frame)
    for joint in joints:
        joint.hide_viewport = True
        joint.hide_render = True
        joint.keyframe_insert(data_path="hide_viewport", frame=1 + duration * fps)
        joint.keyframe_insert(data_path="hide_render", frame=1 + duration * fps)
        setInterpolation(joint, "CONSTANT")
    bpy.context.scene.frame_set(bpy.context.scene.frame_current)
    print("Created 33-sphere illustration; missing samples hidden, filled provenance retained; no rig or files saved.")
    return collection

if __name__ == "__main__":
    main()
`;
}

function blenderSceneScript(camera: boolean, pose: boolean, plates: { file: string; label: string }[]) {
  return blenderTemplateHeader + String.raw`import runpy

def main():
    manifest = readDocument("manifest.json")
    if manifest.get("schema") != "openCinema-motion-production-pack-v1":
        raise ValueError("Unsupported production package")
    members = {item["path"]: item for item in manifest.get("files", [])}
    plates = json.loads(__plates__)
    prepared = []
    for plate in plates:
        member = members.get(plate["file"], {})
        video = member.get("video", {})
        width = finiteNumber(video.get("width"))
        height = finiteNumber(video.get("height"))
        count = finiteNumber(video.get("frameCount"))
        if width <= 0 or height <= 0 or count < 1 or count != int(count) or member.get("mimeType") != "video/mp4":
            raise ValueError("Missing real video metadata: " + plate["file"])
        prepared.append((plate, bundleFile(plate["file"]), video))
    for name in __templates__:
        namespace = runpy.run_path(str(bundleFile(name)), run_name="openCinemaTemplate")
        namespace["main"]()
    collection = createCollection("OpenCinema Reference Plates")
    collection["limitations"] = "Reference plates only; movie textures use scene FPS; inspect per-file FPS/hold. Not a synchronized review or reconstruction"
    for index, (plate, path, video) in enumerate(prepared):
        halfHeight = 1.6 * video["height"] / video["width"]
        mesh = bpy.data.meshes.new("OpenCinema Reference Plane")
        mesh.from_pydata([(-1.6, 0, -halfHeight), (1.6, 0, -halfHeight), (1.6, 0, halfHeight), (-1.6, 0, halfHeight)], [], [(0, 1, 2, 3)])
        mesh.update()
        uv = mesh.uv_layers.new(name="UVMap")
        for loop, coordinate in zip(uv.data, [(0, 0), (1, 0), (1, 1), (0, 1)]):
            loop.uv = coordinate
        plane = bpy.data.objects.new(plate["file"], mesh)
        collection.objects.link(plane)
        plane.location = (index * 3.8, 2, 1.8)
        plane["sourceVideo"] = json.dumps(video)
        material = bpy.data.materials.new("OpenCinema Reference Material")
        material.use_nodes = True
        image = bpy.data.images.load(str(path), check_existing=False)
        image.source = "MOVIE"
        texture = material.node_tree.nodes.new("ShaderNodeTexImage")
        texture.image = image
        texture.image_user.frame_start = 1
        texture.image_user.frame_duration = int(video["frameCount"])
        texture.image_user.use_auto_refresh = True
        texture.image_user.use_cyclic = False
        shader = material.node_tree.nodes.get("Principled BSDF")
        material.node_tree.links.new(texture.outputs["Color"], shader.inputs["Base Color"])
        plane.data.materials.append(material)
    print("Created reference template. Inspect FPS/hold; save a new blend manually. Existing collections and files preserved.")
    return collection

if __name__ == "__main__":
    main()
`.replace("__plates__", JSON.stringify(JSON.stringify(plates))).replace("__templates__", JSON.stringify([...(camera ? ["blenderCamera.py"] : []), ...(pose ? ["blenderPose.py"] : [])]));
}
