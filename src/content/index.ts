import type {
  BackgroundToContentMessage,
  PopupToContentMessage,
  ContentToBackgroundMessage
} from '../shared/messages';

interface ActiveAudioState {
  semitoneOffset: number | null;
  speedPercent: number | null;
  ttlSeconds: number | null;
}

let activeState: ActiveAudioState = {
  semitoneOffset: null,
  speedPercent: null,
  ttlSeconds: null
};

function postToBackground(message: ContentToBackgroundMessage): void {
  chrome.runtime.sendMessage(message);
}

function handleAudioApply(payload: ActiveAudioState): void {
  activeState = { ...payload };
  console.debug('[content] Received apply audio command', activeState);
}

function handleAudioReset(): void {
  activeState = { semitoneOffset: null, speedPercent: null, ttlSeconds: null };
  console.debug('[content] Received reset audio command');
}

function isBackgroundMessage(message: unknown): message is BackgroundToContentMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    ['AUDIO_APPLY', 'AUDIO_RESET', 'PING'].includes(String((message as any).type))
  );
}

function isPopupToContentMessage(message: unknown): message is PopupToContentMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    String((message as any).type).startsWith('POPUP_')
  );
}

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (isBackgroundMessage(message)) {
    switch (message.type) {
      case 'AUDIO_APPLY':
        handleAudioApply({
          semitoneOffset: message.payload.semitoneOffset ?? null,
          speedPercent: message.payload.speedPercent ?? null,
          ttlSeconds: message.payload.ttlSeconds ?? null
        });
        break;
      case 'AUDIO_RESET':
        handleAudioReset();
        break;
      case 'PING':
        postToBackground({ type: 'CONTENT_PONG' });
        break;
      default:
        break;
    }
    return;
  }

  if (isPopupToContentMessage(message)) {
    switch (message.type) {
      case 'POPUP_APPLY_AUDIO':
        handleAudioApply({
          semitoneOffset: message.payload.semitoneOffset,
          speedPercent: message.payload.speedPercent,
          ttlSeconds: null
        });
        break;
      case 'POPUP_RESET_AUDIO':
        handleAudioReset();
        break;
      default:
        break;
    }
  }
});

postToBackground({ type: 'CONTENT_READY' });
