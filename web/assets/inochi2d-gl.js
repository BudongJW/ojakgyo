// WebGL2 renderer for puppets from inochi2d-core.js. Mirrors the Inochi2D 0.8 draw path
// (BSD 2-Clause, Copyright (c) 2020, Inochi2D Project; see inochi2d-core.js for the notice):
// premultiplied colour, stencil masks, the basic blend modes, and Composites drawn offscreen
// and blended back as one layer.
import { Composite, Part } from './inochi2d-core.js';

const VERT = `#version 300 es
in vec2 pos;
in vec2 uv;
uniform vec4 view; // centre x, centre y, half width, half height (model units)
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4((pos.x - view.x) / view.z, -(pos.y - view.y) / view.w, 0.0, 1.0);
}`;

// Inochi2D samples with GL_CLAMP_TO_BORDER and a transparent border, so meshes whose UVs
// run past the image edge show nothing there. WebGL has no border mode; test the UV instead.
const BORDER = `
bool outside(vec2 uv) { return any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0))); }`;

const FRAG = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D tex;
uniform float opacity;
uniform vec3 multColor;
uniform vec3 screenColor;
out vec4 outColor;
${BORDER}
void main() {
  vec4 c = outside(vUv) ? vec4(0.0) : texture(tex, vUv);
  vec3 s = vec3(1.0) - (vec3(1.0) - c.rgb) * (vec3(1.0) - screenColor * c.a);
  outColor = vec4(s, c.a) * vec4(multColor, 1.0) * opacity;
}`;

const MASK_FRAG = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D tex;
uniform float threshold;
out vec4 outColor;
${BORDER}
void main() {
  if ((outside(vUv) ? 0.0 : texture(tex, vUv).a) <= threshold) discard;
  outColor = vec4(1.0);
}`;

