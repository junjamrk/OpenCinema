import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { disposeModel, loadModel } from "./model";
import { createEnvironment, environmentRendering } from "./environment";
import { createRenderPass, type CapturePass } from "./renderPass";
import { createScanRenderer } from "./scanRenderer";
import { cameraMountFrame } from "./cameraMount";
import { buildAsset, type BuiltAsset } from "./nativeBlockout/builders";
import { ShotEvaluator } from "./nativeBlockout/evaluate";
import { GAITS } from "./nativeBlockout/gaits";
import { ASPECT_RATIOS, verticalFov } from "./nativeBlockout/camera";
import { recordTuning, type RecordingPose, type RecordPrecision } from "./recording";
import { headingOf } from "./nativeBlockout/path";
import type { ActorMark, ScanRef, Scene, Shot, V3 } from "./nativeBlockout/types";

export type BlockoutViewportProps = {
  scene: Scene;
  shot: Shot;
  time: number;
  selected: string;
  selectedIds?: string[];
  markId: string;
  cameraView?: boolean;
  disabled?: boolean;
  liveCamera?: RecordingPose;
  actorPreview?: { entityId: string; marks: ActorMark[] };
  recordingLens?: number;
  recording?: boolean;
  readModel: (path: string) => Promise<ArrayBuffer>;
  readScan: (scan: ScanRef, signal?: AbortSignal) => Promise<ArrayBuffer>;
  mode: "translate" | "rotate" | "scale";
};

