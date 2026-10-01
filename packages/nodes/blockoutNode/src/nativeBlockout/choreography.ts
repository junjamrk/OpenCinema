/**
 * Copyright 2026 Sam Wasserman (wassermanproductions.com).
 * SPDX-License-Identifier: Apache-2.0
 * Source: https://github.com/wassermanproductions/blockout/blob/3f2d0564fd575f70fc28e9bfaa7e94b05e3955d9/src/engine/choreography.ts
 * Modified 2026-10-22: strict budgets, complete bounded motifs and root continuation.
 * Short windows retime every source keyframe; no motion is silently truncated.
 * Timing/root continuation repairs change upstream seeded results. Determinism is guaranteed
 * within this implementation, not byte parity with the upstream scheduler.
 * Original LICENSE and NOTICE are reproduced in ../../readme.md.
 */
/** Seeded routines produce editable performer marks; see motions.ts for joint conventions. */

import { motionPresets, type MotionPreset } from './motions'
import type { GaitId } from './types'

export type ChoreoKind = 'dance' | 'fight' | 'chase'
export type FormationId = 'line' | 'twoRows' | 'vShape' | 'circle' | 'diamond'
export type DanceStyle = 'hiphop' | 'party' | 'latin' | 'robot' | 'mixed'
export type FightStyle = 'brawl' | 'martial-arts' | 'sparring'
export type FightEnding = 'sparring' | 'finish'
export type ChaseEnding = 'caught' | 'escape'

export interface RoutineSpec {
  kind: ChoreoKind
  /** Integer performers: dance 1–40, fight 2–8, chase 2–6. */
  performers: number
  /** Shot seconds to fill, 0.2–300 inclusive. */
  durationS: number
  /** Uint32 PRNG seed — same validated spec + context gives identical marks. */
  seed: number
  /** Dance tempo (beats/min). Default 116; fights use `beatDur`. */
  bpm?: number
  /** Explicit fight beat length (s, default 0.55); chase uses seeded time fractions. */
  beatDur?: number
  /** Dance vocabulary / fight style. */
  style?: DanceStyle | FightStyle | string
  /** Dance starting formation. */
  formation?: FormationId
  /** Dance wave: at most half of each move window is used for canon delay. */
  canon?: boolean
  /** Dance: odd performers mirrored (fight: mirror stances). */
  mirror?: boolean
  /** Dance: walk to a fresh formation between phrases. */
  formationChange?: boolean
  /** Fight: 'sparring' (loser gets up) | 'finish' (stays down).
   *  Chase: 'caught' | 'escape'. */
  ending?: FightEnding | ChaseEnding | string
  /** Chase serpentine sideways amplitude (m). Default 4. */
  amplitude?: number
}

export interface RoutineCtx {
  /** Where to stage it and which way the group faces/travels. */
  origin: { x: number; z: number; heading: number }
}

/** A single blocking mark for one performer (superset of the sequence mark). */
export interface ChoreoMarkSpec {
  time: number
  position: { x: number; y: number; z: number }
  gait: GaitId
  easeIn: number
  easeOut: number
  hold: number
  joints?: Record<string, number>
  /** Face this heading at/through this mark; else travel heading is used. */
  arriveHeading?: number
}

export interface ChoreoEntitySpec {
  assetId: string
  name: string
  position: { x: number; y: number; z: number }
  rotationY: number
  label?: { text: string; color: string }
  marks: ChoreoMarkSpec[]
}

const maxMarksPerEntity = 2000
const spacing = 1.4
const fightRange = 1.2

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Rng = () => number
const pick = <T>(rng: Rng, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length) % arr.length]!
const randInt = (rng: Rng, lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1))

/** Rotate a local offset (right=+lx, forward=+lz) into world space. */
function place(
  origin: { x: number; z: number; heading: number },
  lx: number,
  lz: number
): { x: number; z: number } {
  const cos = Math.cos(origin.heading)
  const sin = Math.sin(origin.heading)
  return { x: origin.x + lx * cos - lz * sin, z: origin.z - lx * sin - lz * cos }
}

/** Heading that makes an entity at `from` face `to` (0 faces −Z). */
function facingTo(from: { x: number; z: number }, to: { x: number; z: number }): number {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z))
}

/** Forward unit vector for a heading (0 faces −Z). */
function forwardOf(heading: number): { x: number; z: number } {
  return { x: -Math.sin(heading), z: -Math.cos(heading) }
}

const dist2 = (a: { x: number; z: number }, b: { x: number; z: number }): number =>
  Math.hypot(a.x - b.x, a.z - b.z)

const byId: Map<string, MotionPreset> = new Map(motionPresets.map((p) => [p.id, p]))
const motion = (id: string): MotionPreset | undefined => byId.get(id)

/** First existing id from a preference list (lets vocab tolerate renames). */
function firstOf(ids: readonly string[]): MotionPreset | undefined {
  for (const id of ids) {
    const m = byId.get(id)
    if (m) return m
  }
  return undefined
}

/** L/R joint pairs swapped when mirroring a pose. */
const lrPairs: readonly [string, string][] = [
  ['shoulderLX', 'shoulderRX'],
  ['shoulderLZ', 'shoulderRZ'],
  ['elbowL', 'elbowR'],
  ['hipLX', 'hipRX'],
  ['hipLZ', 'hipRZ'],
  ['kneeL', 'kneeR']
]
/** Twist/lean channels whose sign flips under a mirror. */
const negateOnMirror = new Set(['torsoY', 'headY', 'torsoZ', 'headZ'])

/**
 * Mirror a pose: swap L/R joint values and negate the twist/lean channels so a
 * mirrored performer is the visual reflection of the original.
 */
