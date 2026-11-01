export type CanvasAlignmentNode = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  parentId?: string;
  hidden?: boolean;
};

export type CanvasAlignmentGuide = {
  axis: "x" | "y";
  position: number;
  start: number;
  end: number;
  targetId: string;
};

export type CanvasAlignmentResult = { dx: number; dy: number; guides: CanvasAlignmentGuide[] };
type AlignmentBounds = Pick<CanvasAlignmentNode, "x" | "y" | "width" | "height">;
type AlignmentCandidate = { delta: number; distance: number; gap: number; centerDistance: number; anchorDifference: number; anchor: number; target: CanvasAlignmentNode };

// ACT: 按节点大小的网格逐圈探测，最多比较 625 格；更远的空位不找，全满时退回原点由用户拖开。
export function findOpenPosition(origin: { x: number; y: number }, occupied: readonly AlignmentBounds[], size = { width: 360, height: 220 }, gap = 40) {
  const isFree = (x: number, y: number) => !occupied.some(item => x < item.x + item.width + gap && x + size.width + gap > item.x && y < item.y + item.height + gap && y + size.height + gap > item.y);
  for (let ring = 0; ring <= 12; ring++) {
    const cells: { x: number; y: number }[] = [];
    for (let row = -ring; row <= ring; row++) for (let column = -ring; column <= ring; column++) {
      if (Math.max(Math.abs(column), Math.abs(row)) === ring) cells.push({ x: origin.x + column * (size.width + gap), y: origin.y + row * (size.height + gap) });
    }
    // 画布从左向右连线，同圈内优先放在同一行的右侧。
    cells.sort((left, right) => Math.abs(left.y - origin.y) - Math.abs(right.y - origin.y) || right.x - left.x || right.y - left.y);
    const open = cells.find(cell => isFree(cell.x, cell.y));
    if (open) return open;
  }
  return origin;
}

/** 输入均为本帧拟移动后的画布绝对左上矩形；返回统一位移，不修改父子关系或任何输入。 */
export function getCanvasAlignment({ nodes, movingIds, zoom, thresholdPx = 6, maxGapPx = 240 }: {
  nodes: readonly CanvasAlignmentNode[];
  movingIds: Iterable<string>;
  zoom: number;
  thresholdPx?: number;
  maxGapPx?: number;
}): CanvasAlignmentResult {
  const empty: CanvasAlignmentResult = { dx: 0, dy: 0, guides: [] };
  if (!Number.isFinite(zoom) || zoom <= 0 || !Number.isFinite(thresholdPx) || thresholdPx < 0 || !Number.isFinite(maxGapPx) || maxGapPx < 0) return empty;
  const byId = new Map(nodes.map(node => [node.id, node])), moving = new Set(movingIds);
  function ancestors(node: CanvasAlignmentNode) {
    const ids = new Set([node.id]);
    let parentId = node.parentId;
    while (parentId && !ids.has(parentId)) {
      ids.add(parentId);
      parentId = byId.get(parentId)?.parentId;
    }
    ids.delete(node.id);
    return ids;
  }
  function measurable(node: CanvasAlignmentNode) {
    return node.hidden !== true && ![...ancestors(node)].some(id => byId.get(id)?.hidden === true) && node.width > 0 && node.height > 0
      && [node.x, node.y, node.width, node.height, node.x + node.width, node.y + node.height].every(Number.isFinite);
  }
  const roots = nodes.filter(node => moving.has(node.id) && measurable(node) && ![...ancestors(node)].some(id => moving.has(id)));
  if (!roots.length) return empty;
  const excluded = new Set(moving);
  for (const node of roots) for (const id of ancestors(node)) excluded.add(id);
  const left = Math.min(...roots.map(node => node.x)), top = Math.min(...roots.map(node => node.y));
  const bounds: AlignmentBounds = { x: left, y: top, width: Math.max(...roots.map(node => node.x + node.width)) - left, height: Math.max(...roots.map(node => node.y + node.height)) - top };
  const threshold = thresholdPx / zoom, maxGap = maxGapPx / zoom, padding = 6 / zoom;
  if (![bounds.width, bounds.height, threshold, maxGap, padding].every(Number.isFinite)) return empty;
  const best: Partial<Record<"x" | "y", AlignmentCandidate>> = {};
  function nearer(candidate: AlignmentCandidate, previous?: AlignmentCandidate) {
    if (!previous) return true;
    for (const key of ["distance", "gap", "anchorDifference", "centerDistance"] as const) {
      const difference = candidate[key] - previous[key];
      if (Math.abs(difference) > 0.000001) return difference < 0;
    }
    return candidate.target.id < previous.target.id || candidate.target.id === previous.target.id && candidate.anchor < previous.anchor;
  }
  // ACT: 每轴只保留一个近邻；按可见节点线性扫描，超大画布可在调用方先用视口或空间索引筛选。
  for (const target of nodes) {
    if (excluded.has(target.id) || !measurable(target) || [...ancestors(target)].some(id => moving.has(id))) continue;
    for (const axis of ["x", "y"] as const) {
      const size = axis === "x" ? "width" : "height", cross = axis === "x" ? "y" : "x", crossSize = axis === "x" ? "height" : "width";
      const gap = Math.max(0, target[cross] - bounds[cross] - bounds[crossSize], bounds[cross] - target[cross] - target[crossSize]);
      if (gap > maxGap) continue;
      const centerDistance = Math.abs(bounds[cross] + bounds[crossSize] / 2 - target[cross] - target[crossSize] / 2);
      for (let from = 0; from < 3; from++) for (let to = 0; to < 3; to++) {
        const anchor = target[axis] + target[size] * (to / 2), delta = anchor - bounds[axis] - bounds[size] * (from / 2), distance = Math.abs(delta);
        if (distance > threshold) continue;
        const candidate = { delta, distance, gap, centerDistance, anchorDifference: from === to ? 0 : 1, anchor, target };
        if (nearer(candidate, best[axis])) best[axis] = candidate;
      }
    }
  }
  const dx = best.x?.delta ?? 0, dy = best.y?.delta ?? 0, guides: CanvasAlignmentGuide[] = [];
  for (const axis of ["x", "y"] as const) {
    const candidate = best[axis];
    if (!candidate) continue;
    const cross = axis === "x" ? "y" : "x", crossSize = axis === "x" ? "height" : "width", offset = axis === "x" ? dy : dx;
    const start = bounds[cross] + offset, end = start + bounds[crossSize];
    guides.push({ axis, position: candidate.anchor,
      start: Math.min(start, Math.max(candidate.target[cross], start - maxGap)) - padding,
      end: Math.max(end, Math.min(candidate.target[cross] + candidate.target[crossSize], end + maxGap)) + padding,
      targetId: candidate.target.id });
  }
  return { dx, dy, guides };
}
