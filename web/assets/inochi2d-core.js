// Inochi2D puppet runtime for the 2D avatar overlay: file parsing, parameters, physics and
// the node tree. Drawing lives in inochi2d-gl.js. No DOM here, so the tests run it in Node.
//
// Behaviour follows the Inochi2D 0.8 runtime (https://github.com/Inochi2D/inochi2d). The keypoint
// re-interpolation, parameter evaluation, SimplePhysics and MeshGroup logic are ported from it:
//
//   BSD 2-Clause License. Copyright (c) 2020, Inochi2D Project. All rights reserved.
//   Redistribution and use in source and binary forms, with or without modification, are
//   permitted provided that the following conditions are met:
//   1. Redistributions of source code must retain the above copyright notice, this list of
//      conditions and the following disclaimer.
//   2. Redistributions in binary form must reproduce the above copyright notice, this list of
//      conditions and the following disclaimer in the documentation and/or other materials
//      provided with the distribution.
//   THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS
//   OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
//   MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE
//   COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
//   EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE
//   GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED
//   AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
//   NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED
//   OF THE POSSIBILITY OF SUCH DAMAGE.
//
// Coordinates are Inochi2D model space: pixels, y pointing down.

const NO_TEXTURE = 4294967295;

/* ── file format ── */

const ascii = (bytes, at, n) => String.fromCharCode(...bytes.subarray(at, at + n));

/**
 * Split an .inp / .inx file into its JSON puppet and embedded textures.
 * Layout: "TRNSRTS\0", u32 BE JSON length, JSON, then optionally "TEX_SECT", u32 BE count and
 * per texture u32 BE length, u8 encoding (0 PNG, 1 TGA, 2 BC7) and the bytes.
 */
export function parseInx(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || ascii(bytes, 0, 8) !== 'TRNSRTS\0') throw new Error('Not an Inochi2D puppet (.inp or .inx).');
  const len = view.getUint32(8);
  if (12 + len > bytes.length) throw new Error('The puppet file is truncated.');
  const puppet = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + len)));
  const textures = [];
  let off = 12 + len;
  if (off + 12 <= bytes.length && ascii(bytes, off, 8) === 'TEX_SECT') {
    const count = view.getUint32(off + 8);
    off += 12;
    for (let i = 0; i < count; i++) {
      if (off + 5 > bytes.length) throw new Error('The texture section is truncated.');
      const size = view.getUint32(off);
      const type = bytes[off + 4];
      if (off + 5 + size > bytes.length) throw new Error('The texture section is truncated.');
      textures.push({ format: ['png', 'tga', 'bc7'][type] ?? `type${type}`, bytes: bytes.subarray(off + 5, off + 5 + size) });
      off += 5 + size;
    }
  }
  return { puppet, textures };
}

/**
 * Decode a TGA image (true-colour or grey, raw or RLE) to top-down RGBA, values untouched.
 * Puppet files store their textures already premultiplied (Inochi2D saves what it uploaded and
 * uploads what it loads), so no alpha conversion happens here.
 */
export function decodeTga(b) {
  if (b.length < 18) throw new Error('TGA image is truncated.');
  const idLen = b[0];
  const type = b[2];
  const w = b[12] | (b[13] << 8);
  const h = b[14] | (b[15] << 8);
  const bpp = b[16];
  const topDown = (b[17] & 0x20) !== 0;
  if (b[1] !== 0 || ![2, 3, 10, 11].includes(type)) throw new Error(`Unsupported TGA type ${type}.`);
  const px = bpp >> 3;
  if (![1, 3, 4].includes(px) || ((type === 3 || type === 11) && px !== 1)) throw new Error(`Unsupported TGA depth ${bpp}.`);
  const out = new Uint8Array(w * h * 4);
  let p = 18 + idLen;
  const put = (i, s) => {
    if (s + px > b.length) throw new Error('TGA image is truncated.');
    const x = i % w;
    const row = topDown ? Math.floor(i / w) : h - 1 - Math.floor(i / w);
    const o = (row * w + x) * 4;
    if (px === 1) {
      out[o] = out[o + 1] = out[o + 2] = b[s];
    } else {
      out[o] = b[s + 2];
      out[o + 1] = b[s + 1];
      out[o + 2] = b[s];
    }
    out[o + 3] = px === 4 ? b[s + 3] : 255;
  };
  const total = w * h;
  if (type === 2 || type === 3) {
    for (let i = 0; i < total; i++, p += px) put(i, p);
  } else {
    let i = 0;
    while (i < total) {
      if (p >= b.length) throw new Error('TGA image is truncated.');
      const head = b[p++];
      const n = Math.min((head & 0x7f) + 1, total - i);
      if (head & 0x80) {
        for (let k = 0; k < n; k++) put(i++, p);
        p += px;
      } else {
        for (let k = 0; k < n; k++, p += px) put(i++, p);
      }
    }
  }
  return { width: w, height: h, data: out };
}

/* ── small matrix helpers (4×4, column-major) ── */