export function mirrorJoints(joints: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = { ...joints }
  for (const [l, r] of lrPairs) {
    const lv = joints[l]
    const rv = joints[r]
    if (lv !== undefined) out[r] = lv
    if (rv !== undefined) out[l] = rv
    if (lv === undefined) delete out[r]
    if (rv === undefined) delete out[l]
  }
  for (const k of negateOnMirror) if (out[k] !== undefined) out[k] = -out[k]
  return out
}

interface PlayOpts {
  facing?: number
  mirror?: boolean
  gait?: GaitId
  rootForward?: boolean
}

/**
 * Exact same-time events are a hand-off: the later writer owns that whole
 * mark. Any positive time difference is retained, including less than 1e-4 s.
 * ACT: bounded linear lookup (at most 2000 marks/person), no second time index.
 */
function appendMark(marks: ChoreoMarkSpec[], mark: ChoreoMarkSpec): void {
  const index = marks.findIndex((current) => current.time === mark.time)
  if (index >= 0) {
    marks[index] = mark
    return
  }
  if (marks.length >= maxMarksPerEntity) throw new Error('群组编舞每人最多 2000 个时点；未返回部分结果')
  marks.push(mark)
}

/** Full source motion, affinely retimed into one explicit closed window. */
function playMotion(
  marks: ChoreoMarkSpec[],
  preset: MotionPreset,
  pos: { x: number; y: number; z: number },
  startT: number,
  endT: number,
  opts: PlayOpts = {}
): void {
  if (!(endT > startT) || !Number.isFinite(endT - startT)) throw new Error('动作窗口须为有限正时长')
  const fwd = opts.facing !== undefined ? forwardOf(opts.facing) : { x: 0, z: 0 }
  let previousTime = -Infinity
  for (let i = 0; i < preset.keyframes.length; i++) {
    const kf = preset.keyframes[i]!
    const time = i === 0 ? startT : i === preset.keyframes.length - 1
      ? endT : startT + (endT - startT) * (kf.t / preset.duration)
    if (!Number.isFinite(time) || time <= previousTime || time < startT || time > endT) {
      throw new Error('动作窗口精度不足以保留完整关键帧；未合并近时点或返回部分结果')
    }
    previousTime = time
    const forward = opts.rootForward === false ? 0 : kf.move?.forward ?? 0
    appendMark(marks, {
      time,
      position: {
        x: pos.x + fwd.x * forward,
        y: Math.max(0, pos.y + (kf.move?.up ?? 0)),
        z: pos.z + fwd.z * forward
      },
      gait: opts.gait ?? 'stand',
      easeIn: 0, easeOut: 0, hold: 0,
      joints: opts.mirror ? mirrorJoints(kf.joints) : { ...kf.joints },
      arriveHeading: opts.facing
    })
  }
}

/**
 * Natural full cycles followed by a complete retimed final cycle. Short tail
 * windows speed up a whole cycle rather than dropping its later keyframes.
 */
function playLooped(
  marks: ChoreoMarkSpec[],
  preset: MotionPreset,
  pos: { x: number; y: number; z: number },
  startT: number,
  endT: number,
  opts: PlayOpts = {}
): void {
  let t = startT
  while (t < endT) {
    const next = Math.min(endT, t + preset.duration)
    if (!(next > t)) throw new Error('动作循环时钟未推进')
    // Upstream loops stay rooted in X/Z; their altitude/joints still animate.
    playMotion(marks, preset, pos, t, next, { ...opts, rootForward: false })
    t = next
  }
}

function requireMotion(id: string): MotionPreset {
  const preset = motion(id)
  if (!preset) throw new Error(`编舞动作不存在：${id}`)
  return preset
}

/** Hold an actual completed pose, not a substitute for playing its motion. */
function holdPose(fighter: Fighter, startT: number, endT: number): void {
  const last = fighter.marks[fighter.marks.length - 1]
  if (!last) throw new Error('编舞缺少可保持的完整姿态')
  for (const time of [startT, endT]) appendMark(fighter.marks, {
    ...last, time, position: { ...last.position },
    joints: last.joints ? { ...last.joints } : undefined,
    hold: 0
  })
}

// Dance

const danceVocab: Record<DanceStyle, string[]> = {
  hiphop: ['top-rock', 'running-man', 'shuffle-step', 'dab', 'floss-dance', 'body-roll', 'chest-pop', 'c-walk'],
  party: ['groove-loop', 'arms-up-party', 'disco-point', 'shoulder-bounce', 'raise-the-roof', 'clap-groove', 'macarena', 'shopping-cart'],
  latin: ['salsa-step', 'hip-sway-groove', 'two-step', 'grapevine', 'charleston', 'slow-sway-partner'],
  robot: ['robot', 'robot-wave', 'arm-wave', 'vogue-frames', 'chest-pop', 'dab'],
  mixed: ['groove-loop', 'top-rock', 'salsa-step', 'robot', 'running-man', 'hip-sway-groove', 'shuffle-step', 'disco-point', 'body-roll', 'two-step']
}
const freezeMoves = ['spin-freeze', 'breakdance-freeze', 'vogue-frames', 'dab']

const formationOrder: FormationId[] = ['line', 'twoRows', 'vShape', 'diamond', 'circle']

