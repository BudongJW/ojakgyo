// Build a new VRM from the three CC0 VRoid girls:
//   face   = a new point in the face shape space learned from all three (head-aligned PCA),
//            blended only where the hair and the neck seam do not depend on it
//   body   = Victoria Rubin's rig, hair and dress
//   colour = clusters learned per texture (k-means in Lab) moved to a magpie palette
// Usage: VROID_SAMPLES=<folder> node build.mjs [--weights 0.34,0.33,0.33] [--out kkachi-full.vrm]
//        [--title Kkachi] [--thumbnail portrait.png] [--plain]
// then:  ojakgyo avatar optimize kkachi-full.vrm -o kkachi.vrm --max 1024
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { chroma, decodePng, encodePng, hexToLab, hue, kmeans, transfer } from './color.mjs';
import { NAMES, faceData, pca } from './face-space.mjs';
import { accessor, imageBytes, loadVrm, nodeIndex, refreshBounds, repack, worldPos } from './lib.mjs';

const { values } = parseArgs({ options: { weights: { type: 'string', default: '0.34,0.33,0.33' }, out: { type: 'string', default: 'kkachi-full.vrm' }, title: { type: 'string', default: 'Kkachi' }, plain: { type: 'boolean', default: false }, thumbnail: { type: 'string' } } });
const W = values.weights.split(',').map(Number);
if (W.length !== 3 || Math.abs(W.reduce((a, b) => a + b, 0) - 1) > 1e-6) throw new Error('--weights needs three numbers that sum to 1 (Shino, Vita, Victoria)');

const models = NAMES.map(loadVrm);
const base = models[2];
const faces = models.map(faceData);
const bf = faces[2];

/* ── 1. face: a new point in the learned shape space ── */
const { coords } = pca(faces.map((f) => f.local));
const newCoord = [0, 1].map((k) => coords.reduce((acc, c, s) => acc + W[s] * c[k], 0));
console.log(`face weights ${W.join(' / ')} → PC1 ${(newCoord[0] * 1000).toFixed(2)} mm, PC2 ${(newCoord[1] * 1000).toFixed(2)} mm`);

const smooth = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
// Keep the skull under the hair and the neck seam of the base; blend the face in between.
const maskOf = (y) => Math.min(smooth(-0.005, 0.025, y), 1 - smooth(0.105, 0.125, y));

const prim = bf.prim;
const pos = accessor(base, prim.attributes.POSITION);
const nrm = prim.attributes.NORMAL !== undefined ? accessor(base, prim.attributes.NORMAL) : null;
const others = faces.map((f, s) => ({ pos: accessor(models[s], f.prim.attributes.POSITION), nrm: f.prim.attributes.NORMAL !== undefined ? accessor(models[s], f.prim.attributes.NORMAL) : null }));
const mask = new Float64Array(pos.length / 3);
for (let v = 0; v < pos.length / 3; v++) {
  const i = v * 3;
  mask[v] = maskOf(bf.local[i + 1]);
  for (let k = 0; k < 3; k++) {
    const blended = faces.reduce((acc, f, s) => acc + W[s] * f.local[i + k], 0);
    pos[i + k] = bf.head[k] + bf.local[i + k] + mask[v] * (blended - bf.local[i + k]);
  }
  if (nrm) {
    const n = [0, 1, 2].map((k) => nrm[i + k] + mask[v] * (others.reduce((acc, o, s) => acc + W[s] * o.nrm[i + k], 0) - nrm[i + k]));
    const len = Math.hypot(...n) || 1;
    for (let k = 0; k < 3; k++) nrm[i + k] = n[k] / len;
  }
}
refreshBounds(base, prim.attributes.POSITION);

// Expressions: blend each morph target's offsets the same way (same template, same order).
const names = (m) => m.json.meshes.find((x) => /^Face/.test(x.name)).extras?.targetNames ?? m.json.meshes.find((x) => /^Face/.test(x.name)).primitives[0].extras?.targetNames;
const baseNames = names(base);
for (const m of models) if (JSON.stringify(names(m)) !== JSON.stringify(baseNames)) throw new Error('morph targets differ between the samples');
const seenTargets = new Set();
for (const p of base.json.meshes[bf.meshIndex].primitives) {
  p.targets?.forEach((t, ti) => {
    for (const attr of ['POSITION', 'NORMAL']) {
      if (t[attr] === undefined || seenTargets.has(t[attr])) continue;
      seenTargets.add(t[attr]);
      const mine = accessor(base, t[attr]);
      const theirs = models.map((m, s) => accessor(m, faces[s].prim.targets[ti][attr]));
      for (let v = 0; v < mine.length / 3; v++) for (let k = 0; k < 3; k++) {
        const i = v * 3 + k;
        mine[i] += mask[v] * (theirs.reduce((acc, a, s) => acc + W[s] * a[i], 0) - mine[i]);
      }
      if (attr === 'POSITION') refreshBounds(base, t[attr]);
    }
  });
}

