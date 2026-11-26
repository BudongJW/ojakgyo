// VRM avatar overlay: idle motion, blinking, gaze, TTS lip-sync and rule-driven expressions.
// Query: ?view=bust|full   ?preview=1 (checkerboard)   ?demo=1 (cycle expressions and talk)   ?demo=talk (talk only)
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { connect, el } from './client.js';
import { headRotation, smooth, toVrmPresets } from './face-map.js';

const params = new URLSearchParams(location.search);
if (params.has('preview')) document.body.classList.add('preview');

function notice(text, detail) {
  const box = el('div', 'notice', text);
  if (detail) {
    box.append(document.createElement('br'));
    box.append(el('code', '', detail));
  }
  document.body.append(box);
}

/* ── scene ── */
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, premultipliedAlpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const key = new THREE.DirectionalLight(0xffffff, Math.PI * 0.9);
key.position.set(0.6, 1.4, 1.6);
scene.add(key);

const camera = new THREE.PerspectiveCamera(24, window.innerWidth / window.innerHeight, 0.05, 50);

/* ── state ── */
let vrm = null;
let frameTarget = null; // { center, height }
const mouth = { target: 0, value: 0, lastSignal: 0 };
const active = new Map(); // expression -> { weight, start, until }
let nextBlink = 1.5;
// Expression names resolved once per model. Perfect Sync models (ARKit 52) get their
// jaw and eyelid shapes driven directly; plain VRMs fall back to the VRM presets.
let rig = { blink: [], mouth: [], mouthShape: null, perfectSync: false, names: new Map() };
// Latest webcam frame from /tracker (already mirrored there), smoothed.
const face = { blend: null, head: [0, 0, 0], at: 0 };
const faceActive = () => performance.now() - face.at < 500;
// 0 = idle animation, 1 = webcam. Eased, so the avatar settles back to idle instead of
// freezing mid-wink when the tracker window closes or stalls.
let faceMix = 0;
// Expressions written last frame; anything not written this frame goes back to 0.
let lastWritten = new Set();

function resolveRig(em) {
  const names = new Map(em.expressions.map((e) => [e.expressionName.toLowerCase(), e.expressionName]));
  const find = (...candidates) => candidates.map((c) => names.get(c.toLowerCase())).find(Boolean) ?? null;
  const jaw = find('jawOpen');
  const blinkL = find('eyeBlinkLeft');
  const blinkR = find('eyeBlinkRight');
  const perfectSync = Boolean(jaw && blinkL && blinkR);
  return {
    names,
    perfectSync,
    blink: perfectSync ? [blinkL, blinkR] : [find('blink')].filter(Boolean),
    // Jaw drives the opening; a little 'aa' keeps the VRM mouth shape (teeth, tongue) in play.
    mouth: perfectSync ? [jaw] : [find('aa')].filter(Boolean),
    mouthShape: perfectSync ? find('aa') : null,
  };
}

function frameCamera() {
  if (!frameTarget) return;
  const { center, height } = frameTarget;
  camera.aspect = window.innerWidth / window.innerHeight;
  const fitHeight = Math.max(height, (height * 0.62) / camera.aspect);
  const dist = fitHeight / 2 / Math.tan((camera.fov * Math.PI) / 360);
  camera.position.set(center.x, center.y, center.z + dist);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  frameCamera();
});

/* ── loading ── */
async function load(view) {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.loadAsync('/avatar/model.vrm');
  vrm = gltf.userData.vrm;
  if (!vrm) throw new Error('The file is not a VRM model.');
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  VRMUtils.rotateVRM0(vrm);
  vrm.scene.traverse((o) => (o.frustumCulled = false));
  scene.add(vrm.scene);
  if (vrm.lookAt) vrm.lookAt.target = camera;
  if (vrm.expressionManager) rig = resolveRig(vrm.expressionManager);

  applyPose(0);
  vrm.update(0);
  vrm.scene.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(vrm.scene);
  const head = vrm.humanoid.getRawBoneNode('head')?.getWorldPosition(new THREE.Vector3());
  if (view === 'full' || !head) {
    frameTarget = { center: box.getCenter(new THREE.Vector3()), height: (box.max.y - box.min.y) * 1.08 };
  } else {
    // Head and shoulders: from a bit above the head down to mid-chest.
    const top = box.max.y + 0.03;
    const bottom = head.y - (top - head.y) * 1.45;
    frameTarget = { center: new THREE.Vector3(head.x, (top + bottom) / 2, head.z), height: top - bottom };
  }
  frameCamera();
}

