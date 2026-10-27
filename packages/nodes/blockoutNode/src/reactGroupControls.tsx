import { useEffect, useState } from "react";
import { blockoutCommand } from "./editing";
import { sequenceStyles, type SequenceType } from "./nativeBlockout/sequences";
import {
  choreoEndings,
  choreoFormations,
  choreoStyles,
  type ChoreoKind,
  type FormationId,
} from "./nativeBlockout/choreography";
import { motionPresets } from "./nativeBlockout/motions";
import { actionPresets } from "./nativeBlockout/actionPresets";

export default function GroupControls({
  sceneId,
  shotId,
  duration,
  entityIds,
  sharedShots,
  disabled,
  onCommand,
}: {
  sceneId: string;
  shotId: string;
  duration: number;
  entityIds: string[];
  sharedShots: string[];
  disabled: boolean;
  onCommand(command: Record<string, unknown>): unknown;
}) {
  const [origin, setOrigin] = useState({ x: 0, z: 0, heading: 0 });
  const [sequenceType, setSequenceType] = useState<SequenceType>("dance");
  const [sequenceStyle, setSequenceStyle] = useState("mixed");
  const [sequenceCount, setSequenceCount] = useState(12);
  const [kind, setKind] = useState<ChoreoKind>("dance");
  const [style, setStyle] = useState("mixed"),
    [ending, setEnding] = useState("freeze");
  const [count, setCount] = useState(8),
    [seed, setSeed] = useState(1),
    [bpm, setBpm] = useState(116);
  const [beat, setBeat] = useState(0.55),
    [amplitude, setAmplitude] = useState(4);
  const [formation, setFormation] = useState<FormationId>("line");
  const [canon, setCanon] = useState(false),
    [mirror, setMirror] = useState(false),
    [formationChange, setFormationChange] = useState(false);
  const [replace, setReplace] = useState(false),
    [motion, setMotion] = useState(motionPresets[0]!.id),
    [action, setAction] = useState(actionPresets[0]!.id);
  const [error, setError] = useState("");
  const range = kind === "dance" ? [1, 40] : kind === "fight" ? [2, 8] : [2, 6];
  useEffect(() => {
    setReplace(false);
    setError("");
  }, [sceneId, shotId, duration, entityIds.join("|"), sharedShots.join("|"), disabled]);
  function submit(value: unknown) {
    if (disabled) return;
    const parsed = blockoutCommand.safeParse(value);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "群组参数无效");
      return;
    }
    setError("");
    setReplace(false);
    onCommand(parsed.data);
  }
  const scope = { sceneId, shotId };
  const spec = {
    kind,
    seed,
    style,
    ending,
    ...(kind === "dance"
      ? { bpm, formation, canon, mirror, formationChange }
      : kind === "fight"
        ? { beatDur: beat, mirror }
        : { amplitude }),
  };
  return (
    <section className="blockoutParityPanel" aria-label="群组编排">
      <h3>群组编排</h3>
      <p>从 0 秒编排到镜尾 {duration.toFixed(2)} 秒。已确认 Take 请先复制后排演。</p>
      {sharedShots.length > 0 && (
        <p>共享当前 Take：{sharedShots.join("、")}。重排会影响这些镜头。</p>
      )}
      <fieldset disabled={disabled}>
        <details open>
          <summary>新增群组的原点</summary>
          <div className="blockoutFieldRow">
            {(["x", "z", "heading"] as const).map((key) => (
              <label key={key}>
                {key === "heading" ? "朝向 / 弧度" : `${key.toUpperCase()} / m`}
                <input
                  type="number"
                  min={-100000}
                  max={100000}
                  step={key === "heading" ? 0.1 : 0.5}
                  value={origin[key]}
                  onChange={(event) => setOrigin({ ...origin, [key]: event.target.valueAsNumber })}
                />
              </label>
            ))}
          </div>
          <p>新增物体属于整个场景，动作写入当前 Take。</p>
        </details>
        <details open>
          <summary>群组序列</summary>
          <label>
            序列类型
            <select
              value={sequenceType}
              onChange={(event) => {
                const type = event.target.value as SequenceType;
                setSequenceType(type);
                setSequenceStyle(sequenceStyles(type)[0]!.id);
              }}>
              <option value="dance">群舞</option>
              <option value="fight">群体打斗</option>
              <option value="footChase">徒步追逐</option>
              <option value="carChase">车辆追逐</option>
            </select>
          </label>
          <label>
            成员数 / 2–60
            <input
              type="number"
              min={2}
              max={60}
              step={1}
              value={sequenceCount}
              onChange={(event) => setSequenceCount(event.target.valueAsNumber)}
            />
          </label>
          <label>
            序列风格
            <select
              value={sequenceStyle}
              onChange={(event) => setSequenceStyle(event.target.value)}>
              {sequenceStyles(sequenceType).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() =>
              submit({
                type: "stageSequence",
                ...scope,
                sequenceType,
                count: sequenceCount,
                style: sequenceStyle,
                origin,
              })
            }>
            新增群组序列
          </button>
        </details>
        <details open>
          <summary>舞蹈 / 对打 / 追逐例程</summary>
          <label>
            例程
            <select
              value={kind}
              onChange={(event) => {
                const next = event.target.value as ChoreoKind;
                setKind(next);
                setStyle(choreoStyles(next)[0]!.id);
                setEnding(choreoEndings(next)[0]!.id);
                setCount(next === "dance" ? 8 : 2);
                setReplace(false);
              }}>
              <option value="dance">舞蹈</option>
              <option value="fight">对打</option>
              <option value="chase">追逐</option>
            </select>
          </label>
          <label>
            风格
            <select value={style} onChange={(event) => setStyle(event.target.value)}>
              {choreoStyles(kind).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            新增人数 / {range.join("–")}
            <input
              type="number"
              min={range[0]}
              max={range[1]}
              step={1}
              value={count}
              onChange={(event) => setCount(event.target.valueAsNumber)}
            />
          </label>
          <label>
            种子 / uint32
            <span className="blockoutFieldRow">
              <input
                type="number"
                min={0}
                max={4294967295}
                step={1}
                value={seed}
                onChange={(event) => setSeed(event.target.valueAsNumber)}
              />
              <button
                type="button"
                onClick={() => setSeed(crypto.getRandomValues(new Uint32Array(1))[0]!)}>
                随机
              </button>
            </span>
          </label>
          {kind === "dance" && (
            <>
              <label>
                BPM
                <input
                  type="number"
                  min={60}
                  max={180}
                  value={bpm}
                  onChange={(event) => setBpm(event.target.valueAsNumber)}
                />
              </label>
              <label>
                队形
                <select
                  value={formation}
                  onChange={(event) => setFormation(event.target.value as FormationId)}>
                  {choreoFormations().map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="blockoutCheck">
                <input
                  type="checkbox"
                  checked={canon}
                  onChange={(event) => setCanon(event.target.checked)}
                />
                依次错拍入场
              </label>
              <label className="blockoutCheck">
                <input
                  type="checkbox"
                  checked={formationChange}
                  onChange={(event) => setFormationChange(event.target.checked)}
                />
                短语间换队形
              </label>
            </>
          )}
          {kind === "fight" && (
            <label>
              节拍 / 秒
              <input
                type="number"
                min={0.05}
                step={0.05}
                value={beat}
                onChange={(event) => setBeat(event.target.valueAsNumber)}
              />
            </label>
          )}
          {kind === "chase" && (
            <label>
              蛇形振幅 / m
              <input
                type="number"
                min={0}
                step={0.5}
                value={amplitude}
                onChange={(event) => setAmplitude(event.target.valueAsNumber)}
              />
            </label>
          )}
          {kind !== "chase" && (
            <label className="blockoutCheck">
              <input
                type="checkbox"
                checked={mirror}
                onChange={(event) => setMirror(event.target.checked)}
              />
              镜像动作 / 架势
            </label>
          )}
          <label>
            结尾
            <select value={ending} onChange={(event) => setEnding(event.target.value)}>
              {choreoEndings(kind).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => {
              if (!Number.isInteger(count) || count < range[0]! || count > range[1]!) {
                setError(`人数须为 ${range.join("–")} 之间的整数`);
                return;
              }
              submit({
                type: "stageRoutine",
                ...scope,
                spec: { ...spec, performers: count },
                origin,
              });
            }}>
            新增完整例程
          </button>
        </details>
        <details open>
          <summary>重排完整选择 · {entityIds.length} 个物体</summary>
          <p>
            替换当前 Take 中 0
            秒至镜尾的已知走位、关节及视线；保留场景静态姿态和镜尾后的轨道。不会截取选择或跳过不支持的物体。
          </p>
          <label className="blockoutCheck">
            <input
              type="checkbox"
              checked={replace}
              onChange={(event) => setReplace(event.target.checked)}
            />
            确认替换全部所选物体的现有表演
          </label>
          <button
            type="button"
            disabled={!replace || entityIds.length < range[0]! || entityIds.length > range[1]!}
            onClick={() =>
              submit({
                type: "applyRoutineToEntities",
                ...scope,
                entityIds,
                spec,
                replacePerformance: true,
              })
            }>
            用上方例程重排所选
          </button>
          <label>
            身体动作 / 194 项
            <select value={motion} onChange={(event) => setMotion(event.target.value)}>
              {motionPresets.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.category} · {item.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!replace || !entityIds.length}
            onClick={() =>
              submit({
                type: "applyMotionToEntities",
                ...scope,
                entityIds,
                presetId: motion,
                replacePerformance: true,
              })
            }>
            为全部所选铺身体动作
          </button>
          <label>
            根路径 / 33 项
            <select value={action} onChange={(event) => setAction(event.target.value)}>
              {actionPresets.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.category} · {item.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!replace || !entityIds.length}
            onClick={() =>
              submit({
                type: "applyActionToEntities",
                ...scope,
                entityIds,
                presetId: action,
                replacePerformance: true,
              })
            }>
            为全部所选铺根路径
          </button>
        </details>
      </fieldset>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