export function trs(t, r, s) {
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(r[0]), Math.sin(r[0]), Math.cos(r[1]), Math.sin(r[1]), Math.cos(r[2]), Math.sin(r[2])];
  // R = Rz · Ry · Rx
  const m00 = cz * cy, m01 = cz * sy * sx - sz * cx, m02 = cz * sy * cx + sz * sx;
  const m10 = sz * cy, m11 = sz * sy * sx + cz * cx, m12 = sz * sy * cx - cz * sx;
  const m20 = -sy, m21 = cy * sx, m22 = cy * cx;
  return new Float64Array([m00 * s[0], m10 * s[0], m20 * s[0], 0, m01 * s[1], m11 * s[1], m21 * s[1], 0, m02, m12, m22, 0, t[0], t[1], t[2] ?? 0, 1]);
}

export function mul(a, b) {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}

export function invert(m) {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const d = 1 / det;
  return new Float64Array([
    (a11 * b11 - a12 * b10 + a13 * b09) * d, (a02 * b10 - a01 * b11 - a03 * b09) * d, (a31 * b05 - a32 * b04 + a33 * b03) * d, (a22 * b04 - a21 * b05 - a23 * b03) * d,
    (a12 * b08 - a10 * b11 - a13 * b07) * d, (a00 * b11 - a02 * b08 + a03 * b07) * d, (a32 * b02 - a30 * b05 - a33 * b01) * d, (a20 * b05 - a22 * b02 + a23 * b01) * d,
    (a10 * b10 - a11 * b08 + a13 * b06) * d, (a01 * b08 - a00 * b10 - a03 * b06) * d, (a30 * b04 - a31 * b02 + a33 * b00) * d, (a21 * b02 - a20 * b04 - a23 * b00) * d,
    (a11 * b07 - a10 * b09 - a12 * b06) * d, (a00 * b09 - a01 * b07 + a02 * b06) * d, (a31 * b01 - a30 * b03 - a32 * b00) * d, (a20 * b03 - a21 * b01 + a22 * b00) * d,
  ]);
}

const IDENTITY = trs([0, 0, 0], [0, 0, 0], [1, 1]);

/* ── keypoint re-interpolation (Inochi2D binding.d reInterpolate) ── */

const floatOps = { add: (a, b) => a + b, scale: (a, s) => a * s };
const deformOps = {
  add: (a, b) => a.map((v, i) => v + b[i]),
  scale: (a, s) => a.map((v) => v * s),
};

/**
 * Fill keypoints the rig author left unset by interpolating and extrapolating from the set ones.
 * Mutates `values` and returns false when no keypoint is set at all.
 */