/* ── animation ── */
function applyPose(t) {
  const h = vrm.humanoid;
  const s = vrm.meta?.metaVersion === '0' ? -1 : 1; // VRM 0.x faces -Z in model space
  const set = (bone, x, y, z) => h.getNormalizedBoneNode(bone)?.rotation.set(x, y, z);
  const breath = Math.sin(t * 1.7);
  set('leftUpperArm', 0, 0, (-1.2 + breath * 0.015) * s);
  set('rightUpperArm', 0, 0, (1.2 - breath * 0.015) * s);
  set('leftLowerArm', 0, 0, -0.12 * s);
  set('rightLowerArm', 0, 0, 0.12 * s);
  set('spine', breath * 0.012, 0, 0);
  set('chest', breath * 0.018, 0, 0);
  let neck = [0, Math.sin(t * 0.45) * 0.04, 0];
  let head = [Math.sin(t * 0.6) * 0.025, Math.sin(t * 0.33) * 0.07, Math.sin(t * 0.27) * 0.035];
  if (faceMix > 0) {
    // Split the tracked head rotation between neck and head so the turn looks natural.
    const tracked = headRotation(face.head, { mirror: false, vrm0: s === -1 });
    const blend = (idle, share) => idle.map((v, i) => v + (tracked[i] * share - v) * faceMix);
    neck = blend(neck, 0.4);
    head = blend(head, 0.6);
  }
  set('neck', ...neck);
  set('head', ...head);
}

function blinkWeight(t) {
  if (t > nextBlink + 0.2) nextBlink = t + 2.2 + Math.random() * 3.8;
  const p = (t - nextBlink) / 0.2;
  return p >= 0 && p <= 1 ? Math.sin(p * Math.PI) : 0;
}

function expressionWeight(entry, t) {
  if (t < entry.start) return 0;
  const fadeIn = Math.min(1, (t - entry.start) / 0.25);
  const fadeOut = t > entry.until ? Math.max(0, 1 - (t - entry.until) / 0.4) : 1;
  return entry.weight * fadeIn * fadeOut;
}

/** Webcam expressions: all 52 shapes on Perfect Sync models, the VRM presets otherwise. */
function faceWeights(add, mix) {
  if (rig.perfectSync) {
    for (const [key, value] of Object.entries(face.blend)) add(rig.names.get(key.toLowerCase()), value * mix);
    return;
  }
  const p = toVrmPresets(face.blend);
  const name = (n) => rig.names.get(n.toLowerCase());
  if (name('blinkLeft') && name('blinkRight')) {
    add(name('blinkLeft'), p.blinkLeft * mix);
    add(name('blinkRight'), p.blinkRight * mix);
  } else {
    add(name('blink'), ((p.blinkLeft + p.blinkRight) / 2) * mix);
  }
  for (const key of ['aa', 'ou', 'ee', 'happy']) add(name(key), p[key] * mix);
}

/** No webcam: idle blinking and TTS-driven lip-sync. */
function idleWeights(add, t, mix) {
  const blink = blinkWeight(t);
  for (const name of rig.blink) add(name, blink * mix);
  const open = Math.min(1, mouth.value);
  // ARKit jawOpen = 1 is a yawn; speech lives in roughly the lower half of the range.
  for (const name of rig.mouth) add(name, (rig.perfectSync ? open * 0.55 : open) * mix);
  if (rig.mouthShape) add(rig.mouthShape, open * 0.3 * mix);
}

