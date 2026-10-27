import { useEffect, useState } from "react";
import { cameraFocusAt } from "./nativeBlockout/evaluate";
import { shotCameras } from "./nativeBlockout/schema";
import type { Scene, Shot, ShotSizeId } from "./nativeBlockout/types";
import { NumberField } from "./reactFields";

export default function ShotControls({
  scene,
  shot,
  time,
  selectedIds,
  disabled,
  onCommand,
  onTime,
}: {
  scene: Scene;
  shot: Shot;
  time: number;
  selectedIds: string[];
  disabled: boolean;
  onCommand(command: Record<string, unknown>): unknown;
  onTime(time: number): void;
}) {
  const scope = { sceneId: scene.id, shotId: shot.id },
    active = shot.cameraName ?? "A",
    cameras = shotCameras(shot);
  const [name, setName] = useState(active),
    [size, setSize] = useState<ShotSizeId>("MS"),
    [pan, setPan] = useState(0),
    [lens, setLens] = useState(35),
    [transition, setTransition] = useState(0.5),
    [target, setTarget] = useState("");
  const focus = cameraFocusAt(shot.camera, time);
  useEffect(() => setName(active), [shot.id, active]);
  useEffect(() => setTarget(focus.entityId ?? ""), [shot.id, active, focus.entityId]);
  const submit = (command: Record<string, unknown>) => onCommand({ ...scope, ...command });
  return (
    <section className="blockoutParityPanel">
      <fieldset disabled={disabled}>
        <details open>
          <summary>多机位</summary>
          <label className="blockoutField">
            <span>活动机位</span>
            <select
              value={active}
              onChange={(event) => submit({ type: "switchCamera", name: event.target.value })}>
              {cameras.map((camera) => (
                <option key={camera.name} value={camera.name}>
                  {camera.name}
                </option>
              ))}
            </select>
          </label>
          <div className="blockoutFieldRow">
            <input
              aria-label="机位名称"
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
            />
            <button
              disabled={!name.trim() || name === active}
              onClick={() => submit({ type: "renameCamera", name: name.trim() })}>
              重命名
            </button>
          </div>
          <div className="blockoutFieldRow">
            <button
              disabled={cameras.length >= 26}
              onClick={() => submit({ type: "addCamera", copyCurrent: true })}>
              复制机位
            </button>
            <button
              disabled={cameras.length >= 26}
              onClick={() => submit({ type: "addCamera", copyCurrent: false })}>
              空白机位
            </button>
            <button
              disabled={cameras.length <= 1}
              onClick={() => submit({ type: "removeCamera", name: active })}>
              删除机位
            </button>
          </div>
        </details>
        <details>
          <summary>
            主体构图 ·{" "}
            {selectedIds.filter((id) => scene.entities.some((entity) => entity.id === id)).length}{" "}
            个主体
          </summary>
          <label className="blockoutField">
            <span>景别</span>
            <select value={size} onChange={(event) => setSize(event.target.value as ShotSizeId)}>
              {["EWS", "WS", "FS", "MS", "MCU", "CU", "ECU"].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <NumberField label="观察方向 / 度" value={pan} step={5} onChange={setPan} />
          <NumberField
            label="焦距 / mm"
            value={lens}
            min={1}
            max={1000}
            step={1}
            onChange={setLens}
          />
          <button
            disabled={
              !selectedIds.length || selectedIds.includes("camera") || selectedIds.length > 20
            }
            onClick={() =>
              submit({
                type: "frameSubjects",
                entityIds: selectedIds,
                time,
                size,
                pan: (pan * Math.PI) / 180,
                focalLength: lens,
              })
            }>
            在当前时间构图
          </button>
        </details>
        <details open>
          <summary>摄影关注与挂载</summary>
          <label className="blockoutField">
            <span>关注主体</span>
            <select value={target} onChange={(event) => setTarget(event.target.value)}>
              <option value="">自由朝向</option>
              {scene.entities.map((entity) => (
                <option key={entity.id} value={entity.id}>
                  {entity.name}
                </option>
              ))}
            </select>
          </label>
          <div className="blockoutFieldRow">
            <button onClick={() => submit({ type: "trackCamera", entityId: target || null })}>
              设为初始关注
            </button>
            <button
              onClick={() =>
                submit({ type: "trackCamera", entityId: target || null, time, transition })
              }>
              在此切换关注
            </button>
          </div>
          <NumberField
            label="切换过渡 / 秒"
            value={transition}
            min={0}
            max={10}
            step={0.1}
            onChange={setTransition}
          />
          {(shot.camera.focusMarks ?? [])
            .slice()
            .sort((a, b) => a.time - b.time)
            .map((mark) => (
              <div className="blockoutFocusRow" key={mark.id}>
                <NumberField
                  label="关注时间 / 秒"
                  value={mark.time}
                  min={0}
                  max={shot.duration}
                  onChange={(at) =>
                    submit({
                      type: "trackCamera",
                      entityId: mark.entityId,
                      time: at,
                      transition: mark.transition,
                      focusId: mark.id,
                    })
                  }
                />
                <NumberField
                  label="关注过渡 / 秒"
                  value={mark.transition}
                  min={0}
                  max={10}
                  onChange={(seconds) =>
                    submit({
                      type: "trackCamera",
                      entityId: mark.entityId,
                      time: mark.time,
                      transition: seconds,
                      focusId: mark.id,
                    })
                  }
                />
                <button onClick={() => onTime(mark.time)}>
                  {mark.time.toFixed(2)}s ·{" "}
                  {scene.entities.find((entity) => entity.id === mark.entityId)?.name ?? "自由朝向"}
                </button>
                <button
                  aria-label="删除摄影关注标记"
                  onClick={() => submit({ type: "removeCameraFocus", focusId: mark.id })}>
                  删除
                </button>
              </div>
            ))}
          <label className="blockoutField">
            <span>相机挂载 · 生成新机位</span>
            <select
              value={shot.camera.mountEntityId ?? ""}
              onChange={(event) =>
                submit({
                  type: "setCameraMount",
                  sourceCameraName: active,
                  entityId: event.target.value || null,
                  time,
                })
              }>
              <option value="">无挂载</option>
              {scene.entities.map((entity) => (
                <option key={entity.id} value={entity.id}>
                  {entity.name}
                </option>
              ))}
            </select>
          </label>
        </details>
      </fieldset>
    </section>
  );
}