export function reInterpolate(values, isSet, axisPoints, ops = floatOps) {
  const xCount = axisPoints[0].length;
  const yCount = axisPoints[1].length;
  const valid = isSet.map((r) => r.slice());
  let validCount = valid.flat().filter(Boolean).length;
  const total = xCount * yCount;
  if (validCount === 0) return false;
  const dist = Array.from({ length: xCount }, () => new Array(yCount).fill(0));
  let newlySet = [];
  const commit = [];
  let yMajor = false;

  const majorCnt = () => (yMajor ? yCount : xCount);
  const minorCnt = () => (yMajor ? xCount : yCount);
  const xy = (maj, min) => (yMajor ? [min, maj] : [maj, min]);
  const isValid = (maj, min) => { const [x, y] = xy(maj, min); return valid[x][y]; };
  const isNew = (maj, min) => { const [x, y] = xy(maj, min); return newlySet[x][y]; };
  const get = (maj, min) => { const [x, y] = xy(maj, min); return values[x][y]; };
  const getDist = (maj, min) => { const [x, y] = xy(maj, min); return dist[x][y]; };
  const set = (maj, min, val, d = 0) => {
    const [x, y] = xy(maj, min);
    values[x][y] = val;
    dist[x][y] = d;
    newlySet[x][y] = true;
    commit.push([x, y]);
  };
  const axisPoint = (i) => (yMajor ? axisPoints[0][i] : axisPoints[1][i]);
  const interp = (maj, l, m, r) => {
    const off = (axisPoint(m) - axisPoint(l)) / (axisPoint(r) - axisPoint(l));
    return ops.add(ops.scale(get(maj, l), 1 - off), ops.scale(get(maj, r), off));
  };

  function interpolate1D2D(secondPass) {
    yMajor = secondPass;
    let intersections = false;
    for (let i = 0; i < majorCnt(); i++) {
      const cnt = minorCnt();
      let l = 0;
      while (l < cnt && !isValid(i, l)) l++;
      if (l >= cnt) continue;
      for (;;) {
        while (l < cnt - 1 && isValid(i, l + 1)) l++;
        if (l >= cnt - 1) break;
        let r = l + 1;
        while (r < cnt && !isValid(i, r)) r++;
        if (r >= cnt) break;
        for (let m = l + 1; m < r; m++) {
          const val = interp(i, l, m, r);
          if (secondPass && isNew(i, m)) {
            if (!intersections) commit.length = 0;
            set(i, m, ops.scale(ops.add(val, get(i, m)), 0.5));
            intersections = true;
          }
          if (!intersections) set(i, m, val);
        }
        l = r;
      }
    }
  }

  function extrapolateCorners() {
    if (yCount <= 1 || xCount <= 1) return;
    const corner = (bx, by, ox, oy) => {
      const base = values[bx][by];
      const dX = ops.add(values[bx + ox][by], ops.scale(base, -1));
      const dY = ops.add(values[bx][by + oy], ops.scale(base, -1));
      values[bx + ox][by + oy] = ops.add(ops.add(base, dX), dY);
      commit.push([bx + ox, by + oy]);
    };
    for (let x = 0; x < xCount - 1; x++) {
      for (let y = 0; y < yCount - 1; y++) {
        const [a, b, c, d] = [valid[x][y], valid[x + 1][y], valid[x][y + 1], valid[x + 1][y + 1]];
        if (a && b && c && !d) corner(x, y, 1, 1);
        else if (a && b && !c && d) corner(x + 1, y, -1, 1);
        else if (a && !b && c && d) corner(x, y + 1, 1, -1);
        else if (!a && b && c && d) corner(x + 1, y + 1, -1, -1);
      }
    }
  }

  function extendAndIntersect(secondPass) {
    yMajor = secondPass;
    let intersections = false;
    const setOrAverage = (maj, min, val, origin) => {
      const minDist = Math.abs(axisPoint(min) - origin);
      if (secondPass && isNew(maj, min)) {
        if (!intersections) commit.length = 0;
        const majDist = getDist(maj, min);
        const frac = minDist / (minDist + (majDist * majDist) / minDist);
        set(maj, min, ops.add(ops.scale(val, 1 - frac), ops.scale(get(maj, min), frac)));
        intersections = true;
      }
      if (!intersections) set(maj, min, val, minDist);
    };
    for (let i = 0; i < majorCnt(); i++) {
      const cnt = minorCnt();
      let j = 0;
      while (j < cnt && !isValid(i, j)) j++;
      if (j >= cnt) continue;
      let val = get(i, j);
      let origin = axisPoint(j);
      for (let k = 0; k < j; k++) setOrAverage(i, k, val, origin);
      j = cnt - 1;
      while (j >= 0 && !isValid(i, j)) j--;
      val = get(i, j);
      origin = axisPoint(j);
      for (let k = j + 1; k < cnt; k++) setOrAverage(i, k, val, origin);
    }
  }

  for (;;) {
    for (const [x, y] of commit) {
      if (valid[x][y]) continue;
      valid[x][y] = true;
      validCount++;
    }
    commit.length = 0;
    if (validCount >= total) break;
    newlySet = Array.from({ length: xCount }, () => new Array(yCount).fill(false));
    interpolate1D2D(false);
    interpolate1D2D(true);
    if (commit.length) continue;
    extrapolateCorners();
    if (commit.length) continue;
    extendAndIntersect(false);
    extendAndIntersect(true);
    if (commit.length) continue;
    break;
  }
  return true;
}

/* ── nodes ── */

const DEFAULT_OFFSET = { 'transform.s.x': 1, 'transform.s.y': 1, opacity: 1, 'tint.r': 1, 'tint.g': 1, 'tint.b': 1 };

class Node {
  constructor(data, parent) {
    this.uuid = data.uuid;
    this.name = data.name ?? '';
    this.type = data.type ?? 'Node';
    this.enabled = data.enabled !== false;
    this.zsort = data.zsort ?? 0;
    const tf = data.transform ?? {};
    this.t = tf.trans ?? [0, 0, 0];
    this.r = tf.rot ?? [0, 0, 0];
    this.s = tf.scale ?? [1, 1];
    this.lockToRoot = Boolean(data.lockToRoot);
    this.parent = parent;
    this.children = [];
    this.world = IDENTITY;
    // Set by an enclosing MeshGroup: { group, mode: 'pre' | 'post' | 'translate' }.
    this.filter = null;
    this.beginUpdate();
  }
  get renderEnabled() {
    return this.enabled && (this.parent ? this.parent.renderEnabled : true);
  }
  get zSort() {
    return (this.parent ? this.parent.zSort : 0) + this.zsort + this.offSort;
  }
  beginUpdate() {
    this.ot = [0, 0, 0];
    this.or = [0, 0, 0];
    this.os = [1, 1];
    this.offSort = 0;
  }
  setValue(key, v) {
    switch (key) {
      case 'zSort': this.offSort += v; return true;
      case 'transform.t.x': this.ot[0] += v; return true;
      case 'transform.t.y': this.ot[1] += v; return true;
      case 'transform.t.z': this.ot[2] += v; return true;
      case 'transform.r.x': this.or[0] += v; return true;
      case 'transform.r.y': this.or[1] += v; return true;
      case 'transform.r.z': this.or[2] += v; return true;
      case 'transform.s.x': this.os[0] *= v; return true;
      case 'transform.s.y': this.os[1] *= v; return true;
      default: return false;
    }
  }
  /** Local transform with this frame's parameter offsets applied. */
  localMatrix() {
    return trs([this.t[0] + this.ot[0], this.t[1] + this.ot[1], (this.t[2] ?? 0) + this.ot[2]], [this.r[0] + this.or[0], this.r[1] + this.or[1], this.r[2] + this.or[2]], [this.s[0] * this.os[0], this.s[1] * this.os[1]]);
  }
  updateTransform(root) {
    const local = this.localMatrix();
    this.world = this.lockToRoot ? mul(root.localMatrix(), local) : this.parent ? mul(this.parent.world, local) : local;
    for (const c of this.children) c.updateTransform(root);
  }
}