/** Local (right, forward) formation positions for n performers, spacing 1.4m. */
function formationPositions(id: FormationId, n: number): { lx: number; lz: number }[] {
  const out: { lx: number; lz: number }[] = []
  const s = spacing
  switch (id) {
    case 'line': {
      for (let i = 0; i < n; i++) out.push({ lx: (i - (n - 1) / 2) * s, lz: 0 })
      break
    }
    case 'twoRows': {
      const front = Math.ceil(n / 2)
      for (let i = 0; i < n; i++) {
        const row = i < front ? 0 : 1
        const idxInRow = i < front ? i : i - front
        const rowN = row === 0 ? front : n - front
        out.push({ lx: (idxInRow - (rowN - 1) / 2) * s, lz: -row * s * 1.4 })
      }
      break
    }
    case 'vShape': {
      // Alternate arms of a V opening toward the front (−lz), apex at back.
      for (let i = 0; i < n; i++) {
        const rank = Math.floor(i / 2) + 1
        const side = i % 2 === 0 ? -1 : 1
        out.push({ lx: side * rank * s * 0.8, lz: -rank * s * 0.8 + n * 0.05 })
      }
      break
    }
    case 'diamond': {
      // Ring on a rotated square perimeter.
      const r = s * (0.9 + n * 0.11)
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + Math.PI / 4
        out.push({ lx: Math.cos(a) * r, lz: Math.sin(a) * r })
      }
      break
    }
    case 'circle': {
      const r = Math.max(s, (s * n) / (2 * Math.PI))
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2
        out.push({ lx: Math.sin(a) * r, lz: -Math.cos(a) * r })
      }
      break
    }
  }
  return out
}

function danceRoutine(spec: RoutineSpec, ctx: RoutineCtx): ChoreoEntitySpec[] {
  const rng = mulberry32(spec.seed)
  const n = spec.performers
  const phraseDur = 8 * 60 / (spec.bpm ?? 116)
  const facing = ctx.origin.heading
  const vocab = danceVocab[(spec.style ?? 'mixed') as DanceStyle].filter((id) => byId.has(id))
  if (!vocab.length) throw new Error('舞蹈词表为空')
  const startFormation = spec.formation ?? 'line'
  let currentPos = formationPositions(startFormation, n)
  const nPhrases = Math.ceil(spec.durationS / phraseDur)
  const marks: ChoreoMarkSpec[][] = Array.from({ length: n }, () => [])
  const world = (slot: { lx: number; lz: number }): { x: number; y: number; z: number } => {
    const p = place(ctx.origin, slot.lx, slot.lz)
    return { x: p.x, y: 0, z: p.z }
  }
  let formStep = 0
  for (let ph = 0; ph < nPhrases; ph++) {
    const phraseStart = ph * phraseDur
    const phraseEnd = ph === nPhrases - 1 ? spec.durationS : (ph + 1) * phraseDur
    const localBeat = (phraseEnd - phraseStart) / 8
    let countsFilled = 0
    if (spec.formationChange && ph > 0 && n > 1) {
      formStep++
      const nextPos = formationPositions(formationOrder[formStep % formationOrder.length]!, n)
      const walkEnd = phraseStart + 4 * localBeat
      const arrival = walkEnd - Math.min(0.06, localBeat * 0.25)
      for (let i = 0; i < n; i++) {
        const from = world(currentPos[i]!)
        const to = world(nextPos[i]!)
        const gait = dist2(from, to) > 0.05 ? 'walk' : 'stand'
        appendMark(marks[i]!, {
          time: phraseStart, position: from, gait, easeIn: 0.2, easeOut: 0.2, hold: 0
        })
        appendMark(marks[i]!, {
          time: arrival, position: to, gait, easeIn: 0.2, easeOut: 0.2, hold: 0,
          arriveHeading: facing
        })
      }
      currentPos = nextPos
      countsFilled = 4
    }
    while (countsFilled < 8) {
      const span = pick(rng, [2, 4, 8].filter((value) => value <= 8 - countsFilled))
      const finalMove = ph === nPhrases - 1 && countsFilled + span === 8
      const id = finalMove ? (freezeMoves.find((value) => byId.has(value)) ?? vocab[0]!) : pick(rng, vocab)
      const preset = requireMotion(id)
      const moveStart = phraseStart + countsFilled * localBeat
      countsFilled += span
      const moveEnd = countsFilled === 8 ? phraseEnd : phraseStart + countsFilled * localBeat
      const canonSpan = spec.canon ? Math.min((n - 1) * 2 * localBeat, (moveEnd - moveStart) / 2) : 0
      for (let i = 0; i < n; i++) {
        const delay = n === 1 ? 0 : canonSpan * i / (n - 1)
        const startT = moveStart + delay
        const pos = world(currentPos[i]!)
        if (delay > 0) {
          const previous = marks[i]![marks[i]!.length - 1]
          appendMark(marks[i]!, {
            time: moveStart, position: { ...pos }, gait: 'stand',
            easeIn: 0, easeOut: 0, hold: delay,
            joints: previous?.joints ? { ...previous.joints } : {},
            arriveHeading: facing
          })
        }
        const opts = { facing, mirror: !!spec.mirror && i % 2 === 1 }
        // A freeze is a complete final motif; it is not a lone terminal pose.
        if (finalMove) playMotion(marks[i]!, preset, pos, startT, moveEnd, opts)
        else playLooped(marks[i]!, preset, pos, startT, moveEnd, opts)
      }
    }
  }
  const start = formationPositions(startFormation, n)
  return marks.map((track, i) => ({
    assetId: i % 2 === 0 ? 'person.man' : 'person.woman',
    name: `Dancer ${i + 1}`,
    position: world(start[i]!),
    rotationY: facing,
    marks: dedupeSort(track)
  }))
}

// Fight

/** ATTACK id → ordered candidate REACTION ids (blocks first, then hits). */
const compat: Record<string, string[]> = {
  'hook-punch': ['duck-under', 'hit-reaction-head'],
  'jab-cross': ['block-high', 'weave-bob', 'hit-reaction-head'],
  'jab-hook-cross': ['block-high', 'weave-bob', 'hit-reaction-head'],
  'front-kick': ['block-low', 'hit-reaction-body', 'stagger-back'],
  'teep-push-kick': ['block-low', 'stagger-back'],
  'side-kick': ['block-low', 'stagger-back', 'hit-reaction-body'],
  'low-sweep': ['jump', 'trip-and-fall-flat'],
  haymaker: ['duck-under', 'ko-collapse'],
  'knee-strike': ['hit-reaction-body'],
  'elbow-strike': ['hit-reaction-head', 'stagger-back'],
  'roundhouse-kick': ['block-high', 'stagger-back', 'hit-reaction-head'],
  'spinning-back-kick': ['stagger-back', 'knockdown-fall'],
  'spinning-back-fist': ['duck-under', 'hit-reaction-head'],
  'tackle-lunge': ['dodge-left', 'dodge-right', 'knockdown-fall'],
  'shove-two-hands': ['stagger-back']
}