const clock = new THREE.Clock();
function tick() {
  requestAnimationFrame(tick);
  const delta = Math.min(clock.getDelta(), 0.1);
  const t = clock.elapsedTime;
  if (vrm) {
    const target = faceActive() && face.blend ? 1 : 0;
    faceMix += (target - faceMix) * Math.min(1, delta * 6);
    if (Math.abs(target - faceMix) < 0.01) faceMix = target;
    if (performance.now() - mouth.lastSignal > 180) mouth.target = 0;
    mouth.value += (mouth.target - mouth.value) * Math.min(1, delta * 18);
    applyPose(t);
    const em = vrm.expressionManager;
    if (em) {
      const weights = new Map();
      const add = (name, v) => {
        if (name && v > 0) weights.set(name, (weights.get(name) ?? 0) + v);
      };
      if (faceMix > 0) faceWeights(add, faceMix);
      if (faceMix < 1) idleWeights(add, t, 1 - faceMix);
      // Rule-driven emotions win over tracked and idle values with the same name.
      for (const [name, entry] of active) {
        if (em.getExpression(name)) weights.set(name, expressionWeight(entry, t));
        if (t > entry.until + 0.45) active.delete(name);
      }
      // A preset smile (VRoid's Joy) already closes the eyes. A blink or wink on top of it
      // folds the eyelids through the cheek, so blinks give way as the smile grows.
      const happyName = rig.perfectSync ? null : rig.names.get('happy');
      const smile = happyName ? Math.min(1, weights.get(happyName) ?? 0) : 0;
      if (smile > 0) {
        for (const key of ['blink', 'blinkleft', 'blinkright']) {
          const name = rig.names.get(key);
          if (name && weights.has(name)) weights.set(name, weights.get(name) * (1 - smile));
        }
      }
      for (const name of lastWritten) if (!weights.has(name)) em.setValue(name, 0);
      for (const [name, v] of weights) em.setValue(name, Math.min(1, v));
      lastWritten = new Set(weights.keys());
    }
    vrm.update(delta);
  }
  renderer.render(scene, camera);
}

/* ── wiring ── */
const bridge = connect('avatar', (msg) => {
  if (msg.kind === 'mouth') {
    mouth.target = Math.max(0, Math.min(1, msg.level * 1.4));
    mouth.lastSignal = performance.now();
  } else if (msg.kind === 'face') {
    face.blend = smooth(face.blend, msg.blend, 0.6);
    face.head = face.at ? face.head.map((v, i) => v + (msg.head[i] - v) * 0.5) : msg.head;
    face.at = performance.now();
  } else if (msg.kind === 'avatar') {
    const t = clock.elapsedTime;
    active.set(msg.expression, { weight: msg.weight ?? 1, start: t, until: t + (msg.duration ?? 3) });
  }
});

async function main() {
  const res = await fetch('/api/avatar');
  const cfg = await res.json();
  if (!cfg.enabled || !cfg.hasModel) {
    if (params.has('preview')) notice('No avatar configured. Set outputs.avatar in ojakgyo.yaml:', 'avatar: { enabled: true, model: my-avatar.vrm }');
    return;
  }
  try {
    await load(params.get('view') ?? cfg.view);
  } catch (err) {
    notice('Could not load the avatar model.', String(err?.message ?? err));
    return;
  }
  document.title = 'ojakgyo · avatar · ready';
  if (params.has('debug')) {
    // Inspect live state from the browser console: __avatar()
    window.__avatar = () => ({
      rig: { ...rig, names: [...rig.names.values()] },
      face: { ...face, active: faceActive(), mix: faceMix },
      values: Object.fromEntries(vrm.expressionManager?.expressions.map((e) => [e.expressionName, e.weight]) ?? []),
    });
  }
  bridge.send({
    kind: 'avatar-info',
    perfectSync: rig.perfectSync,
    expressions: vrm.expressionManager?.expressions.length ?? 0,
    vrmVersion: vrm.meta?.metaVersion === '0' ? '0.x' : '1.0',
  });

  if (params.has('demo')) {
    // ?demo=1 cycles expressions and talks; ?demo=talk only talks (for checking lip-sync).
    const names = ['happy', 'surprised', 'relaxed', 'angry', 'sad'];
    let i = 0;
    if (params.get('demo') !== 'talk') setInterval(() => {
      const t = clock.elapsedTime;
      active.set(names[i++ % names.length], { weight: 1, start: t, until: t + 2 });
    }, 3500);
    setInterval(() => {
      mouth.target = 0.2 + Math.random() * 0.7;
      mouth.lastSignal = performance.now();
    }, 90);
  }
}

tick();
main();
