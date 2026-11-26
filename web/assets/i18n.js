// Dashboard strings in English and Korean.
// Technical error text from the bridge and the log stay in English.

export const LANGS = ['en', 'ko'];

export const STRINGS = {
  en: {
    'lang.label': 'Language',
    'bench.title': 'Test event',
    'bench.hint': 'Runs a fake event through your rules. Nothing is posted to your channel.',
    'bench.type': 'Event type',
    'type.donation': 'Donation',
    'type.chat': 'Chat',
    'type.subscription': 'Subscription',
    'field.nickname': 'Nickname',
    'field.amount': 'Amount (KRW)',
    'field.months': 'Months',
    'field.message': 'Message',
    'bench.send': 'Send test event',
    'sources.title': 'OBS browser sources',
    'sources.alerts': 'Alerts',
    'sources.chat': 'Chat',
    'copy': 'Copy',
    'copied': 'Copied',
    'events.title': 'Events',
    'events.empty': 'No events yet. Send a test event, or go live.',
    'events.test': 'Test event',
    'log.title': 'Log',
    'log.waiting': 'Waiting for log output…',
    'kind.chat': 'Chat',
    'kind.donation': 'Donation',
    'kind.subscription': 'Sub',
    'role.streamer': 'streamer',
    'role.manager': 'manager',
    'role.chat_manager': 'chat manager',
    'anonymous': 'Anonymous',
    'months': '{n} mo',
    'won': '₩{n}',
    'status.connections': 'Connections',
    'label.chzzk': 'CHZZK',
    'label.vts': 'VTube Studio',
    'label.obs': 'OBS',
    'label.overlay': 'Overlays',
    'state.connected': 'Connected',
    'state.connecting': 'Connecting',
    'state.disconnected': 'Offline',
    'state.error': 'Error',
    'state.disabled': 'Disabled',
    'state.action-needed': 'Action needed',
    'state.chzzk.login': 'Login required',
    'state.overlay.none': 'None open',
    'state.overlay.open': 'Open',
    'detail.disabled': 'Off in ojakgyo.yaml',
    'detail.vts.retry': 'Retrying. Is the API enabled in VTube Studio?',
    'detail.overlay.none': 'Add a browser source in OBS',
    'detail.overlay.count': '{alerts} alert · {chat} chat',
    'detail.chzzk.login': 'Log in to connect your channel',
    'detail.chzzk.missingKeys': 'Missing clientId / clientSecret',
    'detail.chzzk.loggedOut': 'Logged out',
    'detail.chzzk.expired': 'Login expired',
    'detail.chzzk.noScopes': 'Could not subscribe to any event. Check your app scopes.',
    'detail.chzzk.revoked': 'Permission revoked: {what}',
    'detail.vts.allow': 'Click "Allow" in VTube Studio',
    'action.login': 'Log in',
    'action.open': 'Open',
  },
  ko: {
    'lang.label': '언어',
    'bench.title': '테스트 이벤트',
    'bench.hint': '가짜 이벤트로 규칙이 잘 동작하는지 확인합니다. 실제 채널에는 아무것도 전송되지 않습니다.',
    'bench.type': '이벤트 종류',
    'type.donation': '후원',
    'type.chat': '채팅',
    'type.subscription': '구독',
    'field.nickname': '닉네임',
    'field.amount': '금액(원)',
    'field.months': '구독 개월',
    'field.message': '메시지',
    'bench.send': '테스트 이벤트 보내기',
    'sources.title': 'OBS 브라우저 소스',
    'sources.alerts': '알림',
    'sources.chat': '채팅',
    'copy': '복사',
    'copied': '복사됨',
    'events.title': '이벤트',
    'events.empty': '아직 이벤트가 없습니다. 테스트 이벤트를 보내거나 방송을 시작해 보세요.',
    'events.test': '테스트 이벤트',
    'log.title': '로그',
    'log.waiting': '로그를 기다리는 중…',
    'kind.chat': '채팅',
    'kind.donation': '후원',
    'kind.subscription': '구독',
    'role.streamer': '스트리머',
    'role.manager': '매니저',
    'role.chat_manager': '채팅 매니저',
    'anonymous': '익명의 후원자',
    'months': '{n}개월',
    'won': '{n}원',
    'status.connections': '연결 상태',
    'label.chzzk': '치지직',
    'label.vts': 'VTube Studio',
    'label.obs': 'OBS',
    'label.overlay': '오버레이',
    'state.connected': '연결됨',
    'state.connecting': '연결 중',
    'state.disconnected': '오프라인',
    'state.error': '오류',
    'state.disabled': '사용 안 함',
    'state.action-needed': '확인 필요',
    'state.chzzk.login': '로그인 필요',
    'state.overlay.none': '열린 오버레이 없음',
    'state.overlay.open': '열림',
    'detail.disabled': 'ojakgyo.yaml에서 꺼져 있음',
    'detail.vts.retry': '재시도 중. VTube Studio API가 켜져 있나요?',
    'detail.overlay.none': 'OBS에 브라우저 소스를 추가하세요',
    'detail.overlay.count': '알림 {alerts} · 채팅 {chat}',
    'detail.chzzk.login': '로그인해서 채널을 연결하세요',
    'detail.chzzk.missingKeys': 'clientId / clientSecret이 설정되지 않았습니다',
    'detail.chzzk.loggedOut': '로그아웃됨',
    'detail.chzzk.expired': '로그인이 만료되었습니다. 다시 로그인하세요.',
    'detail.chzzk.noScopes': '구독된 이벤트가 없습니다. 앱 권한(Scope)을 확인하세요.',
    'detail.chzzk.revoked': '권한이 회수됨: {what}',
    'detail.vts.allow': 'VTube Studio 팝업에서 "Allow"를 눌러 주세요',
    'action.login': '로그인',
    'action.open': '열기',
  },
};

