/**
 * Copyright 2026 Sam Wasserman (wassermanproductions.com).
 * SPDX-License-Identifier: Apache-2.0
 * Source: https://github.com/wassermanproductions/blockout/blob/3f2d0564fd575f70fc28e9bfaa7e94b05e3955d9/src/engine/sequences.ts
 * Modified 2026-10-22: camelCase catalogs, explicit input/window validation and non-truncating 2000-mark budgets.
 * Original LICENSE and NOTICE are reproduced in ../../readme.md.
 */
/** Deterministic group marks; each generated performer remains individually editable. */

import { motionPresets, type MotionPreset } from './motions'

export type SequenceType = 'dance' | 'fight' | 'footChase' | 'carChase'

export interface SequenceOptions {
  type: SequenceType
  /** Exact performer count: integer 2–60; invalid values are rejected. */
  count: number
  /**
   * Per type: dance → a dance MotionPreset id or 'mixed'; fight → 'paired'
   * or 'mob'; footChase → 'straight' or 'weaving'; carChase → 'straight' or
   * 'weaving'.
   */
  style: string
  /** Where to stage it and which way the sequence faces/travels. */
  origin: { x: number; z: number; heading: number }
  /** Shot seconds (0.2–300); entrances beyond it remain explicit static waits. */
  duration: number
}

export interface SequenceMarkSpec {
  time: number
  position: { x: number; y: number; z: number }
  gait: 'walk' | 'jog' | 'run' | 'stand'
  easeIn: number
  easeOut: number
  hold: number
  joints?: Record<string, number>
}

export interface SequenceEntitySpec {
  assetId: string
  name: string
  position: { x: number; y: number; z: number }
  rotationY: number
  label?: { text: string; color: string }
  marks: SequenceMarkSpec[]
  /** Present only for an empty track whose original entrance is after the window. */
  delayedUntil?: number
}

/** The native document budget; exceeding it rejects the whole generation. */
const maxMarksPerEntity = 2000

function requireCoordinate(value: number, label: string): void {
  if (!Number.isFinite(value) || Math.abs(value) > 100000) throw new Error(`${label}须为-100000到100000之间的有限数值`)
}

function requirePosition(position: { x: number; y: number; z: number }): void {
  if (!position) throw new Error('编排位置不存在')
  for (const axis of ['x', 'y', 'z'] as const) requireCoordinate(position[axis], `编排位置${axis}`)
}

function requireDuration(duration: number): void {
  if (!Number.isFinite(duration) || duration < 0.2 || duration > 300) throw new Error('群组编排时域须为0.2–300秒')
}

function validateMarks(marks: SequenceMarkSpec[], end: number, performer: string, start = 0, allowEmpty = false): void {
  if (!marks.length && !allowEmpty) throw new Error(`${performer}在编排时窗内没有真实标记`)
  if (marks.length > maxMarksPerEntity) throw new Error(`${performer}超过每人2000标记上限；请缩短时长或选择其他动作，不截尾`)
  for (const [index, mark] of marks.entries()) {
    if (!Number.isFinite(mark.time) || mark.time < start || mark.time > end || index > 0 && mark.time <= marks[index - 1]!.time) throw new Error(`${performer}的标记须在${start}–${end}秒内严格递增；请调整时长，不裁剪或合并近点`)
    requirePosition(mark.position)
    if (!['walk', 'jog', 'run', 'stand'].includes(mark.gait)) throw new Error(`${performer}的步态无效`)
    if (![mark.hold, mark.easeIn, mark.easeOut].every(Number.isFinite) || mark.hold < 0 || mark.hold > 300 || mark.easeIn < 0 || mark.easeIn > 1 || mark.easeOut < 0 || mark.easeOut > 1) throw new Error(`${performer}的停留或缓动参数无效`)
    for (const [key, value] of Object.entries(mark.joints ?? {})) requireCoordinate(value, `关节${key}`)
  }
}

/** Rotate a local offset (right = +lx, forward = +lz) into world space. */
function place(
  origin: { x: number; z: number; heading: number },
  lx: number,
  lz: number
): { x: number; z: number } {
  const cos = Math.cos(origin.heading)
  const sin = Math.sin(origin.heading)
  // right(θ) = (cosθ, 0, -sinθ); forward(θ) = (-sinθ, 0, -cosθ)
  return {
    x: origin.x + lx * cos - lz * sin,
    z: origin.z - lx * sin - lz * cos
  }
}

