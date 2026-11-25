import { newEventId, type OjakgyoEvent, type Role } from '../../core/events.js';

/** Payload shapes from https://chzzk.gitbook.io/chzzk/chzzk-api/session */

export interface ChzzkChatPayload {
  channelId: string;
  senderChannelId?: string;
  chatChannelId?: string;
  profile?: { nickname?: string; badges?: unknown[]; verifiedMark?: boolean };
  userRoleCode?: string;
  content?: string;
  emojis?: Record<string, string>;
  messageTime?: number;
}

export interface ChzzkDonationPayload {
  donationType?: string;
  channelId: string;
  donatorChannelId?: string | null;
  donatorNickname?: string | null;
  payAmount?: string | number;
  donationText?: string;
  emojis?: Record<string, string>;
}

export interface ChzzkSubscriptionPayload {
  channelId: string;
  subscriberChannelId?: string;
  subscriberNickname?: string;
  tierNo?: number;
  tierName?: string;
  month?: number;
}

const ROLE_MAP: Record<string, Role> = {
  streamer: 'streamer',
  streaming_channel_manager: 'manager',
  streaming_chat_manager: 'chat_manager',
  common_user: 'viewer',
};

const asRecord = (v: unknown): Record<string, string> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {};

/** Translate one CHZZK session event into the unified model. Returns null for unknown events. */
export function mapChzzkEvent(name: string, payload: unknown, now = Date.now()): OjakgyoEvent | null {
  if (!payload || typeof payload !== 'object') return null;
  const base = { id: newEventId(), platform: 'chzzk' as const, receivedAt: now };

  switch (name) {
    case 'CHAT': {
      const p = payload as ChzzkChatPayload;
      return {
        ...base,
        type: 'chat',
        channelId: p.channelId ?? '',
        user: {
          ...(p.senderChannelId ? { id: p.senderChannelId } : {}),
          nickname: p.profile?.nickname ?? '',
          role: ROLE_MAP[p.userRoleCode ?? ''] ?? 'viewer',
        },
        message: p.content ?? '',
        emojis: asRecord(p.emojis),
      };
    }
    case 'DONATION': {
      const p = payload as ChzzkDonationPayload;
      const amount = Number(String(p.payAmount ?? '0').replace(/[^0-9.]/g, '')) || 0;
      return {
        ...base,
        type: 'donation',
        channelId: p.channelId ?? '',
        user: p.donatorNickname
          ? {
              ...(p.donatorChannelId ? { id: p.donatorChannelId } : {}),
              nickname: p.donatorNickname,
              role: 'viewer',
            }
          : null,
        amount,
        currency: 'KRW',
        kind: p.donationType === 'VIDEO' ? 'video' : p.donationType === 'CHAT' ? 'chat' : 'other',
        message: p.donationText ?? '',
        emojis: asRecord(p.emojis),
      };
    }
    case 'SUBSCRIPTION': {
      const p = payload as ChzzkSubscriptionPayload;
      return {
        ...base,
        type: 'subscription',
        channelId: p.channelId ?? '',
        user: {
          ...(p.subscriberChannelId ? { id: p.subscriberChannelId } : {}),
          nickname: p.subscriberNickname ?? '',
          role: 'viewer',
        },
        tier: p.tierNo ?? 1,
        ...(p.tierName ? { tierName: p.tierName } : {}),
        months: p.month ?? 1,
        message: '',
      };
    }
    default:
      return null;
  }
}
