/// <reference path="./threejson.d.ts" />
import { createJsonScene, registerObject, type SceneRuntime } from "threejson/core";
import { AmbientLight, Box3, DirectionalLight, GridHelper, HemisphereLight, Mesh, PCFSoftShadowMap, PlaneGeometry, ShadowMaterial, Sphere, Vector3 } from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import { createMannequin } from "./mannequin";

import { sceneSchema, type SceneDocument, type CameraView } from "@toonflow/node-shared/director/schema";
export { sceneSchema, cameraViewSchema, createMannequinObject, createEmptyScene, type SceneDocument, type CameraView } from "@toonflow/node-shared/director/schema";

export interface SceneSettings {
  gridVisible: boolean;
  skyVisible: boolean;
}

export function applySceneSettings(runtime: SceneRuntime, settings: SceneSettings) {
  for (const child of runtime.scene.children) {
    if (child instanceof GridHelper) child.visible = settings.gridVisible;
  }
  let sky = runtime.scene.children.find(child => child instanceof Sky);
  if (!sky && settings.skyVisible) {
    sky = new Sky();
    sky.scale.setScalar(450000);
    sky.material.uniforms.sunPosition!.value.set(10, 16, 12);
    // 单独压缩天空的 HDR 高亮，保留模型原有的亮度。
    sky.material.fragmentShader = sky.material.fragmentShader.replace(
      "#include <tonemapping_fragment>",
      "gl_FragColor.rgb = gl_FragColor.rgb / (gl_FragColor.rgb + vec3(2.0));",
    );
    runtime.scene.add(sky);
  }
  if (sky) sky.visible = settings.skyVisible;
  runtime.invalidate();
}

export interface LightingSettings {
  globalEnabled: boolean;
  globalIntensity: number;
  sunEnabled: boolean;
  azimuth: number;
  elevation: number;
  color: string;
  intensity: number;
}

export function getSceneLighting(document: SceneDocument): LightingSettings {
  const lights = document.sceneConfig.lights;
  const main = lights.find(light => light.type === "directional");
  const position = main?.position ?? { x: 0, y: 1, z: 0 };
  const target = main?.target ?? { x: 0, y: 0, z: 0 };
  const direction = new Vector3(position.x - target.x, position.y - target.y, position.z - target.z).normalize();
  return {
    globalEnabled: lights.some(light => light.type === "ambient" || light.type === "hemisphere"),
    globalIntensity: lights.find(light => light.type === "ambient" || light.type === "hemisphere")?.intensity ?? 0.8,
    sunEnabled: false,
    azimuth: (Math.atan2(direction.x, direction.z) * 180 / Math.PI + 360) % 360,
    elevation: Math.asin(direction.y) * 180 / Math.PI,
    color: main?.color ?? "#ffffff",
    intensity: main?.intensity ?? 2,
  };
}

export function applyLighting(runtime: SceneRuntime, lighting: LightingSettings) {
  let main: DirectionalLight | undefined;
  let hasGlobalLight = false;
  runtime.scene.traverse(object => {
    if (object instanceof AmbientLight || object instanceof HemisphereLight) {
      object.visible = lighting.globalEnabled;
      object.intensity = lighting.globalIntensity;
      hasGlobalLight = true;
    }
    if (!main && object instanceof DirectionalLight) main = object;
  });
  if (!hasGlobalLight && lighting.globalEnabled) runtime.scene.add(new AmbientLight("#ffffff", lighting.globalIntensity));
  if (!main) {
    main = new DirectionalLight();
    runtime.scene.add(main, main.target);
  }
  if (!main.target.parent) runtime.scene.add(main.target);
  const azimuth = lighting.azimuth * Math.PI / 180;
  const elevation = lighting.elevation * Math.PI / 180;
  const distance = main.position.distanceTo(main.target.position) || 20;
  main.position.set(
    Math.sin(azimuth) * Math.cos(elevation),
    Math.sin(elevation),
    Math.cos(azimuth) * Math.cos(elevation),
  ).multiplyScalar(distance).add(main.target.position);
  main.color.set(lighting.color);
  main.intensity = lighting.intensity;
  main.visible = lighting.sunEnabled;
  main.castShadow = main.visible;
  main.shadow.mapSize.set(2048, 2048);
  main.shadow.normalBias = 0.04;
  main.shadow.bias = -0.0001;
  updateSunShadow(runtime);
  runtime.invalidate();
}

export function updateSunShadow(runtime: SceneRuntime) {
  const main = runtime.scene.children.find(object => object instanceof DirectionalLight) as DirectionalLight | undefined;
  if (!main?.castShadow) return;
  const bounds = new Box3();
  runtime.scene.updateMatrixWorld(true);
  runtime.scene.traverse(object => {
    if (object instanceof Mesh && !(object instanceof Sky) && !(object.material instanceof ShadowMaterial)) bounds.expandByObject(object);
  });
  const sphere = bounds.isEmpty() ? new Sphere(new Vector3(), 10) : bounds.getBoundingSphere(new Sphere());
  const radius = Math.max(5, sphere.radius * 1.5);
  const direction = main.position.clone().sub(main.target.position).normalize();
  main.target.position.copy(sphere.center);
  main.position.copy(sphere.center).addScaledVector(direction, radius * 2);
  Object.assign(main.shadow.camera, { left: -radius, right: radius, top: radius, bottom: -radius, near: 0.1, far: radius * 4 });
  main.shadow.camera.updateProjectionMatrix();
}