/** Deterministic per-index jitter in [-1, 1]. */
const jitter = (i: number, salt: number): number => Math.sin(i * 12.9898 + salt * 78.233) % 1

function dancePresets(): MotionPreset[] {
  return motionPresets.filter((p) => p.category === 'dance')
}

function fightPresets(ids: string[], fallback: string[]): MotionPreset[] {
  const found = ids
    .map((id) => motionPresets.find((p) => p.id === id))
    .filter((p): p is MotionPreset => !!p)
  if (found.length > 0) return found
  return fallback
    .map((id) => motionPresets.find((p) => p.id === id))
    .filter((p): p is MotionPreset => !!p)
}

/**
 * Lay a motion's keyframes down as joint marks starting at `startT`,
 * looping to fill the window. Keyframe `move` offsets (jumps, crawls) are
 * applied relative to `pos` along `heading`. Returns the time it finished.
 */
function appendMotion(
  marks: SequenceMarkSpec[],
  preset: MotionPreset,
  pos: { x: number; y: number; z: number },
  startT: number,
  endT: number,
  heading = 0
): number {
  if (!Number.isFinite(preset.duration) || preset.duration <= 0 || !preset.keyframes.length) throw new Error(`动作${preset.id}缺少有效时长或关键帧`)
  let t = startT
  const cycle = preset.duration + (preset.loop ? 0.05 : 0.4)
  const fwd = { x: -Math.sin(heading), z: -Math.cos(heading) }
  while (t <= endT || t - endT <= 1e-9) {
    for (const kf of preset.keyframes) {
      let time = t + kf.t
      if (time > endT) {
        if (time - endT > 1e-9) break
        // ACT: normalize only floating-point overshoot at this explicit window
        // endpoint. Nearby interior marks are never merged or resampled.
        time = endT
      }
      if (marks.length >= maxMarksPerEntity) throw new Error(`动作${preset.id}超过每人2000标记上限；请缩短时长或选择其他动作，不截尾`)
      const forward = kf.move?.forward ?? 0
      const up = kf.move?.up ?? 0
      marks.push({
        time,
        position: {
          x: pos.x + fwd.x * forward,
          y: Math.max(0, pos.y + up),
          z: pos.z + fwd.z * forward
        },
        gait: 'stand',
        easeIn: 0,
        easeOut: 0,
        hold: 0,
        joints: { ...kf.joints }
      })
    }
    if (!preset.loop && t + cycle + preset.duration - endT > 1e-9) break
    t += cycle
  }
  return t
}

// Dance

function danceSequence(opts: SequenceOptions): SequenceEntitySpec[] {
  const count = opts.count
  const styles = dancePresets()
  if (!styles.length) throw new Error('舞蹈动作库为空，不能生成群组')
  const chosen = opts.style === 'mixed' ? null : styles.find((p) => p.id === opts.style)
  const out: SequenceEntitySpec[] = []
  const cols = Math.min(6, Math.ceil(Math.sqrt(count * 1.4)))
  for (let i = 0; i < count; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    const rowWidth = Math.min(cols, count - row * cols)
    const lx = (col - (rowWidth - 1) / 2) * 1.8 + jitter(i, 1) * 0.15
    const lz = -row * 2.0 + jitter(i, 2) * 0.15
    const pos3 = place(opts.origin, lx, lz)
    const preset = chosen ?? styles[i % styles.length]!
    const marks: SequenceMarkSpec[] = []
    // Ripple: back rows start a beat later — reads as staged choreography.
    const ripple = row * 0.12
    appendMotion(marks, preset, { x: pos3.x, y: 0, z: pos3.z }, ripple, opts.duration)
    out.push({
      assetId: i % 2 === 0 ? 'person.man' : 'person.woman',
      name: `Dancer ${i + 1}`,
      position: { x: pos3.x, y: 0, z: pos3.z },
      rotationY: opts.origin.heading,
      marks,
      ...(!marks.length ? { delayedUntil: ripple } : {})
    })
  }
  return out
}

// Fight

