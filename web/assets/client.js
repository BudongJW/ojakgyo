// Shared browser helpers for the dashboard and overlays.

/** Open a self-healing WebSocket to the bridge. */
export function connect(role, onMessage) {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?client=${encodeURIComponent(role)}`;
  let ws = null;
  let retry = 0;
  const open = () => {
    ws = new WebSocket(url);
    ws.onopen = () => (retry = 0);
    ws.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data));
      } catch (err) {
        console.error(err);
      }
    };
    ws.onclose = () => setTimeout(open, Math.min(5000, 400 * 2 ** retry++));
  };
  open();
  return {
    send(message) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    },
  };
}

/** Create an element with text only. Never use innerHTML for viewer content. */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/**
 * Render a message with CHZZK emoji tokens `{:id:}` swapped for images.
 * Only https image URLs from the event's own emoji map are used.
 */
export function richText(container, message, emojis = {}) {
  const parts = String(message ?? '').split(/(\{:[^:{}]+:\})/g);
  for (const part of parts) {
    const m = /^\{:([^:{}]+):\}$/.exec(part);
    const src = m && emojis[m[1]];
    if (src && /^https:\/\//.test(src)) {
      const img = document.createElement('img');
      img.src = src;
      img.alt = m[1];
      img.className = 'emoji';
      img.referrerPolicy = 'no-referrer';
      container.append(img);
    } else if (part) {
      container.append(document.createTextNode(part));
    }
  }
  return container;
}

export const won = (n) => new Intl.NumberFormat('ko-KR').format(n);

/** Stable, readable colour per nickname. */
export function nickColor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return `hsl(${h} 55% 72%)`;
}
