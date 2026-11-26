/**
 * Shrink the textures inside a .vrm / .glb so it loads fast in a browser source.
 *
 * VRM avatars are mostly texture: VRoid exports spend 58–77% of their bytes on
 * PNG images, often several 2048² sheets. This rewrites only the embedded images
 * (downscaled with an area filter, alpha-correct) and repacks the binary chunk.
 * The glTF JSON, including every VRM extension (humanoid, expressions, spring
 * bones, MToon), is left untouched apart from buffer offsets.
 */
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

interface BufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
  target?: number;
}

interface Gltf {
  images?: { bufferView?: number; mimeType?: string; name?: string; uri?: string }[];
  bufferViews?: BufferView[];
  buffers?: { byteLength: number; uri?: string }[];
  [key: string]: unknown;
}

export interface OptimizeOptions {
  /** Longest texture edge after optimisation, in pixels. */
  maxSize: number;
  /** JPEG quality (1–100) for images that were JPEG to begin with. */
  jpegQuality?: number;
}

export interface ImageReport {
  name: string;
  mime: string;
  from: [number, number];
  to: [number, number];
  bytesBefore: number;
  bytesAfter: number;
}

export interface OptimizeReport {
  bytesBefore: number;
  bytesAfter: number;
  images: ImageReport[];
}

export function parseGlb(buf: Buffer): { json: Gltf; bin: Buffer } {
  if (buf.length < 20 || buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error('not a binary glTF (.glb/.vrm) file');
  let offset = 12;
  let json: Gltf | null = null;
  let bin: Buffer = Buffer.alloc(0);
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32LE(offset);
    const type = buf.readUInt32LE(offset + 4);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === CHUNK_JSON) json = JSON.parse(data.toString('utf8')) as Gltf;
    else if (type === CHUNK_BIN) bin = data;
    offset += 8 + len;
  }
  if (!json) throw new Error('GLB has no JSON chunk');
  return { json, bin };
}

export function writeGlb(json: Gltf, bin: Buffer): Buffer {
  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
  const binBuf = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  const total = 12 + 8 + jsonBuf.length + (binBuf.length ? 8 + binBuf.length : 0);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonBuf.length, 0);
  jsonHeader.writeUInt32LE(CHUNK_JSON, 4);
  const parts = [header, jsonHeader, jsonBuf];
  if (binBuf.length) {
    const binHeader = Buffer.alloc(8);
    binHeader.writeUInt32LE(binBuf.length, 0);
    binHeader.writeUInt32LE(CHUNK_BIN, 4);
    parts.push(binHeader, binBuf);
  }
  return Buffer.concat(parts);
}

/** Area-average downscale on premultiplied RGBA, so transparent edges don't go dark. */
export function resizeRgba(src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  const out = new Uint8Array(dw * dh * 4);
  const sx = sw / dw;
  const sy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = y * sy;
    const y1 = y0 + sy;
    for (let x = 0; x < dw; x++) {
      const x0 = x * sx;
      const x1 = x0 + sx;
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let yy = Math.floor(y0); yy < Math.min(sh, Math.ceil(y1)); yy++) {
        const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
        for (let xx = Math.floor(x0); xx < Math.min(sw, Math.ceil(x1)); xx++) {
          const w = (Math.min(xx + 1, x1) - Math.max(xx, x0)) * wy;
          const i = (yy * sw + xx) * 4;
          const al = src[i + 3]! / 255;
          r += src[i]! * al * w;
          g += src[i + 1]! * al * w;
          b += src[i + 2]! * al * w;
          a += al * w;
          wsum += w;
        }
      }
      const o = (y * dw + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round((a / wsum) * 255);
    }
  }
  return out;
}

function fitWithin(w: number, h: number, max: number): [number, number] {
  if (w <= max && h <= max) return [w, h];
  const s = max / Math.max(w, h);
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

function reencode(data: Buffer, mime: string, maxSize: number, jpegQuality: number): { data: Buffer; from: [number, number]; to: [number, number] } | null {
  if (mime === 'image/png') {
    const png = PNG.sync.read(data);
    const [dw, dh] = fitWithin(png.width, png.height, maxSize);
    if (dw === png.width && dh === png.height) return null;
    const out = new PNG({ width: dw, height: dh });
    out.data = Buffer.from(resizeRgba(png.data, png.width, png.height, dw, dh));
    return { data: PNG.sync.write(out, { deflateLevel: 9 }), from: [png.width, png.height], to: [dw, dh] };
  }
  if (mime === 'image/jpeg') {
    const img = jpeg.decode(data, { useTArray: true, formatAsRGBA: true });
    const [dw, dh] = fitWithin(img.width, img.height, maxSize);
    if (dw === img.width && dh === img.height) return null;
    const resized = resizeRgba(img.data, img.width, img.height, dw, dh);
    const enc = jpeg.encode({ data: resized, width: dw, height: dh }, jpegQuality);
    return { data: Buffer.from(enc.data), from: [img.width, img.height], to: [dw, dh] };
  }
  return null; // KTX2, WebP, etc.: leave as is
}

export function optimizeGlb(input: Buffer, opts: OptimizeOptions): { output: Buffer; report: OptimizeReport } {
  const { json, bin } = parseGlb(input);
  const views = json.bufferViews ?? [];
  const replaced = new Map<number, Buffer>();
  const images: ImageReport[] = [];

  (json.images ?? []).forEach((img, index) => {
    if (img.bufferView === undefined || replaced.has(img.bufferView)) return;
    const view = views[img.bufferView];
    if (!view || view.buffer !== 0) return;
    const start = view.byteOffset ?? 0;
    const data = bin.subarray(start, start + view.byteLength);
    const mime = img.mimeType ?? '';
    const result = reencode(data, mime, opts.maxSize, opts.jpegQuality ?? 90);
    if (!result || result.data.length >= data.length) return; // never make a texture bigger
    replaced.set(img.bufferView, result.data);
    images.push({
      name: img.name || `image_${index}`,
      mime,
      from: result.from,
      to: result.to,
      bytesBefore: data.length,
      bytesAfter: result.data.length,
    });
  });

  if (replaced.size === 0) return { output: input, report: { bytesBefore: input.length, bytesAfter: input.length, images } };

  // Repack buffer 0 view by view, keeping 4-byte alignment for accessors.
  const chunks: Buffer[] = [];
  let cursor = 0;
  views.forEach((view, i) => {
    if (view.buffer !== 0) return;
    const pad = (4 - (cursor % 4)) % 4;
    if (pad) {
      chunks.push(Buffer.alloc(pad));
      cursor += pad;
    }
    const start = view.byteOffset ?? 0;
    const data = replaced.get(i) ?? bin.subarray(start, start + view.byteLength);
    view.byteOffset = cursor;
    view.byteLength = data.length;
    chunks.push(data);
    cursor += data.length;
  });
  const newBin = Buffer.concat(chunks);
  if (json.buffers?.[0]) json.buffers[0].byteLength = newBin.length;
  const output = writeGlb(json, newBin);
  return { output, report: { bytesBefore: input.length, bytesAfter: output.length, images } };
}
