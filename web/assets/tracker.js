// Webcam face tracking with MediaPipe Face Landmarker. Runs in a normal browser window
// (OBS browser sources cannot open cameras) and streams ARKit-style blendshapes plus
// head rotation to the bridge, which relays them to /overlay/avatar.
import * as THREE from 'three';
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { connect, el } from './client.js';
import { mirrorBlend } from './face-map.js';
import { detectLang, setLang, t, translatePage } from './i18n.js';

setLang(detectLang());
translatePage();
document.getElementById('host').textContent = location.host;

const video = document.getElementById('video');
const canvas = document.getElementById('dots');
const ctx = canvas.getContext('2d');
const stage = document.getElementById('stage');
const stateEl = document.getElementById('state');
const toggle = document.getElementById('toggle');
const cameraSelect = document.getElementById('camera');
const mirrorBox = document.getElementById('mirror');
const params = new URLSearchParams(location.search);

const bridge = connect('tracker', () => {});
let landmarker = null;
let stream = null;
let running = false;
let lastVideoTime = -1;
let lastSent = 0;
let frames = 0;
let fpsAt = performance.now();
let fps = 0;
let faceSeen = false;

const METERS = [
  ['jawOpen', 'jawOpen'],
  ['eyeBlinkLeft', 'eyeBlinkLeft'],
  ['eyeBlinkRight', 'eyeBlinkRight'],
  ['mouthSmile', null],
  ['browInnerUp', 'browInnerUp'],
  ['mouthPucker', 'mouthPucker'],
];
const meterEls = new Map();
for (const [label] of METERS) {
  const row = el('div', 'meter');
  const bar = el('div', 'bar');
  const fill = el('i');
  bar.append(fill);
  const val = el('span', 'val', '0.00');
  row.append(el('span', '', label), bar, val);
  document.getElementById('meters').append(row);
  meterEls.set(label, { fill, val });
}
const headEl = el('div', 'meter');
const headVal = el('span', 'val', '');
headVal.style.gridColumn = '2 / 4';
headVal.style.textAlign = 'left';
headEl.append(el('span', '', 'head'), headVal);
document.getElementById('meters').append(headEl);

function setState(key, extra = '') {
  stateEl.replaceChildren(el('b', '', t(key)));
  if (extra) stateEl.append(document.createTextNode(` · ${extra}`));
}

async function listCameras() {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  const current = cameraSelect.value;
  cameraSelect.replaceChildren(...devices.map((d, i) => {
    const o = el('option', '', d.label || `${t('tracker.camera')} ${i + 1}`);
    o.value = d.deviceId;
    return o;
  }));
  if (current) cameraSelect.value = current;
}

async function loadModel() {
  if (landmarker) return landmarker;
  setState('tracker.loading');
  const files = await FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm');
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: '/vendor/models/face_landmarker.task', delegate },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });
  try {
    landmarker = await FaceLandmarker.createFromOptions(files, options(params.get('delegate') === 'cpu' ? 'CPU' : 'GPU'));
  } catch {
    landmarker = await FaceLandmarker.createFromOptions(files, options('CPU'));
  }
  return landmarker;
}

async function start() {
  toggle.disabled = true;
  try {
    await loadModel();
    stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: cameraSelect.value ? { exact: cameraSelect.value } : undefined, width: 640, height: 480, frameRate: 30 },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    document.getElementById('idle').hidden = true;
    running = true;
    toggle.textContent = t('tracker.stop');
    setState('tracker.running');
    await listCameras();
  } catch (err) {
    setState('tracker.failed', String(err?.message ?? err));
  } finally {
    toggle.disabled = false;
  }
}

function stop() {
  running = false;
  stream?.getTracks().forEach((tr) => tr.stop());
  stream = null;
  toggle.textContent = t('tracker.start');
  document.getElementById('idle').hidden = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  setState('tracker.stopped');
}

toggle.addEventListener('click', () => (running ? stop() : start()));
mirrorBox.addEventListener('change', () => stage.classList.toggle('mirror', mirrorBox.checked));

const m4 = new THREE.Matrix4();
const euler = new THREE.Euler();
const q = new THREE.Quaternion();

// Neutral pose: a camera above or below the screen sees a resting head as tilted. The
// stored rest rotation is removed from every frame, so "looking at the screen" reads as zero.
const NEUTRAL_KEY = 'ojakgyo.tracker.neutral';
let neutralInv = null;
let lastRaw = null;
function setNeutral(quat) {
  neutralInv = quat ? quat.clone().invert() : null;
  if (quat) localStorage.setItem(NEUTRAL_KEY, JSON.stringify(quat.toArray()));
  else localStorage.removeItem(NEUTRAL_KEY);
}
try {
  const saved = JSON.parse(localStorage.getItem(NEUTRAL_KEY) ?? 'null');
  if (Array.isArray(saved) && saved.length === 4 && saved.every(Number.isFinite)) neutralInv = new THREE.Quaternion(...saved).invert();
} catch {}
document.getElementById('calibrate').addEventListener('click', () => lastRaw && setNeutral(lastRaw));
document.getElementById('reset').addEventListener('click', () => setNeutral(null));

function loop() {
  requestAnimationFrame(loop);
  if (!running || !landmarker || video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  const now = performance.now();
  const res = landmarker.detectForVideo(video, now);

  frames++;
  if (now - fpsAt > 1000) {
    fps = Math.round((frames * 1000) / (now - fpsAt));
    frames = 0;
    fpsAt = now;
    setState('tracker.running', `${fps} fps · ${faceSeen ? t('tracker.face') : t('tracker.noFace')}${neutralInv ? ` · ${t('tracker.calibrated')}` : ''}`);
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const landmarks = res.faceLandmarks?.[0];
  const shapes = res.faceBlendshapes?.[0]?.categories;
  const matrix = res.facialTransformationMatrixes?.[0]?.data;
  faceSeen = Boolean(landmarks && shapes && matrix);
  if (!faceSeen) return;

  ctx.fillStyle = 'rgba(232, 163, 61, 0.9)';
  for (let i = 0; i < landmarks.length; i += 3) ctx.fillRect(landmarks[i].x * canvas.width - 1, landmarks[i].y * canvas.height - 1, 2, 2);

  let blend = {};
  for (const c of shapes) if (c.categoryName !== '_neutral') blend[c.categoryName] = Math.round(c.score * 1000) / 1000;
  q.setFromRotationMatrix(m4.fromArray(matrix));
  lastRaw = q.clone();
  if (neutralInv) q.premultiply(neutralInv);
  euler.setFromQuaternion(q, 'YXZ');
  let head = [euler.x, euler.y, euler.z];
  if (mirrorBox.checked) {
    blend = mirrorBlend(blend);
    head = [head[0], -head[1], -head[2]];
  }

  for (const [label, key] of METERS) {
    const v = key ? blend[key] ?? 0 : ((blend.mouthSmileLeft ?? 0) + (blend.mouthSmileRight ?? 0)) / 2;
    const m = meterEls.get(label);
    m.fill.style.width = `${Math.round(v * 100)}%`;
    m.val.textContent = v.toFixed(2);
  }
  const [pitch, yaw, roll] = head.map((r) => Math.round((r * 180) / Math.PI));
  headVal.textContent = `pitch ${pitch}°  yaw ${yaw}°  roll ${roll}°`;

  if (now - lastSent >= 33) {
    lastSent = now;
    bridge.send({ kind: 'face', blend, head });
  }
}

setState('tracker.ready');
listCameras().catch(() => {});
requestAnimationFrame(loop);
if (params.has('autostart')) start();
