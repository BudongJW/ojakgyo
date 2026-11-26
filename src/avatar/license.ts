// What an avatar file says about how it may be used: the VRM meta (0.x and 1.0) or the
// Inochi2D puppet meta, judged for one question: may an individual use it on a monetized
// stream? Only the file's own fields are read. A model converted from someone else's
// character keeps the original owner's terms whatever the file says.
import { closeSync, openSync, readSync } from 'node:fs';
import { basename, extname } from 'node:path';

export type LicenseVerdict = 'ok' | 'check' | 'blocked' | 'unknown';

export interface LicenseNote {
  /** Stable id the dashboard translates. */
  code:
    | 'missing'
    | 'noVrmMeta'
    | 'nonCommercial'
    | 'authorOnly'
    | 'separateLicense'
    | 'otherLicense'
    | 'individualsOnly'
    | 'credit'
    | 'noRedistribution'
    | 'noModification'
    | 'shareAlike';
  level: 'blocked' | 'check' | 'info';
  text: string;
  url?: string;
}

export interface AvatarLicense {
  format: 'vrm1' | 'vrm0' | 'inochi2d' | 'glb';
  title: string | null;
  authors: string[];
  /** License name (VRM 0.x) or URL as written in the file. */
  license: string | null;
  verdict: LicenseVerdict;
  notes: LicenseNote[];
}

const clean = (v: unknown): string => (typeof v === 'string' ? v.replace(/\0/g, '').trim() : '');

const NOTE_TEXT: Record<LicenseNote['code'], string> = {
  missing: 'The file does not say how it may be used. Ask its author before streaming with it.',
  noVrmMeta: 'This glTF file has no VRM license fields. Ask its author before streaming with it.',
  nonCommercial: 'Non-commercial use only. Donations, subscriptions and ads make a stream commercial.',
  authorOnly: 'Only the author may appear as this avatar.',
  separateLicense: 'Only people the author has licensed separately may appear as this avatar.',
  otherLicense: 'The file points to extra terms. Read them before streaming.',
  individualsOnly: 'Commercial use is allowed for individuals, not for companies or agencies.',
  credit: 'Credit the author, for example in the stream description.',
  noRedistribution: 'Do not share or re-upload the file.',
  noModification: 'Do not modify the file. That includes shrinking it with `ojakgyo avatar optimize`.',
  shareAlike: 'Modified versions must be shared under the same license.',
};

const note = (code: LicenseNote['code'], level: LicenseNote['level'], url?: string): LicenseNote => ({ code, level, text: NOTE_TEXT[code], ...(url ? { url } : {}) });

function verdictOf(notes: LicenseNote[]): LicenseVerdict {
  if (notes.some((n) => n.level === 'blocked')) return 'blocked';
  if (notes.some((n) => n.code === 'missing' || n.code === 'noVrmMeta')) return 'unknown';
  if (notes.some((n) => n.level === 'check')) return 'check';
  return 'ok';
}

/** Creative Commons terms from a license name (VRM 0.x `CC_BY_NC_SA`) or URL (`/licenses/by-nc-sa/4.0/`). */
function creativeCommons(value: string, notes: LicenseNote[]): boolean {
  const name = value.toLowerCase();
  if (/cc0|publicdomain|public domain/.test(name)) return true;
  const m = /(?:^cc_)(by(?:_[a-z]+)*)$/.exec(name) ?? /creativecommons\.org\/licenses\/(by(?:-[a-z]+)*)\//.exec(name);
  if (!m) return false;
  const parts = m[1]!.split(/[-_]/);
  notes.push(note('credit', 'info'));
  if (parts.includes('nc')) notes.push(note('nonCommercial', 'blocked'));
  if (parts.includes('nd')) notes.push(note('noModification', 'info'));
  if (parts.includes('sa')) notes.push(note('shareAlike', 'info'));
  return true;
}