function fightSequence(opts: SequenceOptions): SequenceEntitySpec[] {
  const count = opts.count
  const strikes = fightPresets(
    ['jab-cross', 'roundhouse-kick', 'haymaker', 'uppercut', 'front-kick-combo', 'high-kick'],
    ['jab-cross', 'haymaker', 'uppercut', 'high-kick']
  )
  const reactions = fightPresets(
    ['hit-reaction-head', 'hit-reaction-body', 'stumble-back-fall', 'block-and-dodge'],
    ['block-and-dodge', 'knocked-down']
  )
  if (!strikes.length || !reactions.length) throw new Error('打斗动作库不完整，不能生成群组')
  const out: SequenceEntitySpec[] = []

  if (opts.style === 'mob') {
    // One defender in the middle, everyone else circles in and strikes.
    const center = place(opts.origin, 0, 0)
    const defender: SequenceEntitySpec = {
      assetId: 'person.man',
      name: 'Defender',
      position: { x: center.x, y: 0, z: center.z },
      rotationY: opts.origin.heading,
      label: { text: 'HERO', color: '#3b82f6' },
      marks: []
    }
    // Dodges through most of it, goes down near the end.
    const dodge = reactions.find((p) => p.id === 'block-and-dodge') ?? reactions[0]
    const fall =
      reactions.find((p) => p.id === 'stumble-back-fall') ??
      fightPresets(['knocked-down'], ['knocked-down'])[0]
    if (dodge) {
      const downAt = Math.min(opts.duration, Math.max(1, opts.duration - (fall?.duration ?? 1.5) - 0.2))
      appendMotion(defender.marks, dodge, defender.position, 0, downAt)
      if (fall && downAt + 0.1 < opts.duration) appendMotion(defender.marks, fall, defender.position, downAt + 0.1, opts.duration)
    }
    out.push(defender)
    for (let i = 1; i < count; i++) {
      const angle = (i / (count - 1)) * Math.PI * 2
      const r = 1.5 + (i % 3) * 0.7
      const pos = place(opts.origin, Math.sin(angle) * r, Math.cos(angle) * r)
      const facing = Math.atan2(-(center.x - pos.x), -(center.z - pos.z))
      const strike = strikes[i % strikes.length]!
      const marks: SequenceMarkSpec[] = []
      const attackAt = (i - 1) * 0.35
      appendMotion(marks, strike, { x: pos.x, y: 0, z: pos.z }, attackAt, opts.duration)
      out.push({
        assetId: i % 2 === 0 ? 'person.man' : 'person.woman',
        name: `Attacker ${i}`,
        position: { x: pos.x, y: 0, z: pos.z },
        rotationY: facing,
        marks,
        ...(!marks.length ? { delayedUntil: attackAt } : {})
      })
    }
    return out
  }

  // Paired brawl: clusters of duels scattered around the origin.
  const pairs = Math.floor(count / 2)
  for (let p = 0; p < pairs; p++) {
    const clusterAngle = p * 2.399963 // golden angle — even, non-grid scatter
    const clusterR = p === 0 ? 0 : 1.6 + 1.35 * Math.sqrt(p)
    const cx = Math.sin(clusterAngle) * clusterR
    const cz = Math.cos(clusterAngle) * clusterR
    // Each duel fights along its own local axis so the brawl reads chaotic.
    const duelAxis = jitter(p, 3) * Math.PI
    const half = 0.7
    const a = place(opts.origin, cx + Math.sin(duelAxis) * half, cz + Math.cos(duelAxis) * half)
    const b = place(opts.origin, cx - Math.sin(duelAxis) * half, cz - Math.cos(duelAxis) * half)
    const faceAB = Math.atan2(-(b.x - a.x), -(b.z - a.z))
    const faceBA = faceAB + Math.PI
    const strike = strikes[p % strikes.length]!
    const reaction = reactions[p % reactions.length]!
    const offset = (p % 4) * 0.3

    const attacker: SequenceEntitySpec = {
      assetId: p % 2 === 0 ? 'person.man' : 'person.woman',
      name: `Fighter ${p * 2 + 1}`,
      position: { x: a.x, y: 0, z: a.z },
      rotationY: faceAB,
      marks: []
    }
    appendMotion(attacker.marks, strike, attacker.position, offset, opts.duration)
    if (!attacker.marks.length) attacker.delayedUntil = offset

    const defender: SequenceEntitySpec = {
      assetId: p % 2 === 0 ? 'person.woman' : 'person.man',
      name: `Fighter ${p * 2 + 2}`,
      position: { x: b.x, y: 0, z: b.z },
      rotationY: faceBA,
      marks: []
    }
    // Reactions land a beat after the strikes start.
    const reactionAt = offset + strike.duration * 0.5
    appendMotion(defender.marks, reaction, defender.position, reactionAt, opts.duration)
    if (!defender.marks.length) defender.delayedUntil = reactionAt
    out.push(attacker, defender)
  }
  // Odd one out spectates, cheering.
  if (count % 2 === 1) {
    const pos = place(opts.origin, 0, 2.5)
    const cheer = fightPresets(['cheer-jump', 'arms-up-party'], ['arms-up-party'])[0]
    const spectator: SequenceEntitySpec = {
      assetId: 'person.man',
      name: 'Spectator',
      position: { x: pos.x, y: 0, z: pos.z },
      rotationY: opts.origin.heading + Math.PI,
      marks: []
    }
    if (cheer) appendMotion(spectator.marks, cheer, spectator.position, 0.5, opts.duration)
    if (!spectator.marks.length) spectator.delayedUntil = 0.5
    out.push(spectator)
  }
  return out
}

