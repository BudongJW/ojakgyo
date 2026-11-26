// /overlay/avatar picks its renderer from the configured model: Inochi2D puppets (.inp, .inx)
// get the 2D renderer, everything else the VRM one. One OBS URL works for both.
let format = 'vrm';
try {
  format = (await (await fetch('/api/avatar')).json()).format ?? 'vrm';
} catch {
  /* the VRM overlay shows its own notice when the bridge is unreachable */
}
await import(format === 'inochi2d' ? './overlay-inochi.js' : './overlay-avatar.js');
