// 2D avatar overlay for Inochi2D puppets (.inp / .inx): idle motion, hair and cloth physics,
// blinking, TTS lip-sync, webcam tracking from /tracker and rule-driven parameter changes.
// Query: ?view=bust|full  ?preview=1 (checkerboard)  ?demo=1 / ?demo=talk
// Debug: ?still (no idle motion)  ?set=Name=x,y|Name=x (pin parameters)  ?debug (window.__puppet)
import { connect, el } from './client.js';
import { smooth, toVrmPresets } from './face-map.js';
import { Puppet, decodeTga, parseInx } from './inochi2d-core.js';
import { PuppetRenderer } from './inochi2d-gl.js';

const params = new URLSearchParams(location.search);
if (params.has('preview')) document.body.classList.add('preview');
const still = params.has('still');

function notice(text, detail) {
  const box = el('div', 'notice', text);
  if (detail) {
    box.append(document.createElement('br'));
    box.append(el('code', '', detail));
  }
  document.body.append(box);
}

/* ── state ── */
let puppet = null;
let renderer = null;
let rig = null;
let camera = null;
const mouth = { target: 0, value: 0, lastSignal: 0 };
const face = { blend: null, head: [0, 0, 0], at: 0 };
const faceActive = () => performance.now() - face.at < 500;
let faceMix = 0;
const active = new Map(); // parameter name or expression -> { weight, start, until }
let nextBlink = 1.5;
const pinned = (params.get('set') ?? '')
  .split('|')
  .filter(Boolean)
  .map((s) => {
    const i = s.lastIndexOf('=');
    return [s.slice(0, i), s.slice(i + 1).split(',').map(Number)];
  });

/* ── canvas ── */
const canvas = document.createElement('canvas');
document.body.prepend(canvas);
const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, stencil: true, antialias: true });
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  frame();
}
window.addEventListener('resize', resize);

/**
 * Parameter names used by the Inochi2D sample rigs and Inochi Session's defaults. Other rigs
 * can name things differently; whatever is missing is simply not driven.
 */
function resolveRig(p) {
  const find = (...names) => names.map((n) => p.find(n)).find(Boolean) ?? null;
  return {
    head: find('Head:: Yaw-Pitch'),
    headYaw: find('Head:: Yaw', 'Head:: X'),
    headPitch: find('Head:: Pitch', 'Head:: Y'),
    roll: find('Head:: Roll', 'Head:: Z'),
    body: find('Body:: Yaw-Pitch'),
    bodyYaw: find('Body:: Yaw', 'Body:: X'),
    bodyRoll: find('Body:: Roll', 'Body:: Z'),
    blinkL: find('Eye:: Left:: Blink'),
    blinkR: find('Eye:: Right:: Blink'),
    gazeL: find('Eye:: Left:: Move', 'Eye:: Left:: X'),
    gazeR: find('Eye:: Right:: Move', 'Eye:: Right:: X'),
    mouth: find('Mouth:: Shape'),
    mouthOpen: find('Mouth:: Open'),
    smile: find('Mouth:: Smile', 'Mouth:: Form'),
    breath: find('Breath', 'Body:: Breath'),
  };
}

/** Map t in 0..1 onto a parameter axis. */
const span = (prm, axis, t) => prm.min[axis] + (prm.max[axis] - prm.min[axis]) * Math.max(0, Math.min(1, t));
/** Map s in -1..1 onto a parameter axis, 0 being the middle of its range. */
const signed = (prm, axis, s) => span(prm, axis, (s + 1) / 2);

/* ── framing ── */
function frame() {
  if (!puppet) return;
  const b = puppet.rest;
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  const aspect = canvas.width / canvas.height;
  const view = params.get('view') ?? puppet.view;
  if (view === 'full') {
    camera = { x: b.minX + w / 2, y: b.minY + h / 2, height: Math.max(h, w / aspect) * 1.04 };
  } else {
    // Head and shoulders: the top of the figure, centred on what is drawn there (a tail or a
    // prop lower down would pull the full-body centre sideways).
    const bust = h * 0.42;
    const top = puppet.restTop;
    camera = { x: (top.minX + top.maxX) / 2, y: b.minY + bust / 2, height: Math.max(bust, (top.maxX - top.minX) / aspect) * 1.06 };
  }
}

