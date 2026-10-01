// Modified for cross-platform Windows support, host camera-bank editing and shot drafts in 2026; see ../../readme.md.
/**
 * Document creation, validation, and git-friendly serialization.
 * Projects are folders; this module owns the JSON shape. Serialization is
 * pretty-printed with stable key order so diffs stay reviewable.
 */

import { newId } from './ids'
import type {
  ActorMark,
  BlockingTake,
  CameraMark,
  Entity,
  GaitId,
  ProjectDoc,
  Scene,
  ScanRef,
  Shot,
  V3
} from './types'
import { normalizeProjectRelativePath } from './portablePaths'
import { scanRef } from '../scanEditing'

export const SCHEMA_VERSION = 1 as const

export function createProject(name: string): ProjectDoc {
  const doc: ProjectDoc = {
    version: SCHEMA_VERSION,
    id: newId('proj'),
    name,
    settings: { defaultProfileId: 'seedance-2' },
    scenes: []
  }
  doc.scenes.push(createScene(1))
  return doc
}

export function createScene(number: number): Scene {
  const take: BlockingTake = { id: newId('take'), name: 'Master', tracks: [] }
  const scene: Scene = {
    id: newId('scene'),
    name: `Scene ${number}`,
    number,
    environment: { lighting: 'day', sunAzimuth: 0.8, sunElevation: 0.9, fog: 0 },
    entities: [],
    blocking: [take],
    shots: [],
    scans: []
  }
  scene.shots.push(createShot(scene, `${number}A`))
  return scene
}

export function createShot(scene: Scene, name: string): Shot {
  return {
    id: newId('shot'),
    name,
    duration: 5,
    fps: 24,
    aspect: '16:9',
    blockingTakeId: scene.blocking[0]!.id,
    camera: {
      sensorId: 'super35',
      rig: 'sticks',
      rigIntensity: 0.5,
      seed: Math.floor(Math.random() * 1e9),
      marks: []
    }
  }
}

/** The legacy active camera remains authoritative for playback and export. */
export function shotCameras(shot: Shot) {
  return [{ ...shot.cameraEntryFields, name: shot.cameraName ?? 'A', camera: shot.camera }, ...(shot.cameraBank ?? [])]
}

export function createScan(name: string, file: string, position: V3): ScanRef {
  return {
    id: newId('scan'),
    name,
    file,
    position,
    rotationY: 0,
    scale: 1,
    visible: true
  }
}

export function createEntity(assetId: string, name: string, position: V3): Entity {
  return {
    id: newId('ent'),
    assetId,
    name,
    transform: { position, rotationY: 0, scale: 1 }
  }
}

export function createActorMark(position: V3, time: number, gait: GaitId = 'walk'): ActorMark {
  return { id: newId('mark'), time, hold: 0, easeIn: 0.25, easeOut: 0.25, position, gait }
}

export function createCameraMark(
  position: V3,
  time: number,
  pan: number,
  tilt: number,
  focalLength: number
): CameraMark {
  return {
    id: newId('cmark'),
    time,
    hold: 0,
    easeIn: 0.3,
    easeOut: 0.3,
    position,
    pan,
    tilt,
    roll: 0,
    focalLength
  }
}

export interface ValidationIssue {
  path: string
  message: string
}

