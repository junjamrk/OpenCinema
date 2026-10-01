/**
 * Copyright 2026 Sam Wasserman (wassermanproductions.com).
 * SPDX-License-Identifier: Apache-2.0
 * Staging payload/application adapted from Blockout src/renderer/store.ts,
 * commit 3f2d0564fd575f70fc28e9bfaa7e94b05e3955d9; see ../licenses/blockout{License,Notice}.txt.
 * Modified 2026-10-22: validate with the host document boundary, retain every
 * Take and confirmation, remap known entity references, and use node-owned GLB names.
 */
import { z } from "zod";
import { readProject } from "./document";
import { newId } from "./nativeBlockout/ids";
import { createProject, createScene } from "./nativeBlockout/schema";
import type { BlockingTake, Entity, ProjectDoc, Scene } from "./nativeBlockout/types";

export interface StagePresetPayload {
  presetVersion: 1;
  name: string;
  environment: Scene["environment"];
  entities: Entity[];
  blocking: BlockingTake[];
  [key: string]: unknown;
}

const stagePreset = z.looseObject({
  presetVersion: z.literal(1), name: z.string(), environment: z.unknown(),
  entities: z.array(z.unknown()),
  blocking: z.array(z.looseObject({ id: z.string().min(1) })).min(1),
});

export function readStagePreset(value: unknown): StagePresetPayload {
  const original: unknown = z.json().parse(value);
  const payload = stagePreset.parse(original);
  const project = createProject(payload.name), scene = project.scenes[0];
  // ACT: use the existing product validator without sorting or tightening legacy
  // mark timing/ID domains. Return the original JSON fields, not its projection.
  readProject({ ...project, scenes: [{ ...scene, name: payload.name,
    environment: payload.environment, entities: payload.entities, blocking: payload.blocking,
    shots: [{ ...scene.shots[0], blockingTakeId: payload.blocking[0].id }],
  }] });
  return structuredClone(original) as StagePresetPayload;
}

export function createStagePreset(scene: Scene, name: string): StagePresetPayload {
  // The source preset contract stores staging only; shots, cameras and scans stay in the project.
  return readStagePreset({ presetVersion: 1, name, environment: scene.environment,
    entities: scene.entities, blocking: scene.blocking });
}

export function applyStagePreset(project: ProjectDoc, value: unknown) {
  const payload = readStagePreset(value), scene = createScene(project.scenes.length + 1);
  scene.name = payload.name;
  scene.environment = payload.environment;
  scene.entities = payload.entities;
  scene.blocking = payload.blocking;
  const entityIds = new Map(scene.entities.map(entity => [entity.id, newId("ent")]));
  for (const entity of scene.entities) {
    entity.id = entityIds.get(entity.id)!;
    if (entity.attachedTo !== undefined) entity.attachedTo = entityIds.get(entity.attachedTo)!;
  }
  let duration = 5;
  for (const take of scene.blocking) {
    take.id = newId("take");
    for (const track of take.tracks) {
      track.entityId = entityIds.get(track.entityId)!;
      for (const mark of track.marks) {
        mark.id = newId("mark");
        if (mark.attachTo !== undefined) mark.attachTo = entityIds.get(mark.attachTo)!;
        if (mark.lookAtEntityId !== undefined) mark.lookAtEntityId = entityIds.get(mark.lookAtEntityId)!;
        duration = Math.max(duration, mark.time);
      }
    }
  }
  // ACT: this is a new host-default shot with an empty camera, not a preset camera.
  // Its duration exposes every copied Take's saved marks, without adding holds or marks.
  const shot = scene.shots[0];
  shot.blockingTakeId = scene.blocking[0].id;
  shot.duration = duration;
  readProject({ ...project, scenes: [...project.scenes, scene] });
  project.scenes.push(scene);
  return { sceneId: scene.id, shotId: shot.id, entityIds: scene.entities.map(entity => entity.id),
    takeIds: scene.blocking.map(take => take.id), duration, derivedDefaultShot: true as const };
}
