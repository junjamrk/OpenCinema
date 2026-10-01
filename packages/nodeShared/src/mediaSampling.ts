export const frameCountPolicy = "halfOpenStableCeilV1" as const;
export type FrameCountPolicy = typeof frameCountPolicy | "legacyCeil";

export function countSampleFrames(duration: number, fps: number, policy: FrameCountPolicy = frameCountPolicy) {
  const frames = duration * fps;
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(fps) || fps <= 0 || !Number.isSafeInteger(Math.ceil(frames))) throw new Error("采样时长与帧率须为有效正数，帧数不得超出安全整数");
  if (policy === "legacyCeil") return Math.ceil(frames);
  if (policy !== frameCountPolicy) throw new Error("不支持的采样计数规则");
  // ACT: 距整帧不超过1e-9帧视为同一边界，消除选区相减误差；更小的真实尾数也按整帧，正区间仍至少1帧。
  const rounded = Math.round(frames);
  return Math.max(1, Math.ceil(Math.abs(frames - rounded) <= 1e-9 ? rounded : frames));
}
