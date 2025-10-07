export const TWITCH_CLIENT_ID = (process.env.TWITCH_CLIENT_ID ?? '').trim();

export const TWITCH_REDIRECT_PATH = (process.env.TWITCH_REDIRECT_PATH ?? 'twitch').trim();

export const TWITCH_REQUIRED_SCOPES = [
  'channel:read:redemptions',
  'bits:read',
  'channel:read:subscriptions'
] as const;

export type TwitchScope = (typeof TWITCH_REQUIRED_SCOPES)[number];

export const TWITCH_AUTH_BASE = 'https://id.twitch.tv/oauth2';
export const TWITCH_HELIX_BASE = 'https://api.twitch.tv/helix';
export const TWITCH_EVENTSUB_WS = 'wss://eventsub.wss.twitch.tv/ws';

export interface TwitchAuthData {
  accessToken: string;
  expiresAt: number;
  obtainedAt: number;
  scopes: string[];
  broadcasterId: string;
  displayName: string;
  login: string;
}

export const TWITCH_AUTH_STORAGE_KEY = 'twitchAuth';

export interface TwitchDiagnosticsSnapshot {
  websocketConnected: boolean;
  sessionId: string | null;
  subscriptions: number;
  lastKeepaliveAt: number | null;
  lastNotificationAt: number | null;
  lastNotificationType: string | null;
  lastError: string | null;
}

export function createEmptyDiagnostics(): TwitchDiagnosticsSnapshot {
  return {
    websocketConnected: false,
    sessionId: null,
    subscriptions: 0,
    lastKeepaliveAt: null,
    lastNotificationAt: null,
    lastNotificationType: null,
    lastError: null
  };
}

export interface EventSubSubscriptionDefinition {
  type: string;
  version: string;
  condition: Record<string, string>;
}

export function getRequiredEventSubDefinitions(broadcasterId: string): EventSubSubscriptionDefinition[] {
  return [
    {
      type: 'channel.channel_points_custom_reward_redemption.add',
      version: '1',
      condition: { broadcaster_user_id: broadcasterId }
    },
    {
      type: 'channel.cheer',
      version: '1',
      condition: { broadcaster_user_id: broadcasterId }
    },
    {
      type: 'channel.subscribe',
      version: '1',
      condition: { broadcaster_user_id: broadcasterId }
    },
    {
      type: 'channel.follow',
      version: '2',
      condition: {
        broadcaster_user_id: broadcasterId,
        moderator_user_id: broadcasterId
      }
    }
  ];
}

export function scopesMissing(required: readonly string[], granted: string[]): string[] {
  const grantedLower = new Set(granted.map((scope) => scope.toLowerCase()));
  return required.filter((scope) => !grantedLower.has(scope.toLowerCase()));
}

