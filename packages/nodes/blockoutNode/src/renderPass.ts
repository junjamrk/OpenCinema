import * as THREE from "three";

export type ControlLayer = "depth" | "normal";
export type DepthRange = { near: number; far: number };
export type CapturePass = { layer: ControlLayer; depthRange?: DepthRange };

/** Instance-owned opaque nearest-surface passes, preserving skin/morph and authored alpha-test cutouts. */
export function createRenderPass(renderer: THREE.WebGLRenderer) {
  const target = new THREE.WebGLRenderTarget(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true });
  const depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
  target.depthTexture = depthTexture;
  target.texture.colorSpace = THREE.NoColorSpace;
  const uniforms = { source: { value: target.texture as THREE.Texture }, depthPass: { value: 0 }, clipNear: { value: 0.05 }, clipFar: { value: 5000 }, near: { value: 0.5 }, far: { value: 100 } };
  const material = new THREE.ShaderMaterial({
    uniforms, depthTest: false, depthWrite: false, toneMapped: false,
    vertexShader: "varying vec2 sampleUv; void main() { sampleUv=uv; gl_Position=vec4(position.xy,0.0,1.0); }",
    fragmentShader: `
      #include <packing>
      uniform sampler2D source;
      uniform int depthPass;
      uniform float clipNear, clipFar, near, far;
      varying vec2 sampleUv;
      void main() {
        vec4 pixel=texture2D(source,sampleUv);
        if (depthPass==1) {
          float distance=-perspectiveDepthToViewZ(pixel.r,clipNear,clipFar);
          float value=pixel.r>=1.0 ? 0.0 : 1.0-clamp((distance-near)/(far-near),0.0,1.0);
          gl_FragColor=vec4(vec3(value),1.0);
        } else gl_FragColor=vec4(pixel.rgb,1.0);
      }`,
  });
  const geometry = new THREE.PlaneGeometry(2, 2), screen = new THREE.Scene(), camera = new THREE.Camera();
  screen.add(new THREE.Mesh(geometry, material));
  const surfaces = new Map<THREE.Material, THREE.MeshNormalMaterial>();
  let failure: unknown;

  function surfaceMaterial(source: THREE.Material, mesh: THREE.Mesh, layer: ControlLayer) {
    const original = source as THREE.MeshPhysicalMaterial;
    if (source.alphaHash || source.alphaToCoverage || source.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile
      || !["MeshBasicMaterial", "MeshLambertMaterial", "MeshPhongMaterial", "MeshStandardMaterial", "MeshPhysicalMaterial", "MeshToonMaterial", "MeshMatcapMaterial", "MeshNormalMaterial"].includes(source.type)) throw new Error(`${layer}不支持材质${source.type}的随机alpha或自定义shader；旧输出保留，可仅导出RGB`);
    if (layer === "normal" && !mesh.geometry.getAttribute("normal") && !original.flatShading) throw new Error("Normal需要有效的几何法线，旧输出保留");
    let result = surfaces.get(source);
    if (!result) {
      result = new THREE.MeshNormalMaterial();
      result.onBeforeCompile = shader => {
        shader.vertexShader = shader.vertexShader.replace("#include <normal_pars_vertex>", "#include <normal_pars_vertex>\n#include <color_pars_vertex>").replace("#include <uv_vertex>", "#include <uv_vertex>\n#include <color_vertex>");
        shader.fragmentShader = shader.fragmentShader.replace("#include <uv_pars_fragment>", "#include <uv_pars_fragment>\n#include <color_pars_fragment>\n#include <map_pars_fragment>\n#include <alphamap_pars_fragment>\n#include <alphatest_pars_fragment>")
          .replace("#include <clipping_planes_fragment>", "#include <color_fragment>\n#include <map_fragment>\n#include <alphamap_fragment>\n#include <alphatest_fragment>\n#include <clipping_planes_fragment>");
      };
      surfaces.set(source, result);
    }
    // Three's normal shader already owns skin/morph/displacement. Add its standard alpha/color discard chunks.
    for (const key of ["side", "visible", "alphaTest", "vertexColors", "flatShading", "wireframe", "polygonOffset", "polygonOffsetFactor", "polygonOffsetUnits", "clippingPlanes", "clipIntersection", "clipShadows", "normalMap", "normalMapType", "bumpMap", "bumpScale", "displacementMap", "displacementScale", "displacementBias", "map", "alphaMap"] as const) {
      if (key in original) Object.assign(result, { [key]: original[key] });
    }
    if (original.normalScale) result.normalScale.copy(original.normalScale);
    result.opacity = source.alphaTest > 0 ? source.opacity : 1;
    result.transparent = false; result.blending = THREE.NoBlending;
    result.depthTest = true; result.depthWrite = true; result.depthFunc = THREE.LessEqualDepth;
    result.toneMapped = false;
    // ACT: resync animated material values and defines/UV channels each sampled frame. Three reuses identical compiled programs.
    result.needsUpdate = true;
    return result;
  }

  return {
    render(scene: THREE.Scene, shotCamera: THREE.PerspectiveCamera, width: number, height: number, pass: CapturePass, hidden: THREE.Object3D[]) {
      if (failure) throw failure;
      const previous = { target: renderer.getRenderTarget(), viewport: renderer.getViewport(new THREE.Vector4()), scissor: renderer.getScissor(new THREE.Vector4()), scissorTest: renderer.getScissorTest(),
        clearColor: renderer.getClearColor(new THREE.Color()), clearAlpha: renderer.getClearAlpha(), autoClear: renderer.autoClear, toneMapping: renderer.toneMapping, exposure: renderer.toneMappingExposure,
        colorSpace: renderer.outputColorSpace, background: scene.background, fog: scene.fog, override: scene.overrideMaterial,
        shaderError: renderer.debug.onShaderError, shaderChecks: renderer.debug.checkShaderErrors };
      const visibility = hidden.map(object => [object, object.visible] as const), materials: [THREE.Mesh, THREE.Material | THREE.Material[]][] = [];
      try {
        renderer.debug.checkShaderErrors = true; renderer.debug.onShaderError = () => { failure = new Error("控制层shader编译失败，未发布本次导出"); throw failure; };
        for (const [object] of visibility) object.visible = false;
        scene.traverseVisible(object => {
          if (object instanceof THREE.Sprite || object instanceof THREE.Line || object instanceof THREE.Points) {
            throw new Error(`${pass.layer}不支持可见的Sprite/Line/Points材质；请排除该实体或仅导出RGB`);
          }
          if (object instanceof THREE.Mesh) {
            materials.push([object, object.material]);
            object.material = Array.isArray(object.material) ? object.material.map(source => surfaceMaterial(source, object, pass.layer)) : surfaceMaterial(object.material, object, pass.layer);
          }
        });
        scene.background = new THREE.Color(0); scene.fog = null; scene.overrideMaterial = null;
        renderer.toneMapping = THREE.NoToneMapping; renderer.toneMappingExposure = 1; renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
        renderer.autoClear = true; renderer.setScissorTest(false); renderer.setClearColor(0, 1);
        target.setSize(width, height); renderer.setRenderTarget(target); renderer.setViewport(previous.viewport); renderer.clear(); renderer.render(scene, shotCamera);
        uniforms.source.value = pass.layer === "depth" ? depthTexture : target.texture;
        uniforms.depthPass.value = pass.layer === "depth" ? 1 : 0;
        uniforms.clipNear.value = shotCamera.near; uniforms.clipFar.value = shotCamera.far;
        if (pass.layer === "depth") {
          const range = pass.depthRange;
          if (!range || !Number.isFinite(range.near) || !Number.isFinite(range.far) || range.near < shotCamera.near || range.far > shotCamera.far || range.far <= range.near) throw new Error("Depth范围须在摄影机clip范围内且far大于near");
          uniforms.near.value = range.near; uniforms.far.value = range.far;
        }
        renderer.setRenderTarget(null); renderer.setViewport(0, 0, width, height); renderer.clear(); renderer.render(screen, camera);
      } finally {
        for (const [object, source] of materials) object.material = source;
        for (const [object, visible] of visibility) object.visible = visible;
        scene.background = previous.background; scene.fog = previous.fog; scene.overrideMaterial = previous.override;
        renderer.toneMapping = previous.toneMapping; renderer.toneMappingExposure = previous.exposure; renderer.outputColorSpace = previous.colorSpace;
        renderer.autoClear = previous.autoClear; renderer.setClearColor(previous.clearColor, previous.clearAlpha); renderer.setRenderTarget(previous.target);
        renderer.setViewport(previous.viewport); renderer.setScissor(previous.scissor); renderer.setScissorTest(previous.scissorTest);
        renderer.debug.onShaderError = previous.shaderError; renderer.debug.checkShaderErrors = previous.shaderChecks;
      }
    },
    dispose() { for (const value of surfaces.values()) value.dispose(); surfaces.clear(); target.dispose(); material.dispose(); geometry.dispose(); },
  };
}
