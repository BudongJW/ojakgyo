// Shared setup for the 2D bake: load Kkachi, pose her for a waist-up 2D rig, frame an orthographic camera.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

export const SIZE = 2048;

export async function loadModel(url) {
  const loader = new GLTFLoader();
  loader.register((p) => new VRMLoaderPlugin(p));
  const gltf = await loader.loadAsync(url);
  const vrm = gltf.userData.vrm;
  VRMUtils.rotateVRM0(vrm);
  const meshes = [];
  vrm.scene.traverse((o) => {
    if (!o.isMesh) return;
    const assoc = gltf.parser.associations.get(o) ?? {};
    o.frustumCulled = false;
    meshes.push({ mesh: o, gltfMesh: assoc.meshes, prim: assoc.primitives, material: (Array.isArray(o.material) ? o.material[0] : o.material).name });
  });
  return { gltf, vrm, meshes };
}

export function bone(vrm, name) {
  return vrm.humanoid.getNormalizedBoneNode(name);
}

export function worldPos(vrm, name) {
  return vrm.humanoid.getRawBoneNode(name).getWorldPosition(new THREE.Vector3());
}

/** Apply the humanoid pose to the raw skeleton and refresh world matrices (no spring bones, no expressions). */
export function settle(vrm) {
  vrm.humanoid.update();
  vrm.scene.updateMatrixWorld(true);
}

/** Arms down along the body, a little forward, elbows slightly bent. Picks the rotation sign that lowers the hands. */
export function restPose(vrm) {
  vrm.humanoid.resetNormalizedPose();
  settle(vrm);
  const tryArm = (side, z) => {
    bone(vrm, `${side}UpperArm`).rotation.set(0, 0, z);
    settle(vrm);
    return worldPos(vrm, `${side}Hand`).y;
  };
  for (const side of ['left', 'right']) {
    const shoulderY = worldPos(vrm, `${side}UpperArm`).y;
    let z = 1.22;
    if (tryArm(side, z) > shoulderY - 0.2) z = -z;
    tryArm(side, z);
    const s = Math.sign(z);
    bone(vrm, `${side}UpperArm`).rotation.set(0, 0, z);
    bone(vrm, `${side}LowerArm`).rotation.set(0, 0, s * 0.12);
    bone(vrm, `${side}Hand`).rotation.set(0, 0, s * 0.08);
  }
  settle(vrm);
}

/** Orthographic camera from the top of the hair down to just below the hips, square, centred on x = 0. */
export function frameCamera(vrm, meshes) {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const { mesh } of meshes) {
    const pos = mesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i += 7) {
      mesh.getVertexPosition(i, v);
      v.applyMatrix4(mesh.matrixWorld);
      box.expandByPoint(v);
    }
  }
  const top = box.max.y + 0.02;
  const bottom = worldPos(vrm, 'hips').y - 0.13;
  const h = top - bottom;
  const cy = (top + bottom) / 2;
  const cam = new THREE.OrthographicCamera(-h / 2, h / 2, h / 2, -h / 2, 0.01, 10);
  cam.position.set(0, cy, 5);
  cam.lookAt(0, cy, 0);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return { cam, top, bottom, h };
}

/** World point -> canvas pixel (x right, y down) and depth (0 near .. 1 far, like gl_FragCoord.z). */
export function project(cam, p) {
  const n = p.clone().project(cam);
  return [((n.x + 1) / 2) * SIZE, ((1 - n.y) / 2) * SIZE, (n.z + 1) / 2];
}

export function makeRenderer() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(SIZE, SIZE);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  document.body.append(renderer.domElement);
  return renderer;
}

/** Soft, mostly frontal light so the baked art reads like an illustration. */
export function lights(scene) {
  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(-0.6, 1.2, 2.5);
  scene.add(key);
}

export async function save(name, body) {
  const res = await fetch(`/save/${name}`, { method: 'POST', body });
  if (!res.ok) throw new Error(`save ${name} failed`);
}
