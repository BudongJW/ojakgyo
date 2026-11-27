// Turn a bake (bake.json, positions.bin, layer_*.png from bake.mjs) into an Inochi2D puppet.
// Usage: node build.mjs <bake dir> <order.json> <out.inp>
// Every keyform is the 3D model's own motion projected to 2D: deform = projected offset − node translation.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(HERE, '../../../../package.json'));
const { PNG } = require('pngjs');

const [bakeDir, orderFile, outFile] = process.argv.slice(2);
if (!outFile) throw new Error('usage: node build.mjs <bake dir> <order.json> <out.inp>');
const OUT = resolve(bakeDir);
const bake = JSON.parse(readFileSync(join(OUT, 'bake.json'), 'utf8'));
const order = JSON.parse(readFileSync(orderFile, 'utf8'));
const buf = readFileSync(join(OUT, 'positions.bin'));
const pos = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
const S = bake.size;
const C = [S / 2, S / 2];
const total = bake.layers.reduce((n, l) => n + l.vertexCount, 0);
const RING = 4; // px of edge skirt so MToon outlines and anti-aliasing are not clipped

/* ── deterministic ids ── */
const uuid = (s) => {
  let h = 0x811c9dc5;
  for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0), 0x01000193) >>> 0;
  return h || 1;
};

/* ── states and node translations ── */
const stateIndex = new Map(bake.states.map((s, i) => [s.id, i]));
const A = bake.anchors;
const disp = (name, s) => [A[s][name][0] - A[0][name][0], A[s][name][1] - A[0][name][1]];
const tBody = (s) => (bake.states[s].param === 'Body:: Yaw-Pitch' ? disp('chest', s) : [0, 0]);
const tHead = (s) => {
  const p = bake.states[s].param;
  if (!['Head:: Yaw-Pitch', 'Body:: Yaw-Pitch', 'Breath'].includes(p)) return [0, 0];
  const f = disp('face', s), b = tBody(s);
  return [f[0] - b[0], f[1] - b[1]];
};

/* ── parts: mesh with an outline skirt, texture crop ── */
const offsets = [];
bake.layers.reduce((o, l) => (offsets.push(o), o + l.vertexCount), 0);
const P = (s, li, k) => { const i = (s * total + offsets[li] + k) * 2; return [pos[i], pos[i + 1]]; };

function buildPart(li) {
  const l = bake.layers[li];
  const n = l.vertexCount;
  const base = Array.from({ length: n }, (_, k) => P(0, li, k));
  const tris = l.tris.slice();
  // Boundary edges: used by one triangle. Push a skirt outward, away from the triangle's third vertex.
  const edges = new Map();
  for (let t = 0; t < tris.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = tris[t + e], b = tris[t + ((e + 1) % 3)], c = tris[t + ((e + 2) % 3)];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const rec = edges.get(key);
      if (rec) rec.count++;
      else edges.set(key, { a, b, c, count: 1 });
    }
  }
  const normal = new Map();
  const boundary = [];
  for (const { a, b, c, count } of edges.values()) {
    if (count !== 1) continue;
    const [ax, ay] = base[a], [bx, by] = base[b], [cx, cy] = base[c];
    let nx = -(by - ay), ny = bx - ax;
    const len = Math.hypot(nx, ny) || 1;
    nx /= len; ny /= len;
    if (nx * (cx - ax) + ny * (cy - ay) > 0) { nx = -nx; ny = -ny; }
    for (const v of [a, b]) { const m = normal.get(v) ?? [0, 0]; normal.set(v, [m[0] + nx, m[1] + ny]); }
    boundary.push([a, b]);
  }
  const ringOf = new Map(); // base vertex -> ring vertex
  const verts = base.slice();
  const source = Array.from({ length: n }, (_, k) => k); // which base vertex each vertex follows
  for (const [v, [nx, ny]] of normal) {
    const len = Math.hypot(nx, ny);
    if (len < 1e-6) continue;
    ringOf.set(v, verts.length);
    verts.push([base[v][0] + (nx / len) * RING, base[v][1] + (ny / len) * RING]);
    source.push(v);
  }
  for (const [a, b] of boundary) {
    const ra = ringOf.get(a), rb = ringOf.get(b);
    if (ra === undefined || rb === undefined) continue;
    tris.push(a, b, rb, a, rb, ra);
  }
  // Texture crop around everything the mesh can sample.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of verts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  x0 = Math.max(0, Math.floor(x0) - 2); y0 = Math.max(0, Math.floor(y0) - 2);
  x1 = Math.min(S, Math.ceil(x1) + 2); y1 = Math.min(S, Math.ceil(y1) + 2);
  return { li, name: l.name, group: l.group, image: l.image, verts, source, tris, crop: [x0, y0, x1 - x0, y1 - y0] };
}

