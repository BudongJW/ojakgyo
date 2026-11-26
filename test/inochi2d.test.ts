import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/app.js';
import { parseConfig } from '../src/config.js';
import { MemoryStore } from '../src/core/store.js';
import { avatarFormat } from '../src/server/http.js';

const load = () => import('../web/assets/inochi2d-core.js') as Promise<any>;

/** Build an .inp file: magic, BE JSON length, JSON, then a texture section. */
function inp(json: unknown, textures: Array<{ type: number; bytes: Uint8Array }> = []): Uint8Array {
  const body = Buffer.from(JSON.stringify(json));
  const parts: Buffer[] = [Buffer.from('TRNSRTS\0', 'latin1'), Buffer.alloc(4), body, Buffer.from('TEX_SECT', 'latin1'), Buffer.alloc(4)];
  parts[1]!.writeUInt32BE(body.length);
  parts[4]!.writeUInt32BE(textures.length);
  for (const t of textures) {
    const head = Buffer.alloc(5);
    head.writeUInt32BE(t.bytes.length);
    head[4] = t.type;
    parts.push(head, Buffer.from(t.bytes));
  }
  return new Uint8Array(Buffer.concat(parts));
}

/** 2×2 TGA, 32-bit BGRA, bottom-up rows: bottom row red, green; top row blue, white half alpha. */
function tga(): Uint8Array {
  const head = new Uint8Array(18);
  head[2] = 2;
  head[12] = 2;
  head[14] = 2;
  head[16] = 32;
  head[17] = 8;
  const px = [0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 128, 128, 128, 128];
  return new Uint8Array([...head, ...px]);
}

const quad = (x = 0, y = 0) => ({ verts: [x, y, x + 10, y, x + 10, y + 10, x, y + 10], uvs: [0, 0, 1, 0, 1, 1, 0, 1], indices: [0, 1, 2, 0, 2, 3], origin: [0, 0] });
const node = (uuid: number, type: string, extra: object = {}, children: object[] = []) => ({ uuid, name: `n${uuid}`, type, enabled: true, zsort: 0, transform: { trans: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1] }, children, ...extra });
const param = (uuid: number, name: string, bindings: object[], extra: object = {}) => ({ uuid, name, is_vec2: false, min: [0, 0], max: [1, 1], defaults: [0, 0], axis_points: [[0, 1], [0]], bindings, ...extra });

describe('Inochi2D files', () => {
  it('splits the puppet JSON and its textures', async () => {
    const { parseInx } = await load();
    const file = inp({ nodes: node(1, 'Node') }, [{ type: 1, bytes: tga() }, { type: 0, bytes: new Uint8Array([1, 2, 3]) }]);
    const { puppet, textures } = parseInx(file.buffer);
    expect(puppet.nodes.uuid).toBe(1);
    expect(textures.map((t: any) => [t.format, t.bytes.length])).toEqual([['tga', 34], ['png', 3]]);
  });

  it('rejects files that are not puppets or are cut short', async () => {
    const { parseInx } = await load();
    expect(() => parseInx(new TextEncoder().encode('glTF....nope'))).toThrow(/Not an Inochi2D puppet/);
    const file = inp({ nodes: node(1, 'Node') }, [{ type: 1, bytes: tga() }]);
    expect(() => parseInx(file.subarray(0, file.length - 5))).toThrow(/truncated/);
  });

  it('decodes raw and RLE TGA images top-down without touching alpha', async () => {
    const { decodeTga } = await load();
    const img = decodeTga(tga());
    expect([img.width, img.height]).toEqual([2, 2]);
    // top row (stored last): blue, then the half-alpha pixel kept exactly as stored
    expect([...img.data.subarray(0, 8)]).toEqual([0, 0, 255, 255, 128, 128, 128, 128]);
    expect([...img.data.subarray(8, 16)]).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);

    // RLE, 24-bit: one run of 3 red pixels, then one literal green pixel; top-down flag set
    const rle = new Uint8Array([0, 0, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 2, 0, 24, 0x20, 0x82, 0, 0, 255, 0x00, 0, 255, 0]);
    const out = decodeTga(rle);
    expect([...out.data]).toEqual([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255]);
  });
});