// Eye pivots follow the blended eyes, so gaze still turns around the eyeball centre.
const parentOf = new Map();
base.json.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parentOf.set(c, i)));
for (const name of ['J_Adj_L_FaceEyeSet', 'J_Adj_R_FaceEyeSet', 'J_Adj_L_FaceEye', 'J_Adj_R_FaceEye']) {
  let found = true;
  const local = [0, 1, 2].map((k) => models.reduce((acc, m, s) => {
    let idx;
    try { idx = nodeIndex(m, name); } catch { found = false; return acc; }
    return acc + W[s] * (worldPos(m, idx)[k] - faces[s].head[k]);
  }, 0));
  if (!found) continue;
  const node = nodeIndex(base, name);
  const target = local.map((v, k) => bf.head[k] + v);
  const parentWorld = worldPos(base, parentOf.get(node));
  base.json.nodes[node].translation = target.map((v, k) => v - parentWorld[k]);
}
// Children of the eye sets keep their own offsets; recompute every joint's inverse bind matrix.
for (const skin of base.json.skins) {
  const ibm = accessor(base, skin.inverseBindMatrices);
  skin.joints.forEach((j, n) => {
    const w = worldPos(base, j);
    ibm[n * 16 + 12] = -w[0];
    ibm[n * 16 + 13] = -w[1];
    ibm[n * 16 + 14] = -w[2];
  });
}

/* ── 2. colour: learned clusters → magpie palette ── */
const P = {
  wing: hexToLab('#232938'), wingSoft: hexToLab('#2d3448'), slate: hexToLab('#3b4459'),
  white: hexToLab('#f4f6f9'), teal: hexToLab('#2a919c'), tealTip: hexToLab('#3fb0b8'), gold: hexToLab('#d8a24a'),
  hair: hexToLab('#23283a'), hairMid: hexToLab('#2c5f70'),
};
const isWhite = (c) => c[0] > 90 && chroma(c) < 8;
const isPink = (c) => (hue(c) > 290 || hue(c) < 20) && chroma(c) > 10;
const isGold = (c) => hue(c) > 60 && hue(c) < 95 && chroma(c) > 35;