/** Reactions that are pure defense (no ground/pushback). */
const blockReactions = new Set([
  'block-high',
  'block-low',
  'parry-deflect',
  'weave-bob',
  'duck-under',
  'dodge-left',
  'dodge-right',
  'shield-brace',
  'jump'
])

/** How far a reaction shoves the defender backward (m). */
const pushback: Record<string, number> = {
  'stagger-back': 0.6,
  'knockdown-fall': 1.2,
  'ko-collapse': 1.2,
  'trip-and-fall-flat': 0.9,
  'thrown-backward': 1.5
}

const attackPool: Record<FightStyle, string[]> = {
  brawl: ['haymaker', 'hook-punch', 'shove-two-hands', 'tackle-lunge', 'elbow-strike'],
  'martial-arts': ['front-kick', 'side-kick', 'spinning-back-kick', 'knee-strike', 'low-sweep', 'roundhouse-kick'],
  sparring: ['jab-cross', 'hook-punch', 'front-kick', 'jab-hook-cross']
}
const climaxAttack: Record<FightStyle, string> = {
  brawl: 'haymaker',
  'martial-arts': 'spinning-back-kick',
  sparring: 'hook-punch'
}

interface Fighter {
  pos: { x: number; y: number; z: number }
  marks: ChoreoMarkSpec[]
}

function attackDuration(attackId: string, reactionId: string, beatDur: number): number {
  const duration = beatDur * 0.4 + Math.max(
    requireMotion(attackId).duration, beatDur * 0.35 + requireMotion(reactionId).duration
  )
  if (!Number.isFinite(duration)) throw new Error('攻击节拍时长溢出')
  return duration
}

/** One complete approach/contact/reaction slot, with a shared explicit end. */
function attackBeat(
  atk: Fighter, def: Fighter, attackId: string, reactionId: string,
  startT: number, endT: number, beatDur: number, mirror: boolean
): void {
  const attack = requireMotion(attackId)
  const react = requireMotion(reactionId)
  const nativeDuration = attackDuration(attackId, reactionId, beatDur)
  const at = (offset: number): number => offset === nativeDuration
    ? endT : startT + (endT - startT) * offset / nativeDuration
  const approach = beatDur * 0.4
  const attackStart = at(approach)
  const reactStart = at(approach + beatDur * 0.35)
  const attackEnd = at(approach + attack.duration)
  const reactEnd = at(approach + beatDur * 0.35 + react.duration)
  const toDef = facingTo(atk.pos, def.pos)
  const fwd = forwardOf(toDef)
  const previous = { ...atk.pos }
  atk.pos = { x: def.pos.x - fwd.x * fightRange, y: 0, z: def.pos.z - fwd.z * fightRange }
  const defFace = facingTo(def.pos, atk.pos)
  appendMark(atk.marks, {
    time: startT, position: previous, gait: 'walk', easeIn: 0, easeOut: 0.3, hold: 0,
    arriveHeading: toDef
  })
  const guard = firstOf(['boxing-guard-bounce', 'boxing-bounce-drill'])
  if (!guard) throw new Error('缺少防守动作')
  appendMark(def.marks, {
    time: startT, position: { ...def.pos }, gait: 'stand', easeIn: 0, easeOut: 0,
    hold: reactStart - startT, joints: { ...guard.keyframes[0]!.joints }, arriveHeading: defFace
  })
  playMotion(atk.marks, attack, atk.pos, attackStart, attackEnd, { facing: toDef, mirror })
  playMotion(def.marks, react, def.pos, reactStart, reactEnd, { facing: defFace })
  // Continue subsequent guard/approach/retreat from the completed root motion,
  // including when the attacker is the longer side and needs no hold slot.
  atk.pos = { ...atk.marks[atk.marks.length - 1]!.position }
  const push = pushback[reactionId] ?? 0
  if (push > 0) {
    // The upstream push table names a terminal offset from the reaction base;
    // do not add it again to the preset's own terminal root displacement.
    const away = forwardOf(defFace)
    def.pos = { x: def.pos.x - away.x * push, y: 0, z: def.pos.z - away.z * push }
    const last = def.marks[def.marks.length - 1]!
    appendMark(def.marks, { ...last, position: { ...def.pos } })
  } else def.pos = { ...def.marks[def.marks.length - 1]!.position }
  if (attackEnd < endT) holdPose(atk, attackEnd, endT)
  if (reactEnd < endT) holdPose(def, reactEnd, endT)
}

/** Guard loop with original circling geometry interpolated over this window. */
function guardBreather(a: Fighter, b: Fighter, startT: number, endT: number, angle: number): void {
  if (!(endT > startT)) throw new Error('防守窗口精度不足')
  const bounce = firstOf(['boxing-guard-bounce', 'boxing-bounce-drill'])
  if (!bounce) throw new Error('缺少防守动作')
  const mid = { x: (a.pos.x + b.pos.x) / 2, z: (a.pos.z + b.pos.z) / 2 }
  const rotate = (p: Fighter['pos']): Fighter['pos'] => ({
    x: mid.x + (p.x - mid.x) * Math.cos(angle) - (p.z - mid.z) * Math.sin(angle),
    y: 0,
    z: mid.z + (p.x - mid.x) * Math.sin(angle) + (p.z - mid.z) * Math.cos(angle)
  })
  const aStart = { ...a.pos }, bStart = { ...b.pos }
  a.pos = rotate(a.pos)
  b.pos = rotate(b.pos)
  for (const [fighter, from, target] of [[a, aStart, b.pos], [b, bStart, a.pos]] as const) {
    playLooped(fighter.marks, bounce, from, startT, endT, { facing: facingTo(fighter.pos, target) })
    for (const mark of fighter.marks) {
      if (mark.time < startT || mark.time > endT) continue
      const f = (mark.time - startT) / (endT - startT)
      mark.position = {
        x: from.x + (fighter.pos.x - from.x) * f,
        y: mark.position.y,
        z: from.z + (fighter.pos.z - from.z) * f
      }
    }
  }
}

