import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readAvatarLicense } from '../src/avatar/license.js';
import { parseGlb } from '../src/avatar/optimize.js';

const KKACHI = 'examples/avatars/kkachi/kkachi.vrm';

describe('bundled sample avatar', () => {
  it('stays free to stream with and redistribute', () => {
    expect(readAvatarLicense(KKACHI)).toMatchObject({ format: 'vrm0', title: 'Kkachi', authors: ['ojakgyo'], license: 'CC0', verdict: 'ok', notes: [] });
  });

  it('keeps what the overlay needs: humanoid rig, expressions, light textures', () => {
    const { json } = parseGlb(readFileSync(KKACHI));
    const vrm = (json as { extensions: { VRM: { humanoid: { humanBones: unknown[] }; blendShapeMaster: { blendShapeGroups: { presetName: string }[] } } } }).extensions.VRM;
    expect(vrm.humanoid.humanBones.length).toBeGreaterThanOrEqual(50);
    const presets = vrm.blendShapeMaster.blendShapeGroups.map((g) => g.presetName);
    for (const p of ['a', 'blink', 'blink_l', 'blink_r', 'joy']) expect(presets).toContain(p);
    for (const img of (json as { images: { mimeType: string; bufferView: number }[] }).images) {
      expect(['image/png', 'image/jpeg']).toContain(img.mimeType);
    }
  });
});

const KKACHI_2D = 'examples/avatars/kkachi-2d/kkachi2d.inp';
const KKACHI_PSD = 'examples/avatars/kkachi-2d/kkachi2d.psd';
const inochi = () => import('../web/assets/inochi2d-core.js') as Promise<any>;

describe('bundled 2D sample avatar', () => {
  it('stays free to stream with and redistribute', () => {
    const license = readAvatarLicense(KKACHI_2D);
    expect(license).toMatchObject({ format: 'inochi2d', title: 'Kkachi 2D', verdict: 'ok' });
    expect(license.license).toContain('publicdomain/zero');
  });

  it('has the parameters the overlay drives, and they move the right parts the right way', async () => {
    const { parseInx, Puppet } = await inochi();
    const { puppet: json, textures } = parseInx(new Uint8Array(readFileSync(KKACHI_2D)));
    expect(textures).toHaveLength(34);
    expect(textures.every((t: { format: string }) => t.format === 'png')).toBe(true);
    const p = new Puppet(json);
    for (const name of ['Head:: Yaw-Pitch', 'Head:: Roll', 'Body:: Yaw-Pitch', 'Body:: Roll', 'Breath', 'Eye:: Left:: Blink', 'Eye:: Right:: Blink', 'Eye:: Left:: Move', 'Eye:: Right:: Move', 'Mouth:: Shape', 'happy', 'angry', 'sad', 'relaxed', 'surprised']) {
      expect(p.find(name), name).toBeTruthy();
    }
    expect(p.drivers.length).toBe(7); // hair pendulums

    const part = (name: string) => [...p.nodes.values()].find((n: { name: string }) => n.name === name);
    const centre = (name: string) => {
      const pos: Float32Array = part(name).positions;
      let x = 0, y = 0;
      for (let i = 0; i < pos.length; i += 2) { x += pos[i]!; y += pos[i + 1]!; }
      return [x / (pos.length / 2), y / (pos.length / 2)] as const;
    };
    const after = (name: string, x: number, y: number | undefined, measure: string) => {
      const prm = p.find(name);
      const rest = [...prm.value] as [number, number];
      p.update(0);
      const before = centre(measure);
      p.set(prm, x, y ?? rest[1]);
      p.update(0);
      const moved = centre(measure);
      p.set(prm, rest[0], rest[1]);
      p.update(0);
      return [moved[0] - before[0], moved[1] - before[1]];
    };
    // The character's left eye is on the viewer's right.
    p.update(0);
    expect(centre('Eye:: Left:: Lash')[0]).toBeGreaterThan(centre('Eye:: Right:: Lash')[0]);
    // Yaw +1 turns the face to the viewer's right, pitch +1 tilts it up (screen y grows downwards).
    expect(after('Head:: Yaw-Pitch', 1, 0, 'Face')[0]).toBeGreaterThan(10);
    expect(after('Head:: Yaw-Pitch', 0, 1, 'Face')[1]).toBeLessThan(-3);
    // Blinking brings the upper lashes down; an open mouth moves its inside down.
    expect(after('Eye:: Left:: Blink', 1, undefined, 'Eye:: Left:: Lash')[1]).toBeGreaterThan(3);
    expect(after('Eye:: Right:: Blink', 1, undefined, 'Eye:: Left:: Lash')[1]).toBeCloseTo(0, 1);
    expect(after('Mouth:: Shape', 0.6, 1, 'Mouth:: Inside')[1]).toBeGreaterThan(2);
  });

  it('ships a Live2D-ready PSD: RGB, 8 bits, 34 layers', () => {
    const psd = readFileSync(KKACHI_PSD);
    expect(psd.toString('latin1', 0, 4)).toBe('8BPS');
    expect([psd.readUInt16BE(12), psd.readUInt32BE(14), psd.readUInt32BE(18), psd.readUInt16BE(22), psd.readUInt16BE(24)]).toEqual([4, 2048, 2048, 8, 3]);
    const layerInfo = 26 + 4 + psd.readUInt32BE(26) + 4 + psd.readUInt32BE(30 + psd.readUInt32BE(26)) + 4;
    expect(Math.abs(psd.readInt16BE(layerInfo + 4))).toBe(34);
  });
});
