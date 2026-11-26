// How far is the new face from each source face (head-aligned, face front only)?
// Usage: VROID_SAMPLES=<folder> node face-diff.mjs [../kkachi.vrm]
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAMES, faceData } from './face-space.mjs';
import { loadVrm, parseGlb } from './lib.mjs';

const built = parseGlb(readFileSync(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'kkachi.vrm')));
const mine = faceData({ json: built.json, bin: Buffer.from(built.bin) });
const sources = NAMES.map((n) => faceData(loadVrm(n)));
for (const [s, f] of sources.entries()) {
  let sum = 0, n = 0, max = 0;
  for (let i = 0; i < f.local.length; i += 3) {
    if (mine.local[i + 2] > -0.03 || mine.local[i + 1] < 0.02 || mine.local[i + 1] > 0.11) continue; // front of the face
    const d = Math.hypot(mine.local[i] - f.local[i], mine.local[i + 1] - f.local[i + 1], mine.local[i + 2] - f.local[i + 2]);
    sum += d * d;
    max = Math.max(max, d);
    n++;
  }
  console.log(`${NAMES[s].padEnd(16)} RMS ${(Math.sqrt(sum / n) * 1000).toFixed(2)} mm, max ${(max * 1000).toFixed(1)} mm over ${n} front vertices`);
}
