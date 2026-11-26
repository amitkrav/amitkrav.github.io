import * as THREE from './vendor/three/three.module.min.js';

import { mergeGeometries } from './vendor/three/BufferGeometryUtils.js';

const up = new THREE.Vector3(0, 1, 0);
const radians = THREE.MathUtils.degToRad;
export const minZoom = 0.6;
export const maxZoom = 1.8;

// Targets are absolute angles in degrees. Each rig has its own cadence and start phase.
const tracks = {
  flak: { targets: [[-36, 6], [44, 27], [9, 12]], move: 1.05, hold: 2.35, phase: 0.14 },
  gatling: { targets: [[32, 3], [-48, 18], [7, -4]], move: .82, hold: 2.65, phase: 2.1 },
  rocket: { targets: [[-24, 8], [17, 25], [54, 14]], move: 1.28, hold: 2.5, phase: 4.3 },
};

function travel(from, to, fraction, range) {
  const seating = fraction > .84;
  const t = seating ? Math.min((fraction - .84) / .16, 1) : fraction / .84;
  const smooth = t * t * (3 - 2 * t);
  // Spend the final 16% of travel seating back onto the absolute target.
  const progress = seating ? 1 + .018 * (1 - smooth) : 1.018 * smooth;
  return THREE.MathUtils.clamp(THREE.MathUtils.lerp(from, to, progress), ...range);
}

export function aimAt(model, elapsed) {
  const {targets, move, hold, phase} = tracks[model.id];
  const period = move + hold;
  const t = (elapsed + phase) % (period * targets.length);
  const i = Math.floor(t / period);
  const from = targets[i];
  const to = targets[(i + 1) % targets.length];
  const fraction = (t - i * period) / move;
  return {
    yawDeg: travel(from[0], to[0], fraction, model.rig.yawRangeDeg),
    pitchDeg: travel(from[1], to[1], fraction / .84, model.rig.pitchRangeDeg),
  };
}

export function poseRig(rig, angles) {
  rig.yaw.quaternion.setFromAxisAngle(up, radians(angles.yawDeg)).multiply(rig.yawRest);
  rig.pitch.quaternion.copy(rig.pitchRest).multiply(
    rig.turn.setFromAxisAngle(rig.axis, radians(angles.pitchDeg))
  );
}

export function frameModel(scene, model) {
  scene.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(scene, true);
  const center = bounds.getCenter(new THREE.Vector3());
  let rig = null;
  if (model.rig) {
    const yaw = scene.getObjectByName(model.rig.yawNode);
    const pitch = scene.getObjectByName(model.rig.pitchNode);
    if (!yaw || pitch?.parent !== yaw) throw new Error('Incomplete model rig');
    rig = {yaw, pitch, yawRest: yaw.quaternion.clone(), pitchRest: pitch.quaternion.clone(),
      axis: new THREE.Vector3(...model.rig.pitchAxisThree).normalize(), turn: new THREE.Quaternion()};
    const pivot = yaw.getWorldPosition(new THREE.Vector3());
    center.x = pivot.x;
    center.z = pivot.z;
  }
  let radius = 0;
  if (model.bodyRadius) {
    // All five planet bodies share the export origin. A common 1.9-body-radius
    // envelope includes the farthest ring vertex (1.853) and the ice debris.
    center.set(0, 0, 0);
    radius = model.bodyRadius * 1.9;
  } else {
    const barrelMeshes = new Set();
    const pivot = new THREE.Vector3();
    if (rig) {
      rig.pitch.traverse(node => barrelMeshes.add(node));
      rig.pitch.getWorldPosition(pivot);
    }
    const point = new THREE.Vector3();
    scene.traverse(node => {
      if (!node.isMesh) return;
      const positions = node.geometry.attributes.position;
      for (let i = 0; i < positions.count; i++) {
        point.fromBufferAttribute(positions, i).applyMatrix4(node.matrixWorld);
        // Yaw preserves distance from our on-axis center. The pitch envelope
        // uses the triangle inequality about the hinge, valid for every angle.
        const distance = barrelMeshes.has(node)
          ? point.distanceTo(pivot) + pivot.distanceTo(center)
          : point.distanceTo(center);
        radius = Math.max(radius, distance);
      }
    });
  }
  if (!Number.isFinite(radius) || radius <= 0) throw new Error('Invalid model bounds');
  scene.position.sub(center);
  const root = new THREE.Group();
  root.scale.setScalar(1 / radius);
  root.add(scene);
  return {root, rig};
}