describe('keypoint re-interpolation', () => {
  it('interpolates between set keypoints along an axis', async () => {
    const { reInterpolate } = await load();
    const values = [[0], [99], [8]];
    reInterpolate(values, [[true], [false], [true]], [[0, 0.25, 1], [0]]);
    expect(values[1]![0]).toBeCloseTo(2);
  });

  it('extrapolates a missing corner and extends to the edges', async () => {
    const { reInterpolate } = await load();
    const grid = [[0, 1], [10, 0]];
    reInterpolate(grid, [[true, true], [true, false]], [[0, 1], [0, 1]]);
    expect(grid[1]![1]).toBe(11);
    const row = [[0], [5], [0]];
    reInterpolate(row, [[false], [true], [false]], [[0, 0.5, 1], [0]]);
    expect(row.map((r) => r[0])).toEqual([5, 5, 5]);
  });

  it('reports a binding with nothing set', async () => {
    const { reInterpolate } = await load();
    expect(reInterpolate([[0], [0]], [[false], [false]], [[0, 1], [0]])).toBe(false);
  });
});

describe('puppet runtime', () => {
  it('moves and bends parts through parameter bindings', async () => {
    const { Puppet } = await load();
    const p = new Puppet({
      nodes: node(1, 'Node', {}, [node(2, 'Part', { textures: [0], mesh: quad() })]),
      param: [
        param(10, 'Move', [{ node: 2, param_name: 'transform.t.x', values: [[0], [10]], isSet: [[true], [true]] }]),
        param(11, 'Bend', [{ node: 2, param_name: 'deform', values: [[[[0, 0], [0, 0], [0, 0], [0, 0]]], [[[0, 0], [0, 0], [0, 4], [0, 4]]]], isSet: [[true], [true]] }]),
      ],
    });
    const part = p.nodes.get(2);
    p.set(p.find('move'), 0.5);
    p.set(p.find('  BEND '), 1);
    p.update(1 / 60);
    expect([...part.positions]).toEqual([5, 0, 15, 0, 15, 14, 5, 14]);
  });

  it('fills keypoints a file leaves out before applying them', async () => {
    const { Puppet } = await load();
    const p = new Puppet({
      nodes: node(1, 'Node', {}, [node(2, 'Part', { textures: [0], mesh: quad() })]),
      param: [param(10, 'Move', [{ node: 2, param_name: 'transform.t.y', values: [[0], [null], [8]], isSet: [[true], [false], [true]] }], { axis_points: [[0, 0.5, 1], [0]] })],
    });
    p.set(p.find('Move'), 0.5);
    p.update(1 / 60);
    expect(p.nodes.get(2).positions[1]).toBeCloseTo(4);
  });

  it('draws back to front by zSort and keeps Composite children together', async () => {
    const { Puppet } = await load();
    const p = new Puppet({
      nodes: node(1, 'Node', {}, [
        node(2, 'Part', { textures: [0], mesh: quad(), zsort: -1 }),
        node(3, 'Part', { textures: [0], mesh: quad(), zsort: 1 }),
        node(4, 'Composite', { zsort: 0 }, [node(5, 'Part', { textures: [0], mesh: quad() })]),
      ]),
      param: [param(10, 'Front', [{ node: 3, param_name: 'zSort', values: [[0], [-5]], isSet: [[true], [true]] }])],
    });
    expect(p.drawList().map((n: any) => n.uuid)).toEqual([3, 4, 2]);
    expect(p.nodes.get(4).subParts.map((n: any) => n.uuid)).toEqual([5]);
    p.set(p.find('Front'), 1);
    p.update(1 / 60);
    expect(p.drawList().map((n: any) => n.uuid)).toEqual([4, 2, 3]);
  });

  it('swings physics when the anchor moves and settles again', async () => {
    const { Puppet } = await load();
    const p = new Puppet({
      physics: { pixelsPerMeter: 1000, gravity: 9.8 },
      nodes: node(1, 'Node', {}, [
        node(2, 'Node', {}, [node(3, 'SimplePhysics', { param: 20, model_type: 'Pendulum', map_mode: 'XY', length: 100, gravity: 1, angle_damping: 0.5, output_scale: [1, 1] })]),
      ]),
      param: [
        param(10, 'Sway', [{ node: 2, param_name: 'transform.t.x', values: [[0], [80]], isSet: [[true], [true]] }]),
        param(20, 'Hair', [], { is_vec2: true, min: [-1, -1], max: [1, 1], axis_points: [[0, 0.5, 1], [0, 0.5, 1]] }),
      ],
    });
    const hair = p.find('Hair');
    for (let i = 0; i < 30; i++) p.update(1 / 60);
    expect(Math.abs(hair.value[0])).toBeLessThan(1e-6);
    p.set(p.find('Sway'), 1);
    p.update(1 / 60);
    // The bob lags behind the anchor that jumped right, so the hair swings out to the left.
    expect(hair.value[0]).toBeLessThan(-0.1);
    for (let i = 0; i < 600; i++) p.update(1 / 60);
    expect(Math.abs(hair.value[0])).toBeLessThan(0.02);
  });

  it('carries parts along with a MeshGroup in both of its modes', async () => {
    const { Puppet } = await load();
    const tri = { verts: [-100, -100, 100, -100, 0, 100], uvs: [0, 0, 1, 0, 0.5, 1], indices: [0, 1, 2], origin: [0, 0] };
    const build = (dynamic: boolean) =>
      new Puppet({
        nodes: node(1, 'Node', {}, [
          node(2, 'MeshGroup', { mesh: tri, dynamic_deformation: dynamic, translate_children: !dynamic }, [
            node(3, 'Part', { textures: [0], mesh: { verts: [0, -50, 10, -50, 0, -40], uvs: [0, 0, 1, 0, 0, 1], indices: [0, 1, 2], origin: [0, 0] } }),
          ]),
        ]),
        // Shift the whole group mesh 20 px right: everything inside follows.
        param: [param(10, 'Shift', [{ node: 2, param_name: 'deform', values: [[[[0, 0], [0, 0], [0, 0]]], [[[20, 0], [20, 0], [20, 0]]]], isSet: [[true], [true]] }])],
      });
    for (const dynamic of [false, true]) {
      const p = build(dynamic);
      p.set(p.find('Shift'), 1);
      p.update(1 / 60);
      expect([...p.nodes.get(3).positions].map((v) => Math.round(v))).toEqual([20, -50, 30, -50, 20, -40]);
    }
  });
});