/* ── animation ── */
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

const clamp1 = (v) => Math.max(-1, Math.min(1, v));

/** This frame's pose in rig-neutral terms: angles -1..1, eyes and mouth 0..1. */
function pose(t) {
  const idle = {
    yaw: still ? 0 : Math.sin(t * 0.33) * 0.12,
    pitch: still ? 0 : Math.sin(t * 0.6) * 0.06,
    roll: still ? 0 : Math.sin(t * 0.27) * 0.08,
    blinkL: still ? 0 : blinkWeight(t),
    blinkR: 0,
    open: Math.min(1, mouth.value),
    smile: 0,
    gaze: 0,
  };
  idle.blinkR = idle.blinkL;
  if (faceMix === 0 || !face.blend) return idle;
  // Tracker angles are radians, already mirrored; about ±30° of yaw fills the rig's range.
  const [pitch, yaw, roll] = face.head;
  const p = toVrmPresets(face.blend);
  const b = face.blend;
  const tracked = {
    yaw: clamp1(yaw / 0.55),
    pitch: clamp1(pitch / 0.45),
    roll: clamp1(roll / 0.5),
    blinkL: p.blinkLeft,
    blinkR: p.blinkRight,
    open: p.aa,
    smile: p.happy,
    gaze: clamp1(((b.eyeLookOutLeft ?? 0) + (b.eyeLookInRight ?? 0) - (b.eyeLookInLeft ?? 0) - (b.eyeLookOutRight ?? 0)) / 1.2),
  };
  const out = {};
  for (const k of Object.keys(idle)) out[k] = idle[k] + (tracked[k] - idle[k]) * faceMix;
  return out;
}

/**
 * Write a pose into the rig. On the Inochi2D sample rigs Head:: Yaw-Pitch x +1 turns the face
 * to the viewer's right and y +1 tilts it up; Head:: Roll +1 leans the top of the head to the
 * viewer's right. The pose uses the VRM overlay's mirror convention (positive yaw faces the
 * viewer's right, positive pitch nods down, positive roll leans left), so pitch and roll flip.
 */
function apply(ps, t) {
  const r = rig;
  const yaw = ps.yaw;
  const pitch = -ps.pitch;
  const roll = -ps.roll;
  if (r.head) puppet.set(r.head, signed(r.head, 0, yaw), signed(r.head, 1, pitch));
  if (r.headYaw) puppet.set(r.headYaw, signed(r.headYaw, 0, yaw));
  if (r.headPitch) puppet.set(r.headPitch, signed(r.headPitch, 0, pitch));
  if (r.roll) puppet.set(r.roll, signed(r.roll, 0, roll));
  if (r.body) puppet.set(r.body, signed(r.body, 0, yaw * 0.35), signed(r.body, 1, pitch * 0.3));
  if (r.bodyYaw) puppet.set(r.bodyYaw, signed(r.bodyYaw, 0, yaw * 0.35));
  if (r.bodyRoll) puppet.set(r.bodyRoll, signed(r.bodyRoll, 0, roll * 0.4));
  if (r.blinkL) puppet.set(r.blinkL, span(r.blinkL, 0, ps.blinkL));
  if (r.blinkR) puppet.set(r.blinkR, span(r.blinkR, 0, ps.blinkR));
  if (r.gazeL) puppet.set(r.gazeL, signed(r.gazeL, 0, ps.gaze));
  if (r.gazeR) puppet.set(r.gazeR, signed(r.gazeR, 0, ps.gaze));
  // Mouth:: Shape (sample rigs): x 0 = frown … 1 = smile, y 0 = closed … 1 = open. Its default
  // (1, 1) is a wide open grin, so the resting mouth is set explicitly: closed, a slight smile.
  if (r.mouth) puppet.set(r.mouth, span(r.mouth, 0, 0.6 + 0.4 * ps.smile), span(r.mouth, 1, ps.open));
  if (r.mouthOpen) puppet.set(r.mouthOpen, span(r.mouthOpen, 0, ps.open));
  if (r.smile) puppet.set(r.smile, span(r.smile, 0, ps.smile));
  if (r.breath) puppet.set(r.breath, span(r.breath, 0, still ? 0 : (Math.sin(t * 1.7) + 1) / 2));
  // Rule-driven parameters (avatar.expression with a parameter name) win while they play.
  for (const [name, entry] of active) {
    const prm = puppet.find(name);
    if (prm) {
      const fade = Math.min(1, expressionWeight(entry, t) / Math.max(entry.weight, 1e-6)); // 0 → 1 → 0
      puppet.set(prm, prm.value[0] + (span(prm, 0, entry.weight) - prm.value[0]) * fade);
    }
    if (t > entry.until + 0.45) active.delete(name);
  }
  for (const [name, v] of pinned) {
    const prm = puppet.find(name);
    if (prm) puppet.set(prm, v[0], v[1] ?? prm.value[1]);
  }
}