class Drawable extends Node {
  constructor(data, parent) {
    super(data, parent);
    const mesh = data.mesh ?? { verts: [], uvs: [], indices: [], origin: [0, 0] };
    this.verts = Float32Array.from(mesh.verts ?? []);
    this.uvs = Float32Array.from(mesh.uvs ?? []);
    this.indices = Uint16Array.from(mesh.indices ?? []);
    this.origin = mesh.origin ?? [0, 0];
    this.deform = new Float32Array(this.verts.length);
    this.positions = new Float32Array(this.verts.length);
  }
  beginUpdate() {
    super.beginUpdate();
    this.deform?.fill(0);
  }
  addDeform(d) {
    const n = Math.min(d.length, this.deform.length);
    for (let i = 0; i < n; i++) this.deform[i] += d[i];
  }
  /** Final model-space positions: world · (vertex − origin + deformation). */
  updatePositions() {
    const m = this.world;
    const v = this.verts;
    const d = this.deform;
    const [ox, oy] = this.origin;
    for (let i = 0; i < v.length; i += 2) {
      const x = v[i] - ox + d[i];
      const y = v[i + 1] - oy + d[i + 1];
      this.positions[i] = m[0] * x + m[4] * y + m[12];
      this.positions[i + 1] = m[1] * x + m[5] * y + m[13];
    }
  }
}

class Part extends Drawable {
  constructor(data, parent) {
    super(data, parent);
    const tex = data.textures?.[0];
    this.texture = tex == null || tex === NO_TEXTURE ? -1 : tex;
    this.blend = data.blend_mode ?? 'Normal';
    this.tint = data.tint ?? [1, 1, 1];
    this.screenTint = data.screenTint ?? [0, 0, 0];
    this.opacity = data.opacity ?? 1;
    this.maskThreshold = data.mask_threshold ?? 0.5;
    this.maskRefs = (data.masks ?? []).map((m) => ({ source: m.source, mode: m.mode ?? 'Mask' }));
    this.masks = [];
  }
  beginUpdate() {
    super.beginUpdate();
    this.offOpacity = 1;
    this.offTint = [1, 1, 1];
    this.offScreen = [0, 0, 0];
  }
  setValue(key, v) {
    if (super.setValue(key, v)) return true;
    const ch = { r: 0, g: 1, b: 2 }[key.slice(-1)];
    if (key === 'opacity') this.offOpacity *= v;
    else if (key.startsWith('tint.')) this.offTint[ch] *= v;
    else if (key.startsWith('screenTint.')) this.offScreen[ch] += v;
    else return false;
    return true;
  }
  get drawOpacity() { return Math.min(1, Math.max(0, this.opacity * this.offOpacity)); }
  get drawTint() { return this.tint.map((c, i) => Math.min(1, Math.max(0, c * this.offTint[i]))); }
  get drawScreen() { return this.screenTint.map((c, i) => Math.min(1, Math.max(0, c + this.offScreen[i]))); }
}

class MaskNode extends Drawable {
  constructor(data, parent) {
    super(data, parent);
    this.texture = -1;
    this.maskThreshold = -1;
  }
}

class Composite extends Node {
  constructor(data, parent) {
    super(data, parent);
    this.blend = data.blend_mode ?? 'Normal';
    this.tint = data.tint ?? [1, 1, 1];
    this.screenTint = data.screenTint ?? [0, 0, 0];
    this.opacity = data.opacity ?? 1;
    this.maskThreshold = data.mask_threshold ?? 0.5;
    this.maskRefs = (data.masks ?? []).map((m) => ({ source: m.source, mode: m.mode ?? 'Mask' }));
    this.masks = [];
    this.subParts = [];
  }
}
for (const k of ['beginUpdate', 'setValue']) Composite.prototype[k] = Part.prototype[k];
for (const k of ['drawOpacity', 'drawTint', 'drawScreen']) Object.defineProperty(Composite.prototype, k, Object.getOwnPropertyDescriptor(Part.prototype, k));

/**
 * MeshGroup: a mesh that bends what is below it. A point inside one of its rest triangles is
 * carried to the same barycentric spot of that triangle as deformed this frame.
 */
