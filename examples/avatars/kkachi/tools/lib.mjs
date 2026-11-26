// Small helpers for editing VRM (glTF binary) files in place.
// Needs the ojakgyo build (`npm run build`) and the three VRoid sample VRMs in a folder named by
// the VROID_SAMPLES environment variable (any file names containing the character's name).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const optimizeJs = join(REPO, 'dist/avatar/optimize.js');
if (!existsSync(optimizeJs)) throw new Error('build ojakgyo first: npm run build');
const { parseGlb, writeGlb } = await import(pathToFileURL(optimizeJs).href);
export { parseGlb, writeGlb };
export const requireRepo = createRequire(join(REPO, 'package.json'));

const TYPES = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const COMP = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array, 5121: Uint8Array };

/** Load a VRoid sample by character name, e.g. 'Sendagaya_Shino', from $VROID_SAMPLES. */
export function loadVrm(name) {
  const dir = process.env.VROID_SAMPLES;
  if (!dir) throw new Error('set VROID_SAMPLES to the folder holding the VRoid sample .vrm files');
  const key = (s) => s.toLowerCase().replace(/[^a-z]/g, '');
  const file = readdirSync(dir).find((f) => /\.vrm$/i.test(f) && key(f).includes(key(name)));
  if (!file) throw new Error(`no .vrm for ${name} in ${dir}`);
  const { json, bin } = parseGlb(readFileSync(join(dir, file)));
  return { json, bin: Buffer.from(bin) }; // own copy, safe to edit
}

/** A typed-array view onto an accessor's bytes (edits write straight into the binary chunk). */
export function accessor(m, index) {
  const a = m.json.accessors[index];
  const view = m.json.bufferViews[a.bufferView];
  const n = TYPES[a.type];
  const Ctor = COMP[a.componentType];
  if (view.byteStride && view.byteStride !== n * Ctor.BYTES_PER_ELEMENT) throw new Error('interleaved accessor');
  if (a.sparse) throw new Error('sparse accessor');
  const start = m.bin.byteOffset + (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
  return new Ctor(m.bin.buffer, start, a.count * n);
}

/** Refresh an accessor's min/max after editing (required for POSITION). */
export function refreshBounds(m, index) {
  const a = m.json.accessors[index];
  const data = accessor(m, index);
  const n = TYPES[a.type];
  const min = new Array(n).fill(Infinity), max = new Array(n).fill(-Infinity);
  for (let i = 0; i < data.length; i += n) for (let k = 0; k < n; k++) {
    min[k] = Math.min(min[k], data[i + k]);
    max[k] = Math.max(max[k], data[i + k]);
  }
  if (a.min) a.min = min;
  if (a.max) a.max = max;
}

export function nodeIndex(m, name) {
  const i = m.json.nodes.findIndex((n) => n.name === name);
  if (i < 0) throw new Error(`no node ${name}`);
  return i;
}

/** Bind-pose world position (VRoid exports use translations only). */
export function worldPos(m, index) {
  const parent = new Map();
  m.json.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parent.set(c, i)));
  const out = [0, 0, 0];
  for (let i = index; i !== undefined; i = parent.get(i)) {
    const t = m.json.nodes[i].translation ?? [0, 0, 0];
    out[0] += t[0];
    out[1] += t[1];
    out[2] += t[2];
  }
  return out;
}

export function imageBytes(m, imageIndex) {
  const img = m.json.images[imageIndex];
  const view = m.json.bufferViews[img.bufferView];
  return m.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
}

/** Rebuild the binary chunk with some buffer views replaced (new image bytes). */
export function repack(m, replaced) {
  const chunks = [];
  let cursor = 0;
  m.json.bufferViews.forEach((view, i) => {
    const pad = (4 - (cursor % 4)) % 4;
    if (pad) {
      chunks.push(Buffer.alloc(pad));
      cursor += pad;
    }
    const start = view.byteOffset ?? 0;
    const data = replaced.get(i) ?? m.bin.subarray(start, start + view.byteLength);
    view.byteOffset = cursor;
    view.byteLength = data.length;
    chunks.push(data);
    cursor += data.length;
  });
  const bin = Buffer.concat(chunks);
  m.json.buffers[0].byteLength = bin.length;
  return writeGlb(m.json, bin);
}