export async function createStage(canvas: HTMLCanvasElement, document: SceneDocument, beforeFrame?: () => void, aspect = 16 / 9, lighting?: LightingSettings, settings: SceneSettings = { gridVisible: true, skyVisible: true }) {
  document = sceneSchema.parse(document);
  const width = Math.round(960 * Math.min(1, aspect) / 2) * 2;
  const height = Math.round(960 / Math.max(1, aspect) / 2) * 2;
  let runtime: SceneRuntime | undefined;
  try {
    const next = await createJsonScene({
      ...document,
      objectList: document.objectList.filter(object => object.objType !== "mannequin"),
      sceneConfig: {
        ...document.sceneConfig, canvasWidth: width, canvasHeight: height,
        controls: { enabled: false },
        renderer: { antialias: true, ratioRate: 1 / window.devicePixelRatio, shadowMapEnabled: true },
        renderLoop: { autoResize: false, firstAutoResize: false, updateAnimations: false, scheduleMode: "demand" },
      },
    }, { canvas, beforeFrame, onRuntimeReady: context => { runtime = context.runtime; } });
    for (const object of document.objectList) {
      if (object.objType !== "mannequin") continue;
      const mannequin = createMannequin(object.threeJsonId, object.material.color, object.hiddenParts);
      mannequin.position.set(object.position.x, object.position.y, object.position.z);
      mannequin.rotation.set(object.rotation?.rotationX ?? 0, object.rotation?.rotationY ?? 0, object.rotation?.rotationZ ?? 0);
      mannequin.scale.set(object.scale?.scaleX ?? 1, object.scale?.scaleY ?? 1, object.scale?.scaleZ ?? 1);
      for (const [name, rotation] of Object.entries(object.pose ?? {})) mannequin.getObjectByName(name)!.rotation.set(rotation.x, rotation.y, rotation.z);
      const { type: _type, color: _color, ...appearance } = object.material;
      mannequin.traverse(part => {
        if (part instanceof Mesh) Object.assign(part.material, appearance);
      });
      next.scene.add(mannequin);
      registerObject(mannequin, object, { recursive: false }, next.scene);
    }
    // 离屏 canvas 没有布局尺寸，不能依赖运行时从 clientWidth / clientHeight 推断。
    next.renderer.setSize(width, height, false);
    next.camera.aspect = aspect;
    const { x, y, z } = document.sceneConfig.controls.target;
    next.camera.lookAt(x, y, z);
    next.camera.updateProjectionMatrix();
    next.renderer.shadowMap.type = PCFSoftShadowMap;
    next.scene.traverse(object => {
      if (object instanceof Mesh) {
        object.castShadow = true;
        object.receiveShadow = true;
      }
    });
    // 网格线无法接收阴影，用透明地面承接太阳光投影。
    const shadowGround = new Mesh(new PlaneGeometry(200, 200), new ShadowMaterial({ opacity: 0.35 }));
    shadowGround.rotation.x = -Math.PI / 2;
    shadowGround.position.y = -0.01;
    shadowGround.receiveShadow = true;
    next.scene.add(shadowGround);
    next.scene.add(new GridHelper(200, 200, 0x666670, 0x3d3d45));
    applySceneSettings(next, settings);
    if (lighting) applyLighting(next, lighting);
    return next;
  } catch (error) {
    if (runtime) disposeStage(runtime);
    throw error;
  }
}

export function captureCamera(runtime: SceneRuntime): CameraView {
  const { camera } = runtime;
  const { x, y, z } = camera.position;
  const target = camera.getWorldDirection(new Vector3()).add(camera.position);
  return {
    camera: { position: { x, y, z }, fov: camera.fov, near: camera.near, far: camera.far },
    controls: { target: { x: target.x, y: target.y, z: target.z } },
  };
}

export function capturePreview(runtime: SceneRuntime) {
  runtime.renderer.render(runtime.scene, runtime.camera);
  const preview = runtime.renderer.domElement.toDataURL("image/jpeg", 0.85);
  if (!preview.startsWith("data:image/jpeg;base64,")) throw new Error("镜头截图失败");
  return preview;
}

export function disposeStage(runtime: SceneRuntime) {
  for (const child of runtime.scene.children) {
    if (child instanceof GridHelper) child.dispose();
    if (child instanceof Sky) {
      child.geometry.dispose();
      child.material.dispose();
    }
  }
  runtime.dispose();
  runtime.renderer.forceContextLoss();
}
