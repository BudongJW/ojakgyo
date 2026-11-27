// Bake Kkachi (examples/avatars/kkachi/kkachi.vrm) into 2D layers and projected keyforms.
// Serves bake.html with three.js from the repo's node_modules, opens it in headless Chrome
// (software WebGL, so the output is the same on every machine), and saves the results.
// Usage: node examples/avatars/kkachi-2d/tools/bake.mjs <out dir>
// Set CHROME to the Chrome or Chromium executable if it is not in the usual place.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(TOOLS, '../../../..');
const NM = join(REPO, 'node_modules');
const VRM = join(REPO, 'examples/avatars/kkachi/kkachi.vrm');
const OUT = resolve(process.argv[2] ?? 'kkachi2d-bake');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.vrm': 'model/gltf-binary' };

const CHROME = process.env.CHROME ?? [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((p) => existsSync(p));
if (!CHROME) throw new Error('Chrome not found; set CHROME to its executable');
if (!existsSync(join(NM, 'three')) || !existsSync(join(NM, '@pixiv/three-vrm'))) throw new Error('run npm install in the repo first');
mkdirSync(OUT, { recursive: true });

const within = (root, rel) => {
  const p = normalize(join(root, rel));
  return p === root || p.startsWith(root + sep) ? p : null;
};
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (req.method === 'POST' && path.startsWith('/save/')) {
    const name = basename(path.slice(6));
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = Buffer.concat(chunks);
    if (name.endsWith('.png')) body = Buffer.from(body.toString().replace(/^data:image\/png;base64,/, ''), 'base64');
    writeFileSync(join(OUT, name), body);
    return res.writeHead(200).end('ok');
  }
  const file = path === '/kkachi.vrm' ? VRM : path.startsWith('/nm/') ? within(NM, path.slice(4)) : within(TOOLS, path === '/' ? 'bake.html' : path.slice(1));
  if (!file) return res.writeHead(403).end();
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream' }).end(data);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const debugPort = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(CHROME, [
  '--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars',
  `--remote-debugging-port=${debugPort}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'kkachi2d-'))}`, '--no-first-run', '--window-size=800,800', 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 80 && !target; i++) {
  try { target = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find((t) => t.type === 'page'); } catch {}
  if (!target) await sleep(250);
}
if (!target) throw new Error('Chrome did not start');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled') console.log(m.params.args.map((a) => a.value ?? a.description).join(' '));
};
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Runtime.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${port}/bake.html` });
let title = '';
for (const start = Date.now(); Date.now() - start < 600_000;) {
  await sleep(1000);
  title = (await send('Runtime.evaluate', { expression: 'document.title' })).result?.result?.value ?? '';
  if (title === 'done' || title === 'error') break;
}
ws.close();
chrome.kill();
server.close();
if (title !== 'done') throw new Error(`bake failed (${title || 'timed out'})`);
console.log(`baked into ${OUT}`);
