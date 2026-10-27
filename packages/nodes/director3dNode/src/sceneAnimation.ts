import { AnimationClip, AnimationMixer, Euler, LoopOnce, Quaternion, QuaternionKeyframeTrack, VectorKeyframeTrack } from "three";
import { getObjectByThreeJsonId, type SceneRuntime } from "threejson/core";
import { updateSunShadow } from "./scene";
import { directorPlanSchema, type DirectorPlan } from "@toonflow/node-shared/director/schema";
export { directorPlanSchema, type DirectorPlan, type DirectorPlanItem, type DirectorGeneration } from "@toonflow/node-shared/director/schema";

export function prepareSceneAnimation(runtime: SceneRuntime, value: DirectorPlan) {
  const { name, duration, tracks: sourceTracks, cameraFrames } = value;
  const animation = directorPlanSchema.parse({ name, duration, tracks: sourceTracks, cameraFrames });
  const tracks = animation.tracks.flatMap(track => {
    const root = getObjectByThreeJsonId(track.objectId, runtime.scene);
    if (!root) throw new Error(`场景中找不到动画物体：${track.objectId}`);
    if (track.joint && root.userData.objJson?.objType !== "mannequin") throw new Error(`只有人偶支持关节动画：${track.objectId}`);
    const object = track.joint ? root.getObjectByName(track.joint) : root;
    if (!object) throw new Error(`场景中找不到人偶关节：${track.joint}`);
    const times = track.frames.map(frame => frame.time);
    return [
      new QuaternionKeyframeTrack(`${object.uuid}.quaternion`, times, track.frames.flatMap(frame => new Quaternion().setFromEuler(new Euler(frame.rotation.x, frame.rotation.y, frame.rotation.z)).toArray())),
      ...(["position", "scale"] as const).filter(property => track.frames.some(frame => frame[property])).map(property =>
        new VectorKeyframeTrack(`${object.uuid}.${property}`, times, track.frames.flatMap(frame => {
          const value = frame[property] ?? object[property];
          return [value.x, value.y, value.z];
        })),
      ),
    ];
  });
  const mixer = new AnimationMixer(runtime.scene);
  const clip = new AnimationClip(animation.name, animation.duration, tracks);
  const action = mixer.clipAction(clip).setLoop(LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  return {
    setTime(time: number) {
      if (!Number.isFinite(time)) throw new Error("场景动画时间无效");
      // LoopOnce 到终点会自动暂停；再次定位到任意时间前恢复采样。
      action.paused = false;
      mixer.setTime(Math.min(animation.duration, Math.max(0, time)));
      updateSunShadow(runtime);
    },
    dispose() {
      mixer.stopAllAction();
      mixer.uncacheRoot(runtime.scene);
    },
  };
}