function cropTexture(part, premultiply) {
  const src = PNG.sync.read(readFileSync(join(OUT, part.image)));
  const [x0, y0, w, h] = part.crop;
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((y0 + y) * src.width + (x0 + x)) * 4, di = (y * w + x) * 4;
      const a = src.data[si + 3];
      for (let c = 0; c < 3; c++) out.data[di + c] = premultiply ? Math.round((src.data[si + c] * a) / 255) : src.data[si + c];
      out.data[di + 3] = a;
    }
  }
  return out;
}

/* ── parameters ── */
const PARAMS = [
  { name: 'Head:: Yaw-Pitch', vec2: true, min: [-1, -1], max: [1, 1], axes: [[-1, -0.5, 0, 0.5, 1], [-1, 0, 1]] },
  { name: 'Head:: Roll', min: [-1, 0], max: [1, 1], axes: [[-1, 0, 1], [0]] },
  { name: 'Body:: Yaw-Pitch', vec2: true, min: [-1, -1], max: [1, 1], axes: [[-1, 0, 1], [-1, 0, 1]] },
  { name: 'Body:: Roll', min: [-1, 0], max: [1, 1], axes: [[-1, 0, 1], [0]] },
  { name: 'Breath', min: [0, 0], max: [1, 1], axes: [[0, 1], [0]] },
  { name: 'Eye:: Left:: Blink', min: [0, 0], max: [1, 1], axes: [[0, 1], [0]] },
  { name: 'Eye:: Right:: Blink', min: [0, 0], max: [1, 1], axes: [[0, 1], [0]] },
  { name: 'Eye:: Left:: Move', min: [-1, 0], max: [1, 1], axes: [[-1, 0, 1], [0]], only: /Iris|Highlight/ },
  { name: 'Eye:: Right:: Move', min: [-1, 0], max: [1, 1], axes: [[-1, 0, 1], [0]], only: /Iris|Highlight/ },
  { name: 'Mouth:: Shape', vec2: true, min: [0, 0], max: [1, 1], axes: [[0, 0.6, 1], [0, 0.5, 1]], defaults: [0.6, 0] },
  ...['happy', 'angry', 'sad', 'relaxed', 'surprised'].map((name) => ({ name, min: [0, 0], max: [1, 1], axes: [[0, 1], [0]] })),
];
// Hair pendulums: procedural bends that grow from root to tip, driven by SimplePhysics nodes.
const PHYS = [
  { name: 'Hair:: Front:: Physics', parts: ['Hair:: Front'], amp: 0.05, freq: 1.4, scale: 2.0, pendulum: 150 },
  { name: 'Hair:: Side:: Left:: Physics', parts: ['Hair:: Side:: Left'], amp: 0.09, freq: 1.1, scale: 2.5, pendulum: 200 },
  { name: 'Hair:: Side:: Right:: Physics', parts: ['Hair:: Side:: Right'], amp: 0.09, freq: 1.1, scale: 2.5, pendulum: 200 },
  { name: 'Hair:: Lock:: Left:: Physics', parts: ['Hair:: Lock:: Left'], amp: 0.09, freq: 1.2, scale: 2.5, pendulum: 200 },
  { name: 'Hair:: Lock:: Right:: Physics', parts: ['Hair:: Lock:: Right'], amp: 0.09, freq: 1.2, scale: 2.5, pendulum: 200 },
  { name: 'Hair:: Back:: Physics', parts: ['Hair:: Back'], amp: 0.05, freq: 1.0, scale: 2.0, pendulum: 220 },
  { name: 'Hair:: Ponytail:: Physics', parts: ['Hair:: Ponytail:: Back', 'Hair:: Ponytail', 'Hair:: Ponytail:: Front', 'Ribbon:: Back', 'Ribbon:: Front'], amp: 0.13, freq: 0.8, scale: 3.0, pendulum: 250 },
];
for (const p of PHYS) PARAMS.push({ name: p.name, vec2: true, min: [-1, -1], max: [1, 1], axes: [[-1, 0, 1], [-1, 0, 1]], phys: p });
for (const p of PARAMS) { p.uuid = uuid(`param:${p.name}`); p.bindings = []; p.defaults ??= [p.vec2 ? 0 : p.min[0] < 0 ? 0 : 0, 0]; }
const param = (name) => PARAMS.find((p) => p.name === name);
const grid = (p, fn) => p.axes[0].map((x) => (p.axes[1] ?? [0]).map((y) => fn(x, y)));
const stateAt = (p, x, y) => {
  const at = p.vec2 ? [x, y] : [x];
  return stateIndex.get(`${p.name}@${at.join(',')}`);
};

