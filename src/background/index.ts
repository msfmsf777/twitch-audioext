import {
  type PopupToBackgroundMessage,
  type ContentToBackgroundMessage,
  type BackgroundToPopupMessage,
  type BackgroundToContentMessage
} from '../shared/messages';
import {
  createDefaultPopupState,
  POPUP_STATE_STORAGE_KEY,
  type PopupPersistentState
} from '../shared/state';
import { loadFromStorage, saveToStorage } from '../shared/storage';

let cachedState: PopupPersistentState = createDefaultPopupState();

async function init(): Promise<void> {
  cachedState = await loadFromStorage(POPUP_STATE_STORAGE_KEY, createDefaultPopupState());
}

void init();

function respondToPopup(
  sendResponse: (response?: BackgroundToPopupMessage) => void,
  message: BackgroundToPopupMessage
): void {
  sendResponse(message);
}

async function handlePopupMessage(
  message: PopupToBackgroundMessage,
  sendResponse: (response?: BackgroundToPopupMessage) => void
): Promise<void> {
  switch (message.type) {
    case 'POPUP_READY':
    case 'POPUP_REQUEST_STATE': {
      respondToPopup(sendResponse, { type: 'BACKGROUND_STATE', state: cachedState });
      return;
    }
    case 'POPUP_UPDATE_STATE': {
      cachedState = message.state;
      await saveToStorage(POPUP_STATE_STORAGE_KEY, cachedState);
      respondToPopup(sendResponse, { type: 'BACKGROUND_STATE', state: cachedState });
      return;
    }
    case 'POPUP_TOGGLE_DEVTOOLS': {
      cachedState = { ...cachedState, diagnosticsExpanded: message.expanded };
      await saveToStorage(POPUP_STATE_STORAGE_KEY, cachedState);
      respondToPopup(sendResponse, { type: 'BACKGROUND_DEVTOOLS', expanded: message.expanded });
      return;
    }
    default:
      return;
  }
}

function handleContentMessage(message: ContentToBackgroundMessage): void {
  switch (message.type) {
    case 'CONTENT_READY':
      console.info('[background] Content script is ready');
      break;
    case 'CONTENT_PONG':
      console.debug('[background] Received pong from content script');
      break;
    case 'AUDIO_STATUS':
      console.debug('[background] Audio status update', message.status);
      break;
    default:
      break;
  }
}

function isPopupMessage(message: unknown): message is PopupToBackgroundMessage {
  return typeof message === 'object' && message !== null && 'type' in message && String((message as any).type).startsWith('POPUP_');
}

function isContentMessage(message: unknown): message is ContentToBackgroundMessage {
  return typeof message === 'object' && message !== null && 'type' in message && String((message as any).type).startsWith('CONTENT_');
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (isPopupMessage(message)) {
    void handlePopupMessage(message, sendResponse);
    return true;
  }

  if (isContentMessage(message)) {
    handleContentMessage(message);
  }

  return false;
});

export function dispatchAudioCommand(tabId: number, message: BackgroundToContentMessage): void {
  try {
    chrome.tabs.sendMessage(tabId, message, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        console.warn('[background] Failed to send audio command', error.message);
      }
    });
  } catch (error) {
    console.warn('[background] Failed to send audio command', error);
  }
}
