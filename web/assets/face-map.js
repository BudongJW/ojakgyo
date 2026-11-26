// Face tracking helpers shared by /tracker and the avatar overlay. Pure functions, no DOM.
// Input is MediaPipe Face Landmarker output: ARKit-named blendshapes (0..1) and head rotation.

const clamp = (v) => Math.max(0, Math.min(1, v));

/** Mirror mode: the avatar moves like your reflection, so left and right swap. */
export function mirrorBlend(blend) {
  const out = {};
  for (const [k, v] of Object.entries(blend)) {
    const swapped = k.endsWith('Left') ? `${k.slice(0, -4)}Right` : k.endsWith('Right') ? `${k.slice(0, -5)}Left` : k;
    out[swapped] = v;
  }
  return out;
}

/**
 * Map ARKit blendshapes onto the VRM preset expressions every VRM has, for
 * models without Perfect Sync. Thresholds trim the resting noise webcams produce.
 */
export function toVrmPresets(b) {
  const g = (k) => b[k] ?? 0;
  const smile = (g('mouthSmileLeft') + g('mouthSmileRight')) / 2;
  const stretch = (g('mouthStretchLeft') + g('mouthStretchRight')) / 2;
  return {
    blinkLeft: clamp((g('eyeBlinkLeft') - 0.1) / 0.6),
    blinkRight: clamp((g('eyeBlinkRight') - 0.1) / 0.6),
    aa: clamp(g('jawOpen') * 1.8),
    ou: clamp((Math.max(g('mouthPucker'), g('mouthFunnel')) - 0.1) * 1.4),
    ee: clamp((stretch - 0.1) * 1.5),
    happy: clamp((smile - 0.2) * 1.6),
  };
}

/** Exponential smoothing for jittery tracking values; k = 1 means no smoothing. */
export function smooth(prev, next, k) {
  const out = {};
  for (const [key, v] of Object.entries(next)) out[key] = prev && key in prev ? prev[key] + (v - prev[key]) * k : v;
  return out;
}

/**
 * Head rotation for the avatar. `head` is [pitch, yaw, roll] in radians as sent by /tracker.
 * Mirror mode turns the avatar like a reflection (yaw and roll flip); VRM 0.x rigs face the
 * other way in model space, so their pitch and roll flip too.
 */
export function headRotation(head, { mirror = true, vrm0 = false, limit = 0.7 } = {}) {
  const lim = (v) => Math.max(-limit, Math.min(limit, v));
  let [pitch, yaw, roll] = head;
  if (mirror) {
    yaw = -yaw;
    roll = -roll;
  }
  if (vrm0) {
    pitch = -pitch;
    roll = -roll;
  }
  return [lim(pitch), lim(yaw), lim(roll)];
}