/* ── nodes ── */
const nodeJson = (name, trans, children = [], extra = {}) => ({
  uuid: uuid(`node:${name}`), name, type: 'Node', enabled: true, zsort: 0,
  transform: { trans: [trans[0], trans[1], 0], rot: [0, 0, 0], scale: [1, 1] }, lockToRoot: false, children, ...extra,
});
const bodyPivot = [A[0].hips[0] - C[0], A[0].hips[1] - C[1]];
const headPivotAbs = [A[0].head[0] - C[0], A[0].head[1] - C[1]];
const headPivot = [headPivotAbs[0] - bodyPivot[0], headPivotAbs[1] - bodyPivot[1]];
const body = nodeJson('Body', bodyPivot);
const head = nodeJson('Head', headPivot);
body.children.push(head);
const root = { ...nodeJson('Root', [0, 0], [body]) };

// Translation bindings on the Body and Head nodes (the parts' deforms exclude them).
const transBinding = (node, p, prop, fn) => {
  const values = grid(p, (x, y) => { const s = stateAt(p, x, y); return s === undefined ? 0 : +fn(s).toFixed(3); });
  if (values.flat().every((v) => Math.abs(v) < 0.05)) return;
  p.bindings.push({ node: node.uuid, param_name: prop, values, isSet: grid(p, () => true), interpolate_mode: 'Linear' });
};
for (const name of ['Head:: Yaw-Pitch', 'Body:: Yaw-Pitch', 'Breath']) {
  const p = param(name);
  transBinding(body, p, 'transform.t.x', (s) => tBody(s)[0]);
  transBinding(body, p, 'transform.t.y', (s) => tBody(s)[1]);
  transBinding(head, p, 'transform.t.x', (s) => tHead(s)[0]);
  transBinding(head, p, 'transform.t.y', (s) => tHead(s)[1]);
}
// Roll: rotate the head about the neck and the body about the hips. +1 leans the top to the viewer's right.
param('Head:: Roll').bindings.push({ node: head.uuid, param_name: 'transform.r.z', values: [[-0.22], [0], [0.22]], isSet: [[true], [true], [true]], interpolate_mode: 'Linear' });
param('Body:: Roll').bindings.push({ node: body.uuid, param_name: 'transform.r.z', values: [[-0.07], [0], [0.07]], isSet: [[true], [true], [true]], interpolate_mode: 'Linear' });

/*
 * Turning the head makes triangles near the far edge face away; projected, they fold back over the
 * surface. A 2D mesh has no back-face culling, so in those keyforms every vertex whose triangles have
 * all flipped is moved onto its nearest still-visible neighbour, collapsing the fold to the silhouette.
 * Hair cards are double-sided, but the rest render only shows the side facing the camera, so a hair
 * triangle that turns over would show the wrong side too and is collapsed the same way.
 */
const FOLDS = /Yaw-Pitch/;
function unfold(part, s) {
  const l = bake.layers[part.li];
  const n = l.vertexCount;
  const at = Array.from({ length: n }, (_, k) => P(s, part.li, k));
  const rest = Array.from({ length: n }, (_, k) => P(0, part.li, k));
  const area = (q, a, b, c) => (q[b][0] - q[a][0]) * (q[c][1] - q[a][1]) - (q[c][0] - q[a][0]) * (q[b][1] - q[a][1]);
  const visible = new Uint8Array(n);
  const nbr = Array.from({ length: n }, () => new Set());
  for (let t = 0; t < l.tris.length; t += 3) {
    const [a, b, c] = [l.tris[t], l.tris[t + 1], l.tris[t + 2]];
    const r0 = area(rest, a, b, c), r1 = area(at, a, b, c);
    if (Math.sign(r0) === Math.sign(r1) && Math.abs(r1) > Math.abs(r0) * 0.05) visible[a] = visible[b] = visible[c] = 1;
    nbr[a].add(b).add(c); nbr[b].add(a).add(c); nbr[c].add(a).add(b);
  }
  // Multi-source BFS from visible vertices: each hidden vertex takes its nearest visible vertex's position.
  const from = new Int32Array(n).fill(-1);
  const queue = [];
  for (let k = 0; k < n; k++) if (visible[k]) { from[k] = k; queue.push(k); }
  for (let qi = 0; qi < queue.length; qi++) {
    const k = queue[qi];
    for (const m of nbr[k]) if (from[m] < 0) { from[m] = from[k]; queue.push(m); }
  }
  const out = at.map((p, k) => (from[k] >= 0 && from[k] !== k ? at[from[k]] : p));
  // Ring vertices follow their base vertex.
  return part.source.map((k) => out[k]);
}

