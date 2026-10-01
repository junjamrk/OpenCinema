import { useEffect, useState } from "react";
import type { NodeViewProps } from "@toonflow/node-shared/reactNode";
import type { NodeMediaValue } from "@toonflow/nodes-scaffold/values";
import type { BlockoutService } from "./reactService";
import type { Shot } from "./nativeBlockout/types";
import { NumberField } from "./reactFields";

export default function ReferenceControls({
  nodeId,
  controller,
  service,
  shot,
  sceneId,
  revision,
  disabled,
  onAction,
  onCommand,
}: {
  nodeId: string;
  controller: NodeViewProps["controller"];
  service: BlockoutService;
  shot: Shot;
  sceneId: string;
  revision: string;
  disabled: boolean;
  onAction(callback: () => Promise<unknown>): unknown;
  onCommand(command: Record<string, unknown>): unknown;
}) {
  const sources = controller
    .getNodeService(nodeId)
    .getInputs("in")
    .filter((input) => input.dataType === "VIDEO" && input.value)
    .map((input) => ({
      ...input,
      media: input.value as NodeMediaValue & { controlType?: string },
    }));
  const [sourceId, setSourceId] = useState(""),
    [kind, setKind] = useState<"rgb" | "pose" | "depth">("rgb");
  const source =
    sources.find((input) => `${input.source}:${input.sourceHandle}` === sourceId) ?? sources[0];
  useEffect(() => {
    const control = source?.media.controlType;
    setKind(control === "pose" || control === "depth" ? control : "rgb");
  }, [source?.source, source?.sourceHandle]);
  const reference = shot.referenceVideo,
    scope = { sceneId, shotId: shot.id };
  return (
    <section className="blockoutParityPanel">
      <fieldset disabled={disabled}>
        <details open>
          <summary>RGB / Pose / Depth 参考</summary>
          <label className="blockoutField">
            <span>参考类型</span>
            <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
              <option value="rgb">RGB</option>
              <option value="pose">Pose</option>
              <option value="depth">Depth</option>
            </select>
          </label>
          <label className="blockoutImport">
            导入视频副本
            <input
              type="file"
              accept="video/mp4,video/webm,.mp4,.webm"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file)
                  onAction(() =>
                    service.importReference(file, { ...scope, expectedRevision: revision, kind }),
                  );
                event.target.value = "";
              }}
            />
          </label>
          <label className="blockoutField">
            <span>已连接视频</span>
            <select
              disabled={!sources.length}
              value={source ? `${source.source}:${source.sourceHandle}` : ""}
              onChange={(event) => setSourceId(event.target.value)}>
              {!sources.length && <option value="">没有视频输入</option>}
              {sources.map((input) => (
                <option
                  key={`${input.source}:${input.sourceHandle}`}
                  value={`${input.source}:${input.sourceHandle}`}>
                  {input.sourceHandle} ·{" "}
                  {input.media.controlType ?? input.media.url.split("/").at(-1)}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={!source?.media.url}
            onClick={() =>
              source &&
              onAction(() =>
                service.importReference(source.media.url, {
                  ...scope,
                  expectedRevision: revision,
                  kind,
                }),
              )
            }>
            保存输入为本节点参考副本
          </button>
          {reference && (
            <>
              <small>
                {reference.width} × {reference.height} · {reference.duration?.toFixed(2)}s ·{" "}
                {reference.kind?.toUpperCase() ?? "旧参考"}
              </small>
              <label className="blockoutField">
                <span>显示方式</span>
                <select
                  value={reference.mode}
                  onChange={(event) =>
                    onCommand({ type: "setReferenceVideo", ...scope, mode: event.target.value })
                  }>
                  <option value="ghost">Ghost 叠加</option>
                  <option value="pip">PiP 画中画</option>
                </select>
              </label>
              <NumberField
                label="透明度"
                value={reference.opacity}
                min={0}
                max={1}
                step={0.05}
                onChange={(opacity) => onCommand({ type: "setReferenceVideo", ...scope, opacity })}
              />
              <NumberField
                label="参考时间偏移 / 秒"
                value={reference.timeOffset}
                min={-3600}
                max={3600}
                step={0.1}
                onChange={(timeOffset) =>
                  onCommand({ type: "setReferenceVideo", ...scope, timeOffset })
                }
              />
              <button
                onClick={() => onCommand({ type: "setReferenceVideo", ...scope, remove: true })}>
                移除参考
              </button>
            </>
          )}
        </details>
      </fieldset>
    </section>
  );
}