const rules = {
  // dress: white blouse stays white, cream/beige/pink become the black of a magpie's wings,
  // deep pink becomes the blue-green sheen, gold trim stays
  // (the top half of this texture is the blouse: its pale pink frills turn white there)
  F00_002_Onepiece_01: (c, u, v) => (isGold(c) ? P.gold : isWhite(c) ? P.white : isPink(c) && chroma(c) > 25 ? P.teal : v < 0.5 && isPink(c) ? P.white : c[0] > 88 ? P.wing : P.wingSoft),
  F00_002_Shoes_01: (c) => (isGold(c) ? P.gold : chroma(c) > 45 ? P.teal : c[0] > 85 ? P.wing : P.wingSoft),
  // body: skin untouched; only the mauve trim takes the accent colour
  F00_002_Body_00: (c) => (isPink(c) && c[0] < 70 ? P.teal : null),
  F00_000_Hair_00_01: (c) => (chroma(c) > 20 ? P.tealTip : chroma(c) > 8 ? P.hairMid : P.hair),
  F00_000_Hair_00_02: () => P.hair,
  // iris: navy → amber, sky blue → gold, darkest first
  F00_000_EyeIris_00: (c) => (c[0] < 33 ? hexToLab('#5a2e0e') : c[0] < 50 ? hexToLab('#9a5718') : c[0] < 70 ? hexToLab('#d9952f') : hexToLab('#f5cf6e')),
  F00_000_EyeHighlight_00: (c) => (chroma(c) > 8 ? hexToLab('#fff3d6') : null),
};
const ks = { F00_002_Onepiece_01: 7, F00_002_Shoes_01: 5, F00_002_Body_00: 6, F00_000_Hair_00_01: 3, F00_000_Hair_00_02: 3, F00_000_EyeIris_00: 4, F00_000_EyeHighlight_00: 3 };
const replaced = new Map();
if (!values.plain) {
  base.json.images.forEach((img, i) => {
    const rule = rules[img.name];
    if (!rule) return;
    const png = decodePng(imageBytes(base, i));
    const { centroids } = kmeans(png, ks[img.name]);
    const targets = rule.length > 1 ? (j, u, v) => rule(centroids[j], u, v) : centroids.map((c) => rule(c));
    const keepTint = /Hair|Iris/.test(img.name) ? 0.25 : 0.5;
    // Clothes jump between far-apart targets (white stays, cream turns black): assign sharply
    // there so white does not pick up grey from its neighbours; gradients elsewhere stay soft.
    const sigma = /Onepiece|Shoes|Body/.test(img.name) ? 4.5 : 9;
    replaced.set(img.bufferView, encodePng(transfer(png, centroids, targets, { keepTint, sigma })));
    console.log(`recoloured ${img.name}: ${centroids.length} colour groups learned`);
  });

  // Colours carried by the materials (MToon) rather than the textures.
  const rgb = (hex, a = 1) => [1, 3, 5].map((o) => parseInt(hex.slice(o, o + 2), 16) / 255).concat(a);
  const mat = {
    F00_000_Hair_00_HAIR_01: { _Color: rgb('#ffffff'), _ShadeColor: rgb('#9aa3bd'), _EmissionColor: rgb('#0a0c12') },
    F00_000_Hair_00_HAIR_02: { _Color: rgb('#ffffff'), _ShadeColor: rgb('#9aa3bd'), _EmissionColor: rgb('#0a0c12') },
    F00_000_HairBack_00_HAIR: { _Color: rgb('#2d3347'), _ShadeColor: rgb('#1a1e2b'), _EmissionColor: rgb('#06070b') },
    F00_000_Hair_00_HAIR_03: { _Color: rgb('#eef2f6'), _ShadeColor: rgb('#a7b4c4'), _EmissionColor: rgb('#1b1f27') },
    F00_000_00_FaceBrow_00_FACE: { _Color: rgb('#2c3242'), _ShadeColor: rgb('#1f2430') },
    F00_000_00_FaceEyelash_00_FACE: { _Color: rgb('#1b1e29'), _ShadeColor: rgb('#14161f') },
    F00_000_00_FaceEyeline_00_FACE: { _Color: rgb('#22252f'), _ShadeColor: rgb('#181a22') },
    F00_002_01_Tops_01_CLOTH: { _ShadeColor: rgb('#dfe5ef') },
    F00_002_01_Shoes_01_CLOTH: { _ShadeColor: rgb('#dfe5ef') },
  };
  const props = base.json.extensions.VRM.materialProperties;
  for (const mp of props) {
    const key = mp.name.replace(/ \(Instance\)/g, '');
    const set = mat[key];
    if (!set) continue;
    Object.assign(mp.vectorProperties, set);
    const gm = base.json.materials.find((m) => m.name === mp.name);
    if (gm?.pbrMetallicRoughness && set._Color) gm.pbrMetallicRoughness.baseColorFactor = set._Color;
    if (gm && set._EmissionColor) gm.emissiveFactor = set._EmissionColor.slice(0, 3);
  }
}

/* ── 3. identity ── */
const meta = base.json.extensions.VRM.meta;
Object.assign(meta, {
  title: values.title,
  version: '1.0',
  author: 'ojakgyo',
  contactInformation: 'https://github.com/BudongJW/ojakgyo',
  reference: 'Built from the VRoid sample characters Sendagaya Shino, Vita and Victoria Rubin (CC0, pixiv Inc.)',
  allowedUserName: 'Everyone',
  violentUssageName: 'Allow',
  sexualUssageName: 'Disallow',
  commercialUssageName: 'Allow',
  otherPermissionUrl: '',
  licenseName: 'CC0',
  otherLicenseUrl: '',
});
base.json.asset.generator = 'ojakgyo char-lab';

// A portrait of the new character as the file's thumbnail (shown by VRM tools and stores).
if (values.thumbnail) {
  const ti = base.json.textures[meta.texture]?.source;
  if (ti !== undefined) replaced.set(base.json.images[ti].bufferView, readFileSync(values.thumbnail));
}

const output = repack(base, replaced);
mkdirSync(dirname(values.out), { recursive: true });
writeFileSync(values.out, output);
console.log(`wrote ${values.out} (${(output.length / 1048576).toFixed(1)} MB)`);
