import { randomUUID } from 'node:crypto';
import type { TtsConfig } from '../config.js';
import { sanitizeForSpeech } from '../core/speech.js';

/**
 * Korean TTS. Audio is synthesised on the server and played by the alert
 * overlay (so OBS captures it and the overlay can drive lip-sync).
 *
 * Providers:
 *  - browser:    overlay uses the Web Speech API, nothing to install
 *  - openai:     any OpenAI-compatible POST /v1/audio/speech server
 *  - gpt-sovits: GPT-SoVITS api_v2.py (GET /tts)
 */

export type SpeechPlan =
  | { mode: 'browser'; text: string; lang: string }
  | { mode: 'audio'; text: string; audioUrl: string }
  | null;

interface Clip {
  data: Buffer;
  mime: string;
  expires: number;
}

export class TtsService {
  private readonly clips = new Map<string, Clip>();

  constructor(
    private readonly config: TtsConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get enabled(): boolean {
    return this.config.provider !== 'none';
  }

  /** Clean the text and synthesise it; returns what the overlay should play. */
  async prepare(rawText: string, voice?: string): Promise<SpeechPlan> {
    if (!this.enabled) return null;
    const text = sanitizeForSpeech(rawText, this.config);
    if (!text) return null;

    if (this.config.provider === 'browser') return { mode: 'browser', text, lang: toBcp47(this.config.language) };

    const { data, mime } =
      this.config.provider === 'openai' ? await this.openai(text, voice) : await this.gptSovits(text);
    const id = randomUUID();
    this.gc();
    this.clips.set(id, { data, mime, expires: Date.now() + 10 * 60_000 });
    return { mode: 'audio', text, audioUrl: `/tts/${id}` };
  }

  /** Serve a synthesised clip (used by the HTTP server). */
  clip(id: string): Clip | undefined {
    return this.clips.get(id);
  }

  private gc(): void {
    const now = Date.now();
    for (const [id, clip] of this.clips) if (clip.expires < now) this.clips.delete(id);
  }

  private async openai(text: string, voice?: string): Promise<{ data: Buffer; mime: string }> {
    if (!this.config.baseUrl) throw new Error('tts.baseUrl is required for the openai provider');
    const url = new URL('audio/speech', withSlash(this.config.baseUrl));
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.config.model,
        input: text,
        voice: voice || this.config.voice || 'alloy',
        response_format: 'mp3',
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`TTS server answered ${res.status} ${await res.text().catch(() => '')}`.trim());
    return { data: Buffer.from(await res.arrayBuffer()), mime: res.headers.get('content-type') || 'audio/mpeg' };
  }

  private async gptSovits(text: string): Promise<{ data: Buffer; mime: string }> {
    if (!this.config.baseUrl) throw new Error('tts.baseUrl is required for the gpt-sovits provider');
    const url = new URL('tts', withSlash(this.config.baseUrl));
    const params: Record<string, string> = {
      text,
      text_lang: this.config.language,
      ref_audio_path: this.config.refAudioPath,
      prompt_text: this.config.promptText,
      prompt_lang: this.config.promptLang,
      media_type: 'wav',
      streaming_mode: 'false',
    };
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`GPT-SoVITS answered ${res.status} ${await res.text().catch(() => '')}`.trim());
    return { data: Buffer.from(await res.arrayBuffer()), mime: res.headers.get('content-type') || 'audio/wav' };
  }
}

const withSlash = (u: string) => (u.endsWith('/') ? u : `${u}/`);

function toBcp47(lang: string): string {
  const map: Record<string, string> = { ko: 'ko-KR', ja: 'ja-JP', en: 'en-US', zh: 'zh-CN' };
  return map[lang] ?? lang;
}