let app: App | null = null;
afterEach(async () => {
  await app?.stop();
  app = null;
});

describe('2D avatar serving', () => {
  it('tells the overlay which renderer a model needs', () => {
    expect(avatarFormat('/models/Aka.inx')).toBe('inochi2d');
    expect(avatarFormat('C:\\models\\puppet.INP')).toBe('inochi2d');
    expect(avatarFormat('/models/avatar.vrm')).toBe('vrm');
    expect(avatarFormat(null)).toBe('vrm');
  });

  it('serves an Inochi2D puppet from /avatar/model', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ojakgyo-2d-'));
    const file = join(dir, 'puppet.inp');
    const bytes = inp({ nodes: node(1, 'Node') });
    writeFileSync(file, bytes);
    const port = 20000 + Math.floor(Math.random() * 20000);
    const config = parseConfig(`server: { port: ${port} }\noutputs:\n  avatar: { enabled: true, model: ${JSON.stringify(file)} }\n`);
    app = new App({ config, path: null, dataDir: mkdtempSync(join(tmpdir(), 'ojakgyo-data-')) }, { store: new MemoryStore() });
    await app.start();
    const base = `http://127.0.0.1:${port}`;
    expect(await (await fetch(`${base}/api/avatar`)).json()).toMatchObject({ enabled: true, hasModel: true, format: 'inochi2d' });
    const res = await fetch(`${base}/avatar/model`);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
    expect((await fetch(`${base}/assets/avatar-boot.js`)).status).toBe(200);
  });
});
