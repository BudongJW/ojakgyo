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
