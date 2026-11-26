// Learn a face shape space from the three CC0 VRoid girls (same face template):
// align each face to its own head bone, then PCA. Run directly to print where they differ:
//   VROID_SAMPLES=<folder> node face-space.mjs
import { pathToFileURL } from 'node:url';
import { accessor, loadVrm, nodeIndex, worldPos } from './lib.mjs';

export const NAMES = ['Sendagaya_Shino', 'Vita', 'Victoria_Rubin'];

export function faceData(m) {
  const meshIndex = m.json.meshes.findIndex((x) => /^Face/.test(x.name));
  const prim = m.json.meshes[meshIndex].primitives[0];
  const head = worldPos(m, nodeIndex(m, 'J_Bip_C_Head'));
  const pos = accessor(m, prim.attributes.POSITION);
  const local = new Float64Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) local[i + k] = pos[i + k] - head[k];
  return { meshIndex, prim, head, local };
}

/** PCA of N aligned shapes via the N×N Gram matrix (power iteration with deflation). */
export function pca(shapes) {
  const n = shapes.length, d = shapes[0].length;
  const mean = new Float64Array(d);
  for (const s of shapes) for (let i = 0; i < d; i++) mean[i] += s[i] / n;
  const centered = shapes.map((s) => s.map((v, i) => v - mean[i]));
  const G = centered.map((a) => centered.map((b) => a.reduce((acc, v, i) => acc + v * b[i], 0)));
  const comps = [];
  let M = G.map((r) => r.slice());
  for (let c = 0; c < n - 1; c++) {
    let v = Array.from({ length: n }, (_, i) => (i === c ? 1 : 0.5));
    let lambda = 0;
    for (let it = 0; it < 200; it++) {
      const w = M.map((row) => row.reduce((acc, x, j) => acc + x * v[j], 0));
      const norm = Math.hypot(...w);
      if (!norm) break;
      v = w.map((x) => x / norm);
      lambda = norm;
    }
    comps.push({ lambda, v });
    M = M.map((row, i) => row.map((x, j) => x - lambda * v[i] * v[j]));
  }
  // Each sample's coordinates on each component, in metres of RMS vertex offset.
  const perVertex = Math.sqrt(d / 3);
  const coords = shapes.map((_, s) => comps.map((cmp) => (Math.sqrt(cmp.lambda) * cmp.v[s]) / perVertex));
  const variance = comps.map((c) => c.lambda);
  return { mean, centered, comps, coords, variance };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const models = NAMES.map(loadVrm);
  const faces = models.map(faceData);
  const { coords, variance } = pca(faces.map((f) => f.local));
  const total = variance.reduce((a, b) => a + b, 0);
  console.log('variance explained:', variance.map((v) => `${((v / total) * 100).toFixed(1)}%`).join(' / '));
  NAMES.forEach((n, i) => console.log(`  ${n.padEnd(16)} PC1 ${(coords[i][0] * 1000).toFixed(2)} mm  PC2 ${(coords[i][1] * 1000).toFixed(2)} mm`));

  // Where do the aligned faces differ? Bucket vertices by region (VRM 0.x faces -Z).
  const base = faces[2].local;
  const regions = { 'front (z < -0.03)': [], 'side/ears': [], 'back of head (z > 0.02)': [], 'top (y > 0.12)': [], 'neck seam (y < 0.01)': [] };
  for (let i = 0; i < base.length; i += 3) {
    const [x, y, z] = [base[i], base[i + 1], base[i + 2]];
    const spread = Math.max(...faces.map((f) => Math.hypot(f.local[i] - base[i], f.local[i + 1] - base[i + 1], f.local[i + 2] - base[i + 2])));
    const key = y < 0.01 ? 'neck seam (y < 0.01)' : y > 0.12 ? 'top (y > 0.12)' : z < -0.03 ? 'front (z < -0.03)' : z > 0.02 ? 'back of head (z > 0.02)' : 'side/ears';
    regions[key].push(spread);
  }
  for (const [k, v] of Object.entries(regions)) {
    v.sort((a, b) => a - b);
    console.log(`  ${k.padEnd(24)} ${String(v.length).padStart(5)} verts  median ${(v[v.length >> 1] * 1000 || 0).toFixed(1)} mm  max ${((v.at(-1) ?? 0) * 1000).toFixed(1)} mm`);
  }
  // Which joints drive the face mesh?
  const m = models[2], f = faces[2];
  const joints = accessor(m, f.prim.attributes.JOINTS_0), weights = accessor(m, f.prim.attributes.WEIGHTS_0);
  const skin = m.json.skins[m.json.nodes.find((x) => x.mesh === f.meshIndex).skin];
  const use = new Map();
  for (let i = 0; i < joints.length; i++) if (weights[i] > 0.01) {
    const name = m.json.nodes[skin.joints[joints[i]]].name;
    use.set(name, (use.get(name) ?? 0) + 1);
  }
  console.log('  face joints:', [...use].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}:${c}`).join(' '));
}