/* ── parts, deforms, textures ── */
const textures = [];
const zOf = (i) => +((order.length / 2 - i) * 0.01).toFixed(3);
const parts = order.map((name) => buildPart(bake.layers.findIndex((l) => l.name === name)));
for (const [zi, part] of parts.entries()) {
  const parent = part.group === 'head' ? head : body;
  const parentAbs = part.group === 'head' ? headPivotAbs : bodyPivot;
  const [x0, y0, w, h] = part.crop;
  const centre = [x0 + w / 2 - C[0], y0 + h / 2 - C[1]];
  const trans = [centre[0] - parentAbs[0], centre[1] - parentAbs[1]];
  const verts = [], uvs = [];
  for (const [x, y] of part.verts) {
    verts.push(+(x - C[0] - centre[0]).toFixed(2), +(y - C[1] - centre[1]).toFixed(2));
    uvs.push(+((x - x0) / w).toFixed(5), +((y - y0) / h).toFixed(5));
  }
  const texId = textures.length;
  textures.push(PNG.sync.write(cropTexture(part, true)));
  const node = {
    uuid: uuid(`part:${part.name}`), name: part.name, type: 'Part', enabled: true, zsort: zOf(zi),
    transform: { trans: [+trans[0].toFixed(2), +trans[1].toFixed(2), 0], rot: [0, 0, 0], scale: [1, 1] }, lockToRoot: false,
    mesh: { verts, uvs, indices: part.tris, origin: [0, 0] }, textures: [texId], blend_mode: 'Normal', tint: [1, 1, 1], screenTint: [0, 0, 0],
    mask_threshold: 0.5, opacity: 1, psdLayerPath: '',
  };
  parent.children.push(node);
  part.node = node;

  // 3D-derived deforms.
  const anc = (s) => { const b = tBody(s); if (part.group !== 'head') return b; const hd = tHead(s); return [b[0] + hd[0], b[1] + hd[1]]; };
  for (const p of PARAMS) {
    if (p.phys || p.name.endsWith('Roll')) continue;
    if (p.only && !p.only.test(part.name)) continue;
    let peak = 0;
    const values = grid(p, (x, y) => {
      const s = stateAt(p, x, y);
      if (s === undefined) return part.source.map(() => [0, 0]);
      const t = anc(s);
      const moved = FOLDS.test(p.name) ? unfold(part, s) : null;
      return part.source.map((k) => {
        const a = moved ? moved[k] : P(s, part.li, k), r = P(0, part.li, k);
        const d = [a[0] - r[0] - t[0], a[1] - r[1] - t[1]].map((v) => Math.round(v * 10) / 10 || 0);
        peak = Math.max(peak, Math.abs(d[0]), Math.abs(d[1]));
        return d;
      });
    });
    // Head parts ride the Head node through body turns and breathing; keep only real residual motion.
    if (peak < (part.group === 'head' && /^(Body|Breath)/.test(p.name) ? 1 : 0.3)) continue;
    p.bindings.push({ node: node.uuid, param_name: 'deform', values, isSet: grid(p, () => true), interpolate_mode: 'Linear' });
  }
}

// Side hair sits in front of the face, but once the head turns away from that side it belongs behind it
// (just in front of the clothes); a zSort binding on Head:: Yaw-Pitch flips it, as the sample rigs do.
{
  const p = param('Head:: Yaw-Pitch');
  const zClothes = parts.find((q) => q.name === 'Body:: Clothes').node.zsort;
  for (const [name, away] of [['Hair:: Side:: Left', 1], ['Hair:: Side:: Right', -1]]) {
    const q = parts.find((x) => x.name === name);
    if (!q) continue;
    const behind = +(zClothes - 0.005 - q.node.zsort).toFixed(3);
    p.bindings.push({ node: q.node.uuid, param_name: 'zSort', values: grid(p, (x) => (x * away >= 0.5 ? behind : 0)), isSet: grid(p, () => true), interpolate_mode: 'Linear' });
  }
}