export function validateProject(doc: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const err = (path: string, message: string) => issues.push({ path, message })
  if (typeof doc !== 'object' || doc === null) {
    err('$', 'project is not an object')
    return issues
  }
  const p = doc as Record<string, unknown>
  if (p.version !== 1) err('version', `unsupported schema version ${String(p.version)}`)
  if (typeof p.name !== 'string') err('name', 'missing project name')
  if (!Array.isArray(p.scenes)) {
    err('scenes', 'missing scenes array')
    return issues
  }
  p.scenes.forEach((s: unknown, i: number) => {
    if (typeof s !== 'object' || s === null) return err(`scenes[${i}]`, 'scene is not an object')
    const scene = s as Record<string, unknown>
    if (typeof scene.id !== 'string') err(`scenes[${i}].id`, 'missing id')
    if (!Array.isArray(scene.entities)) err(`scenes[${i}].entities`, 'missing entities')
    else {
      ;(scene.entities as unknown[]).forEach((entity: unknown, j: number) => {
        if (typeof entity !== 'object' || entity === null) return
        const sourceFile = (entity as Record<string, unknown>).sourceFile
        if (sourceFile !== undefined &&
          (typeof sourceFile !== 'string' || normalizeProjectRelativePath(sourceFile) === null)) {
          err(`scenes[${i}].entities[${j}].sourceFile`, 'must be a relative path inside the project')
        }
      })
    }
    if (!Array.isArray(scene.blocking) || (scene.blocking as unknown[]).length === 0)
      err(`scenes[${i}].blocking`, 'scene needs at least one blocking take')
    const takeIds = new Set(
      (Array.isArray(scene.blocking) ? (scene.blocking as { id?: unknown }[]) : [])
        .map((b) => b.id)
        .filter((x): x is string => typeof x === 'string')
    )
    const mainIds = new Set(
      (Array.isArray(scene.shots) ? scene.shots : [])
        .filter((shot): shot is Record<string, unknown> => typeof shot === 'object' && shot !== null)
        .map((shot) => shot.id)
        .filter((id): id is string => typeof id === 'string')
    )
    const shotIds = new Set<string>()
    for (const [key, value] of [['shots', scene.shots], ['drafts', scene.drafts === undefined ? [] : scene.drafts]] as const) {
      const collectionPath = `scenes[${i}].${key}`
      if (!Array.isArray(value)) {
        err(collectionPath, 'must be a shots array')
        continue
      }
      if (value.length > 100) err(collectionPath, 'must contain at most 100 shots')
      value.forEach((sh: unknown, j: number) => {
        const location = `${collectionPath}[${j}]`
        if (typeof sh !== 'object' || sh === null) return err(location, 'not an object')
        const shot = sh as Record<string, unknown>
        if (typeof shot.id !== 'string' || !shot.id || shotIds.has(shot.id)) err(`${location}.id`, 'missing or duplicate shot id')
        else shotIds.add(shot.id)
        if (typeof shot.name !== 'string') err(`${location}.name`, 'missing shot name')
        if (key === 'shots' ? shot.draftOf !== undefined : typeof shot.draftOf !== 'string' || !mainIds.has(shot.draftOf))
          err(`${location}.draftOf`, 'draft must reference a main shot in this scene; main shots cannot have draftOf')
        if (typeof shot.duration !== 'number' || !Number.isFinite(shot.duration) || shot.duration < 0.2 || shot.duration > 300)
          err(`${location}.duration`, 'duration must be 0.2..300 seconds')
        if (typeof shot.fps !== 'number' || !Number.isInteger(shot.fps) || shot.fps < 1 || shot.fps > 60)
          err(`${location}.fps`, 'fps must be an integer in 1..60')
        if (!['16:9', '9:16', '2.39:1', '4:3', '1:1'].includes(String(shot.aspect))) err(`${location}.aspect`, 'unknown aspect ratio')
        if (typeof shot.blockingTakeId !== 'string' || !takeIds.has(shot.blockingTakeId))
          err(`${location}.blockingTakeId`, 'references a missing blocking take')
        const camera = shot.camera as Record<string, unknown> | undefined
        if (!camera || !Array.isArray(camera.marks)) err(`${location}.camera`, 'missing camera')
        if (shot.cameraBank !== undefined && (!Array.isArray(shot.cameraBank) || shot.cameraBank.some(entry =>
          typeof entry !== 'object' || entry === null || typeof entry.name !== 'string' ||
          typeof entry.camera !== 'object' || entry.camera === null || !Array.isArray(entry.camera.marks)))) {
          err(`${location}.cameraBank`, 'invalid camera bank')
        }
        const reference = shot.referenceVideo as Record<string, unknown> | undefined
        if (reference &&
          (typeof reference.path !== 'string' || normalizeProjectRelativePath(reference.path) === null)) {
          err(`${location}.referenceVideo.path`, 'must be a relative path inside the project')
        }
      })
    }
  })
  return issues
}

function requirePortableProjectPath(value: string, location: string): string {
  const normalized = normalizeProjectRelativePath(value)
  if (!normalized) throw new Error(`${location}: must be a relative path inside the project`)
  return normalized
}

function normalizeProjectPaths(doc: ProjectDoc): ProjectDoc {
  for (const [sceneIndex, scene] of doc.scenes.entries()) {
    for (const [entityIndex, entity] of scene.entities.entries()) {
      if (entity.sourceFile !== undefined) {
        entity.sourceFile = requirePortableProjectPath(
          entity.sourceFile,
          `scenes[${sceneIndex}].entities[${entityIndex}].sourceFile`
        )
      }
    }
    for (const [shotIndex, shot] of [...scene.shots, ...(scene.drafts ?? [])].entries()) {
      if (shot.referenceVideo) {
        shot.referenceVideo.path = requirePortableProjectPath(
          shot.referenceVideo.path,
          `scenes[${sceneIndex}].shotsOrDrafts[${shotIndex}].referenceVideo.path`
        )
      }
    }
  }
  return doc
}

/** Recursively sort object keys so serialization is byte-stable. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key]
      if (v !== undefined) out[key] = stable(v)
    }
    return out
  }
  return value
}

export function serializeProject(doc: ProjectDoc): string {
  const copy = JSON.parse(JSON.stringify(doc)) as ProjectDoc
  return JSON.stringify(stable(normalizeProjectPaths(copy)), null, 2) + '\n'
}

/**
 * Forward-migrate a validated document in place. Additive fields introduced
 * after v1 (like scene.scans) are normalized here so the rest of the app can
 * rely on their shape without version-gating. Host scan validation retains
 * unknown fields and legacy file strings; invalid entries must never disappear.
 */
function migrateProject(doc: ProjectDoc): ProjectDoc {
  for (const scene of doc.scenes) {
    const raw = (scene as { scans?: unknown }).scans
    scene.scans = scanRef.array().parse(raw === undefined ? [] : raw)
  }
  return doc
}

export function parseProject(json: string): { doc: ProjectDoc | null; issues: ValidationIssue[] } {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch (e) {
    return { doc: null, issues: [{ path: '$', message: `invalid JSON: ${(e as Error).message}` }] }
  }
  const issues = validateProject(raw)
  if (issues.length > 0) return { doc: null, issues }
  // Order matters only by convention: migrate fills additive fields (scans),
  // then path normalization enforces portable project-relative paths.
  return { doc: normalizeProjectPaths(migrateProject(raw as ProjectDoc)), issues: [] }
}