const QUAD_VERT = `#version 300 es
in vec2 pos;
out vec2 vUv;
void main() {
  vUv = pos * 0.5 + 0.5;
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

function program(gl, vs, fs) {
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'pos');
  gl.bindAttribLocation(p, 1, 'uv');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) {
    const name = gl.getActiveUniform(p, i).name;
    u[name] = gl.getUniformLocation(p, name);
  }
  return { p, u };
}

export class PuppetRenderer {
  /**
   * @param gl WebGL2 context created with { stencil: true, premultipliedAlpha: true }
   * @param puppet Puppet from inochi2d-core.js
   * @param images per texture index: { width, height, data: RGBA } or an ImageBitmap, premultiplied
   */
  constructor(gl, puppet, images) {
    this.gl = gl;
    this.puppet = puppet;
    this.part = program(gl, VERT, FRAG);
    this.mask = program(gl, VERT, MASK_FRAG);
    this.quad = program(gl, QUAD_VERT, FRAG);
    this.textures = images.map((img) => this.texture(img));
    this.white = this.texture({ width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) });
    this.meshes = new Map();
    for (const n of puppet.nodes.values()) if (n.verts && n.indices?.length) this.meshes.set(n, this.mesh(n));
    this.quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    this.fbo = null;
  }

  texture(img) {
    const gl = this.gl;
    if (!img) return null;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (img.data) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, img.width, img.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, img.data);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  mesh(n) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const pos = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, pos);
    gl.bufferData(gl.ARRAY_BUFFER, n.positions.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const uv = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, uv);
    gl.bufferData(gl.ARRAY_BUFFER, n.uvs.length ? n.uvs : new Float32Array(n.verts.length), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
    const idx = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, n.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, pos, count: n.indices.length };
  }

  /** Offscreen target for Composites, sized like the canvas. */
  ensureFbo(w, h) {
    const gl = this.gl;
    if (this.fbo && this.fbo.w === w && this.fbo.h === h) return this.fbo;
    if (this.fbo) {
      gl.deleteFramebuffer(this.fbo.fb);
      gl.deleteTexture(this.fbo.tex);
      gl.deleteRenderbuffer(this.fbo.rb);
    }
    const fb = gl.createFramebuffer();
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const rb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, rb);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.fbo = { fb, tex, rb, w, h };
    return this.fbo;
  }

  /** Blend functions of Inochi2D's non-advanced path (nodes/common.d inSetBlendMode). */
  blend(mode) {
    const gl = this.gl;
    gl.blendEquation(gl.FUNC_ADD);
    switch (mode) {
      case 'Multiply': gl.blendFunc(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA); break;
      case 'Screen': gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR); break;
      case 'Lighten': gl.blendEquation(gl.MAX); gl.blendFunc(gl.ONE, gl.ONE); break;
      case 'ColorDodge': gl.blendFunc(gl.DST_COLOR, gl.ONE); break;
      case 'LinearDodge': gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_COLOR, gl.ONE, gl.ONE_MINUS_SRC_ALPHA); break;
      case 'AddGlow': gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE_MINUS_SRC_ALPHA); break;
      case 'Subtract': gl.blendEquationSeparate(gl.FUNC_REVERSE_SUBTRACT, gl.FUNC_ADD); gl.blendFunc(gl.ONE_MINUS_DST_COLOR, gl.ONE); break;
      case 'Exclusion': gl.blendFuncSeparate(gl.ONE_MINUS_DST_COLOR, gl.ONE_MINUS_SRC_COLOR, gl.ONE, gl.ONE); break;
      case 'Inverse': gl.blendFunc(gl.ONE_MINUS_DST_COLOR, gl.ONE_MINUS_SRC_ALPHA); break;
      case 'DestinationIn': gl.blendFunc(gl.ZERO, gl.SRC_ALPHA); break;
      case 'ClipToLower': gl.blendFunc(gl.DST_ALPHA, gl.ONE_MINUS_SRC_ALPHA); break;
      case 'SliceFromLower': gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA); break;
      default: gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }
  }

  drawMesh(n, prog) {
    const gl = this.gl;
    const m = this.meshes.get(n);
    if (!m) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, m.pos);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, n.positions);
    gl.bindVertexArray(m.vao);
    gl.useProgram(prog.p);
    gl.uniform4fv(prog.u.view, this.view);
    gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);
  }

  /** Stencil masks around `draw` (Part.drawOne / Composite.drawOne). */
  masked(node, draw) {
    const gl = this.gl;
    if (!node.masks.length) return draw();
    const hasMasks = node.masks.some((m) => m.mode !== 'DodgeMask');
    gl.enable(gl.STENCIL_TEST);
    gl.clearStencil(hasMasks ? 0 : 1);
    gl.clear(gl.STENCIL_BUFFER_BIT);
    gl.colorMask(false, false, false, false);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
    gl.stencilMask(0xff);
    for (const { source, mode } of node.masks) {
      gl.stencilFunc(gl.ALWAYS, mode === 'DodgeMask' ? 0 : 1, 0xff);
      gl.useProgram(this.mask.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, (source.texture >= 0 && this.textures[source.texture]) || this.white);
      gl.uniform1f(this.mask.u.threshold, Math.min(1, Math.max(-1, source.maskThreshold)));
      this.drawMesh(source, this.mask);
    }
    gl.colorMask(true, true, true, true);
    gl.stencilFunc(gl.EQUAL, 1, 0xff);
    gl.stencilMask(0x00);
    draw();
    gl.stencilMask(0xff);
    gl.stencilFunc(gl.ALWAYS, 1, 0xff);
    gl.disable(gl.STENCIL_TEST);
  }

  drawPart(p) {
    if (!p.renderEnabled || p.texture < 0 || !this.textures[p.texture]) return;
    const gl = this.gl;
    this.masked(p, () => {
      gl.useProgram(this.part.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.textures[p.texture]);
      gl.uniform1f(this.part.u.opacity, p.drawOpacity);
      gl.uniform3fv(this.part.u.multColor, p.drawTint);
      gl.uniform3fv(this.part.u.screenColor, p.drawScreen);
      this.blend(p.blend);
      this.drawMesh(p, this.part);
    });
  }

  drawComposite(c, target) {
    if (!c.renderEnabled || !c.subParts.length) return;
    const gl = this.gl;
    const fbo = this.ensureFbo(target.w, target.h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fb);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const parts = c.subParts.map((p, i) => [p, i]).sort((a, b) => b[0].zSort - a[0].zSort || a[1] - b[1]);
    for (const [p] of parts) this.drawPart(p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
    this.masked(c, () => {
      gl.useProgram(this.quad.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, fbo.tex);
      gl.uniform1f(this.quad.u.opacity, c.drawOpacity);
      gl.uniform3fv(this.quad.u.multColor, c.drawTint);
      gl.uniform3fv(this.quad.u.screenColor, c.drawScreen);
      this.blend(c.blend);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.disableVertexAttribArray(1);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    });
  }

  /**
   * Draw the puppet into the current canvas.
   * @param camera { x, y, height } — model point at the centre and visible model height
   */
  render(camera) {
    const gl = this.gl;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const halfH = camera.height / 2;
    this.view = new Float32Array([camera.x, camera.y, (halfH * w) / h, halfH]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    const target = { fb: null, w, h };
    for (const node of this.puppet.drawList()) {
      if (node instanceof Composite) this.drawComposite(node, target);
      else if (node instanceof Part) this.drawPart(node);
    }
  }
}