/** Judge a glTF JSON with VRM 1.0 (`VRMC_vrm`) or 0.x (`VRM`) meta. */
export function licenseFromGltf(json: { extensions?: Record<string, { meta?: Record<string, unknown> }> }): AvatarLicense {
  const notes: LicenseNote[] = [];
  const m1 = json.extensions?.VRMC_vrm?.meta;
  if (m1) {
    const authors = Array.isArray(m1.authors) ? m1.authors.map(clean).filter(Boolean) : [];
    if (!clean(m1.licenseUrl) || !clean(m1.commercialUsage)) notes.push(note('missing', 'check'));
    if (m1.commercialUsage === 'personalNonProfit') notes.push(note('nonCommercial', 'blocked'));
    if (m1.commercialUsage === 'personalProfit') notes.push(note('individualsOnly', 'info'));
    if (m1.avatarPermission === 'onlyAuthor') notes.push(note('authorOnly', 'blocked'));
    if (m1.avatarPermission === 'onlySeparatelyLicensedPerson') notes.push(note('separateLicense', 'check'));
    if (clean(m1.otherLicenseUrl)) notes.push(note('otherLicense', 'check', clean(m1.otherLicenseUrl)));
    if (m1.creditNotation === 'required') notes.push(note('credit', 'info'));
    if (m1.allowRedistribution === false) notes.push(note('noRedistribution', 'info'));
    if (m1.modification === 'prohibited') notes.push(note('noModification', 'info'));
    return { format: 'vrm1', title: clean(m1.name) || null, authors, license: clean(m1.licenseUrl) || null, verdict: verdictOf(notes), notes };
  }
  const m0 = json.extensions?.VRM?.meta;
  if (m0) {
    const licenseName = clean(m0.licenseName);
    const commercial = clean(m0.commercialUssageName);
    if (!licenseName && !commercial) notes.push(note('missing', 'check'));
    if (commercial === 'Disallow') notes.push(note('nonCommercial', 'blocked'));
    if (m0.allowedUserName === 'OnlyAuthor') notes.push(note('authorOnly', 'blocked'));
    if (m0.allowedUserName === 'ExplicitlyLicensedPerson') notes.push(note('separateLicense', 'check'));
    if (licenseName === 'Redistribution_Prohibited') notes.push(note('noRedistribution', 'info'));
    else if (licenseName === 'Other') notes.push(note('otherLicense', 'check', clean(m0.otherLicenseUrl) || undefined));
    else if (licenseName) creativeCommons(licenseName, notes);
    if (clean(m0.otherPermissionUrl)) notes.push(note('otherLicense', 'check', clean(m0.otherPermissionUrl)));
    // A CC non-commercial license and an "Allow" commercial flag contradict; the stricter one wins.
    const deduped = notes.filter((n, i) => notes.findIndex((o) => o.code === n.code && o.url === n.url) === i);
    return { format: 'vrm0', title: clean(m0.title) || null, authors: clean(m0.author) ? [clean(m0.author)] : [], license: licenseName || null, verdict: verdictOf(deduped), notes: deduped };
  }
  notes.push(note('noVrmMeta', 'check'));
  return { format: 'glb', title: null, authors: [], license: null, verdict: 'unknown', notes };
}

/** Judge an Inochi2D puppet's meta (`licenseURL`, `artist`, `rigger` …). */
export function licenseFromInochi(meta: Record<string, unknown> | undefined): AvatarLicense {
  const notes: LicenseNote[] = [];
  const url = clean(meta?.licenseURL);
  const authors = [...new Set([clean(meta?.artist), clean(meta?.rigger)].filter(Boolean))];
  if (!url) notes.push(note('missing', 'check'));
  else if (!creativeCommons(url, notes)) notes.push(note('otherLicense', 'check', url));
  return { format: 'inochi2d', title: clean(meta?.name) || null, authors, license: url || null, verdict: verdictOf(notes), notes };
}

/** Read just the header and JSON part of a .vrm/.glb or .inp/.inx file; textures are skipped. */
export function readAvatarLicense(path: string): AvatarLicense {
  const license = readLicenseFields(path);
  // Untitled models (the Inochi2D samples, many VRoid exports) go by their file name.
  return license.title ? license : { ...license, title: basename(path, extname(path)) };
}

function readLicenseFields(path: string): AvatarLicense {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(20);
    readSync(fd, head, 0, 20, 0);
    const read = (at: number, len: number) => {
      const buf = Buffer.alloc(len);
      const got = readSync(fd, buf, 0, len, at);
      if (got !== len) throw new Error('the file is truncated');
      return buf;
    };
    if (/\.(inp|inx)$/i.test(extname(path)) || head.subarray(0, 8).toString('latin1') === 'TRNSRTS\0') {
      if (head.subarray(0, 8).toString('latin1') !== 'TRNSRTS\0') throw new Error('not an Inochi2D puppet');
      const json = JSON.parse(read(12, head.readUInt32BE(8)).toString('utf8')) as { meta?: Record<string, unknown> };
      return licenseFromInochi(json.meta);
    }
    if (head.readUInt32LE(0) !== 0x46546c67) throw new Error('not a binary glTF (.vrm/.glb) file');
    if (head.readUInt32LE(16) !== 0x4e4f534a) throw new Error('GLB has no JSON chunk');
    return licenseFromGltf(JSON.parse(read(20, head.readUInt32LE(12)).toString('utf8')));
  } finally {
    closeSync(fd);
  }
}

/** One line for logs and the CLI. */
export function describeLicense(l: AvatarLicense): string {
  const who = [l.title ? `"${l.title}"` : 'this avatar', l.authors.length ? `by ${l.authors.join(', ')}` : ''].filter(Boolean).join(' ');
  const verdict = {
    ok: 'its license allows monetized streaming',
    check: 'check its terms before monetized streaming',
    blocked: 'its license does not allow monetized streaming',
    unknown: 'its file does not say how it may be used',
  }[l.verdict];
  return `${who}: ${verdict}`;
}