/** Server status details we know how to translate. Anything else is shown as sent. */
const KNOWN_DETAILS = [
  [/^Log in to connect your channel$/, 'detail.chzzk.login'],
  [/^Missing clientId \/ clientSecret$/, 'detail.chzzk.missingKeys'],
  [/^Logged out$/, 'detail.chzzk.loggedOut'],
  [/^Login expired$/, 'detail.chzzk.expired'],
  [/^Could not subscribe to any event/, 'detail.chzzk.noScopes'],
  [/^Permission revoked: (?<what>.*)$/, 'detail.chzzk.revoked'],
  [/^Click "Allow" in VTube Studio$/, 'detail.vts.allow'],
  [/^(?<alerts>\d+) alert · (?<chat>\d+) chat$/, 'detail.overlay.count'],
  [/^No overlay open/, 'detail.overlay.none'],
];

const STORAGE_KEY = 'ojakgyo.lang';

export function detectLang() {
  const fromUrl = new URLSearchParams(location.search).get('lang');
  if (LANGS.includes(fromUrl)) return fromUrl;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (LANGS.includes(saved)) return saved;
  } catch {
    /* storage blocked */
  }
  return (navigator.languages?.[0] ?? navigator.language ?? 'en').toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

export function saveLang(lang) {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* storage blocked */
  }
}

let current = 'en';

export function setLang(lang) {
  current = LANGS.includes(lang) ? lang : 'en';
  document.documentElement.lang = current;
}

export function getLang() {
  return current;
}

/** Translate a key, filling `{name}` placeholders. Falls back to English, then to the key. */
export function t(key, vars = {}) {
  const template = STRINGS[current][key] ?? STRINGS.en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole));
}

/** Translate a status detail sent by the bridge, if it is one we recognise. */
export function translateDetail(detail) {
  if (!detail) return '';
  for (const [pattern, key] of KNOWN_DETAILS) {
    const m = pattern.exec(detail);
    if (m) return t(key, m.groups ?? {});
  }
  return detail;
}

/** Apply translations to every element marked with data-i18n / data-i18n-aria. */
export function translatePage(root = document) {
  for (const node of root.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const node of root.querySelectorAll('[data-i18n-aria]')) node.setAttribute('aria-label', t(node.dataset.i18nAria));
}
