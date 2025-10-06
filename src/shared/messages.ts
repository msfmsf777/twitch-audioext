import type { PopupPersistentState } from './state';

export type PopupToBackgroundMessage =
  | { type: 'POPUP_READY' }
  | { type: 'POPUP_UPDATE_STATE'; state: PopupPersistentState }
  | { type: 'POPUP_REQUEST_STATE' }
  | { type: 'POPUP_TOGGLE_DEVTOOLS'; expanded: boolean };

export type BackgroundToPopupMessage =
  | { type: 'BACKGROUND_STATE'; state: PopupPersistentState }
  | { type: 'BACKGROUND_DEVTOOLS'; expanded: boolean };

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
  | { type: 'PING' };

export type ContentToBackgroundMessage =
  | { type: 'CONTENT_READY' }
  | { type: 'CONTENT_PONG' }
  | {
      type: 'AUDIO_STATUS';
      status: 'idle' | 'active';
    };

export type PopupToContentMessage =
  | { type: 'POPUP_APPLY_AUDIO'; payload: { semitoneOffset: number; speedPercent: number } }
  | { type: 'POPUP_RESET_AUDIO' };