function guardWindow(fighter: Fighter, target: Fighter, startT: number, endT: number): void {
  if (!(endT > startT)) return
  const bounce = firstOf(['boxing-guard-bounce', 'boxing-bounce-drill'])
  if (!bounce) throw new Error('缺少防守动作')
  playLooped(fighter.marks, bounce, fighter.pos, startT, endT, { facing: facingTo(fighter.pos, target.pos) })
}

function resolveFight(winner: Fighter, down: Fighter, ending: FightEnding, startT: number, endT: number): void {
  guardWindow(winner, down, startT, endT)
  if (ending === 'sparring') {
    playMotion(down.marks, requireMotion('get-up-from-ground'), down.pos, startT, endT, {
      facing: facingTo(down.pos, winner.pos)
    })
  } else holdPose(down, startT, endT)
}

function fightReaction(rng: Rng, attackId: string, probing: boolean): string {
  const candidates = (compat[attackId] ?? ['hit-reaction-body']).filter((id) => byId.has(id))
  const blocks = candidates.filter((id) => blockReactions.has(id))
  return pick(rng, probing && blocks.length ? blocks : candidates)
}

function fightRoutine(spec: RoutineSpec, ctx: RoutineCtx): ChoreoEntitySpec[] {
  if (spec.performers >= 3) return oneVsManyRoutine(spec, ctx)
  const rng = mulberry32(spec.seed)
  const beatDur = spec.beatDur ?? 0.55
  const style = (spec.style ?? 'brawl') as FightStyle
  const ending: FightEnding = spec.ending === 'sparring' || style === 'sparring' ? 'sparring' : 'finish'
  const dur = spec.durationS
  const aStart = place(ctx.origin, -fightRange / 2, 0)
  const bStart = place(ctx.origin, fightRange / 2, 0)
  const a: Fighter = { pos: { ...aStart, y: 0 }, marks: [] }
  const b: Fighter = { pos: { ...bStart, y: 0 }, marks: [] }
  const pool = attackPool[style].filter((id) => byId.has(id))
  let exchange = 0
  // Each phase has its own shared boundary; even a 0.2 s shot plays the full
  // probing, combo, climax and resolution motifs, accelerated into the shot.
  for (const [phaseStart, phaseEnd, probing] of [
    [0, dur * 0.3, true], [dur * 0.3, dur * 0.7, false]
  ] as const) {
    let t = phaseStart
    while (t < phaseEnd) {
      const attacker = exchange % 2 === 0 ? a : b
      const defender = exchange % 2 === 0 ? b : a
      const attacks = Array.from({ length: probing ? 1 : randInt(rng, 2, 3) }, () => {
        const id = pick(rng, pool)
        const reaction = fightReaction(rng, id, probing)
        return { id, reaction, duration: attackDuration(id, reaction, beatDur) }
      })
      const breather = randInt(rng, 2, 4) * beatDur
      const angle = (rng() - 0.5) * 0.5
      const nativeDuration = attacks.reduce((sum, attack) => sum + attack.duration, breather)
      if (!Number.isFinite(nativeDuration)) throw new Error('交锋时长溢出')
      const endT = Math.min(phaseEnd, t + nativeDuration)
      const startT = t
      let elapsed = 0
      for (const attack of attacks) {
        const start = startT + (endT - startT) * elapsed / nativeDuration
        elapsed += attack.duration
        const end = startT + (endT - startT) * elapsed / nativeDuration
        attackBeat(attacker, defender, attack.id, attack.reaction, start, end, beatDur, !!spec.mirror && exchange % 2 === 1)
      }
      const guardStart = startT + (endT - startT) * elapsed / nativeDuration
      guardBreather(a, b, guardStart, endT, angle)
      t = endT
      exchange++
    }
  }
  const winner = exchange % 2 === 0 ? a : b
  const down = winner === a ? b : a
  attackBeat(winner, down, climaxAttack[style], ending === 'finish' ? 'ko-collapse' : 'knockdown-fall',
    dur * 0.7, dur * 0.9, beatDur, !!spec.mirror && exchange % 2 === 1)
  resolveFight(winner, down, ending, dur * 0.9, dur)
  return [a, b].map((fighter, i) => ({
    assetId: i === 0 ? 'person.man' : 'person.woman',
    name: i === 0 ? 'Fighter A' : 'Fighter B',
    position: { ...(i === 0 ? aStart : bStart), y: 0 },
    rotationY: facingTo(fighter.pos, i === 0 ? b.pos : a.pos),
    label: { text: i === 0 ? 'FIGHTER A' : 'FIGHTER B', color: i === 0 ? '#3b82f6' : '#e5484d' },
    marks: dedupeSort(fighter.marks)
  }))
}