export function createBlockoutViewport(
  element: HTMLDivElement,
  canvasElement: HTMLCanvasElement,
  initial: BlockoutViewportProps,
  emit: (name: string, ...args: any[]) => void = () => {},
) {
  let props = initial;
  const container = { value: element },
    canvas = { value: canvasElement };
  const failure = { value: "" },
    scanFailure = { value: "" },
    scanLoading = { value: 0 };
  let renderer: THREE.WebGLRenderer | undefined;
  let stage: THREE.Scene;
  let orbit: OrbitControls;
  let gizmo: TransformControls;
  let editCamera: THREE.PerspectiveCamera;
  let shotCamera: THREE.PerspectiveCamera;
  let evaluator: ShotEvaluator;
  let objects = new Map<string, BuiltAsset>();
  let content = new THREE.Group();
  let paths = new THREE.Group();
  let selectionBoxes = new THREE.Group();
  const scansGroup = new THREE.Group();
  let scans: ReturnType<typeof createScanRenderer> | undefined;
  let scanDisposal: Promise<void> | undefined;
  let selectedObject: THREE.Object3D | undefined;
  let dragObjects: Map<string, { position: THREE.Vector3; rotationY: number }> | undefined;
  let skipSelection = false;
  let resize: ResizeObserver;
  let dragging = false;
  let frame = 0;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let pointerStart = { x: 0, y: 0 };
  let generation = 0;
  let pendingModels: Promise<void> = Promise.resolve();
  let environment: ReturnType<typeof createEnvironment> | undefined;
  let controlRenderer: ReturnType<typeof createRenderPass> | undefined;
  let orbitSettings:
    | {
        rotateSpeed: number;
        panSpeed: number;
        zoomSpeed: number;
        enableDamping: boolean;
        dampingFactor: number;
      }
    | undefined;
  let actorControl:
    | {
        position: THREE.Vector3;
        heading: number;
        height: number;
        precision: RecordPrecision;
        orbitEnabled: boolean;
        cancelled: boolean;
      }
    | undefined;
  let pointerInside = false;

  function updateEvaluator() {
    const preview = props.actorPreview;
    const scene = preview
      ? {
          ...props.scene,
          blocking: props.scene.blocking.map((take) =>
            take.id !== props.shot.blockingTakeId
              ? take
              : {
                  ...take,
                  tracks: [
                    ...take.tracks.filter((track) => track.entityId !== preview.entityId),
                    { entityId: preview.entityId, marks: preview.marks },
                  ],
                },
          ),
        }
      : props.scene;
    evaluator = new ShotEvaluator(scene, props.shot);
  }

  function disposeGroup(group: THREE.Object3D) {
    disposeModel(group);
  }

  function rebuild() {
    if (!renderer) return;
    scans?.sync(props.scene.scans ?? []);
    cancelInteraction();
    const current = ++generation;
    controlRenderer?.dispose();
    controlRenderer = undefined;
    environment?.update(props.scene.environment);
    failure.value = "";
    gizmo.detach();
    disposeGroup(content);
    disposeGroup(paths);
    disposeGroup(selectionBoxes);
    objects.clear();
    const loads: Promise<void>[] = [];
    for (const entity of props.scene.entities) {
      if (entity.sourceFile) {
        loads.push(
          (async () => {
            const built = await loadModel(await props.readModel(entity.sourceFile!));
            if (current !== generation) {
              disposeGroup(built.group);
              return;
            }
            built.group.userData.entityId = entity.id;
            built.group.scale.setScalar(entity.transform.scale);
            built.setTint(entity.label?.color ?? null);
            objects.set(entity.id, built);
            content.add(built.group);
            select();
            draw();
          })().catch((error) => {
            if (current === generation)
              failure.value = error instanceof Error ? error.message : "模型读取失败";
          }),
        );
        continue;
      }
      const built = buildAsset(entity.assetId, entity.params);
      built.group.userData.entityId = entity.id;
      built.group.scale.setScalar(entity.transform.scale);
      built.setTint(entity.label?.color ?? null);
      objects.set(entity.id, built);
      content.add(built.group);
    }
    pendingModels = Promise.all(loads).then(() => {});
    updateEvaluator();
    select();
    draw();
  }

  function select() {
    if (!renderer) return;
    cancelInteraction();
    gizmo.detach();
    disposeGroup(paths);
    disposeGroup(selectionBoxes);
    selectedObject = undefined;
    if (props.cameraView) return;
    const selectedIds = props.selected === "camera" ? [] : (props.selectedIds ?? [props.selected]);
    for (const id of selectedIds) {
      const object = objects.get(id)?.group;
      if (object)
        selectionBoxes.add(
          new THREE.BoxHelper(object, id === props.selected ? 0xf59e0b : 0x409eff),
        );
    }
    if (props.disabled) return;
    const marks =
      props.selected === "camera"
        ? props.shot.camera.marks
        : (props.scene.blocking
            .find((take) => take.id === props.shot.blockingTakeId)
            ?.tracks.find((track) => track.entityId === props.selected)?.marks ?? []);
    for (const mark of marks) {
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.13, 12, 8),
        new THREE.MeshBasicMaterial({
          color: mark.id === props.markId ? 0xf59e0b : 0x409eff,
          depthTest: false,
        }),
      );
      marker.position.set(mark.position.x, mark.position.y, mark.position.z);
      marker.userData.markId = mark.id;
      paths.add(marker);
      if (mark.id === props.markId) selectedObject = marker;
    }
    for (const path of evaluator.paths().filter((path) => path.entityId === props.selected)) {
      paths.add(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(
            path.points.map((point) => new THREE.Vector3(point.x, point.y, point.z)),
          ),
          new THREE.LineBasicMaterial({ color: 0x409eff, depthTest: false }),
        ),
      );
    }
    selectedObject ??= objects.get(props.selected)?.group;
    gizmo.setMode(props.markId ? "translate" : props.mode);
    if (selectedObject && (props.markId || selectedIds.every((id) => objects.has(id))))
      gizmo.attach(selectedObject);
  }

  function drawGroupDrag(state: ReturnType<ShotEvaluator["evaluate"]>) {
    const start = dragObjects?.get(props.selected);
    if (!dragObjects || !start || !selectedObject) return;
    const rotation = selectedObject.rotation.y - start.rotationY,
      cos = Math.cos(rotation),
      sin = Math.sin(rotation);
    const anchor = selectedObject.position;
    for (const [id, original] of dragObjects) {
      if (id === props.selected) continue;
      const object = objects.get(id)!.group,
        dx = original.position.x - start.position.x,
        dz = original.position.z - start.position.z;
      object.position.set(
        anchor.x + dx * cos + dz * sin,
        anchor.y + original.position.y - start.position.y,
        anchor.z - dx * sin + dz * cos,
      );
      object.rotation.y = original.rotationY + rotation;
    }
    // ACT: at most 200 entities and four attachment levels, matching the native
    // evaluator. Follow unselected dependants without changing saved relations.
    const moved = new Set(dragObjects.keys()),
      states = new Map(state.entities.map((item) => [item.entityId, item]));
    const take = props.scene.blocking.find((take) => take.id === props.shot.blockingTakeId)!;
    for (let pass = 0; pass < 4; pass++)
      for (const entity of props.scene.entities) {
        if (dragObjects.has(entity.id)) continue;
        const marks = take.tracks.find((track) => track.entityId === entity.id)?.marks ?? [];
        const active = marks
          .filter((mark) => mark.time <= props.time)
          .sort((a, b) => b.time - a.time)[0];
        const parentId =
          active?.attachTo ??
          (!marks.length || props.time < Math.min(...marks.map((mark) => mark.time))
            ? entity.attachedTo
            : undefined);
        if (!parentId || !moved.has(parentId)) continue;
        const parent = objects.get(parentId)?.group,
          object = objects.get(entity.id)?.group;
        const oldParent = states.get(parentId),
          oldState = states.get(entity.id);
        if (!parent || !object || !oldParent || !oldState) continue;
        const delta = parent.rotation.y - oldParent.heading,
          c = Math.cos(delta),
          s = Math.sin(delta);
        const dx = oldState.position.x - oldParent.position.x,
          dz = oldState.position.z - oldParent.position.z;
        object.position.set(
          parent.position.x + dx * c + dz * s,
          parent.position.y + oldState.position.y - oldParent.position.y,
          parent.position.z - dx * s + dz * c,
        );
        object.rotation.y = oldState.heading + delta;
        moved.add(entity.id);
      }
  }

  function draw(
    time = props.time,
    size?: { width: number; height: number },
    exportPass = false,
    controlPass?: CapturePass,
  ) {
    if (!renderer || !evaluator) return;
    // Gaussian scans are staging references only, never photographic geometry
    // or semantic depth/normal/pose inputs. The camera viewport never loads them.
    scansGroup.visible = !props.cameraView && !exportPass && !controlPass && !scanDisposal;
    const state = evaluator.evaluate(time);
    // ACT: Mounted camera marks stay local for gizmo edits. This displays the
    // authored path in the mount's current frame, not its swept world trajectory.
    const pathFrame =
      props.selected === "camera" ? cameraMountFrame(props.shot.camera, state.entities) : undefined;
    paths.position.set(
      pathFrame?.position.x ?? 0,
      pathFrame?.position.y ?? 0,
      pathFrame?.position.z ?? 0,
    );
    paths.rotation.set(0, pathFrame?.heading ?? 0, 0);
    paths.updateMatrixWorld(true);
    const excluded = exportPass
      ? new Set(
          props.scene.entities
            .filter((entity) => entity.excludeFromExport)
            .map((entity) => entity.id),
        )
      : undefined;
    for (const entityState of state.entities) {
      const built = objects.get(entityState.entityId);
      if (
        !built ||
        (dragging && (built.group === selectedObject || dragObjects?.has(entityState.entityId)))
      )
        continue;
      built.group.visible = !excluded?.has(entityState.entityId);
      built.group.position.set(
        entityState.position.x,
        entityState.position.y,
        entityState.position.z,
      );
      built.group.rotation.y = entityState.heading;
      const scale = props.scene.entities.find((entity) => entity.id === entityState.entityId)!
        .transform.scale;
      built.group.scale.setScalar(scale);
      const stride = GAITS[entityState.gait].strideLength * Math.max(scale, 0.2);
      built.animate?.({
        gait: entityState.gait,
        phase: stride ? (entityState.distanceTravelled / stride) % 1 : 0,
        speed: entityState.speed,
        distance: entityState.distanceTravelled,
        time,
        overrides: entityState.joints,
      });
    }
    if (dragging && !exportPass) drawGroupDrag(state);
    for (const box of selectionBoxes.children) (box as THREE.BoxHelper).update();
    const camera = !exportPass && props.liveCamera ? props.liveCamera : state.camera;
    shotCamera.position.set(camera.position.x, camera.position.y, camera.position.z);
    shotCamera.rotation.set(camera.tilt, camera.pan, camera.roll, "YXZ");
    shotCamera.fov = THREE.MathUtils.radToDeg(
      verticalFov(props.shot.camera.sensorId, camera.focalLength, props.shot.aspect),
    );
    editCamera.fov =
      props.recordingLens === undefined
        ? shotCamera.fov
        : THREE.MathUtils.radToDeg(
            verticalFov(props.shot.camera.sensorId, props.recordingLens, props.shot.aspect),
          );
    shotCamera.aspect = ASPECT_RATIOS[props.shot.aspect];
    shotCamera.updateProjectionMatrix();
    const width = size?.width ?? container.value!.clientWidth,
      height = size?.height ?? container.value!.clientHeight;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, width, height);
    renderer.clear();
    if (props.cameraView) {
      const aspect = shotCamera.aspect;
      const viewWidth = Math.min(width, height * aspect),
        viewHeight = viewWidth / aspect;
      renderer.setViewport(
        (width - viewWidth) / 2,
        (height - viewHeight) / 2,
        viewWidth,
        viewHeight,
      );
    }
    editCamera.aspect = width / height;
    editCamera.updateProjectionMatrix();
    if (controlPass) {
      controlRenderer ??= createRenderPass(renderer);
      controlRenderer.render(stage, shotCamera, width, height, controlPass, [
        paths,
        selectionBoxes,
        scansGroup,
        gizmo.getHelper(),
        ...(environment ? [environment.group] : []),
      ]);
    } else renderer.render(stage, props.cameraView ? shotCamera : editCamera);
  }

  function pointerDown(event: PointerEvent) {
    canvas.value?.focus();
    skipSelection = false;
    pointerStart = { x: event.clientX, y: event.clientY };
    draw();
  }
  function pointerMove(event: PointerEvent) {
    if (!actorControl || !event.isPrimary) return;
    const bounds = canvas.value!.getBoundingClientRect();
    pointerInside =
      bounds.width > 0 &&
      bounds.height > 0 &&
      event.clientX >= bounds.left &&
      event.clientX <= bounds.right &&
      event.clientY >= bounds.top &&
      event.clientY <= bounds.bottom;
    if (pointerInside)
      pointer.set(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        (-(event.clientY - bounds.top) / bounds.height) * 2 + 1,
      );
  }
  function pointerLeave() {
    pointerInside = false;
  }
  function pointerCancel() {
    pointerInside = false;
    if (actorControl) actorControl.cancelled = true;
    cancelInteraction();
  }
  function actorWheel(event: WheelEvent) {
    if (!actorControl || !pointerInside || document.activeElement !== canvas.value) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    actorControl.height = Math.max(
      0,
      Math.min(60, actorControl.height - event.deltaY * recordTuning[actorControl.precision].wheel),
    );
  }
  function pointerUp(event: PointerEvent) {
    if (skipSelection) {
      skipSelection = false;
      return;
    }
    if (
      props.cameraView ||
      props.disabled ||
      dragging ||
      gizmo.axis ||
      Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 4
    )
      return;
    const bounds = canvas.value!.getBoundingClientRect();
    pointer.set(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      (-(event.clientY - bounds.top) / bounds.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, editCamera);
    const mark = raycaster
      .intersectObjects(paths.children, false)
      .find((hit) => hit.object.userData.markId);
    if (mark) {
      emit("mark", mark.object.userData.markId);
      return;
    }
    const hit = raycaster.intersectObjects(content.children, true)[0];
    let object: THREE.Object3D | undefined = hit?.object;
    while (object && !object.userData.entityId) object = object.parent ?? undefined;
    if (object) emit("select", object.userData.entityId, event.shiftKey);
    else if (!event.shiftKey) emit("select", "");
  }

  function dropAsset(event: DragEvent) {
    if (props.cameraView || props.disabled || !renderer) return;
    const assetId = event.dataTransfer?.getData("application/x-opencinema-asset");
    if (!assetId) return;
    const bounds = canvas.value!.getBoundingClientRect();
    pointer.set(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      (-(event.clientY - bounds.top) / bounds.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, editCamera);
    const point = raycaster.ray.intersectPlane(
      new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
      new THREE.Vector3(),
    );
    if (point && Math.abs(point.x) < 100000 && Math.abs(point.z) < 100000)
      emit("place", assetId, {
        x: Math.round(point.x * 10) / 10,
        y: 0,
        z: Math.round(point.z * 10) / 10,
      });
  }

  function initialize() {
    try {
      renderer = new THREE.WebGLRenderer({
        canvas: canvas.value!,
        antialias: true,
        preserveDrawingBuffer: true,
      });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      renderer.setClearColor(0x20242b);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = environmentRendering.exposure;
      stage = new THREE.Scene();
      stage.background = new THREE.Color(0x20242b);
      environment = createEnvironment(stage);
      const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(2000, 2000),
        new THREE.MeshLambertMaterial({ color: 0x353b44 }),
      );
      ground.rotation.x = -Math.PI / 2;
      ground.position.y = -0.02;
      ground.receiveShadow = true;
      stage.add(ground);
      if (!props.cameraView) stage.add(new THREE.GridHelper(100, 100, 0x65758b, 0x404b5b));
      stage.add(content, paths, selectionBoxes, scansGroup);
      if (!props.cameraView)
        scans = createScanRenderer(scansGroup, props.readScan, (state) => {
          scanLoading.value = state.loading;
          scanFailure.value = state.error;
        });
      editCamera = new THREE.PerspectiveCamera(50, 1, 0.05, 5000);
      editCamera.rotation.order = "YXZ";
      editCamera.position.set(10, 8, 12);
      shotCamera = new THREE.PerspectiveCamera(50, 1, 0.05, 5000);
      orbit = new OrbitControls(editCamera, canvas.value!);
      orbit.target.set(0, 1, 0);
      orbit.enabled = !props.cameraView;
      gizmo = new TransformControls(editCamera, canvas.value!);
      gizmo.enabled = !props.cameraView && !props.disabled;
      gizmo.setMode(props.mode);
      if (!props.cameraView) stage.add(gizmo.getHelper());
      gizmo.addEventListener("dragging-changed", (event) => {
        dragging = Boolean(event.value);
        if (dragging && !props.markId && props.selected !== "camera") {
          const ids = props.selectedIds ?? [props.selected];
          dragObjects = new Map(
            ids.map((id) => {
              const object = objects.get(id)!.group;
              return [id, { position: object.position.clone(), rotationY: object.rotation.y }];
            }),
          );
        }
        if (!dragging) dragObjects = undefined;
        orbit.enabled = !dragging && !props.cameraView;
        emit("interaction", dragging);
      });
      gizmo.addEventListener("mouseUp", () => {
        skipSelection = true;
        try {
          if (dragging && selectedObject)
            emit(
              "move",
              props.selected,
              props.markId,
              {
                x: selectedObject.position.x,
                y: selectedObject.position.y,
                z: selectedObject.position.z,
              },
              selectedObject.rotation.y,
              selectedObject.scale.x,
            );
        } finally {
          emit("interaction", false);
        }
      });
      canvas.value!.addEventListener("pointerdown", pointerDown, true);
      canvas.value!.addEventListener("pointerup", pointerUp);
      canvas.value!.addEventListener("pointermove", pointerMove);
      canvas.value!.addEventListener("pointerleave", pointerLeave);
      canvas.value!.addEventListener("pointercancel", pointerCancel);
      canvas.value!.addEventListener("wheel", actorWheel, { passive: false, capture: true });
      window.addEventListener("blur", cancelInteraction);
      resize = new ResizeObserver(() => draw());
      resize.observe(container.value!);
      rebuild();
      const tick = () => {
        orbit.update();
        draw();
        frame = requestAnimationFrame(tick);
      };
      tick();
    } catch (error) {
      failure.value = error instanceof Error ? error.message : "三维场景无法加载";
    }
  }
  function update(value: BlockoutViewportProps) {
    const previous = props;
    props = value;
    const rebuilt = previous.scene !== value.scene || previous.shot !== value.shot;
    if (rebuilt) rebuild();
    else if (previous.actorPreview !== value.actorPreview) updateEvaluator();
    if (previous.scene.scans !== value.scene.scans) scans?.sync(value.scene.scans ?? []);
    if (previous.scene.environment !== value.scene.environment)
      environment?.update(value.scene.environment);
    if (gizmo) {
      if (previous.time !== value.time && dragging) cancelInteraction();
      gizmo.enabled = !value.disabled && !value.cameraView;
      if (
        !rebuilt &&
        (previous.disabled !== value.disabled ||
          previous.mode !== value.mode ||
          previous.markId !== value.markId ||
          previous.selected !== value.selected ||
          previous.selectedIds?.join("\0") !== value.selectedIds?.join("\0"))
      ) {
        gizmo.setMode(value.markId ? "translate" : value.mode);
        select();
      }
    }
    if (orbit && previous.recording !== value.recording) {
      if (value.recording) {
        orbitSettings = {
          rotateSpeed: orbit.rotateSpeed,
          panSpeed: orbit.panSpeed,
          zoomSpeed: orbit.zoomSpeed,
          enableDamping: orbit.enableDamping,
          dampingFactor: orbit.dampingFactor,
        };
        orbit.rotateSpeed = orbit.panSpeed = orbit.zoomSpeed = 0.65;
        orbit.enableDamping = true;
        orbit.dampingFactor = 0.12;
      } else if (orbitSettings) {
        Object.assign(orbit, orbitSettings);
        orbitSettings = undefined;
      }
    }
    draw();
  }
  function dispose() {
    endActorControl();
    generation++;
    emit("interaction", false);
    cancelAnimationFrame(frame);
    resize?.disconnect();
    orbit?.dispose();
    gizmo?.dispose();
    canvas.value?.removeEventListener("pointerdown", pointerDown, true);
    canvas.value?.removeEventListener("pointerup", pointerUp);
    canvas.value?.removeEventListener("pointermove", pointerMove);
    canvas.value?.removeEventListener("pointerleave", pointerLeave);
    canvas.value?.removeEventListener("pointercancel", pointerCancel);
    canvas.value?.removeEventListener("wheel", actorWheel, true);
    window.removeEventListener("blur", cancelInteraction);
    environment?.dispose();
    environment = undefined;
    controlRenderer?.dispose();
    controlRenderer = undefined;
    const scanCleanup = disposeScans(),
      closingRenderer = renderer;
    scansGroup.removeFromParent();
    if (stage) disposeGroup(stage);
    renderer = undefined;
    // React cannot await unmount. Close awaits disposal; delete/reload preflight
    // only drains work so a denied operation keeps the viewer usable. GPU teardown
    // still follows actual worker/build cleanup when this viewport is unmounted.
    void scanCleanup
      .catch((error) => console.error("Gaussian 扫描卸载释放失败", error))
      .finally(() => {
        closingRenderer?.dispose();
        closingRenderer?.forceContextLoss();
      });
  }

  async function waitForScans() {
    await scans?.waitForScans();
  }

  function disposeScans() {
    if (scanDisposal) return scanDisposal;
    scansGroup.visible = false;
    scanDisposal = (async () => {
      try {
        await scans?.dispose();
      } catch (error) {
        scanFailure.value = error instanceof Error ? error.message : "扫描释放失败";
        throw error;
      } finally {
        scansGroup.removeFromParent();
        scanLoading.value = 0;
      }
    })();
    return scanDisposal;
  }

  function getCamera() {
    if (!renderer || !evaluator || renderer.getContext().isContextLost() || failure.value)
      throw new Error(failure.value || "摄影机视口尚未就绪或上下文已失效");
    const angle = new THREE.Euler().setFromQuaternion(editCamera.quaternion, "YXZ");
    return {
      position: { x: editCamera.position.x, y: editCamera.position.y, z: editCamera.position.z },
      pan: angle.y,
      tilt: angle.x,
      roll: angle.z,
      focalLength: props.recordingLens ?? evaluator.evaluate(props.time).camera.focalLength,
    };
  }
  async function ready() {
    await pendingModels;
    getCamera();
  }
  function beginActorControl(position: V3, heading: number, precision: RecordPrecision) {
    getCamera();
    if (position.y < 0 || position.y > 60) throw new Error("角色操演起点高度须在0–60米内");
    actorControl = {
      position: new THREE.Vector3(position.x, position.y, position.z),
      heading,
      height: position.y,
      precision,
      orbitEnabled: orbit.enabled,
      cancelled: false,
    };
    pointerInside = false;
    orbit.enabled = false;
    canvas.value!.focus();
  }
  function sampleActorControl(dt: number) {
    getCamera();
    const control = actorControl;
    if (
      !control ||
      control.cancelled ||
      !document.hasFocus() ||
      document.activeElement !== canvas.value
    )
      throw new Error("角色操演指针取消或Stage/窗口焦点已离开，保留最后实际采样");
    if (pointerInside) {
      raycaster.setFromCamera(pointer, editCamera);
      const point = raycaster.ray.intersectPlane(
        new THREE.Plane(new THREE.Vector3(0, 1, 0), -control.height),
        new THREE.Vector3(),
      );
      if (point) {
        const tuning = recordTuning[control.precision],
          seconds = Math.max(0, Math.min(dt, 0.1));
        const step = point
          .sub(control.position)
          .multiplyScalar(1 - Math.exp(-tuning.rate * seconds));
        if (step.length() > tuning.maxSpeed * seconds) step.setLength(tuning.maxSpeed * seconds);
        if (step.x * step.x + step.z * step.z > 1e-6) control.heading = headingOf(step);
        control.position.add(step);
      }
    }
    if (
      ![control.position.x, control.position.y, control.position.z, control.heading].every(
        (value) => Number.isFinite(value) && Math.abs(value) <= 100000,
      )
    )
      throw new Error("角色操演状态超出支持范围");
    return {
      position: { x: control.position.x, y: control.position.y, z: control.position.z },
      heading: control.heading,
    };
  }
  function endActorControl() {
    if (actorControl && orbit) orbit.enabled = actorControl.orbitEnabled;
    actorControl = undefined;
    pointerInside = false;
  }
  function cancelInteraction() {
    if (!dragging) return;
    gizmo.reset();
    gizmo.dragging = false;
    dragging = false;
    dragObjects = undefined;
    orbit.enabled = !props.cameraView;
    emit("interaction", false);
    draw();
  }
  async function capture(time: number, width = 1280, pass?: CapturePass) {
    if (!props.cameraView || !renderer) throw new Error("摄影机监看尚未就绪");
    await pendingModels;
    if (!renderer || renderer.getContext().isContextLost())
      throw new Error("摄影机渲染上下文已失效，未生成画面");
    if (failure.value) throw new Error(failure.value);
    const current = renderer.getPixelRatio();
    const height = Math.round(width / ASPECT_RATIOS[props.shot.aspect]);
    try {
      renderer.setPixelRatio(1);
      draw(time, { width, height }, true, pass);
      return { dataUrl: canvas.value!.toDataURL("image/png"), width, height };
    } finally {
      renderer.setPixelRatio(current);
      draw();
    }
  }
  async function captureTopDown() {
    if (!props.cameraView || !renderer) throw new Error("俯视图摄影实例尚未就绪");
    await pendingModels;
    getCamera();
    const take = props.scene.blocking.find((item) => item.id === props.shot.blockingTakeId);
    if (!take || props.shot.duration <= 0 || props.shot.duration > 300)
      throw new Error("俯视图须有有效Take，镜头时长不超过300秒");
    const excluded = new Set(
      props.scene.entities.filter((entity) => entity.excludeFromExport).map((entity) => entity.id),
    );
    const tracks = take.tracks.filter(
      (track) =>
        !excluded.has(track.entityId) &&
        props.scene.entities.some((entity) => entity.id === track.entityId),
    );
    const markEntries = [
      ...props.shot.camera.marks.map((mark) => ({ mark, entityId: "camera" })),
      ...tracks.flatMap((track) => track.marks.map((mark) => ({ mark, entityId: track.entityId }))),
    ];
    if (
      markEntries.length > 8192 ||
      markEntries.some(
        ({ mark }) =>
          !Number.isFinite(mark.time) ||
          mark.time < 0 ||
          mark.time > 300 ||
          !Number.isFinite(mark.hold) ||
          mark.hold < 0,
      )
    )
      throw new Error("俯视图最多8192标记，标记时间须在0–300秒且停留有效");
    const pathDuration = Math.max(props.shot.duration, ...markEntries.map(({ mark }) => mark.time));
    const diagramEvaluator = new ShotEvaluator(props.scene, {
      ...props.shot,
      duration: pathDuration,
    });
    const times = new Set<number>([0, pathDuration]);
    for (let index = 1; index < Math.ceil(pathDuration * 10); index++) times.add(index / 10);
    for (const { mark } of markEntries) {
      times.add(mark.time);
      times.add(Math.min(pathDuration, mark.time + mark.hold));
    }
    const entityIds = [
      ...new Set([
        ...tracks.filter((track) => track.marks.length).map((track) => track.entityId),
        ...props.scene.entities
          .filter((entity) => entity.attachedTo && !excluded.has(entity.id))
          .map((entity) => entity.id),
      ]),
    ];
    if (times.size * (entityIds.length + 1) > 250000)
      throw new Error("俯视图路径超过25万采样点或8192标记，请拆分镜头后导出");
    const points = new Map<string, THREE.Vector3[]>([...entityIds, "camera"].map((id) => [id, []]));
    for (const time of [...times].sort((a, b) => a - b)) {
      const state = diagramEvaluator.evaluate(time);
      for (const entity of state.entities)
        points
          .get(entity.entityId)
          ?.push(new THREE.Vector3(entity.position.x, entity.position.y, entity.position.z));
      const position = state.camera.position;
      points.get("camera")!.push(new THREE.Vector3(position.x, position.y, position.z));
    }
    const annotations = markEntries.map(({ mark, entityId }) => {
      const cameraMark = entityId === "camera";
      const state = diagramEvaluator.evaluate(mark.time),
        position = cameraMark
          ? state.camera.position
          : state.entities.find((item) => item.entityId === entityId)!.position;
      const name = cameraMark
        ? `Cam ${props.shot.cameraName ?? "A"}`
        : props.scene.entities.find((entity) => entity.id === entityId)!.name;
      return {
        id: mark.id,
        entityId,
        time: mark.time,
        name,
        position: { ...position },
        sourceMark: structuredClone(mark),
        camera: cameraMark ? state.camera : undefined,
      };
    });
    const initial = diagramEvaluator.evaluate(0);
    const diagram = new THREE.Group(),
      currentRatio = renderer!.getPixelRatio(),
      pathVisible = paths.visible,
      scanVisible = scansGroup.visible,
      helper = gizmo.getHelper(),
      helperVisible = helper.visible;
    const labels: { text: string; position: THREE.Vector3; color: string }[] = [];
    const width = 1600,
      height = 1600;
    try {
      paths.visible = false;
      scansGroup.visible = false;
      helper.visible = false;
      renderer!.setPixelRatio(1);
      draw(0, { width, height }, true);
      content.updateWorldMatrix(true, true);
      const bounds = new THREE.Box3();
      for (const [id, built] of objects)
        if (!excluded.has(id)) bounds.union(new THREE.Box3().setFromObject(built.group));
      for (const line of points.values()) for (const point of line) bounds.expandByPoint(point);
      for (const mark of annotations)
        bounds.expandByPoint(new THREE.Vector3(mark.position.x, mark.position.y, mark.position.z));
      if (bounds.isEmpty()) bounds.set(new THREE.Vector3(-5, 0, -5), new THREE.Vector3(5, 2, 5));
      const center = bounds.getCenter(new THREE.Vector3()),
        extent = bounds.getSize(new THREE.Vector3());
      const span = Math.max(extent.x, extent.z) * 0.65 + 2;
      if (
        ![center.x, center.y, center.z, span, bounds.max.y].every(Number.isFinite) ||
        span > 200000
      )
        throw new Error("俯视图场景边界无效或超过支持范围");
      const markerRadius = Math.max(0.1, span * 0.005),
        colorOf = (id: string) =>
          id === "camera"
            ? "#fbbf24"
            : (props.scene.entities.find((entity) => entity.id === id)?.label?.color ?? "#38bdf8");
      for (const [id, line] of points) {
        if (line.length < 2) continue;
        diagram.add(
          new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(line),
            new THREE.LineBasicMaterial({
              color: colorOf(id),
              depthTest: false,
              depthWrite: false,
              fog: false,
              toneMapped: false,
            }),
          ),
        );
      }
      const marker = (position: V3, color: string) => {
        const mesh = new THREE.Mesh(
          new THREE.CircleGeometry(markerRadius, 12),
          new THREE.MeshBasicMaterial({
            color,
            depthTest: false,
            depthWrite: false,
            fog: false,
            toneMapped: false,
          }),
        );
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.set(position.x, position.y, position.z);
        diagram.add(mesh);
      };
      const cameraSymbol = (camera: typeof initial.camera) => {
        const length = Math.max(1, span * 0.04),
          half = Math.atan(Math.tan(camera.vfov / 2) * ASPECT_RATIOS[props.shot.aspect]);
        const position = new THREE.Vector3(camera.position.x, camera.position.y, camera.position.z);
        const edge = (angle: number) =>
          position
            .clone()
            .add(new THREE.Vector3(-Math.sin(angle), 0, -Math.cos(angle)).multiplyScalar(length));
        diagram.add(
          new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([
              edge(camera.pan - half),
              position,
              edge(camera.pan + half),
              edge(camera.pan - half),
            ]),
            new THREE.LineBasicMaterial({
              color: "#fbbf24",
              depthTest: false,
              depthWrite: false,
              fog: false,
              toneMapped: false,
            }),
          ),
        );
      };
      for (const mark of annotations) {
        const color = colorOf(mark.entityId);
        marker(mark.position, color);
        labels.push({
          text: `${mark.name} · ${mark.time.toFixed(2)}s`,
          position: new THREE.Vector3(mark.position.x, mark.position.y, mark.position.z),
          color,
        });
        if (mark.camera) cameraSymbol(mark.camera);
      }
      cameraSymbol(initial.camera);
      labels.push({
        text: `Cam ${props.shot.cameraName ?? "A"} · t0`,
        position: new THREE.Vector3(
          initial.camera.position.x,
          initial.camera.position.y,
          initial.camera.position.z,
        ),
        color: "#fbbf24",
      });
      for (const entity of initial.entities.filter((item) => !excluded.has(item.entityId)))
        labels.push({
          text: props.scene.entities.find((item) => item.id === entity.entityId)!.name,
          position: new THREE.Vector3(entity.position.x, entity.position.y, entity.position.z),
          color: "#ffffff",
        });
      const cameraHeight = Math.max(60, bounds.max.y + 60);
      const camera = new THREE.OrthographicCamera(
        -span,
        span,
        span,
        -span,
        0.1,
        Math.max(200, cameraHeight - bounds.min.y + 60),
      );
      camera.position.set(center.x, cameraHeight, center.z);
      camera.up.set(0, 0, -1);
      camera.lookAt(center.x, bounds.min.y, center.z);
      camera.updateMatrixWorld();
      renderer!.setSize(width, height, false);
      renderer!.setScissorTest(false);
      renderer!.setViewport(0, 0, width, height);
      renderer!.clear();
      renderer!.render(stage, camera);
      const autoClear = renderer!.autoClear;
      try {
        renderer!.autoClear = false;
        renderer!.render(diagram, camera);
      } finally {
        renderer!.autoClear = autoClear;
      }
      const output = document.createElement("canvas");
      output.width = width;
      output.height = height;
      try {
        const context = output.getContext("2d", { alpha: false });
        if (!context) throw new Error("无法创建俯视图标签画布");
        context.drawImage(canvas.value!, 0, 0);
        context.font = "18px system-ui, sans-serif";
        context.lineWidth = 4;
        context.strokeStyle = "#101015";
        const projectedLabels = labels.map((label) => {
          const point = label.position.clone().project(camera),
            x = ((point.x + 1) * width) / 2,
            y = ((1 - point.y) * height) / 2;
          const text = label.text.length > 70 ? `${label.text.slice(0, 69)}…` : label.text;
          const labelX = Math.max(8, Math.min(width - context.measureText(text).width - 8, x + 8)),
            labelY = Math.max(26, Math.min(height - 40, y - 8));
          context.strokeText(text, labelX, labelY);
          context.fillStyle = label.color;
          context.fillText(text, labelX, labelY);
          return { text: label.text, x: labelX, y: labelY };
        });
        context.fillStyle = "#101015";
        context.fillRect(0, height - 34, width, 34);
        context.fillStyle = "#ffffff";
        context.fillText(
          `${props.scene.name.slice(0, 60)} / ${props.shot.name.slice(0, 60)} · Take ${take.name.slice(0, 40)} · Cam ${props.shot.cameraName ?? "A"} · t0 · +X right / -Z up · meters`,
          12,
          height - 11,
        );
        return {
          dataUrl: output.toDataURL("image/png"),
          width,
          height,
          diagram: {
            projection: "orthographic",
            time: 0,
            unit: "meter",
            screenAxes: { right: "+X", up: "-Z" },
            bounds: { min: bounds.min.toArray(), max: bounds.max.toArray() },
            camera: {
              position: camera.position.toArray(),
              left: -span,
              right: span,
              top: span,
              bottom: -span,
              near: camera.near,
              far: camera.far,
            },
            takeId: take.id,
            cameraName: props.shot.cameraName ?? "A",
            entitiesAtZero: initial.entities.filter((item) => !excluded.has(item.entityId)),
            marks: annotations,
            labels: projectedLabels,
            pathSampling: {
              maximumIntervalSeconds: 0.1,
              shotDuration: props.shot.duration,
              pathHorizonSeconds: pathDuration,
              includesMarkAndHoldBoundaries: true,
              points: times.size * (entityIds.length + 1),
              worldSpaceEvaluation: true,
            },
            excludedEntities: [...excluded].map((entityId) => ({
              entityId,
              reason: "excludeFromExport",
            })),
            annotationsMayOverlap: true,
            cameraSymbol: "planHeadingAndHorizontalFovWedgeNotGroundIntersection",
          },
        };
      } finally {
        output.width = 1;
        output.height = 1;
      }
    } finally {
      diagram.removeFromParent();
      disposeGroup(diagram);
      paths.visible = pathVisible;
      scansGroup.visible = scanVisible;
      helper.visible = helperVisible;
      renderer!.setPixelRatio(currentRatio);
      draw();
    }
  }
  initialize();
  return {
    update,
    dispose,
    dropAsset,
    getCamera,
    ready,
    waitForScans,
    disposeScans,
    cancelInteraction,
    capture,
    captureTopDown,
    beginActorControl,
    sampleActorControl,
    endActorControl,
    getState: () => ({ error: failure.value || scanFailure.value, loading: scanLoading.value }),
  };
}