class MeshGroup extends Drawable {
  constructor(data, parent) {
    super(data, parent);
    this.dynamic = Boolean(data.dynamic_deformation);
    this.translateChildren = data.translate_children !== false;
    this.tris = [];
    this.grid = null;
    this.bent = new Float32Array(this.verts.length);
  }
  precalculate() {
    const v = this.verts;
    const idx = this.indices;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < v.length; i += 2) {
      minX = Math.min(minX, v[i]); maxX = Math.max(maxX, v[i]);
      minY = Math.min(minY, v[i + 1]); maxY = Math.max(maxY, v[i + 1]);
    }
    this.tris = [];
    for (let t = 0; t + 2 < idx.length; t += 3) this.tris.push([idx[t], idx[t + 1], idx[t + 2]]);
    // Uniform grid so a lookup only tests the few triangles near the point.
    const n = 16;
    const cw = Math.max(1e-6, (maxX - minX) / n), ch = Math.max(1e-6, (maxY - minY) / n);
    const cells = Array.from({ length: n * n }, () => []);
    this.tris.forEach(([a, b, c], i) => {
      const xs = [v[a * 2], v[b * 2], v[c * 2]], ys = [v[a * 2 + 1], v[b * 2 + 1], v[c * 2 + 1]];
      const x0 = Math.max(0, Math.floor((Math.min(...xs) - minX) / cw)), x1 = Math.min(n - 1, Math.floor((Math.max(...xs) - minX) / cw));
      const y0 = Math.max(0, Math.floor((Math.min(...ys) - minY) / ch)), y1 = Math.min(n - 1, Math.floor((Math.max(...ys) - minY) / ch));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) cells[y * n + x].push(i);
    });
    this.grid = { n, minX, minY, maxX, maxY, cw, ch, cells };
  }
  /** This frame's deformed mesh, in the group's local space. */
  updateBent() {
    for (let i = 0; i < this.verts.length; i++) this.bent[i] = this.verts[i] + this.deform[i];
  }
  /** Where a group-space rest point moves to, or null when it lies outside the mesh. */
  map(x, y) {
    const g = this.grid;
    if (!g || x < g.minX || y < g.minY || x > g.maxX || y > g.maxY) return null;
    const cx = Math.min(g.n - 1, Math.floor((x - g.minX) / g.cw)), cy = Math.min(g.n - 1, Math.floor((y - g.minY) / g.ch));
    const v = this.verts, q = this.bent;
    for (const i of g.cells[cy * g.n + cx]) {
      const [a, b, c] = this.tris[i];
      const ax = v[a * 2], ay = v[a * 2 + 1], bx = v[b * 2], by = v[b * 2 + 1], qx = v[c * 2], qy = v[c * 2 + 1];
      const d = (by - qy) * (ax - qx) + (qx - bx) * (ay - qy);
      if (!d) continue;
      const l1 = ((by - qy) * (x - qx) + (qx - bx) * (y - qy)) / d;
      const l2 = ((qy - ay) * (x - qx) + (ax - qx) * (y - qy)) / d;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      return [l1 * q[a * 2] + l2 * q[b * 2] + l3 * q[c * 2], l1 * q[a * 2 + 1] + l2 * q[b * 2 + 1] + l3 * q[c * 2 + 1]];
    }
    return null;
  }
}

class SimplePhysics extends Node {
  constructor(data, parent) {
    super(data, parent);
    this.paramRef = data.param;
    this.model = /spring/i.test(data.model_type ?? '') ? 'spring' : 'pendulum';
    this.mapMode = (data.map_mode ?? 'AngleLength').toLowerCase().replace('_', '');
    this.localOnly = Boolean(data.local_only);
    this.gravity = data.gravity ?? 1;
    this.length = data.length ?? 100;
    this.frequency = data.frequency ?? 1;
    this.angleDamping = data.angle_damping ?? 0.5;
    this.lengthDamping = data.length_damping ?? 0.5;
    this.outputScale = data.output_scale ?? [1, 1];
    this.state = null;
  }
}

const NODE_TYPES = { Part, Composite, MeshGroup, SimplePhysics, Mask: MaskNode };

/* ── parameters ── */

class Param {
  constructor(data) {
    this.uuid = data.uuid;
    this.name = data.name ?? '';
    this.isVec2 = Boolean(data.is_vec2);
    this.min = data.min ?? [0, 0];
    this.max = data.max ?? [1, 1];
    this.defaults = data.defaults ?? [0, 0];
    this.value = [...this.defaults];
    this.axisPoints = [data.axis_points?.[0] ?? [0, 1], data.axis_points?.[1] ?? [0]];
    this.bindings = [];
    this.driven = false;
  }
  /** Value as a 0..1 offset on each axis, clamped like Parameter.mapValue. */
  normalized(value = this.value) {
    return [0, 1].map((k) => {
      const range = this.max[k] - this.min[k];
      return range ? Math.min(1, Math.max(0, (value[k] - this.min[k]) / range)) : 0;
    });
  }
  /** Keypoint cell and offset inside it (Parameter.findOffset). */
  locate() {
    const n = this.normalized();
    const axis = (k) => {
      const pos = this.axisPoints[k];
      if (pos.length < 2) return [0, 0];
      for (let i = 0; i < pos.length - 1; i++) {
        if (pos[i + 1] > n[k] || i === pos.length - 2) return [i, (n[k] - pos[i]) / (pos[i + 1] - pos[i])];
      }
      return [0, 0];
    };
    const [ix, ox] = axis(0);
    const [iy, oy] = this.isVec2 ? axis(1) : [0, 0];
    return { ix, iy, ox, oy };
  }
  apply() {
    if (!this.bindings.length) return;
    const { ix, iy, ox, oy } = this.locate();
    for (const b of this.bindings) b.apply(ix, iy, ox, oy, this.isVec2);
  }
}