// Foot chase

function footChaseSequence(opts: SequenceOptions): SequenceEntitySpec[] {
  const count = opts.count
  const runSpeed = 5.2
  const length = Math.min(70, runSpeed * opts.duration * 0.9)
  const weaving = opts.style === 'weaving'
  const out: SequenceEntitySpec[] = []
  for (let i = 0; i < count; i++) {
    // Leader out front; pursuers in a staggered wedge behind.
    const backset = i === 0 ? 0 : 2.2 + i * 1.6
    const lateral = i === 0 ? 0 : jitter(i, 4) * 1.6
    const startL = place(opts.origin, lateral, -0 - backset)
    const marks: SequenceMarkSpec[] = []
    const steps = 5
    for (let s2 = 0; s2 <= steps; s2++) {
      const f = s2 / steps
      const along = f * length - backset
      const wob = weaving ? Math.sin(f * Math.PI * 2 + i * 0.9) * 2.2 : 0
      const p = place(opts.origin, lateral + wob, along)
      marks.push({
        time: f * opts.duration,
        position: { x: s2 === 0 ? startL.x : p.x, y: 0, z: s2 === 0 ? startL.z : p.z },
        gait: 'run',
        easeIn: s2 === steps ? 0.25 : 0,
        easeOut: s2 === 0 ? 0.25 : 0,
        hold: 0
      })
    }
    out.push({
      assetId: i % 2 === 0 ? 'person.man' : 'person.woman',
      name: i === 0 ? 'Runner' : `Pursuer ${i}`,
      position: { x: startL.x, y: 0, z: startL.z },
      rotationY: opts.origin.heading,
      label: i === 0 ? { text: 'RUNNER', color: '#e5484d' } : undefined,
      marks
    })
  }
  return out
}

// Car chase

const chaseCars = ['vehicle.sedan', 'vehicle.suv', 'vehicle.pickup', 'vehicle.van']

function carChaseSequence(opts: SequenceOptions): SequenceEntitySpec[] {
  const count = opts.count
  const speed = 17
  const length = Math.min(160, speed * opts.duration * 0.9)
  const weaving = opts.style === 'weaving'
  const out: SequenceEntitySpec[] = []
  for (let i = 0; i < count; i++) {
    const backset = i * 7.5
    const lane = i === 0 ? 0 : ((i % 3) - 1) * 2.6
    const start = place(opts.origin, lane, -backset)
    const marks: SequenceMarkSpec[] = []
    const steps = 5
    for (let s2 = 0; s2 <= steps; s2++) {
      const f = s2 / steps
      const along = f * length - backset
      const wob = weaving ? Math.sin(f * Math.PI * 2.5 + i * 1.3) * 2.8 : lane * (1 - f * 0.3)
      const p = place(opts.origin, i === 0 && !weaving ? 0 : wob, along)
      marks.push({
        time: f * opts.duration,
        position: { x: s2 === 0 ? start.x : p.x, y: 0, z: s2 === 0 ? start.z : p.z },
        gait: 'run',
        easeIn: 0,
        easeOut: s2 === 0 ? 0.25 : 0,
        hold: 0
      })
    }
    out.push({
      assetId: chaseCars[i % chaseCars.length]!,
      name: i === 0 ? 'Lead car' : `Chase car ${i}`,
      position: { x: start.x, y: 0, z: start.z },
      rotationY: opts.origin.heading,
      label: i === 0 ? { text: 'LEAD', color: '#e5484d' } : undefined,
      marks
    })
  }
  return out
}

