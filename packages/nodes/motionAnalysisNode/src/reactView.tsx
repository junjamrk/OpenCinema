import { useEffect, useRef, useState } from "react";
import NodeIcon from "@toonflow/node-shared/reactIcon";
import { errorText, type NodeViewProps } from "@toonflow/node-shared/reactNode";
import {
  exportLayers,
  referenceModes,
  productionPlanSchema,
  type ProductionPlan,
} from "@toonflow/node-shared/motionProduction";
import { analysisSettingsSchema, type AnalysisSettings } from "./reactEngine";
import type { MotionService } from "./reactService";
import MotionPreview from "./reactMotionPreview";
import { motionView, readProductionPlan } from "./editorView";
import { useEditorSession } from "@toonflow/node-shared/editorSession";
import "./reactStyles.scss";

type Props = NodeViewProps & {
  controller: NodeViewProps["controller"] & { getPluginService(id: string): unknown };
};
export default function MotionNodeView({ node, controller, readOnly }: Props) {
  const view = motionView(controller.getNodeService(node.id));
  const { value: viewState } = useEditorSession(view);
  const tab = viewState.tab;
  const setTab = (tab: typeof viewState.tab) => view.replace({ ...view.read().value, tab, ...(tab !== "preview" ? { playing: false } : {}) });
  const cachedDraft = (
    controller.getPluginService(node.id) as MotionService | undefined
  )?.getDraft();
  const [settings, setSettings] = useState<AnalysisSettings>(
      () =>
        cachedDraft?.settings ??
        (node.data?.analysisSettings as AnalysisSettings) ?? { start: 0, end: 1, sampleFps: 6 },
    ),
    [plan, setPlan] = useState<ProductionPlan>(
      () =>
        cachedDraft?.plan ??
        readProductionPlan(node.data?.productionPlan, node.data?.label as string | undefined),
    ),
    [status, setStatus] = useState<ReturnType<MotionService["getStatus"]>>(),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  const settingsBaseline = useRef(
    cachedDraft?.settingsBaseline ?? {
      persisted: JSON.stringify(node.data?.analysisSettings ?? { start: 0, end: 1, sampleFps: 6 }),
      local: JSON.stringify(settings),
    },
  );
  const planBaseline = useRef(
    cachedDraft?.planBaseline ?? {
      persisted: JSON.stringify(node.data?.productionPlan ?? null),
      local: JSON.stringify(plan),
    },
  );
  useEffect(() => {
    const service = controller.getPluginService(node.id) as MotionService | undefined;
    return service?.subscribeDraft(() => {
      const draft = service.getDraft();
      if (!draft) return;
      settingsBaseline.current = draft.settingsBaseline; planBaseline.current = draft.planBaseline;
      setSettings(draft.settings); setPlan(draft.plan);
    });
  }, [controller, node.id]);
  useEffect(() => {
    const incoming = (node.data?.analysisSettings as AnalysisSettings) ?? {
      start: 0,
      end: 1,
      sampleFps: 6,
    };
    const serialized = JSON.stringify(incoming);
    setSettings((current) => {
      if (
        JSON.stringify(current) !== settingsBaseline.current.local &&
        serialized !== JSON.stringify(current)
      ) {
        if (serialized !== settingsBaseline.current.persisted)
          setError("分析设置有外部更新，本地草稿保留；保存时会检查原版本");
        return current;
      }
      settingsBaseline.current = { persisted: serialized, local: serialized };
      return incoming;
    });
  }, [node.data?.analysisSettings]);
  useEffect(() => {
    const incoming = readProductionPlan(node.data?.productionPlan, node.data?.label as string | undefined);
    const serialized = JSON.stringify(incoming),
      persisted = JSON.stringify(node.data?.productionPlan ?? null);
    setPlan((current) => {
      if (
        JSON.stringify(current) !== planBaseline.current.local &&
        serialized !== JSON.stringify(current)
      ) {
        if (persisted !== planBaseline.current.persisted)
          setError("镜头计划有外部更新，本地草稿保留；保存时会检查原版本");
        return current;
      }
      planBaseline.current = { persisted, local: serialized };
      return incoming;
    });
  }, [node.data?.productionPlan]);
  useEffect(() => {
    const timer = setInterval(() => {
      const value = (
        controller.getPluginService(node.id) as MotionService | undefined
      )?.getStatus();
      if (value) setStatus(value);
    }, 350);
    return () => clearInterval(timer);
  }, [node.id]);
  const locked = readOnly || status?.running || saving;
  const outputs = (node.data?.outputs as Record<string, any>) ?? {},
    summary = outputs.summary?.dataType === "STRING" ? String(outputs.summary.value) : "",
    report = outputs.analysis?.value?.url;
  const references = controller.getNodeService(node.id).getInputs("input");
  const settingsDirty =
    JSON.stringify(settings) !==
    JSON.stringify(node.data?.analysisSettings ?? { start: 0, end: 1, sampleFps: 6 });
  const planDirty = JSON.stringify(plan) !== JSON.stringify(readProductionPlan(node.data?.productionPlan, node.data?.label as string | undefined));
  const settingsValid = analysisSettingsSchema.safeParse(settings).success;
  useEffect(() => {
    (controller.getPluginService(node.id) as MotionService | undefined)?.setDraft(
      settingsDirty || planDirty
        ? {
            settings,
            plan,
            settingsBaseline: settingsBaseline.current,
            planBaseline: planBaseline.current,
          }
        : undefined,
    );
  }, [settings, plan, node.data?.analysisSettings, node.data?.productionPlan]);
  async function call(name: string, args: Record<string, unknown> = {}) {
    setSaving(true);
    setError("");
    try {
      const value = await controller.callNodeTool(node.id, name, {
        ...args,
        ...(name === "setAnalysisSettings"
          ? { expectedCurrent: settingsBaseline.current.persisted }
          : name === "setProductionPlan"
            ? { expectedCurrent: planBaseline.current.persisted }
            : {}),
      });
      if (name === "getMotionStatus" && value) setStatus(value as typeof status);
      return value;
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setSaving(false);
    }
  }
  async function analyze() {
    if (settingsDirty) {
      const value = await call("setAnalysisSettings", settings);
      if (!value) return;
    }
    await call("analyzeMotion");
  }
  async function download(path: string, mimeType: string) {
    try {
      const value = await controller.acquireMedia(path, mimeType),
        link = document.createElement("a");
      link.href = value.url;
      link.download = path.split("/").at(-1) ?? "motion";
      link.click();
      setTimeout(value.release, 30000);
    } catch (failure) {
      setError(errorText(failure));
    }
  }
  return (
    <div
      className="motionReactNode nodrag nopan nowheel"
      onKeyDown={(event) => event.stopPropagation()}>
      <div className="motionTabs">
        <button className={tab === "analysis" ? "active" : ""} onClick={() => setTab("analysis")}>
          参考分析
        </button>
        <button className={tab === "plan" ? "active" : ""} onClick={() => setTab("plan")}>
          镜头计划
        </button>
        <button className={tab === "outputs" ? "active" : ""} onClick={() => setTab("outputs")}>
          产物
        </button>
        <button className={tab === "preview" ? "active" : ""} onClick={() => setTab("preview")}>
          预览
        </button>
      </div>
      {tab === "analysis" && (
        <>
          <div className="motionInput">
            <span>VIDEO</span>
            <small>
              {references.length === 1
                ? ((references[0]!.value as any)?.url ?? "未产出")
                : references.length
                  ? `${references.length} 路输入，须明确保留一路`
                  : "未连接参考视频"}
            </small>
          </div>
          {(["start", "end", "sampleFps"] as const).map((key, index) => (
            <label className="motionSetting" key={key}>
              <span>{["起点 / 秒", "终点 / 秒", "采样帧率"][index]}</span>
              <input
                type="number"
                step={key === "sampleFps" ? 1 : 0.1}
                min={key === "sampleFps" ? 2 : 0}
                max={key === "sampleFps" ? 12 : undefined}
                disabled={locked}
                value={settings[key]}
                onChange={(event) =>
                  setSettings((value) => ({ ...value, [key]: Number(event.target.value) }))
                }
              />
            </label>
          ))}
          <label className="motionCheck">
            <input
              type="checkbox"
              checked={settings.pose ?? false}
              disabled={locked}
              onChange={(event) =>
                setSettings((value) => ({ ...value, pose: event.target.checked }))
              }
            />
            MediaPipe 人体姿态
          </label>
          <label className="motionCheck">
            <input
              type="checkbox"
              checked={settings.depth ?? false}
              disabled={locked}
              onChange={(event) =>
                setSettings((value) => ({ ...value, depth: event.target.checked }))
              }
            />
            本机相对深度
          </label>
          {settings.pose && (
            <small>{status?.resourceState ?? "随插件提供离线模型，启用时校验 SHA-256"}</small>
          )}
          {settings.depth && (
            <small>使用已准备的本机 CPU 模型；模型缺失时明确失败，不自动下载。</small>
          )}
          <div className="motionActions">
            <button disabled={locked || references.length !== 1 || !settingsValid} onClick={() => void analyze()}>
              <NodeIcon name="movie" />分析参考视频
            </button>
            <button
              disabled={locked || !settingsDirty || !settingsValid}
              onClick={() => void call("setAnalysisSettings", settings)}>
              保存设置
            </button>
          </div>
          <small>
            最多 30 秒、每秒 2–12 帧。Camera 是二维图像运动估计；姿态为单人 33
            关键点，不补造缺失人体。
          </small>
        </>
      )}
      {tab === "plan" && (
        <>
          <label>
            镜头标题
            <input
              maxLength={120}
              value={plan.shotTitle}
              disabled={locked}
              onChange={(event) =>
                setPlan((value) => ({ ...value, shotTitle: event.target.value }))
              }
            />
          </label>
          <label>
            创作意图
            <textarea
              maxLength={2000}
              value={plan.description}
              disabled={locked}
              onChange={(event) =>
                setPlan((value) => ({ ...value, description: event.target.value }))
              }
            />
          </label>
          <label>
            运镜意图
            <textarea
              maxLength={1000}
              value={plan.cameraIntent}
              disabled={locked}
              onChange={(event) =>
                setPlan((value) => ({ ...value, cameraIntent: event.target.value }))
              }
            />
          </label>
          <label>
            视觉风格
            <input
              maxLength={1000}
              value={plan.visualStyle}
              disabled={locked}
              onChange={(event) =>
                setPlan((value) => ({ ...value, visualStyle: event.target.value }))
              }
            />
          </label>
          <label>
            参考范围
            <select
              value={plan.referenceMode}
              disabled={locked}
              onChange={(event) =>
                setPlan((value) => ({
                  ...value,
                  referenceMode: event.target.value as ProductionPlan["referenceMode"],
                }))
              }>
              {referenceModes.map((mode) => (
                <option key={mode.id} value={mode.id}>
                  {mode.label}
                </option>
              ))}
            </select>
          </label>
          <details open>
            <summary>明确选择导出层</summary>
            <div className="motionLayers">
              {exportLayers.map((layer) => (
                <label className="motionCheck" key={layer.id} title={layer.purpose}>
                  <input
                    type="checkbox"
                    disabled={locked}
                    checked={plan.layers.includes(layer.id)}
                    onChange={(event) =>
                      setPlan((value) => ({
                        ...value,
                        layers: event.target.checked
                          ? [...value.layers, layer.id]
                          : value.layers.filter((id) => id !== layer.id),
                      }))
                    }
                  />
                  {layer.label}
                </label>
              ))}
            </div>
          </details>
          <div className="motionActions">
            <button
              disabled={locked || !planDirty || !productionPlanSchema.safeParse(plan).success}
              onClick={() => void call("setProductionPlan", plan)}>
              保存镜头计划
            </button>
            <button
              disabled={locked || !report || !productionPlanSchema.safeParse(plan).success}
              onClick={async () => {
                if (planDirty && !(await call("setProductionPlan", plan))) return;
                await call("exportProductionPack", plan);
              }}>
              导出 Production Pack
            </button>
          </div>
          <small>
            法线代理是亮度梯度，非 XYZ 表面法线。三路审阅仅供对照，须有真实 RGB / Pose / Depth
            产物。
          </small>
        </>
      )}
      {tab === "outputs" && (
        <>
          <button disabled={locked || !report} onClick={() => void call("exportMotion")}>
            导出已有 RGB / OpenPose
          </button>
          {summary && <p className="motionSummary">{summary}</p>}
          <div className="motionOutputs">
            {Object.entries(outputs)
              .filter(([, output]) => output?.value?.url)
              .map(([name, output]) => (
                <button
                  key={name}
                  onClick={() => void download(output.value.url, output.value.mimeType)}>
                  <span>{name}</span>
                  <small>{output.value.url.split("/").at(-1)}</small>
                  <NodeIcon name="download" />
                </button>
              ))}
          </div>
        </>
      )}
      {tab === "preview" && (
        <MotionPreview controller={controller} nodeId={node.id} reportPath={report} />
      )}
      {status?.running && (
        <>
          <progress value={status.progress} max={100} />
          <small role="status">
            {status.phase} · {status.progress}%
          </small>
          <button onClick={() => void call("cancelMotion")}>取消并等待收尾</button>
        </>
      )}
      {status?.operationId && (
        <>
          <small>
            Depth {status.operationId} · {status.backendRegistered ? "已登记" : "本地准备"} ·{" "}
            {status.executionSettled ? "执行已收尾" : "执行未确认收尾"}
          </small>
          {!status.running && (
            <div className="motionActions">
              <button onClick={() => void call("getMotionStatus")}>查询原操作</button>
              <button disabled={readOnly} onClick={() => void call("resumeMotionDepth")}>
                恢复成功产物
              </button>
              {!status.executionSettled && (
                <button onClick={() => void call("cancelMotion")}>取消原操作</button>
              )}
            </div>
          )}
        </>
      )}
      {(error || status?.error) && (
        <p className="motionError" role="alert">
          {error || status?.error}
        </p>
      )}
      {status?.state === "succeeded" && !status.running && (
        <small className="motionSuccess">任务完成，产物已保存</small>
      )}
    </div>
  );
}
