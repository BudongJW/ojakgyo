import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parseConfig, RuleSchema, substituteEnv, type Rule } from '../src/config.js';
import { matchRule, RuleEngine } from '../src/core/rules.js';
import { sanitizeForSpeech } from '../src/core/speech.js';
import { render } from '../src/core/template.js';
import { chat, donation } from './helpers.js';

const rule = (input: Record<string, unknown>): Rule =>
  RuleSchema.parse({ name: 'r', actions: [{ type: 'delay', seconds: 0 }], ...input });

describe('template', () => {
  it('fills donation variables with Korean number formatting', () => {
    expect(render('{nickname}님 {amount}원 ({amountRaw})', donation(12345))).toBe('별빛님 12,345원 (12345)');
  });

  it('uses the anonymous name when there is no donor', () => {
    const anon = { ...donation(1000), user: null };
    expect(render('{nickname}', anon)).toBe('익명의 후원자');
    expect(render('{nickname}', anon, '누군가')).toBe('누군가');
  });

  it('leaves unknown placeholders visible', () => {
    expect(render('{nickanme}', donation(1))).toBe('{nickanme}');
  });
});

describe('sanitizeForSpeech', () => {
  const opts = { maxLength: 30, blockedWords: ['나쁜말'], collapseRepeats: 3, stripUrls: true };

  it('collapses ㅋㅋㅋ spam and repeated punctuation', () => {
    expect(sanitizeForSpeech('재밌다ㅋㅋㅋㅋㅋㅋㅋㅋ!!!!!!', opts)).toBe('재밌다ㅋㅋㅋ!!!');
  });

  it('removes links, emoji tokens and blocked words', () => {
    expect(sanitizeForSpeech('보세요 https://evil.example/x {:d_47:} 나쁜말 안녕', opts)).toBe('보세요 링크 안녕');
  });

  it('truncates long text by characters, not bytes', () => {
    const out = sanitizeForSpeech('가'.repeat(50), { ...opts, collapseRepeats: 0 });
    expect(Array.from(out)).toHaveLength(31);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('matchRule', () => {
  it('filters by event type', () => {
    expect(matchRule(rule({ on: 'donation' }), chat('hi'))).toBe(false);
    expect(matchRule(rule({ on: ['chat', 'donation'] }), chat('hi'))).toBe(true);
  });

  it('checks amount ranges and exact amounts', () => {
    const r = rule({ on: 'donation', when: { minAmount: 1000, maxAmount: 9999 } });
    expect(matchRule(r, donation(999))).toBe(false);
    expect(matchRule(r, donation(5000))).toBe(true);
    expect(matchRule(r, donation(10000))).toBe(false);
    expect(matchRule(rule({ on: 'donation', when: { amounts: [1004] } }), donation(1004))).toBe(true);
  });

  it('matches commands case-insensitively and by role', () => {
    const r = rule({ on: 'chat', when: { match: '^!HAT$', roles: ['streamer', 'manager'] } });
    expect(matchRule(r, chat('!hat', 'viewer'))).toBe(false);
    expect(matchRule(r, chat('!hat', 'manager'))).toBe(true);
    expect(matchRule(r, chat('!hats', 'manager'))).toBe(false);
  });

  it('does not match amount conditions on chat events', () => {
    expect(matchRule(rule({ on: 'chat', when: { minAmount: 0 } }), chat('x'))).toBe(false);
  });
});

describe('RuleEngine', () => {
  it('runs actions in order and honours cooldowns', async () => {
    let now = 0;
    const calls: string[] = [];
    const engine = new RuleEngine(
      [
        RuleSchema.parse({
          name: 'thanks',
          on: 'donation',
          cooldown: 10,
          actions: [
            { type: 'vts.hotkey', hotkey: 'A' },
            { type: 'vts.hotkey', hotkey: 'B' },
          ],
        }),
      ],
      () => now,
    );
    engine.handle('vts.hotkey', (a) => void calls.push(a.hotkey));
    await engine.dispatch(donation(1000));
    await engine.dispatch(donation(1000));
    now = 11_000;
    await engine.dispatch(donation(1000));
    expect(calls).toEqual(['A', 'B', 'A', 'B']);
  });

  it('keeps going when one action fails and honours stop', async () => {
    const done = vi.fn();
    const engine = new RuleEngine([
      RuleSchema.parse({ name: 'first', on: 'donation', stop: true, actions: [{ type: 'obs.scene', scene: 'x' }, { type: 'vts.hotkey', hotkey: 'ok' }] }),
      RuleSchema.parse({ name: 'second', on: 'donation', actions: [{ type: 'vts.hotkey', hotkey: 'never' }] }),
    ]);
    engine.handle('obs.scene', () => {
      throw new Error('OBS is down');
    });
    engine.handle('vts.hotkey', (a) => done(a.hotkey));
    const results = await engine.dispatch(donation(1));
    expect(results).toEqual([{ rule: 'first', actions: 2, failed: 1 }]);
    expect(done).toHaveBeenCalledExactlyOnceWith('ok');
  });
});

describe('config', () => {
  it('substitutes environment variables with fallbacks', () => {
    expect(substituteEnv('a=${A} b=${B:-dflt} c=${C}', { A: '1', C: '' })).toBe('a=1 b=dflt c=');
  });

  it('accepts the shipped example config', () => {
    const text = readFileSync(new URL('../ojakgyo.example.yaml', import.meta.url), 'utf8');
    const config = parseConfig(text, { CHZZK_CLIENT_ID: 'id', CHZZK_CLIENT_SECRET: 'secret' });
    expect(config.platforms.chzzk.clientId).toBe('id');
    expect(config.rules.length).toBeGreaterThan(3);
    expect(config.rules[0]!.on).toEqual(['donation']);
  });

  it('runs on defaults with an empty file', () => {
    const config = parseConfig('');
    expect(config.server.port).toBe(7979);
    expect(config.outputs.tts.provider).toBe('browser');
    expect(config.outputs.avatar).toMatchObject({ enabled: false, model: '', view: 'bust', lipSync: true });
    expect(config.outputs.avatar.faceModelUrl).toMatch(/^https:\/\/storage\.googleapis\.com\/mediapipe-models\//);
  });

  it('explains invalid rules', () => {
    expect(() => parseConfig('rules:\n  - name: x\n    on: donation\n    when: { match: "(" }\n    actions: [{ type: delay, seconds: 1 }]')).toThrow(
      /invalid regular expression/,
    );
    expect(() => parseConfig('rules:\n  - name: x\n    on: donation\n    actions: [{ type: vts.teleport }]')).toThrow(/Invalid configuration/);
  });
});