/** Hero centre, attackers rotate fairly through each bounded narrative phase. */
function oneVsManyRoutine(spec: RoutineSpec, ctx: RoutineCtx): ChoreoEntitySpec[] {
  const rng = mulberry32(spec.seed)
  const beatDur = spec.beatDur ?? 0.55
  const style = (spec.style ?? 'martial-arts') as FightStyle
  const ending: FightEnding = spec.ending === 'sparring' || style === 'sparring' ? 'sparring' : 'finish'
  const dur = spec.durationS
  const nAtk = spec.performers - 1
  const center = place(ctx.origin, 0, 0)
  const hero: Fighter = { pos: { ...center, y: 0 }, marks: [] }
  const ringR = Math.max(1.8, 1.4 + nAtk * 0.25)
  const ringPos = Array.from({ length: nAtk }, (_, i) => {
    const angle = i / nAtk * Math.PI * 2
    return place(ctx.origin, Math.sin(angle) * ringR, -Math.cos(angle) * ringR)
  })
  const attackers: Fighter[] = ringPos.map((p) => ({ pos: { ...p, y: 0 }, marks: [] }))
  const idleUntil = new Array<number>(nAtk).fill(0)
  const pool = attackPool[style].filter((id) => byId.has(id))
  let turn = 0
  for (const [phaseStart, phaseEnd, probing] of [
    [0, dur * 0.3, true], [dur * 0.3, dur * 0.7, false]
  ] as const) {
    let t = phaseStart
    let phaseTurn = 0
    while (t < phaseEnd) {
      const i = turn % nAtk
      const atk = attackers[i]!
      for (let j = 0; j < nAtk; j++) {
        guardWindow(attackers[j]!, hero, idleUntil[j]!, t)
        idleUntil[j] = t
      }
      const id = pick(rng, pool)
      const reaction = fightReaction(rng, id, probing)
      const attackTime = attackDuration(id, reaction, beatDur)
      const natural = attackTime + beatDur * 1.5
      if (!Number.isFinite(natural)) throw new Error('轮转交锋时长溢出')
      // Reserve a non-empty turn for every attacker in this phase, including
      // short shots. No ring member is silently left without an exchange.
      const turnsLeft = nAtk - phaseTurn % nAtk
      const endT = Math.min(phaseEnd, t + Math.min(natural, (phaseEnd - t) / turnsLeft))
      const attackEnd = t + (endT - t) * attackTime / natural
      const retreatEnd = t + (endT - t) * (attackTime + beatDur * 0.5) / natural
      attackBeat(atk, hero, id, reaction, t, attackEnd, beatDur, !!spec.mirror && turn % 2 === 1)
      const home = ringPos[i]!
      atk.pos = { ...home, y: 0 }
      appendMark(atk.marks, {
        time: retreatEnd, position: { ...atk.pos }, gait: 'walk',
        easeIn: 0.2, easeOut: 0.2, hold: 0, arriveHeading: facingTo(home, hero.pos)
      })
      guardWindow(atk, hero, retreatEnd, endT)
      guardWindow(hero, atk, attackEnd, endT)
      idleUntil[i] = endT
      t = endT
      turn++
      phaseTurn++
    }
  }
  const climaxStart = dur * 0.7
  const resolveStart = dur * 0.9
  for (let i = 0; i < nAtk; i++) {
    guardWindow(attackers[i]!, hero, idleUntil[i]!, climaxStart)
    idleUntil[i] = climaxStart
  }
  const downIndex = turn % nAtk
  const down = attackers[downIndex]!
  attackBeat(hero, down, climaxAttack[style], ending === 'finish' ? 'ko-collapse' : 'knockdown-fall',
    climaxStart, resolveStart, beatDur, !!spec.mirror)
  resolveFight(hero, down, ending, resolveStart, dur)
  for (let i = 0; i < nAtk; i++) {
    if (i !== downIndex) guardWindow(attackers[i]!, hero, climaxStart, dur)
  }
  return [{
    assetId: 'person.man', name: 'Hero', position: { ...center, y: 0 },
    rotationY: ctx.origin.heading, label: { text: 'HERO', color: '#3b82f6' }, marks: dedupeSort(hero.marks)
  }, ...attackers.map((fighter, i) => ({
    assetId: i % 2 === 0 ? 'person.man' : 'person.woman',
    name: `Attacker ${i + 1}`, position: { ...ringPos[i]!, y: 0 },
    rotationY: facingTo(ringPos[i]!, hero.pos), marks: dedupeSort(fighter.marks)
  }))]
}

// Chase

/** Sample a serpentine polyline of world waypoints across the floor. */
function serpentine(
  ctx: RoutineCtx,
  length: number,
  amplitude: number,
  seed: number
): { x: number; z: number }[] {
  const rng = mulberry32(seed ^ 0x9e3779b9)
  const pts: { x: number; z: number }[] = []
  const segs = Math.max(6, Math.round(length / 4))
  const phase = rng() * Math.PI * 2
  const freq = 1.4 + rng() * 0.8
  for (let i = 0; i <= segs; i++) {
    const f = i / segs
    const along = f * length
    const lateral = Math.sin(f * Math.PI * freq + phase) * amplitude
    const p = place(ctx.origin, lateral, -along)
    pts.push({ x: p.x, z: p.z })
  }
  return pts
}

/** Position at arc-distance `d` along a polyline (clamped). */
function alongPath(pts: { x: number; z: number }[], cumLen: number[], d: number): { x: number; z: number; heading: number } {
  const total = cumLen[cumLen.length - 1]!
  const dd = Math.max(0, Math.min(total, d))
  let i = 1
  while (i < cumLen.length && cumLen[i]! < dd) i++
  const i0 = Math.max(0, i - 1)
  const i1 = Math.min(pts.length - 1, i)
  const segLen = Math.max(1e-6, cumLen[i1]! - cumLen[i0]!)
  const f = (dd - cumLen[i0]!) / segLen
  const a = pts[i0]!
  const b = pts[i1]!
  const x = a.x + (b.x - a.x) * f
  const z = a.z + (b.z - a.z) * f
  const heading = facingTo(a, b)
  return { x, z, heading }
}

