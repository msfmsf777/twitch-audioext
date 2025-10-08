import type { PopupPersistentState, SubTier, TestEventType } from './state';
import type { TwitchDiagnosticsSnapshot } from './twitch';

export type PopupToBackgroundMessage =
  | { type: 'POPUP_READY' }
  | { type: 'POPUP_UPDATE_STATE'; state: PopupPersistentState }
  | { type: 'POPUP_REQUEST_STATE' }
  | { type: 'POPUP_TOGGLE_DEVTOOLS'; expanded: boolean }
  | { type: 'POPUP_TWITCH_CONNECT' }
  | { type: 'POPUP_TWITCH_RECONNECT' }
  | { type: 'POPUP_TWITCH_DISCONNECT' }
  | { type: 'POPUP_REFRESH_REWARDS' }
  | {
      type: 'POPUP_TRIGGER_TEST_EVENT';
      payload: {
        type: TestEventType;
        username: string;
        amount: number | null;
        rewardId: string | null;
        subTier: SubTier;
      };
    };

export type BackgroundToPopupMessage =
  | { type: 'BACKGROUND_STATE'; state: PopupPersistentState }
  | { type: 'BACKGROUND_DEVTOOLS'; expanded: boolean }
  | {
      type: 'BACKGROUND_ACTION_RESULT';
      status: 'ok' | 'error';
      messageKey?: string;
      messageParams?: Record<string, string | number>;
      state?: PopupPersistentState;
    }
  | { type: 'BACKGROUND_DIAGNOSTICS'; diagnostics: TwitchDiagnosticsSnapshot };

export type BackgroundToContentMessage =
  | {
      type: 'AUDIO_APPLY';
      payload: {
        semitoneOffset?: number;
        speedPercent?: number;
        ttlSeconds?: number;
      };
    }
  | { type: 'AUDIO_RESET' }
  | {
      type: 'AUDIO_EFFECT_APPLY';
      payload: {
        effectId: string;
        pitch?: { op: 'add' | 'set'; semitones: number } | null;
        speed?: { op: 'add' | 'set'; percent: number } | null;
        delayMs?: number;
        durationMs?: number | null;
        source: 'event' | 'test';
      };
    }
  | {
      type: 'AUDIO_EFFECT_REVERT';
      payload: { effectId: string };
    }
  | { type: 'PING' };

export type ContentToBackgroundMessage =
  | { type: 'CONTENT_READY' }
  | { type: 'CONTENT_PONG' }
  | {
      type: 'AUDIO_STATUS';
      status: 'idle' | 'active';
    }
  | {
      type: 'AUDIO_EFFECTS_UPDATE';
      payload: { semitoneOffset: number; speedPercent: number };
    };

export type PopupToContentMessage =
  | { type: 'POPUP_APPLY_AUDIO'; payload: { semitoneOffset: number; speedPercent: number } }
  | { type: 'POPUP_RESET_AUDIO' };
