import { beforeAll, describe, expect, it } from 'vitest';

// The dashboard's string table is plain browser JS; give it the bit of DOM it touches.
beforeAll(() => {
  (globalThis as { document?: unknown }).document = { documentElement: {} };
});

const load = () => import('../web/assets/i18n.js') as Promise<typeof import('../web/assets/i18n.js')>;

describe('dashboard i18n', () => {
  it('has the same keys in English and Korean', async () => {
    const { STRINGS } = await load();
    expect(Object.keys(STRINGS.ko).sort()).toEqual(Object.keys(STRINGS.en).sort());
    for (const [key, value] of Object.entries(STRINGS.ko)) expect(value, key).not.toBe('');
  });

  it('keeps placeholders consistent between languages', async () => {
    const { STRINGS } = await load();
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(STRINGS.en) as (keyof typeof STRINGS.en)[]) {
      expect(vars(STRINGS.ko[key]), key).toEqual(vars(STRINGS.en[key]));
    }
  });

  it('translates keys and known bridge messages', async () => {
    const { setLang, t, translateDetail } = await load();
    setLang('ko');
    expect(t('state.chzzk.login')).toBe('로그인 필요');
    expect(t('won', { n: '10,000' })).toBe('10,000원');
    expect(translateDetail('2 alert · 1 chat · 1 avatar')).toBe('알림 2 · 채팅 1 · 아바타 1');
    expect(translateDetail('Permission revoked: DONATION')).toBe('권한이 회수됨: DONATION');
    expect(translateDetail('Model: Hiyori')).toBe('모델: Hiyori');
    expect(translateDetail('No model loaded')).toBe('불러온 모델 없음');
    expect(translateDetail('connect ECONNREFUSED 127.0.0.1:8001')).toBe('connect ECONNREFUSED 127.0.0.1:8001');
    setLang('en');
    expect(t('won', { n: '10,000' })).toBe('₩10,000');
    setLang('fr');
    expect(t('bench.send')).toBe('Send test event');
  });
});