/** Styles offered per sequence type (dance styles come from the library). */
export function sequenceStyles(type: SequenceType): { id: string; name: string }[] {
  switch (type) {
    case 'dance':
      return [
        { id: 'mixed', name: 'Mixed styles' },
        ...dancePresets().map((p) => ({ id: p.id, name: p.name }))
      ]
    case 'fight':
      return [
        { id: 'paired', name: 'Paired brawl' },
        { id: 'mob', name: 'Mob vs one' }
      ]
    case 'footChase':
    case 'carChase':
      return [
        { id: 'straight', name: 'Straight pursuit' },
        { id: 'weaving', name: 'Weaving' }
      ]
  }
  throw new Error('群组编排类型须为dance、fight、footChase或carChase')
}

/**
 * Choreograph ONE performer with a motion preset at a fixed spot — used to
 * restyle already-staged performers (swap the dance, change the strike)
 * without restaging the crowd. Returns null for unknown preset ids.
 */
export function choreographMotion(
  presetId: string,
  pos: { x: number; y: number; z: number },
  heading: number,
  duration: number,
  startT = 0
): SequenceMarkSpec[] | null {
  requirePosition(pos)
  requireCoordinate(heading, '人物朝向')
  requireDuration(duration)
  if (!Number.isFinite(startT) || startT < 0 || startT >= duration) throw new Error('原地动作起点须在0秒到编排终点之前；duration为窗口终点，不是长度')
  const preset = motionPresets.find((p) => p.id === presetId)
  if (!preset) return null
  const marks: SequenceMarkSpec[] = []
  appendMotion(marks, preset, pos, startT, duration, heading)
  validateMarks(marks, duration, preset.name, startT)
  return marks
}

export function generateSequence(opts: SequenceOptions): SequenceEntitySpec[] {
  if (!opts) throw new Error('群组编排参数不存在')
  requireDuration(opts.duration)
  if (!Number.isInteger(opts.count) || opts.count < 2 || opts.count > 60) throw new Error('群组人数须为2–60之间的整数，不自动截断或舍入')
  if (!opts.origin) throw new Error('请明确群组编排原点和朝向')
  for (const key of ['x', 'z', 'heading'] as const) requireCoordinate(opts.origin[key], `群组原点${key}`)
  if (!sequenceStyles(opts.type).some(style => style.id === opts.style)) throw new Error('群组风格不存在，请从sequenceStyles读取当前类型的真实ID')
  let entities: SequenceEntitySpec[]
  switch (opts.type) {
    case 'dance':
      entities = danceSequence(opts)
      break
    case 'fight':
      entities = fightSequence(opts)
      break
    case 'footChase':
      entities = footChaseSequence(opts)
      break
    case 'carChase':
      entities = carChaseSequence(opts)
      break
  }
  if (entities.length !== opts.count) throw new Error('生成角色数量与请求不符，未发布部分群组')
  // ACT: empty delayed tracks are static waiting entities, as in the original
  // store's marks.length gate. Preserve every requested entity; adapters must
  // not create a track or claim a performance for these waiting roles.
  for (const entity of entities) {
    requirePosition(entity.position)
    requireCoordinate(entity.rotationY, `${entity.name}朝向`)
    if (!entity.marks.length && (!Number.isFinite(entity.delayedUntil) || entity.delayedUntil! <= opts.duration)) throw new Error(`${entity.name}缺少有效的静态待场起点`)
    validateMarks(entity.marks, opts.duration, entity.name, 0, true)
  }
  return entities
}
