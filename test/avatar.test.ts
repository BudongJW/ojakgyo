import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { optimizeGlb, parseGlb, resizeRgba, writeGlb } from '../src/avatar/optimize.js';

function png(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const img = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) img.data.set(rgba, i * 4);
  return PNG.sync.write(img);
}

/** A tiny VRM-like GLB: one texture, one accessor's worth of geometry after it, and VRM extensions. */
function fixture(texture: Buffer) {
  const geometry = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
  const pad = Buffer.alloc((4 - (texture.length % 4)) % 4);
  const bin = Buffer.concat([texture, pad, geometry]);
  const json = {
    asset: { version: '2.0' },
    extensionsUsed: ['VRMC_vrm', 'VRMC_springBone'],
    extensions: {
      VRMC_vrm: { specVersion: '1.0', meta: { name: 'Test', licenseUrl: 'https://vrm.dev/licenses/1.0/' }, expressions: { preset: { happy: {} } } },
      VRMC_springBone: { springs: [{ joints: [{ node: 0 }] }] },
    },
    images: [{ bufferView: 0, mimeType: 'image/png', name: 'skin' }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: texture.length },
      { buffer: 0, byteOffset: texture.length + pad.length, byteLength: geometry.length, target: 34962 },
    ],
    accessors: [{ bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' }],
    buffers: [{ byteLength: bin.length }],
  };
  return { glb: writeGlb(json, bin), geometry, json };
}

describe('avatar optimize', () => {
  it('downscales textures, keeps aspect ratio, VRM extensions and geometry', () => {
    const { glb, geometry, json } = fixture(png(64, 48, [200, 40, 90, 255]));
    const { output, report } = optimizeGlb(glb, { maxSize: 16 });

    expect(report.images).toHaveLength(1);
    expect(report.images[0]).toMatchObject({ name: 'skin', from: [64, 48], to: [16, 12] });
    expect(report.bytesAfter).toBeLessThan(report.bytesBefore);

    const out = parseGlb(output);
    expect(out.json.extensions).toEqual(json.extensions);
    expect(out.json.extensionsUsed).toEqual(json.extensionsUsed);

    const views = out.json.bufferViews!;
    for (const v of views) expect((v.byteOffset ?? 0) % 4).toBe(0);
    expect(out.json.buffers![0]!.byteLength).toBe(out.bin.length);

    const img = PNG.sync.read(out.bin.subarray(views[0]!.byteOffset, views[0]!.byteOffset! + views[0]!.byteLength));
    expect([img.width, img.height]).toEqual([16, 12]);
    expect([...img.data.subarray(0, 4)]).toEqual([200, 40, 90, 255]);

    const geo = out.bin.subarray(views[1]!.byteOffset, views[1]!.byteOffset! + views[1]!.byteLength);
    expect(Buffer.compare(geo, geometry)).toBe(0);
  });

  it('leaves files alone when every texture is already small enough', () => {
    const { glb } = fixture(png(32, 32, [1, 2, 3, 255]));
    const { output, report } = optimizeGlb(glb, { maxSize: 1024 });
    expect(report.images).toHaveLength(0);
    expect(output).toBe(glb);
  });

  it('rejects files that are not binary glTF', () => {
    expect(() => optimizeGlb(Buffer.from('{"asset":{}}'), { maxSize: 512 })).toThrow(/not a binary glTF/);
  });

  it('averages with alpha so transparent pixels do not darken edges', () => {
    // 2x1: opaque red next to fully transparent black -> one pixel, red at half opacity
    const src = new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0]);
    expect([...resizeRgba(src, 2, 1, 1, 1)]).toEqual([255, 0, 0, 128]);
  });
});
