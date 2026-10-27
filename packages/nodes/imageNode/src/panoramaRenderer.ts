import * as THREE from "three";
import { z } from "zod";

export const panoramaSchema = z.strictObject({
  mode: z.enum(["sphere", "cylinder"]), count: z.union([z.literal(1), z.literal(4), z.literal(12)]), layout: z.enum(["combined", "separate"]).optional(),
  yaw: z.number().finite().min(-360).max(360).optional(), pitch: z.number().finite().min(-85).max(85).optional(), fov: z.number().finite().min(20).max(120).optional(),
  lensEnabled: z.boolean().optional(), lensMode: z.enum(["barrel", "pincushion"]).optional(), lensStrength: z.number().min(0).max(100).optional(),
  perspectiveEnabled: z.boolean().optional(), horizontalPerspective: z.number().min(-40).max(40).optional(), verticalPerspective: z.number().min(-40).max(40).optional(), levelRotation: z.number().min(-15).max(15).optional(),
  stretchEnabled: z.boolean().optional(), horizontalStretch: z.number().min(-50).max(50).optional(), verticalStretch: z.number().min(-50).max(50).optional(), stretchCenter: z.number().min(0).max(360).optional(),
  horizonEnabled: z.boolean().optional(), horizonOffset: z.number().min(-12).max(12).optional(), waveAmplitude: z.number().min(-12).max(12).optional(), wavePhase: z.number().min(0).max(360).optional(), waveCount: z.number().int().min(1).max(4).optional(),
  seamEnabled: z.boolean().optional(), seamWidth: z.number().min(.5).max(8).optional(),
});
export type PanoramaSettings = z.infer<typeof panoramaSchema>;

