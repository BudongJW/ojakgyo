import { connect, el, richText } from './client.js';

// ?preview=1   checkerboard behind the overlay, for a normal browser
// ?demo=1      loop a sample alert while you position the source
// ?position=   top (default) | center | bottom
const params = new URLSearchParams(location.search);
if (params.has('preview')) document.body.classList.add('preview');

const stage = document.getElementById('stage');
const position = params.get('position');
if (position === 'center' || position === 'bottom') stage.className = `stage ${position}`;

const queue = [];
let busy = false;
const bridge = connect('alerts', (msg) => {
  if (msg.kind !== 'alert') return;
  queue.push(msg);
  if (!busy) void next();
});

const KICKER = { donation: '후원', subscription: '구독', chat: '채팅' };
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
  const gate = el('button', 'sound-gate', 'Click to enable sound (not needed in OBS)');
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
        bridge.send({ kind: 'mouth', level: Math.min(1, Math.sqrt(sum / buf.length) * 4) });
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

/* ── card ── */
function buildCard(item) {
  const card = el('div', `alert ${item.eventType ?? ''}`);
  if (item.accent) card.style.setProperty('--accent', item.accent);
  card.append(el('div', 'bar-side'));
  const body = el('div', 'body');
  body.append(el('div', 'kicker', KICKER[item.eventType] ?? ''));
  if (item.image) {
    const img = el('img', 'art');
    img.src = item.image;
    img.alt = '';
    body.append(img);
  }
  if (item.title) body.append(el('div', 'title', item.title));
  if (item.message) body.append(richText(el('div', 'message'), item.message, item.emojis));
  card.append(body);
  const timer = el('div', 'timer');
  const fill = el('i');
  timer.append(fill);
  card.append(timer);
  return { card, fill };
}

async function next() {
  busy = true;
  while (queue.length) {
    const item = queue.shift();
    if (!item.title && !item.message) {
      await speak(item); // voice-only alert
      continue;
    }
    const { card, fill } = buildCard(item);
    stage.replaceChildren(card);
    if (item.sound) playAudio(item.sound, item.volume);

    const minMs = Math.max(2000, (item.duration ?? 6) * 1000);
    const started = performance.now();
    fill.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: minMs, easing: 'linear', fill: 'forwards' });

    await sleep(300);
    await speak(item);
    const left = minMs - (performance.now() - started);
    await sleep(left > 0 ? left : 500);

    card.classList.add('out');
    await sleep(230);
    card.remove();
    await sleep(200);
  }
  busy = false;
}

if (params.has('demo')) {
  const demo = () => {
    queue.push({ kind: 'alert', title: '별빛시청자 님 10,000원 후원', message: '오늘 방송도 너무 재밌어요ㅋㅋㅋ 화이팅!', duration: 6, eventType: 'donation' });
    if (!busy) void next();
  };
  demo();
  setInterval(demo, 9000);
}