class Binding {
  constructor(data, node, param) {
    this.node = node;
    this.key = data.param_name;
    this.deform = this.key === 'deform';
    this.nearest = /nearest/i.test(data.interpolate_mode ?? '');
    const xCount = param.axisPoints[0].length;
    const yCount = param.axisPoints[1].length;
    const fallback = this.deform ? null : (DEFAULT_OFFSET[this.key] ?? 0);
    const isSet = Array.from({ length: xCount }, (_, x) => Array.from({ length: yCount }, (_, y) => Boolean(data.isSet?.[x]?.[y])));
    const vertexCount = this.deform ? node.verts.length : 0;
    let complete = true;
    // Saved files carry the editor's interpolated values for unset keypoints too; Inochi2D uses
    // them as stored. Only re-interpolate when some keypoint is missing or malformed.
    this.values = Array.from({ length: xCount }, (_, x) => Array.from({ length: yCount }, (_, y) => {
      const raw = data.values?.[x]?.[y];
      if (this.deform) {
        const flat = Array.isArray(raw) ? raw.flat() : [];
        if (flat.length === vertexCount && flat.every(Number.isFinite)) return Float32Array.from(flat);
        complete = false;
        return new Float32Array(vertexCount);
      }
      if (Number.isFinite(raw)) return raw;
      complete = false;
      return fallback;
    }));
    if (!complete) {
      for (let x = 0; x < xCount; x++) for (let y = 0; y < yCount; y++) if (!isSet[x][y]) this.values[x][y] = this.deform ? new Float32Array(vertexCount) : fallback;
      reInterpolate(this.values, isSet, param.axisPoints, this.deform ? deformOps : floatOps);
    }
  }
  apply(ix, iy, ox, oy, vec2) {
    const v = this.values;
    let value;
    if (this.nearest) {
      value = v[ix + (ox >= 0.5 ? 1 : 0)]?.[vec2 ? iy + (oy >= 0.5 ? 1 : 0) : 0];
    } else if (this.deform) {
      // Bilinear blend written straight into the node's deformation (no per-frame arrays).
      const p00 = v[ix][vec2 ? iy : 0], p10 = v[ix + 1]?.[vec2 ? iy : 0] ?? p00;
      const p01 = vec2 ? v[ix][iy + 1] ?? p00 : p00, p11 = vec2 ? v[ix + 1]?.[iy + 1] ?? p10 : p10;
      const out = this.node.deform;
      const n = Math.min(out.length, p00.length);
      for (let i = 0; i < n; i++) {
        const a = p00[i] + (p01[i] - p00[i]) * oy;
        const b = p10[i] + (p11[i] - p10[i]) * oy;
        out[i] += a + (b - a) * ox;
      }
      return;
    } else {
      const p00 = v[ix][vec2 ? iy : 0], p10 = v[ix + 1]?.[vec2 ? iy : 0] ?? p00;
      const p01 = vec2 ? v[ix][iy + 1] ?? p00 : p00, p11 = vec2 ? v[ix + 1]?.[iy + 1] ?? p10 : p10;
      const a = vec2 ? p00 + (p01 - p00) * oy : p00;
      const b = vec2 ? p10 + (p11 - p10) * oy : p10;
      value = a + (b - a) * ox;
    }
    if (value == null) return;
    if (this.deform) this.node.addDeform(value);
    else this.node.setValue(this.key, value);
  }
}

/* ── physics (SimplePhysics, RK4 like phys/system.d) ── */

function rk4(state, deriv, h) {
  const cur = state.slice();
  const k1 = deriv(cur);
  const k2 = deriv(cur.map((v, i) => v + (h * k1[i]) / 2));
  const k3 = deriv(cur.map((v, i) => v + (h * k2[i]) / 2));
  const k4 = deriv(cur.map((v, i) => v + h * k3[i]));
  const next = cur.map((v, i) => v + (h * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i])) / 6);
  return next.every(Number.isFinite) ? next : cur;
}

function stepPhysics(n, gravityScale, h) {
  const g = n.gravity * gravityScale;
  const len = n.length;
  const [ax, ay] = n.anchor;
  const s = n.state;
  if (n.model === 'pendulum') {
    // state: [angle, dAngle]; the bob stays put in world space while the anchor moves.
    s.angle = Math.atan2(-(s.bob[0] - ax), s.bob[1] - ay);
    const ratio = g / len;
    const crit = 2 * Math.sqrt(ratio);
    [s.angle, s.dAngle] = rk4([s.angle, s.dAngle], ([a, da]) => [da, -ratio * Math.sin(a) - da * n.angleDamping * crit], h);
    s.bob = [ax - Math.sin(s.angle) * len, ay + Math.cos(s.angle) * len];
  } else {
    const kSqrt = n.frequency * 2 * Math.PI;
    const k = kSqrt * kSqrt;
    const rest = len - g / k;
    const critAngle = 2 * Math.sqrt(g / len);
    const critLength = 2 * kSqrt;
    const deriv = ([bx, by, vx, vy]) => {
      const ox = bx - ax, oy = by - ay;
      const dist = Math.hypot(ox, oy) || 1e-9;
      const nx = ox / dist, ny = oy / dist;
      let fx = -nx * (dist - rest) * k;
      let fy = g - ny * (dist - rest) * k;
      const rx = vx * ny + vy * nx;
      const ry = vy * ny - vx * nx;
      const drx = -rx * n.angleDamping * critAngle;
      const dry = -ry * n.lengthDamping * critLength;
      fx += drx * ny - dry * nx;
      fy += dry * ny + drx * nx;
      return [vx, vy, fx, fy];
    };
    const [bx, by, vx, vy] = rk4([...s.bob, ...s.vel], deriv, h);
    s.bob = [bx, by];
    s.vel = [vx, vy];
  }
}

