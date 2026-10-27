import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { getLightingPosition, type LightingSettings } from "./imageLighting";
import { getMultiAngleCameraPosition, multiAngleFocalLengths, type MultiAngleSettings } from "./imageMultiAngle";

export default function ImageStage(props: { url: string; mode: "lighting"; settings: LightingSettings; disabled?: boolean; onChange(value: LightingSettings): void } | { url: string; mode: "angle"; settings: MultiAngleSettings; disabled?: boolean; onChange(value: MultiAngleSettings): void }) {
  const host = useRef<HTMLDivElement>(null); const canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef(props); latest.current = props;
  const render = useRef<(() => void) | undefined>(undefined);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!canvas.current || !host.current) return;
    let disposed = false; let texture: THREE.Texture | undefined; let frame = 0;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ canvas: canvas.current, antialias: true, alpha: true }); } catch { setError("3D预览不可用，请使用角度控件调整"); return; }
    const scene = new THREE.Scene(); const overview = new THREE.PerspectiveCamera(43, 1.5, .1, 100); overview.position.set(4, 2.5, 5); overview.lookAt(0, 0, 0);
    const camera = new THREE.PerspectiveCamera(40, 1.5, .05, 100); const controls = new OrbitControls(overview, renderer.domElement); controls.enableDamping = false;
    const front = new THREE.MeshStandardMaterial({ color: 0xffffff, side: THREE.FrontSide, roughness: 1, emissive: 0xffffff, emissiveIntensity: .1 });
    const image = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), front); const back = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshStandardMaterial({ color: 0x64748b, side: THREE.BackSide, roughness: 1 })); image.add(back); scene.add(image, new THREE.AmbientLight(0xffffff, .55));
    const floor = new THREE.GridHelper(6, 12, 0x64748b, 0x343840); floor.position.y = -1.3; scene.add(floor);
    const lights = (["key", "rim"] as const).map(kind => {
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(.13, 20, 12), new THREE.MeshBasicMaterial({ color: 0xffffff })); bulb.userData.kind = kind;
      const light = new THREE.SpotLight(0xffffff, 1, 0, 1.05, .65, 0); light.target = image; const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0x64748b, transparent: true, opacity: .5 }));
      scene.add(bulb, light, line); return { kind, bulb, light, line };
    });
    const cameraBody = new THREE.Mesh(new THREE.BoxGeometry(.4, .3, .3), new THREE.MeshBasicMaterial({ color: 0x14b8a6 })); cameraBody.userData.kind = "camera"; scene.add(cameraBody);
    const helper = new THREE.CameraHelper(camera); scene.add(helper);
    function draw() {
      frame = 0; if (disposed || !host.current) return;
      const value = latest.current; const width = host.current.clientWidth; if (!width) return;
      renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); renderer.setSize(width, Math.round(width * .65), false); overview.aspect = width / Math.round(width * .65); overview.updateProjectionMatrix();
      if (value.mode === "lighting") {
        lights.forEach(item => {
          const rim = item.kind === "rim"; const settings = value.settings; const position = getLightingPosition(rim ? settings.rimAzimuth : settings.azimuth, rim ? settings.rimElevation : settings.elevation);
          item.bulb.position.set(position.x * 2.4, position.y * 2.4, position.z * 2.4); item.light.position.copy(item.bulb.position); const color = rim ? settings.rimColor : settings.lightColor; item.bulb.material.color.set(color); item.light.color.set(color); item.light.intensity = (rim ? settings.rimBrightness : settings.brightness) / 18;
          item.bulb.visible = item.light.visible = item.line.visible = !rim || settings.rimLight; item.line.geometry.setFromPoints([item.bulb.position, new THREE.Vector3()]);
        }); cameraBody.visible = helper.visible = false;
      } else {
        lights[0]!.light.intensity = 1.8; lights[0]!.light.position.set(0, 2, 4); lights.forEach(item => { item.bulb.visible = item.line.visible = false; }); lights[1]!.light.visible = false;
        const point = getMultiAngleCameraPosition(value.settings); camera.position.set(point.x, point.y, point.z); camera.lookAt(0, 0, 0); camera.setFocalLength(multiAngleFocalLengths[value.settings.lens]); camera.aspect = 16 / 9; camera.updateProjectionMatrix(); cameraBody.position.copy(camera.position); cameraBody.lookAt(0, 0, 0); helper.update(); cameraBody.visible = helper.visible = value.settings.viewMode !== "camera";
      }
      renderer.render(scene, value.mode === "angle" && value.settings.viewMode === "camera" ? camera : overview);
    }
    const schedule = () => { if (!frame && !disposed) frame = requestAnimationFrame(draw); }; render.current = schedule; controls.addEventListener("change", schedule);
    const observer = new ResizeObserver(schedule); observer.observe(host.current);
    new THREE.TextureLoader().load(props.url, loaded => {
      if (disposed) { loaded.dispose(); return; } texture = loaded; loaded.colorSpace = THREE.SRGBColorSpace; front.map = loaded; front.needsUpdate = true;
      const source = loaded.image as HTMLImageElement; const ratio = source.naturalWidth / source.naturalHeight; image.scale.set(ratio >= 1 ? 1.5 : 1.5 * ratio, ratio >= 1 ? 1.5 / ratio : 1.5, 1); schedule();
    }, undefined, () => { if (!disposed) setError("参考图加载失败"); });
    const raycaster = new THREE.Raycaster(); let drag: { x: number; y: number; kind: string; azimuth: number; elevation: number } | undefined;
    const down = (event: PointerEvent) => {
      if (latest.current.disabled || event.button !== 0) return;
      const bounds = renderer.domElement.getBoundingClientRect(); raycaster.setFromCamera(new THREE.Vector2((event.clientX - bounds.left) / bounds.width * 2 - 1, 1 - (event.clientY - bounds.top) / bounds.height * 2), overview);
      const object = raycaster.intersectObjects(latest.current.mode === "lighting" ? lights.filter(item => item.bulb.visible).map(item => item.bulb) : [cameraBody])[0]?.object;
      if (!object) return;
      const value = latest.current; const rim = object.userData.kind === "rim";
      drag = { x: event.clientX, y: event.clientY, kind: String(object.userData.kind), azimuth: value.mode === "lighting" && rim ? value.settings.rimAzimuth : value.settings.azimuth, elevation: value.mode === "lighting" && rim ? value.settings.rimElevation : value.settings.elevation };
      controls.enabled = false; renderer.domElement.setPointerCapture(event.pointerId); event.preventDefault();
    };
    const move = (event: PointerEvent) => {
      if (!drag || latest.current.disabled) return; const value = latest.current; const azimuth = ((drag.azimuth + (event.clientX - drag.x) * .6 + 180) % 360 + 360) % 360 - 180; const elevation = Math.max(-80, Math.min(80, drag.elevation - (event.clientY - drag.y) * .6));
      if (value.mode === "lighting") value.onChange({ ...value.settings, ...(drag.kind === "rim" ? { rimAzimuth: azimuth, rimElevation: elevation } : { azimuth, elevation }) }); else value.onChange({ ...value.settings, azimuth, elevation });
    };
    const up = () => { drag = undefined; controls.enabled = true; };
    renderer.domElement.addEventListener("pointerdown", down); renderer.domElement.addEventListener("pointermove", move); renderer.domElement.addEventListener("pointerup", up); renderer.domElement.addEventListener("pointercancel", up); renderer.domElement.addEventListener("lostpointercapture", up);
    schedule(); setError("");
    return () => { disposed = true; if (frame) cancelAnimationFrame(frame); observer.disconnect(); controls.dispose(); render.current = undefined; renderer.domElement.removeEventListener("pointerdown", down); renderer.domElement.removeEventListener("pointermove", move); renderer.domElement.removeEventListener("pointerup", up); renderer.domElement.removeEventListener("pointercancel", up); renderer.domElement.removeEventListener("lostpointercapture", up); texture?.dispose(); scene.traverse(object => { if (object instanceof THREE.Mesh || object instanceof THREE.Line) { object.geometry.dispose(); const materials = Array.isArray(object.material) ? object.material : [object.material]; materials.forEach(material => material.dispose()); } }); renderer.dispose(); renderer.forceContextLoss(); };
  }, [props.url, props.mode]);
  useEffect(() => { render.current?.(); }, [props.settings]);
  return <div ref={host} className="imageSpatialStage"><canvas key={`${props.url}:${props.mode}`} ref={canvas} style={{ width: "100%", display: "block", aspectRatio: "1.54", touchAction: "none" }} />{error && <p role="status" className="nodeError">{error}</p>}<span className="nodeStatus">{props.mode === "lighting" ? "拖动光球调整光位，拖动空白旋转总览" : "拖动相机调整机位，仅显示原图平面的透视"}</span></div>;
}
