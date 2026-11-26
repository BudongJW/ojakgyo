// Colour tools: sRGB <-> CIE Lab, k-means over texture pixels, and cluster-wise palette
// transfer that keeps each pixel's shading relative to its cluster.
import { requireRepo } from './lib.mjs';

const { PNG } = requireRepo('pngjs');

const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
const fi = (t) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));
const WHITE = [0.95047, 1, 1.08883];

export function rgbToLab(r, g, b) {
  const R = lin(r / 255), G = lin(g / 255), B = lin(b / 255);
  const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / WHITE[0];
  const y = (0.2126 * R + 0.7152 * G + 0.0722 * B) / WHITE[1];
  const z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / WHITE[2];
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

export function labToRgb(L, a, b) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const x = fi(fx) * WHITE[0], y = fi(fy) * WHITE[1], z = fi(fz) * WHITE[2];
  const R = 3.2406 * x - 1.5372 * y - 0.4986 * z;
  const G = -0.9689 * x + 1.8758 * y + 0.0415 * z;
  const B = 0.0557 * x - 0.204 * y + 1.057 * z;
  return [R, G, B].map((c) => Math.round(Math.min(1, Math.max(0, gam(Math.min(1, Math.max(0, c))))) * 255));
}

export const hexToLab = (hex) => rgbToLab(parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16));
export const labToHex = (lab) => '#' + labToRgb(...lab).map((v) => v.toString(16).padStart(2, '0')).join('');
export const chroma = (lab) => Math.hypot(lab[1], lab[2]);
export const hue = (lab) => ((Math.atan2(lab[2], lab[1]) * 180) / Math.PI + 360) % 360;

export function decodePng(bytes) {
  return PNG.sync.read(bytes);
}

export function encodePng(png) {
  return PNG.sync.write(png, { colorType: 6 });
}

/** k-means on the opaque pixels of an image, in Lab. Deterministic seeding (k-means++ on a fixed sample). */
export function kmeans(png, k = 6, iterations = 15) {
  const { data } = png;
  const pts = [];
  const step = Math.max(1, Math.floor(data.length / 4 / 40000));
  for (let i = 0; i < data.length; i += 4 * step) if (data[i + 3] > 128) pts.push(rgbToLab(data[i], data[i + 1], data[i + 2]));
  if (!pts.length) return { centroids: [], shares: [] };
  const d2 = (p, c) => (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
  const centroids = [pts[Math.floor(pts.length / 2)]];
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  while (centroids.length < k) {
    const dist = pts.map((p) => Math.min(...centroids.map((c) => d2(p, c))));
    const total = dist.reduce((a, b) => a + b, 0);
    if (!total) break;
    let r = rand() * total, i = 0;
    while ((r -= dist[i]) > 0 && i < pts.length - 1) i++;
    centroids.push(pts[i]);
  }
  let assign = new Array(pts.length).fill(0);
  for (let it = 0; it < iterations; it++) {
    assign = pts.map((p) => centroids.reduce((best, c, j) => (d2(p, c) < d2(p, centroids[best]) ? j : best), 0));
    for (let j = 0; j < centroids.length; j++) {
      const mine = pts.filter((_, i) => assign[i] === j);
      if (mine.length) centroids[j] = [0, 1, 2].map((d) => mine.reduce((s, p) => s + p[d], 0) / mine.length);
    }
  }
  const shares = centroids.map((_, j) => assign.filter((a) => a === j).length / pts.length);
  return { centroids, shares };
}

/**
 * Move every pixel along with its cluster: clusters mapped to a target colour carry their
 * pixels' lightness and tint offsets over (lightness scaled so shading survives a big jump),
 * unmapped clusters stay. Soft assignment avoids seams between clusters.
 */
export function transfer(png, centroids, targets, { sigma = 10, keepTint = 0.5 } = {}) {
  const { data, width, height } = png;
  const out = Buffer.from(data);
  // targets: one per cluster, or a function (cluster, u, v) for colours that depend on where
  // they sit in the texture (the same white is a blouse up top and a frill down below).
  const targetAt = typeof targets === 'function' ? targets : (j) => targets[j];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const px = i / 4;
    const u = (px % width) / width, v = Math.floor(px / width) / height;
    const p = rgbToLab(data[i], data[i + 1], data[i + 2]);
    let wsum = 0;
    const acc = [0, 0, 0];
    centroids.forEach((c, j) => {
      const d = Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]);
      const w = Math.exp(-(d * d) / (2 * sigma * sigma)) + 1e-9;
      const t = targetAt(j, u, v);
      let q = p;
      if (t) {
        const s = Math.min(1.3, Math.max(0.3, (t[0] + 8) / (c[0] + 8)));
        q = [t[0] + (p[0] - c[0]) * s, t[1] + (p[1] - c[1]) * keepTint, t[2] + (p[2] - c[2]) * keepTint];
      }
      acc[0] += w * q[0];
      acc[1] += w * q[1];
      acc[2] += w * q[2];
      wsum += w;
    });
    const [r, g, b] = labToRgb(acc[0] / wsum, acc[1] / wsum, acc[2] / wsum);
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b;
  }
  return { ...png, data: out };
}