/* ── puppet ── */

export class Puppet {
  constructor(json) {
    this.meta = json.meta ?? {};
    this.physics = { pixelsPerMeter: json.physics?.pixelsPerMeter ?? 1000, gravity: json.physics?.gravity ?? 9.8 };
    this.nodes = new Map();
    const build = (data, parent) => {
      const Kind = NODE_TYPES[data.type] ?? Node;
      const node = new Kind(data, parent);
      this.nodes.set(node.uuid, node);
      for (const c of data.children ?? []) node.children.push(build(c, node));
      return node;
    };
    this.root = build(json.nodes, null);

    // Draw list: Parts and Composites outside Composites, in tree order (Puppet.scanParts).
    this.rootParts = [];
    this.drivers = [];
    const scan = (n, inComposite) => {
      if (n instanceof SimplePhysics) this.drivers.push(n);
      if (n instanceof MeshGroup && n.indices.length) {
        n.precalculate();
        // MeshGroup.setupChild: drawables below are bent (before or after their own
        // transform), other nodes only have their origin carried along, and the walk stops
        // at plain nodes and nested groups.
        const setGroup = (c) => {
          const drawable = c instanceof Drawable;
          if (n.translateChildren || drawable) c.filter = { group: n, mode: drawable ? (n.dynamic ? 'post' : 'pre') : 'translate' };
          if ((drawable && !(c instanceof MeshGroup)) || c instanceof Composite) c.children.forEach(setGroup);
        };
        n.children.forEach(setGroup);
      }
      if (!inComposite) {
        if (n instanceof Composite) {
          this.rootParts.push(n);
          const collect = (c) => {
            if (c instanceof Part) n.subParts.push(c);
            if (!(c instanceof Composite)) c.children.forEach(collect);
          };
          n.children.forEach(collect);
          inComposite = true;
        } else if (n instanceof Part) {
          this.rootParts.push(n);
        }
      }
      for (const c of n.children) scan(c, inComposite);
    };
    scan(this.root, false);
    for (const n of this.nodes.values()) {
      if (n.maskRefs) n.masks = n.maskRefs.map((m) => ({ source: this.nodes.get(m.source), mode: m.mode })).filter((m) => m.source instanceof Drawable && !(m.source instanceof MeshGroup));
    }

    this.params = (json.param ?? []).map((d) => {
      const p = new Param(d);
      for (const b of d.bindings ?? []) {
        const node = this.nodes.get(b.node);
        if (!node || (b.param_name === 'deform' && !(node instanceof Drawable))) continue;
        p.bindings.push(new Binding(b, node, p));
      }
      return p;
    });
    const byUuid = new Map(this.params.map((p) => [p.uuid, p]));
    for (const d of this.drivers) {
      d.param = byUuid.get(d.paramRef) ?? null;
      if (d.param) d.param.driven = true;
    }
    this.update(0);
  }

  /** Case- and spacing-insensitive parameter lookup, e.g. find('Head:: Yaw-Pitch'). */
  find(name) {
    const key = (s) => s.toLowerCase().replace(/\s+/g, '');
    const want = key(name);
    return this.params.find((p) => key(p.name) === want) ?? null;
  }

  /** Set a parameter in its own units; values outside min..max are clamped when applied. */
  set(param, x, y = param?.value[1] ?? 0) {
    if (param) param.value = [x, y];
  }

