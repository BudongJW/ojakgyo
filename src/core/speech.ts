/**
 * Clean up chat/donation text before it is read aloud. Korean stream chat is
 * full of things that sound terrible through TTS: `ㅋㅋㅋㅋㅋㅋㅋ`, links,
 * emoji tokens, and the occasional word you never want on stream.
 */
export interface SpeechOptions {
  maxLength: number;
  blockedWords: string[];
  /** Max run length for a repeated character. */
  collapseRepeats: number;
  stripUrls: boolean;
}

const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
/** CHZZK-style emoji tokens: `{:emojiId:}`. */
const EMOJI_TOKEN_RE = /\{:[^:{}]+:\}/g;

export function sanitizeForSpeech(input: string, opts: SpeechOptions): string {
  let text = input.normalize('NFC');
  text = text.replace(EMOJI_TOKEN_RE, ' ');
  if (opts.stripUrls) text = text.replace(URL_RE, ' 링크 ');

  for (const word of opts.blockedWords) {
    if (!word) continue;
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(escaped, 'gi'), '');
  }

  if (opts.collapseRepeats > 0) {
    const n = opts.collapseRepeats;
    // Same character repeated more than n times -> n times. `u` flag keeps Hangul jamo and emoji intact.
    text = text.replace(new RegExp(`(.)\\1{${n},}`, 'gu'), (run: string) => Array.from(run).slice(0, n).join(''));
  }

  text = text.replace(/\s+/g, ' ').trim();

  const chars = Array.from(text);
  if (chars.length > opts.maxLength) text = chars.slice(0, opts.maxLength).join('').trimEnd() + '…';
  return text;
}
