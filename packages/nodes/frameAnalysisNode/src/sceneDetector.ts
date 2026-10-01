type SceneDetectorOptions = {
  method: "adaptive" | "content";
  threshold: number;
  minSceneSeconds: number;
};

type Frame = {
  rgb: Uint8Array;
  histogram: Float32Array;
  time: number;
};

type Transition = {
  before: Frame;
  after: Frame;
  score: number;
  requiredScore: number;
  leftScore: number;
  ignored: boolean;
};

type Boundary = {
  time: number;
  score: number;
  before: Frame;
};

function describeFrame(rgb: Uint8Array, time: number): Frame {
  const histogram = new Float32Array(48);
  const pixelCount = rgb.length / 3;
  for (let index = 0; index < rgb.length; index++) {
    const position = (rgb[index] * 15) / 255;
    const bin = Math.floor(position);
    const fraction = position - bin;
    const offset = (index % 3) * 16;
    histogram[offset + bin] += (1 - fraction) / pixelCount;
    if (bin < 15) histogram[offset + bin + 1] += fraction / pixelCount;
  }
  return { rgb: rgb.slice(), histogram, time };
}

// RGB 空间变化保留构图信息；平滑直方图补充整体色彩分布变化。
// 分值在 0 到 100 之间，是本检测器自己的量纲。
function frameDistance(before: Frame, after: Frame): number {
  let spatialDifference = 0;
  for (let index = 0; index < before.rgb.length; index += 3) {
    spatialDifference += Math.max(
      Math.abs(before.rgb[index] - after.rgb[index]),
      Math.abs(before.rgb[index + 1] - after.rgb[index + 1]),
      Math.abs(before.rgb[index + 2] - after.rgb[index + 2]),
    );
  }
  let histogramDifference = 0;
  for (let index = 0; index < before.histogram.length; index++) {
    histogramDifference += Math.abs(before.histogram[index] - after.histogram[index]);
  }
  const spatialScore = spatialDifference / ((before.rgb.length / 3) * 255);
  const histogramScore = histogramDifference / 6;
  return Math.min(100, 100 * (0.75 * spatialScore + 0.25 * histogramScore));
}

export function createSceneDetector(options: SceneDetectorOptions) {
  const { method, threshold, minSceneSeconds } = options;
  if (method !== "adaptive" && method !== "content") throw new Error("不支持的分镜检测模式");
  if (!Number.isFinite(threshold) || threshold <= 0) throw new Error("分镜检测阈值必须大于 0");
  if (!Number.isFinite(minSceneSeconds) || minSceneSeconds < 0) throw new Error("最短镜头时长不能小于 0");

  const recentScores: { time: number; score: number }[] = [];
  const flashWindowSeconds = 0.12;
  let previousFrame: Frame | undefined;
  let previousTransition: Transition | undefined;
  let pendingBoundary: Boundary | undefined;
  let lastBoundaryTime = 0;
  let finished = false;

  function requiredScore(time: number): number {
    while (recentScores.length && recentScores[0].time < time - 1.2) recentScores.shift();
    if (method === "content") return threshold;
    const sortedScores = recentScores.map((entry) => entry.score).sort((left, right) => left - right);
    const median = sortedScores.length ? sortedScores[Math.floor(sortedScores.length / 2)] : 0;
    // ACT: 以近 1.2 秒的中位数估计运动背景，最多保留 180 帧；不是学习模型。
    return Math.max(4, median) * threshold;
  }

  function emitBoundary(boundary: Boundary, result: number[]) {
    lastBoundaryTime = boundary.time;
    result.push(boundary.time);
  }

  function considerTransition(transition: Transition, rightScore: number, result: number[]) {
    if (
      transition.ignored ||
      transition.score < transition.requiredScore ||
      transition.score <= transition.leftScore ||
      transition.score < rightScore ||
      transition.after.time - lastBoundaryTime < minSceneSeconds
    ) return;

    const boundary = { time: transition.after.time, score: transition.score, before: transition.before };
    if (pendingBoundary && boundary.time - pendingBoundary.time >= minSceneSeconds) {
      emitBoundary(pendingBoundary, result);
      pendingBoundary = undefined;
    }
    if (!pendingBoundary || boundary.score > pendingBoundary.score) pendingBoundary = boundary;
  }

  function flushBoundary(time: number, result: number[]) {
    if (pendingBoundary && time - pendingBoundary.time >= minSceneSeconds) {
      emitBoundary(pendingBoundary, result);
      pendingBoundary = undefined;
    }
  }

  return {
    processFrame(rgb: Uint8Array, time: number): number[] {
      if (finished) throw new Error("分镜检测已经结束");
      if (!rgb.length || rgb.length % 3 !== 0) throw new Error("分镜检测需要完整的 RGB24 帧");
      if (!Number.isFinite(time) || time < 0) throw new Error("视频帧时间必须是非负数");
      if (previousFrame && rgb.length !== previousFrame.rgb.length) throw new Error("分镜检测帧尺寸必须一致");
      if (previousFrame && time <= previousFrame.time) throw new Error("视频帧时间必须严格递增");

      const frame = describeFrame(rgb, time);
      if (!previousFrame) {
        previousFrame = frame;
        lastBoundaryTime = time;
        return [];
      }

      const score = frameDistance(previousFrame, frame);
      const transition: Transition = {
        before: previousFrame,
        after: frame,
        score,
        requiredScore: requiredScore(time),
        leftScore: previousTransition?.score ?? 0,
        ignored: false,
      };
      const result: number[] = [];

      // 候选后短时间内回到原画面，视为闪光或闪帧，同时抑制回返边界。
      if (
        pendingBoundary &&
        time - pendingBoundary.time <= flashWindowSeconds &&
        frameDistance(pendingBoundary.before, frame) < pendingBoundary.score * 0.3
      ) {
        pendingBoundary = undefined;
        transition.ignored = true;
        if (previousTransition) previousTransition.ignored = true;
      }
      if (
        previousTransition &&
        previousTransition.score >= previousTransition.requiredScore &&
        time - previousTransition.after.time <= flashWindowSeconds &&
        frameDistance(previousTransition.before, frame) < previousTransition.score * 0.3
      ) {
        previousTransition.ignored = true;
        transition.ignored = true;
      }
      if (previousTransition) considerTransition(previousTransition, score, result);
      flushBoundary(time, result);

      recentScores.push({ time, score });
      if (recentScores.length > 180) recentScores.shift();
      previousFrame = frame;
      previousTransition = transition;
      return result;
    },
    finish(): number[] {
      if (finished) return [];
      finished = true;
      const result: number[] = [];
      // 末帧没有右邻帧；只在允许零时长镜头时考虑该边界。
      if (previousTransition && minSceneSeconds === 0) considerTransition(previousTransition, 0, result);
      if (previousFrame) flushBoundary(previousFrame.time, result);
      // 不足最小时长的尾段并入前一镜头，不制造尾部边界。
      pendingBoundary = undefined;
      previousTransition = undefined;
      previousFrame = undefined;
      recentScores.length = 0;
      return result;
    },
  };
}