  /** Advance one frame: parameters, then physics, then transforms and meshes. */
  update(dt) {
    for (const n of this.nodes.values()) n.beginUpdate();
    for (const p of this.params) if (!p.driven) p.apply();
    this.root.updateTransform(this.root);
    const gScale = this.physics.gravity * this.physics.pixelsPerMeter;
    for (const d of this.drivers) {
      if (!d.param) continue;
      const anchor = d.localOnly ? [d.t[0] + d.ot[0], d.t[1] + d.ot[1]] : [d.world[12], d.world[13]];
      d.anchor = anchor;
      if (!d.state || dt === 0) {
        d.state = { bob: [anchor[0], anchor[1] + d.length], vel: [0, 0], angle: 0, dAngle: 0 };
      } else {
        let h = Math.min(dt, 10);
        while (h > 0.01) {
          stepPhysics(d, gScale, 0.01);
          h -= 0.01;
        }
        stepPhysics(d, gScale, h);
      }
      const out = d.state.bob;
      const inv = d.localOnly ? IDENTITY : invert(d.world);
      const lx = d.localOnly ? out[0] : inv[0] * out[0] + inv[4] * out[1] + inv[12];
      const ly = d.localOnly ? out[1] : inv[1] * out[0] + inv[5] * out[1] + inv[13];
      const ll = Math.hypot(lx, ly) || 1;
      const [nx, ny] = [lx / ll, ly / ll];
      const rel = Math.hypot(out[0] - anchor[0], out[1] - anchor[1]) / d.length;
      let v;
      if (d.mapMode === 'xy' || d.mapMode === 'yx') {
        v = [nx * rel, -(ny * rel - 1)];
        if (d.mapMode === 'yx') v = [v[1], v[0]];
      } else {
        const a = Math.atan2(-nx, ny) / Math.PI;
        v = d.mapMode === 'lengthangle' ? [rel, a] : [a, rel];
      }
      d.param.value = [v[0] * d.outputScale[0], v[1] * d.outputScale[1]];
      d.param.apply();
    }
    this.finalPass(this.root);
  }

  /**
   * Final transforms and vertex positions, top-down, applying MeshGroup filters on the way:
   * 'translate' moves a node's origin with the mesh before its subtree is placed, 'pre' bends a
   * drawable's rest vertices, 'post' maps its finished positions through the group (dynamic mode).
   */
  finalPass(n) {
    const f = n.filter;
    if (f?.mode === 'translate' && n.parent) {
      const g = f.group;
      const toGroup = mul(g.inv, n.parent.world);
      const cx = toGroup[0] * n.t[0] + toGroup[4] * n.t[1] + toGroup[12];
      const cy = toGroup[1] * n.t[0] + toGroup[5] * n.t[1] + toGroup[13];
      const to = g.map(cx, cy);
      if (to) {
        const back = invert(toGroup);
        const dx = to[0] - cx, dy = to[1] - cy;
        n.ot[0] += back[0] * dx + back[4] * dy;
        n.ot[1] += back[1] * dx + back[5] * dy;
      }
    }
    const local = n.localMatrix();
    n.world = n.lockToRoot ? mul(this.root.localMatrix(), local) : n.parent ? mul(n.parent.world, local) : local;
    if (n instanceof MeshGroup) n.inv = invert(n.world);
    if (n instanceof Drawable) {
      n.updatePositions();
      if (f?.mode === 'pre' && !(n instanceof MeshGroup)) {
        const g = f.group;
        const toGroup = mul(g.inv, n.world);
        const w = g.world;
        for (let i = 0; i < n.verts.length; i += 2) {
          const x = n.verts[i] - n.origin[0], y = n.verts[i + 1] - n.origin[1];
          const cx = toGroup[0] * x + toGroup[4] * y + toGroup[12];
          const cy = toGroup[1] * x + toGroup[5] * y + toGroup[13];
          const to = g.map(cx, cy);
          if (!to) continue;
          const dx = to[0] - cx, dy = to[1] - cy;
          n.positions[i] += w[0] * dx + w[4] * dy;
          n.positions[i + 1] += w[1] * dx + w[5] * dy;
        }
      }
      if (n instanceof MeshGroup) n.updateBent();
    }
    for (const c of n.children) this.finalPass(c);
    if (f?.mode === 'post' && n instanceof Drawable && !(n instanceof MeshGroup)) {
      const g = f.group;
      const inv = g.inv;
      const w = g.world;
      const p = n.positions;
      for (let i = 0; i < p.length; i += 2) {
        const cx = inv[0] * p[i] + inv[4] * p[i + 1] + inv[12];
        const cy = inv[1] * p[i] + inv[5] * p[i + 1] + inv[13];
        const to = g.map(cx, cy);
        if (!to) continue;
        p[i] = w[0] * to[0] + w[4] * to[1] + w[12];
        p[i + 1] = w[1] * to[0] + w[5] * to[1] + w[13];
      }
    }
  }

  /** Parts and Composites in draw order, back to front (higher zSort is further back). */
  drawList() {
    return this.rootParts.map((p, i) => [p, i]).sort((a, b) => b[0].zSort - a[0].zSort || a[1] - b[1]).map(([p]) => p);
  }

  /** Axis-aligned bounds of everything drawn, in model space; `maxY` limits it to points above. */
  bounds(maxYLimit = Infinity) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this.nodes.values()) {
      if (!(n instanceof Part) || !n.renderEnabled) continue;
      for (let i = 0; i < n.positions.length; i += 2) {
        if (n.positions[i + 1] > maxYLimit) continue;
        minX = Math.min(minX, n.positions[i]);
        maxX = Math.max(maxX, n.positions[i]);
        minY = Math.min(minY, n.positions[i + 1]);
        maxY = Math.max(maxY, n.positions[i + 1]);
      }
    }
    return { minX, minY, maxX, maxY };
  }
}

export { Part, Composite, MeshGroup, SimplePhysics, Drawable };