function chaseRoutine(spec: RoutineSpec, ctx: RoutineCtx): ChoreoEntitySpec[] {
  const n = spec.performers
  const dur = spec.durationS
  const ending = (spec.ending ?? 'caught') as ChaseEnding
  const pts = serpentine(ctx, Math.min(120, 5.2 * dur * 0.95), spec.amplitude ?? 4, spec.seed)
  const cumLen: number[] = [0]
  for (let i = 1; i < pts.length; i++) cumLen.push(cumLen[i - 1]! + dist2(pts[i - 1]!, pts[i]!))
  const total = cumLen[cumLen.length - 1]!
  const rng = mulberry32(spec.seed)
  const runnerDist = (t: number): number => {
    const f = t / dur
    return total * (f * 0.82 + f * f * 0.13)
  }
  const gapAt = (t: number): number => ending === 'caught'
    ? 3.5 * (1 - t / dur * 0.92) : 3.5 * (1 + t / dur * 1.1)
  const runnerPos = (t: number) => alongPath(pts, cumLen, runnerDist(t))
  const pursuerPos = (t: number, lag: number) => alongPath(pts, cumLen, runnerDist(t) - gapAt(t) - lag)
  const knock = requireMotion('knockdown-fall')
  const tackle = requireMotion('tackle-lunge')
  const giveUp = requireMotion('sprint-skid-stop')
  const hands = requireMotion('hands-on-hips')
  const endingDuration = ending === 'caught' ? Math.max(knock.duration, tackle.duration) : giveUp.duration + hands.duration
  // Reserve the whole give-up + hands sequence. A short shot scales this entire
  // ending together; it never starts a full native motion outside the window.
  const endingStart = dur - Math.min(endingDuration, dur * 0.4)
  const beatT1 = endingStart * (0.3 + rng() * 0.08)
  const beatT2 = endingStart * (0.6 + rng() * 0.08)
  const out: ChoreoEntitySpec[] = []
  for (let i = 0; i < n; i++) {
    const lag = Math.max(0, i - 1) * 1.6
    const at = (t: number) => i === 0 ? runnerPos(t) : pursuerPos(t, lag)
    const start = at(0)
    const marks: ChoreoMarkSpec[] = []
    for (let sample = 0; sample <= 14; sample++) {
      const t = sample === 14 ? dur : sample / 14 * dur
      const p = at(t)
      appendMark(marks, {
        time: t, position: { x: p.x, y: 0, z: p.z },
        gait: i === 0 && t / dur < 0.35 ? 'jog' : 'run',
        easeIn: 0, easeOut: sample === 0 ? 0.2 : 0, hold: 0, arriveHeading: p.heading
      })
    }
    if (i <= 1) {
      overlayAt(marks, requireMotion(i === 0 ? 'vault-obstacle' : 'stumble-trip'),
        at(beatT1), beatT1, Math.min(beatT2, beatT1 + requireMotion(i === 0 ? 'vault-obstacle' : 'stumble-trip').duration))
      const p = at(beatT2)
      const fwd = forwardOf(p.heading)
      overlayAt(marks, giveUp, {
        x: p.x + (i === 1 ? fwd.x * 1.5 : 0),
        z: p.z + (i === 1 ? fwd.z * 1.5 : 0), heading: p.heading
      }, beatT2, Math.min(endingStart, beatT2 + giveUp.duration))
      if (ending === 'caught') {
        const p = i === 0 ? runnerPos(dur) : alongPath(pts, cumLen, runnerDist(dur) - 0.6)
        overlayAt(marks, i === 0 ? knock : tackle, p, endingStart, dur, 'stand')
      } else if (i === 1) {
        const p = pursuerPos(dur, lag)
        const split = endingStart + (dur - endingStart) * giveUp.duration / (giveUp.duration + hands.duration)
        overlayAt(marks, giveUp, p, endingStart, split, 'stand')
        overlayAt(marks, hands, p, split, dur, 'stand')
      }
    }
    out.push({
      assetId: i === 0 || i % 2 === 1 ? 'person.man' : 'person.woman',
      name: i === 0 ? 'Runner' : n > 2 ? `Pursuer ${i}` : 'Pursuer',
      position: { x: start.x, y: 0, z: start.z }, rotationY: start.heading,
      ...(i === 0 ? { label: { text: 'RUNNER', color: '#e5484d' } } : {}),
      marks: dedupeSort(marks)
    })
  }
  return out
}

/** Scripted overlay owns its whole interval; travel marks cannot erase it. */
function overlayAt(
  marks: ChoreoMarkSpec[], preset: MotionPreset,
  p: { x: number; z: number; heading: number }, startT: number, endT: number,
  gait: GaitId = 'run'
): void {
  for (let i = marks.length - 1; i >= 0; i--) {
    if (marks[i]!.time >= startT && marks[i]!.time <= endT) marks.splice(i, 1)
  }
  playMotion(marks, preset, { x: p.x, y: 0, z: p.z }, startT, endT, { facing: p.heading, gait })
}

/** Sort only: appendMark has already resolved exact same-time ownership. */
function dedupeSort(marks: ChoreoMarkSpec[]): ChoreoMarkSpec[] {
  return [...marks].sort((a, b) => a.time - b.time)
}

