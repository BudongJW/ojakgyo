import { connect, el, richText } from './client.js';

// ?preview=1 shows a checkerboard so you can see the overlay in a normal browser.
const params = new URLSearchParams(location.search);
if (params.has('preview')) document.body.classList.add('preview');

const stage = document.getElementById('stage');
const queue = [];
let busy = false;
const bridge = connect('alerts', (msg) => {
  if (msg.kind !== 'alert') return;
  queue.push(msg);
  if (!busy) void next();
});

const ICON = { donation: '💝', subscription: '⭐', chat: '💬' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── audio + lip-sync ── */
let audioCtx = null;
function ctx() {
  audioCtx ??= new AudioContext();
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
    showSoundGate();
  }
  return audioCtx;
}

function showSoundGate() {
  if (document.querySelector('.sound-gate')) return;
  const gate = el('div', 'sound-gate', '🔈 Click to enable sound (not needed in OBS)');
  gate.onclick = () => {
    audioCtx?.resume();
    gate.remove();
  };
  document.body.append(gate);
}

/** Play an audio URL and stream its loudness to the bridge for lip-sync. */
function playAudio(url, volume) {
  return new Promise((resolve) => {
    const audio = new Audio(url);
    audio.crossOrigin = 'anonymous';
    audio.volume = volume ?? 1;
    let raf = 0;
    try {
      const c = ctx();
      const src = c.createMediaElementSource(audio);
      const analyser = c.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      analyser.connect(c.destination);
      const buf = new Float32Array(analyser.fftSize);
      let last = 0;
      const tick = (t) => {
        raf = requestAnimationFrame(tick);
        if (t - last < 33) return;
        last = t;
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        const rms = Math.sqrt(sum / buf.length);
        bridge.send({ kind: 'mouth', level: Math.min(1, rms * 4) });
      };
      raf = requestAnimationFrame(tick);
    } catch {
      /* analyser unavailable: still play */
    }
    const done = () => {
      cancelAnimationFrame(raf);
      bridge.send({ kind: 'mouth', level: 0 });
      resolve();
    };
    audio.onended = done;
    audio.onerror = done;
    audio.play().catch(() => {
      showSoundGate();
      done();
    });
  });
}

function speakBrowser(text, lang, volume) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang || 'ko-KR';
    u.volume = volume ?? 1;
    const voice = speechSynthesis.getVoices().find((v) => v.lang === u.lang);
    if (voice) u.voice = voice;
    const timer = setTimeout(resolve, 2000 + text.length * 250); // some engines never fire onend
    u.onend = u.onerror = () => {
      clearTimeout(timer);
      resolve();
    };
    speechSynthesis.speak(u);
  });
}

function speak(item) {
  const s = item.speech;
  if (!s) return Promise.resolve();
  return s.mode === 'audio' ? playAudio(s.audioUrl, item.volume) : speakBrowser(s.text, s.lang, item.volume);
}

/* ── visuals ── */
function sparkle(card) {
  for (let i = 0; i < 18; i++) {
    const s = el('i', 'spark');
    const a = (Math.PI * 2 * i) / 18;
    s.style.left = '50%';
    s.style.top = '50%';
    s.style.setProperty('--dx', `${Math.cos(a) * (180 + Math.random() * 140)}px`);
    s.style.setProperty('--dy', `${Math.sin(a) * (70 + Math.random() * 80)}px`);
    card.append(s);
    setTimeout(() => s.remove(), 1300);
  }
}

function buildCard(item) {
  const card = el('div', 'alert');
  if (item.accent) card.style.setProperty('--accent', item.accent);
  card.append(el('div', 'badge', ICON[item.eventType] ?? '✦'));
  if (item.image) {
    const img = el('img', 'art');
    img.src = item.image;
    card.append(img);
  }
  if (item.title) card.append(el('div', 'title', item.title));
  if (item.message) card.append(richText(el('div', 'message'), item.message, item.emojis));
  const bar = el('div', 'bar');
  const fill = el('i');
  bar.append(fill);
  card.append(bar);
  return { card, fill };
}

async function next() {
  busy = true;
  while (queue.length) {
    const item = queue.shift();
    const visual = Boolean(item.title || item.message);
    if (!visual) {
      await speak(item);
      continue;
    }
    const { card, fill } = buildCard(item);
    stage.replaceChildren(card);
    sparkle(card);
    if (item.sound) playAudio(item.sound, item.volume);

    const minMs = Math.max(2000, (item.duration ?? 6) * 1000);
    const started = performance.now();
    fill.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: minMs, fill: 'forwards' });

    await sleep(500); // let the pop-in land before the voice starts
    await speak(item);
    const left = minMs - (performance.now() - started);
    if (left > 0) await sleep(left);
    else await sleep(600);

    card.classList.add('out');
    await sleep(560);
    card.remove();
    await sleep(250);
  }
  busy = false;
}

// ?demo=1 cycles a sample alert, handy for positioning the source in OBS.
if (params.has('demo')) {
  const demo = () => {
    queue.push({ kind: 'alert', title: '별빛시청자 님 10,000원 후원!', message: '오늘 방송도 너무 재밌어요ㅋㅋㅋ 화이팅!', duration: 6, eventType: 'donation' });
    if (!busy) void next();
  };
  demo();
  setInterval(demo, 9000);
}
