import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/app.js';
import { describeLicense, licenseFromGltf, licenseFromInochi, readAvatarLicense } from '../src/avatar/license.js';
import { parseConfig } from '../src/config.js';
import { MemoryStore } from '../src/core/store.js';

const vrm1 = (meta: Record<string, unknown>) => ({ extensions: { VRMC_vrm: { meta: { name: 'A', authors: ['Maker'], licenseUrl: 'https://vrm.dev/licenses/1.0/', avatarPermission: 'everyone', commercialUsage: 'corporation', ...meta } } } });
const vrm0 = (meta: Record<string, unknown>) => ({ extensions: { VRM: { meta: { title: 'B', author: 'Maker', allowedUserName: 'Everyone', commercialUssageName: 'Allow', licenseName: 'CC0', ...meta } } } });
const codes = (l: { notes: { code: string }[] }) => l.notes.map((n) => n.code);

/** Minimal .vrm: GLB header, JSON chunk, no binary chunk. */
function glb(json: unknown): Buffer {
  let body = Buffer.from(JSON.stringify(json));
  body = Buffer.concat([body, Buffer.alloc((4 - (body.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(20 + body.length, 8);
  head.writeUInt32LE(body.length, 12);
  head.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([head, body]);
}

describe('VRM 1.0 license fields', () => {
  it('passes a model any company may stream with', () => {
    const l = licenseFromGltf(vrm1({}));
    expect(l).toMatchObject({ format: 'vrm1', title: 'A', authors: ['Maker'], verdict: 'ok', notes: [] });
    expect(describeLicense(l)).toBe('"A" by Maker: its license allows monetized streaming');
  });

  it('blocks non-commercial and author-only models', () => {
    const l = licenseFromGltf(vrm1({ commercialUsage: 'personalNonProfit', avatarPermission: 'onlyAuthor' }));
    expect(l.verdict).toBe('blocked');
    expect(codes(l)).toEqual(['nonCommercial', 'authorOnly']);
  });

  it('asks for a check when others need a separate license or extra terms apply', () => {
    expect(licenseFromGltf(vrm1({ avatarPermission: 'onlySeparatelyLicensedPerson' })).verdict).toBe('check');
    const other = licenseFromGltf(vrm1({ otherLicenseUrl: 'https://example.com/terms' }));
    expect(other.verdict).toBe('check');
    expect(other.notes[0]).toMatchObject({ code: 'otherLicense', url: 'https://example.com/terms' });
  });

  it('keeps the conditions that do not stop streaming as notes', () => {
    const l = licenseFromGltf(vrm1({ commercialUsage: 'personalProfit', creditNotation: 'required', allowRedistribution: false, modification: 'prohibited' }));
    expect(l.verdict).toBe('ok');
    expect(codes(l)).toEqual(['individualsOnly', 'credit', 'noRedistribution', 'noModification']);
  });

  it('flags a file without the required fields', () => {
    expect(licenseFromGltf(vrm1({ licenseUrl: '', commercialUsage: undefined })).verdict).toBe('unknown');
  });
});

describe('VRM 0.x license fields', () => {
  it('reads the usage flags and license names', () => {
    expect(licenseFromGltf(vrm0({})).verdict).toBe('ok');
    expect(licenseFromGltf(vrm0({ commercialUssageName: 'Disallow' })).verdict).toBe('blocked');
    expect(licenseFromGltf(vrm0({ allowedUserName: 'OnlyAuthor' })).verdict).toBe('blocked');
    expect(licenseFromGltf(vrm0({ allowedUserName: 'ExplicitlyLicensedPerson' })).verdict).toBe('check');
    const prohibited = licenseFromGltf(vrm0({ licenseName: 'Redistribution_Prohibited' }));
    expect([prohibited.verdict, codes(prohibited)]).toEqual(['ok', ['noRedistribution']]);
  });

  it('applies Creative Commons terms, the stricter flag winning', () => {
    const nc = licenseFromGltf(vrm0({ licenseName: 'CC_BY_NC_SA' }));
    expect([nc.verdict, codes(nc)]).toEqual(['blocked', ['credit', 'nonCommercial', 'shareAlike']]);
    const nd = licenseFromGltf(vrm0({ licenseName: 'CC_BY_ND' }));
    expect([nd.verdict, codes(nd)]).toEqual(['ok', ['credit', 'noModification']]);
    const both = licenseFromGltf(vrm0({ commercialUssageName: 'Disallow', licenseName: 'CC_BY_NC' }));
    expect(codes(both).filter((c) => c === 'nonCommercial')).toHaveLength(1);
  });

  it('sends "Other" licenses and extra permission pages to a check', () => {
    const other = licenseFromGltf(vrm0({ licenseName: 'Other', otherLicenseUrl: 'https://example.com/l' }));
    expect(other.verdict).toBe('check');
    expect(other.notes[0]!.url).toBe('https://example.com/l');
    expect(licenseFromGltf(vrm0({ otherPermissionUrl: 'https://example.com/p' })).verdict).toBe('check');
  });

  it('treats empty fields as unknown and plain glTF as unknown', () => {
    expect(licenseFromGltf(vrm0({ licenseName: '', commercialUssageName: '' })).verdict).toBe('unknown');
    expect(licenseFromGltf({ asset: { version: '2.0' } } as never)).toMatchObject({ format: 'glb', verdict: 'unknown' });
  });
});

describe('Inochi2D puppet meta', () => {
  it('reads Creative Commons URLs and strips padding', () => {
    const by = licenseFromInochi({ artist: 'seagetch\0\0\0', rigger: 'seagetch', licenseURL: 'https://creativecommons.org/licenses/by/4.0/\0\0' });
    expect(by).toMatchObject({ format: 'inochi2d', authors: ['seagetch'], verdict: 'ok', license: 'https://creativecommons.org/licenses/by/4.0/' });
    expect(codes(by)).toEqual(['credit']);
    expect(licenseFromInochi({ licenseURL: 'https://creativecommons.org/licenses/by-nc/4.0/' }).verdict).toBe('blocked');
    expect(licenseFromInochi({ licenseURL: 'https://creativecommons.org/publicdomain/zero/1.0/' }).verdict).toBe('ok');
    expect(licenseFromInochi({ licenseURL: 'https://example.com/my-terms' }).verdict).toBe('check');
    expect(licenseFromInochi({}).verdict).toBe('unknown');
  });
});

describe('reading model files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ojakgyo-license-'));

  it('reads only the JSON part of a VRM and an Inochi2D puppet', () => {
    const vrmFile = join(dir, 'Avatar.vrm');
    writeFileSync(vrmFile, Buffer.concat([glb(vrm1({ commercialUsage: 'personalNonProfit' })), Buffer.alloc(4096)]));
    expect(readAvatarLicense(vrmFile)).toMatchObject({ format: 'vrm1', verdict: 'blocked' });

    const json = Buffer.from(JSON.stringify({ meta: { licenseURL: 'https://creativecommons.org/licenses/by/4.0/' }, nodes: {} }));
    const len = Buffer.alloc(4);
    len.writeUInt32BE(json.length);
    const inp = join(dir, 'Puppet.inp');
    writeFileSync(inp, Buffer.concat([Buffer.from('TRNSRTS\0', 'latin1'), len, json]));
    // No name in the puppet: the file name stands in.
    expect(readAvatarLicense(inp)).toMatchObject({ format: 'inochi2d', title: 'Puppet', verdict: 'ok' });
  });

  it('rejects files that are neither', () => {
    const bad = join(dir, 'notes.vrm');
    writeFileSync(bad, 'hello, this is not a model at all');
    expect(() => readAvatarLicense(bad)).toThrow(/not a binary glTF/);
  });
});

let app: App | null = null;
afterEach(async () => {
  await app?.stop();
  app = null;
});

describe('avatar license on the dashboard API', () => {
  it('reports what the configured model allows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ojakgyo-license-app-'));
    const model = join(dir, 'model.vrm');
    writeFileSync(model, glb(vrm0({ commercialUssageName: 'Disallow', title: 'Borrowed' })));
    const port = 20000 + Math.floor(Math.random() * 20000);
    const config = parseConfig(`server: { port: ${port} }\noutputs:\n  avatar: { enabled: true, model: ${JSON.stringify(model)} }\n`);
    app = new App({ config, path: null, dataDir: join(dir, '.ojakgyo') }, { store: new MemoryStore() });
    await app.start();
    const body = await (await fetch(`http://127.0.0.1:${port}/api/avatar`)).json();
    expect(body.license).toMatchObject({ format: 'vrm0', title: 'Borrowed', verdict: 'blocked' });
    expect(body.license.notes.map((n: { code: string }) => n.code)).toContain('nonCommercial');
    expect(JSON.stringify(body)).not.toContain(dir); // the file path never reaches the browser
  });
});