function validateRoutine(spec: RoutineSpec, ctx: RoutineCtx): void {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('编舞参数须为对象')
  const keys = ['kind', 'performers', 'durationS', 'seed', 'bpm', 'beatDur', 'style', 'formation', 'canon', 'mirror', 'formationChange', 'ending', 'amplitude']
  if (Object.keys(spec).some((key) => !keys.includes(key))) throw new Error('编舞参数包含未知字段')
  if (!['dance', 'fight', 'chase'].includes(spec.kind)) throw new Error('编舞类型无效')
  const [min, max] = spec.kind === 'dance' ? [1, 40] : spec.kind === 'fight' ? [2, 8] : [2, 6]
  if (!Number.isInteger(spec.performers) || spec.performers < min! || spec.performers > max!) throw new Error('编舞人数超出该类型范围')
  if (!Number.isFinite(spec.durationS) || spec.durationS < 0.2 || spec.durationS > 300) throw new Error('编舞时长须在 0.2–300 秒')
  if (!Number.isInteger(spec.seed) || spec.seed < 0 || spec.seed > 0xffffffff) throw new Error('编舞种子须为 uint32')
  if (spec.bpm !== undefined && (!Number.isFinite(spec.bpm) || spec.bpm < 60 || spec.bpm > 180)) throw new Error('舞蹈 BPM 须在 60–180')
  if (spec.beatDur !== undefined && (!Number.isFinite(spec.beatDur) || spec.beatDur <= 0)) throw new Error('节拍时长须为有限正数')
  if (spec.amplitude !== undefined && (!Number.isFinite(spec.amplitude) || spec.amplitude < 0)) throw new Error('追逐振幅须为有限非负数')
  for (const key of ['canon', 'mirror', 'formationChange'] as const) {
    if (spec[key] !== undefined && typeof spec[key] !== 'boolean') throw new Error('编舞开关须为布尔值')
  }
  if (spec.formation !== undefined && !formationOrder.includes(spec.formation)) throw new Error('编舞队形无效')
  if (spec.style !== undefined && !choreoStyles(spec.kind).some((style) => style.id === spec.style)) throw new Error('编舞风格不适用于该类型')
  if (spec.ending !== undefined && !choreoEndings(spec.kind).some((ending) => ending.id === spec.ending)) throw new Error('编舞结局不适用于该类型')
  if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx) ||
      Object.keys(ctx).some((key) => key !== 'origin') ||
      !ctx.origin || typeof ctx.origin !== 'object' || Array.isArray(ctx.origin) ||
      Object.keys(ctx.origin).some((key) => !['x', 'z', 'heading'].includes(key)) ||
      ![ctx.origin.x, ctx.origin.z, ctx.origin.heading].every(Number.isFinite)) throw new Error('编舞原点须包含有限 x/z/heading')
}

/** Product validation: invalid or over-budget routines never publish partly. */
function validateOutput(entities: ChoreoEntitySpec[], spec: RoutineSpec): void {
  if (entities.length !== spec.performers) throw new Error('编舞人数与结果不一致')
  for (const entity of entities) {
    if (![entity.position.x, entity.position.y, entity.position.z, entity.rotationY].every(Number.isFinite)) throw new Error('编舞实体坐标无效')
    if (entity.marks.length < 2 || entity.marks.length > maxMarksPerEntity ||
        entity.marks[0]!.time !== 0 || entity.marks[entity.marks.length - 1]!.time !== spec.durationS) throw new Error('编舞未完整覆盖镜头或超出标记预算')
    let previous = -1
    for (const mark of entity.marks) {
      if (!Number.isFinite(mark.time) || mark.time <= previous || mark.time < 0 || mark.time > spec.durationS ||
          ![mark.position.x, mark.position.y, mark.position.z, mark.easeIn, mark.easeOut, mark.hold].every(Number.isFinite) ||
          mark.easeIn < 0 || mark.easeOut < 0 || mark.hold < 0 ||
          (mark.arriveHeading !== undefined && !Number.isFinite(mark.arriveHeading)) ||
          Object.values(mark.joints ?? {}).some((value) => !Number.isFinite(value))) throw new Error('编舞包含越窗、重复或非有限标记')
      previous = mark.time
    }
  }
}

/** Style choices offered per kind (for the Choreographer UI). */
export function choreoStyles(kind: ChoreoKind): { id: string; name: string }[] {
  switch (kind) {
    case 'dance':
      return [
        { id: 'mixed', name: 'Mixed' },
        { id: 'hiphop', name: 'Hip-hop' },
        { id: 'party', name: 'Party' },
        { id: 'latin', name: 'Latin' },
        { id: 'robot', name: 'Robot' }
      ]
    case 'fight':
      return [
        { id: 'brawl', name: 'Brawl' },
        { id: 'martial-arts', name: 'Martial arts' },
        { id: 'sparring', name: 'Sparring' }
      ]
    case 'chase':
      return [{ id: 'default', name: 'Foot chase' }]
  }
}

export function choreoEndings(kind: ChoreoKind): { id: string; name: string }[] {
  switch (kind) {
    case 'fight':
      return [
        { id: 'finish', name: 'Finish (loser stays down)' },
        { id: 'sparring', name: 'Sparring (loser gets up)' }
      ]
    case 'chase':
      return [
        { id: 'caught', name: 'Caught' },
        { id: 'escape', name: 'Escape' }
      ]
    case 'dance':
      return [{ id: 'freeze', name: 'Freeze pose' }]
  }
}

export function choreoFormations(): { id: FormationId; name: string }[] {
  return [
    { id: 'line', name: 'Line' },
    { id: 'twoRows', name: 'Two rows' },
    { id: 'vShape', name: 'V-shape' },
    { id: 'diamond', name: 'Diamond' },
    { id: 'circle', name: 'Circle' }
  ]
}

/**
 * Build a full routine — the per-performer marks a store action drops into the
 * active take as one undoable step. Full motions are retimed when their window
 * is shorter than their native duration. Maximum 2000 unique marks per person;
 * exceeding it throws instead of truncating. No DOM, model, or storage side effects.
 */
export function buildRoutine(spec: RoutineSpec, ctx: RoutineCtx): ChoreoEntitySpec[] {
  validateRoutine(spec, ctx)
  const entities = spec.kind === 'dance' ? danceRoutine(spec, ctx)
    : spec.kind === 'fight' ? fightRoutine(spec, ctx) : chaseRoutine(spec, ctx)
  validateOutput(entities, spec)
  return entities
}