// Resting silhouette sets a stable lens as the model turns.
const toCamera = new THREE.Matrix4();
export function silhouette(root, camera) {
  camera.updateMatrixWorld();
  root.updateMatrixWorld(true);
  let left = Infinity, bottom = Infinity, right = -Infinity, top = -Infinity;
  root.traverse(mesh => {
    if (!mesh.isMesh) return;
    const positions = mesh.geometry.attributes.position;
    const m = toCamera.multiplyMatrices(camera.matrixWorldInverse, mesh.matrixWorld).elements;
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i), y = positions.getY(i), z = positions.getZ(i);
      const sx = m[0] * x + m[4] * y + m[8] * z + m[12];
      const sy = m[1] * x + m[5] * y + m[9] * z + m[13];
      left = Math.min(left, sx);
      right = Math.max(right, sx);
      bottom = Math.min(bottom, sy);
      top = Math.max(top, sy);
    }
  });
  return {left, right, top, bottom, width: right - left, height: top - bottom};
}

// Include the entire aiming cycle in a turret's resting composition so the
// camera stays still when a barrel moves across the stage.
export function restingBounds(root, camera, model, rig) {
  const bounds = silhouette(root, camera);
  if (!rig) return bounds;
  const yaw = rig.yaw.quaternion.clone();
  const pitch = rig.pitch.quaternion.clone();
  const track = tracks[model.id];
  const cycle = (track.move + track.hold) * track.targets.length;
  for (let i = 0; i < 60; i++) {
    poseRig(rig, aimAt(model, cycle * i / 60));
    const pose = silhouette(root, camera);
    bounds.left = Math.min(bounds.left, pose.left);
    bounds.right = Math.max(bounds.right, pose.right);
    bounds.bottom = Math.min(bounds.bottom, pose.bottom);
    bounds.top = Math.max(bounds.top, pose.top);
  }
  rig.yaw.quaternion.copy(yaw);
  rig.pitch.quaternion.copy(pitch);
  bounds.width = bounds.right - bounds.left;
  bounds.height = bounds.top - bounds.bottom;
  return bounds;
}

export function fitProjection(camera, rest, aspect, zoom, bounds) {
  let half = (rest.half ?? Math.max(
    rest.width / Math.max(1, aspect), rest.height / Math.max(1, 1 / aspect)
  ) / rest.fill) / zoom;
  if (bounds) half = Math.max(half, bounds.width / (1.94 * Math.max(1, aspect)), bounds.height / (1.94 * Math.max(1, 1 / aspect)));
  const w = half * Math.max(1, aspect);
  const h = half * Math.max(1, 1 / aspect);
  const x = bounds ? THREE.MathUtils.clamp(rest.x, bounds.right - .98 * w, bounds.left + .98 * w) : rest.x;
  const y = bounds ? THREE.MathUtils.clamp(rest.y, bounds.top - .98 * h, bounds.bottom + .98 * h) : rest.y;
  camera.left = x - w;
  camera.right = x + w;
  camera.bottom = y - h;
  camera.top = y + h;
  camera.updateProjectionMatrix();
}

// Establish the blade pivot in export space before normalizing the model.
export function bladeHub(scene, spin) {
  // The Blades node's own origin is the hub. Spin it in place around the
  // thinnest axis of its local geometry (the disc normal).
  const blades = scene.getObjectByName(spin.node);
  blades.geometry.computeBoundingBox();
  const size = blades.geometry.boundingBox.getSize(new THREE.Vector3());
  const axis = new THREE.Vector3();
  axis.setComponent(size.toArray().indexOf(Math.min(size.x, size.y, size.z)), 1);
  return {hub: blades, axis, speed: radians(spin.degPerSec)};
}

// Landmarks are rigid and untextured, but a single building has hundreds of
// separate Blender objects. Bake their transforms for one draw per landmark.
export function clayModel(scene) {
  scene.updateMatrixWorld(true);
  const parts = [];
  scene.traverse(node => {
    if (!node.isMesh) return;
    const geometry = node.geometry.index ? node.geometry.toNonIndexed() : node.geometry.clone();
    geometry.applyMatrix4(node.matrixWorld);
    for (const key of Object.keys(geometry.attributes)) {
      if (key !== 'position' && key !== 'normal') geometry.deleteAttribute(key);
    }
    parts.push(geometry);
  });
  const merged = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  disposeModel(scene);
  const clay = new THREE.MeshStandardMaterial({color: 0xcac7c4, roughness: .94, side: THREE.DoubleSide});
  return new THREE.Group().add(new THREE.Mesh(merged, clay));
}

export function disposeModel(root, sharedTexture = null) {
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  root.traverse(node => {
    if (node.geometry) geometries.add(node.geometry);
    for (const material of [].concat(node.material || [])) {
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) {
    if (texture === sharedTexture) continue;
    texture.dispose();
    texture.source.data?.close?.();
  }
}