let last = performance.now();
let t = 0;
function tick() {
  requestAnimationFrame(tick);
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  t += dt;
  if (!puppet) return;
  const target = faceActive() && face.blend ? 1 : 0;
  faceMix += (target - faceMix) * Math.min(1, dt * 6);
  if (Math.abs(target - faceMix) < 0.01) faceMix = target;
  if (now - mouth.lastSignal > 180) mouth.target = 0;
  mouth.value += (mouth.target - mouth.value) * Math.min(1, dt * 18);
  const ps = pose(t);
  // 'happy' and friends have no fixed meaning on a 2D rig; 'happy' maps onto the smile.
  const happy = active.get('happy');
  if (happy && !puppet.find('happy')) ps.smile = Math.max(ps.smile, expressionWeight(happy, t));
  apply(ps, t);
  puppet.update(dt);
  renderer.render(camera);
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
    active.set(msg.expression, { weight: msg.weight ?? 1, start: t, until: t + (msg.duration ?? 3) });
  }
});

async function loadImages(textures) {
  return Promise.all(textures.map(async (tex) => {
    if (tex.format === 'tga') return decodeTga(tex.bytes);
    // Stored premultiplied already: keep the bytes as they are.
    if (tex.format === 'png') return createImageBitmap(new Blob([tex.bytes], { type: 'image/png' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    console.warn(`ojakgyo: texture format ${tex.format} is not supported`);
    return null;
  }));
}

async function main() {
  const cfg = await (await fetch('/api/avatar')).json();
  if (!cfg.enabled || !cfg.hasModel) {
    if (params.has('preview')) notice('No avatar configured. Set outputs.avatar in ojakgyo.yaml:', 'avatar: { enabled: true, model: my-puppet.inx }');
    return;
  }
  if (!gl) {
    notice('This browser source cannot use WebGL 2, which the 2D avatar needs.');
    return;
  }
  try {
    const res = await fetch('/avatar/model');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { puppet: json, textures } = parseInx(await res.arrayBuffer());
    const images = await loadImages(textures);
    puppet = new Puppet(json);
    puppet.view = cfg.view;
    puppet.rest = puppet.bounds();
    puppet.restTop = puppet.bounds(puppet.rest.minY + (puppet.rest.maxY - puppet.rest.minY) * 0.3);
    rig = resolveRig(puppet);
    renderer = new PuppetRenderer(gl, puppet, images);
  } catch (err) {
    notice('Could not load the Inochi2D puppet.', String(err?.message ?? err));
    return;
  }
  resize();
  const drives = Object.entries(rig).filter(([, p]) => p).map(([k]) => k);
  bridge.send({ kind: 'avatar-info', format: 'inochi2d', parts: puppet.rootParts.length, params: puppet.params.length, tracked: drives });
  if (params.has('debug')) window.__puppet = { puppet, rig, pose: () => pose(t), face, active };
  requestAnimationFrame(() => requestAnimationFrame(() => (document.title = 'ojakgyo · avatar · ready')));

  if (params.has('demo')) {
    if (params.get('demo') !== 'talk') {
      setInterval(() => active.set('happy', { weight: 1, start: t, until: t + 2 }), 7000);
    }
    setInterval(() => {
      mouth.target = 0.2 + Math.random() * 0.7;
      mouth.lastSignal = performance.now();
    }, 90);
  }
}

tick();
main();