export function createPanoramaRenderer(source: HTMLCanvasElement, mode: "sphere" | "cylinder", canvas?: HTMLCanvasElement) {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: false, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  const scene = new THREE.Scene(); const camera = new THREE.PerspectiveCamera(60, 16 / 9, .1, 100);
  const texture = new THREE.CanvasTexture(source); texture.colorSpace = THREE.SRGBColorSpace; texture.wrapS = THREE.RepeatWrapping;
  const material = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false });
  const uniforms = { sourceCorrections: { value: false }, stretch: { value: new THREE.Vector2() }, stretchCenter: { value: .5 }, horizonOffset: { value: 0 }, wave: { value: new THREE.Vector3() }, seamWidth: { value: 0 } };
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = `uniform bool sourceCorrections; uniform vec2 stretch; uniform float stretchCenter; uniform float horizonOffset; uniform vec3 wave; uniform float seamWidth;\n` + shader.fragmentShader.replace("#include <map_fragment>", `
      #ifdef USE_MAP
        vec2 sourceUv = vMapUv;
        if (sourceCorrections) {
          sourceUv.x -= stretch.x * sin(6.28318530718 * (sourceUv.x - stretchCenter)) / 6.28318530718;
          float height = sourceUv.y;
          height -= stretch.y * (height - 0.5) * 4.0 * height * (1.0 - height);
          float rise = horizonOffset + wave.x * sin(6.28318530718 * wave.y * (sourceUv.x - 0.5) + wave.z);
          sourceUv.y = clamp(height + sin(3.14159265359 * height) * rise, 0.0, 1.0);
        }
        vec4 sampledDiffuseColor = texture2D(map, sourceUv);
        if (seamWidth > 0.0) {
          float longitude = fract(sourceUv.x);
          float blend = 0.5 * (1.0 - smoothstep(0.0, seamWidth, min(longitude, 1.0 - longitude)));
          sampledDiffuseColor = mix(sampledDiffuseColor, texture2D(map, vec2(1.0 - sourceUv.x, sourceUv.y)), blend);
        }
        diffuseColor *= sampledDiffuseColor;
      #endif
    `);
  };
  const geometry = mode === "sphere" ? new THREE.SphereGeometry(10, 96, 64) : new THREE.CylinderGeometry(10, 10, 20 * Math.PI / (source.width / source.height), 128, 1, true);
  geometry.scale(-1, 1, 1); if (mode === "sphere") geometry.rotateY(-Math.PI / 2);
  scene.add(new THREE.Mesh(geometry, material));
  const target = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false, samples: 2 });
  const correction = new THREE.ShaderMaterial({
    uniforms: { image: { value: target.texture }, coefficient: { value: 0 }, crop: { value: 1 }, perspective: { value: new THREE.Vector2() }, rotation: { value: 0 } },
    vertexShader: `varying vec2 imageUv; void main() { imageUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `uniform sampler2D image; uniform float coefficient; uniform float crop; uniform vec2 perspective; uniform float rotation; varying vec2 imageUv;
      void main() {
        vec2 centered = (imageUv * 2.0 - 1.0) / crop;
        float cosine = cos(rotation); float sine = sin(rotation);
        centered = vec2(cosine * centered.x - sine * centered.y * 9.0 / 16.0, sine * centered.x * 16.0 / 9.0 + cosine * centered.y);
        centered /= 1.0 + dot(perspective, centered);
        vec2 radial = centered * vec2(16.0 / 9.0, 1.0);
        float radiusSquared = dot(radial, radial) / (1.0 + 256.0 / 81.0);
        vec2 sourceUv = centered * (1.0 + coefficient * radiusSquared) * 0.5 + 0.5;
        gl_FragColor = texture2D(image, sourceUv);
        #include <colorspace_fragment>
      }`, depthTest: false, depthWrite: false, toneMapped: false,
  });
  const correctionScene = new THREE.Scene(); const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), correction); correctionScene.add(quad);
  const maxFov = mode === "sphere" ? 100 : Math.min(90, 2 * Math.atan(Math.PI / (source.width / source.height)) * 180 / Math.PI * .98);
  function render(settings: PanoramaSettings, width = 1280, height = 720, original = false) {
    renderer.setSize(width, height, false);
    const yaw = (settings.yaw ?? 0) * Math.PI / 180; const pitch = mode === "sphere" ? (settings.pitch ?? 0) * Math.PI / 180 : 0;
    camera.fov = Math.min(maxFov, settings.fov ?? 60); camera.updateProjectionMatrix(); camera.lookAt(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
    uniforms.sourceCorrections.value = !original && !!(settings.stretchEnabled || settings.horizonEnabled);
    uniforms.stretch.value.set(!original && settings.stretchEnabled ? (settings.horizontalStretch ?? 0) / 100 : 0, !original && settings.stretchEnabled ? (settings.verticalStretch ?? 0) / 125 : 0);
    uniforms.stretchCenter.value = .5 + (settings.stretchCenter ?? 0) / 360;
    uniforms.horizonOffset.value = !original && settings.horizonEnabled ? (settings.horizonOffset ?? 0) / 100 : 0;
    uniforms.wave.value.set(!original && settings.horizonEnabled ? (settings.waveAmplitude ?? 0) / 100 : 0, settings.waveCount ?? 1, (settings.wavePhase ?? 0) * Math.PI / 180);
    uniforms.seamWidth.value = !original && settings.seamEnabled ? (settings.seamWidth ?? 3) / 100 : 0;
    const strength = !original && settings.lensEnabled ? (settings.lensStrength ?? 40) / 400 : 0; const coefficient = settings.lensMode === "pincushion" ? strength : -strength;
    const x = !original && settings.perspectiveEnabled ? (settings.horizontalPerspective ?? 0) / 160 : 0; const y = !original && settings.perspectiveEnabled ? (settings.verticalPerspective ?? 0) / 160 : 0; const rotation = !original && settings.perspectiveEnabled ? (settings.levelRotation ?? 0) * Math.PI / 180 : 0;
    if (!coefficient && !x && !y && !rotation) { renderer.render(scene, camera); return; }
    // ACT: 手动投影校正只改变取景与接缝，不推测场景的缺失内容。
    const cosine = Math.abs(Math.cos(rotation)); const sine = Math.abs(Math.sin(rotation)); const boundX = cosine + sine * 9 / 16; const boundY = cosine + sine * 16 / 9;
    correction.uniforms.coefficient!.value = coefficient; correction.uniforms.perspective!.value.set(x, y); correction.uniforms.rotation!.value = rotation;
    correction.uniforms.crop!.value = Math.max(1, (1 + Math.max(0, coefficient)) * Math.max(boundX, boundY) + Math.abs(x) * boundX + Math.abs(y) * boundY);
    target.setSize(width, height);
    try { renderer.setRenderTarget(target); renderer.render(scene, camera); } finally { renderer.setRenderTarget(null); }
    renderer.render(correctionScene, new THREE.Camera());
  }
  return { canvas: renderer.domElement, render, maxFov, dispose() { geometry.dispose(); material.dispose(); texture.dispose(); target.dispose(); correction.dispose(); quad.geometry.dispose(); renderer.dispose(); renderer.forceContextLoss(); } };
}