// Physics: one pendulum per hair group, hung from the group's root under the Head node.
for (const p of PARAMS.filter((q) => q.phys)) {
  const group = parts.filter((q) => p.phys.parts.includes(q.name));
  if (!group.length) continue;
  let rootY = Infinity, tipY = -Infinity, sumX = 0, nx = 0;
  for (const q of group) for (const [x, y] of q.verts) { rootY = Math.min(rootY, y); tipY = Math.max(tipY, y); sumX += x; nx++; }
  const len = tipY - rootY;
  const bend = (y) => Math.pow(Math.min(1, Math.max(0, (y - rootY - 0.12 * len) / (0.88 * len))), 1.6);
  for (const q of group) {
    const values = grid(p, (gx, gy) => q.verts.map(([, y]) => {
      const t = bend(y);
      return [Math.round(gx * p.phys.amp * len * t * 10) / 10 || 0, Math.round(gy * p.phys.amp * 0.3 * len * t * 10) / 10 || 0];
    }));
    p.bindings.push({ node: q.node.uuid, param_name: 'deform', values, isSet: grid(p, () => true), interpolate_mode: 'Linear' });
  }
  const anchorAbs = [sumX / nx - C[0], rootY - C[1]];
  head.children.push({
    uuid: uuid(`phys:${p.name}`), name: `${p.name.replace(':: Physics', '')}:: Pendulum`, type: 'SimplePhysics', enabled: true, zsort: 0,
    transform: { trans: [+(anchorAbs[0] - headPivotAbs[0]).toFixed(2), +(anchorAbs[1] - headPivotAbs[1]).toFixed(2), 0], rot: [0, 0, 0], scale: [1, 1] }, lockToRoot: false,
    param: p.uuid, model_type: 'SpringPendulum', map_mode: 'XY', gravity: 1, length: p.phys.pendulum, frequency: p.phys.freq,
    angle_damping: 0.5, length_damping: 0.5, output_scale: [p.phys.scale, p.phys.scale],
  });
}

/* ── write .inp ── */
const norm = (p, k, v) => (p.max[k] === p.min[k] ? 0 : +((v - p.min[k]) / (p.max[k] - p.min[k])).toFixed(4));
const puppet = {
  meta: {
    name: 'Kkachi 2D', version: 'v0.8.0', rigger: 'ojakgyo', artist: 'ojakgyo', rights: null, copyright: 'CC0 1.0 (public domain dedication)',
    licenseURL: 'https://creativecommons.org/publicdomain/zero/1.0/', contact: 'https://github.com/BudongJW/ojakgyo', reference: null,
    thumbnailId: 4294967295, preservePixels: false,
  },
  physics: { pixelsPerMeter: 1000, gravity: 9.8 },
  nodes: root,
  param: PARAMS.map((p) => ({
    uuid: p.uuid, name: p.name, is_vec2: !!p.vec2, min: p.min, max: p.max, defaults: p.defaults,
    axis_points: [p.axes[0].map((v) => norm(p, 0, v)), (p.axes[1] ?? [0]).map((v) => (p.vec2 ? norm(p, 1, v) : 0))],
    bindings: p.bindings,
  })),
  automation: null,
};
const json = Buffer.from(JSON.stringify(puppet));
const chunks = [Buffer.from('TRNSRTS\0', 'latin1'), u32(json.length), json, Buffer.from('TEX_SECT', 'latin1'), u32(textures.length)];
for (const t of textures) chunks.push(u32(t.length), Buffer.from([0]), t);
writeFileSync(outFile, Buffer.concat(chunks));
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; }

const nVerts = parts.reduce((n, q) => n + q.verts.length, 0);
const nBind = PARAMS.reduce((n, p) => n + p.bindings.length, 0);
console.log(`wrote ${outFile}: ${parts.length} parts, ${nVerts} vertices, ${PARAMS.length} parameters, ${nBind} bindings, ${textures.length} textures, ${(Buffer.concat(chunks).length / 1048576).toFixed(1)} MB`);
for (const p of PARAMS) console.log(`  ${p.name.padEnd(30)} ${p.bindings.length} bindings`);
