import { AudioEngine } from './audio/engine';
import {
  MEDIA_AVAILABILITY_STORAGE_KEY,
  POPUP_STATE_STORAGE_KEY,
  type MediaAvailabilityState,
  type PopupPersistentState
} from '../shared/state';
import type {
  BackgroundToContentMessage,
  PopupToContentMessage,
  ContentToBackgroundMessage
} from '../shared/messages';

const EFFECT_STORAGE_KEY = 'effectAdjustments';

interface EffectContribution {
  pitch?: { op: 'add' | 'set'; value: number };
  speed?: { op: 'add' | 'set'; value: number };
}

interface EffectTotals {
  pitch: number;
  speed: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function safeNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isBackgroundMessage(message: unknown): message is BackgroundToContentMessage {
  if (!message || typeof message !== 'object') {
    return false;
  }
  const type = String((message as { type?: unknown }).type ?? '');
  return (
    type === 'AUDIO_APPLY' ||
    type === 'AUDIO_RESET' ||
    type === 'AUDIO_EFFECT_APPLY' ||
    type === 'AUDIO_EFFECT_REVERT' ||
    type === 'PING'
  );
}

function isPopupMessage(message: unknown): message is PopupToContentMessage {
  if (!message || typeof message !== 'object') {
    return false;
  }
  const type = String((message as { type?: unknown }).type ?? '');
  return type.startsWith('POPUP_');
}

class ContentController {
  private engine: AudioEngine;
  private baseSemitone = 0;
  private baseSpeed = 100;
  private activeEffects = new Map<string, EffectContribution>();
  private effectTotals: EffectTotals = { pitch: 0, speed: 0 };
  private lastPublishedEffectTotals: EffectTotals = { pitch: 0, speed: 0 };
  private availability: MediaAvailabilityState = {
    hasAnyMedia: true,
    hasUsableMedia: true,
    reason: 'none'
  };
  private availabilityTimer: number | null = null;
  private lastAvailabilitySerialized: string | null = null;
  private tabId: number | null = null;

  constructor() {
    this.engine = new AudioEngine((state) => this.handleAvailabilityChange(state));
  }

  async init(): Promise<void> {
    await this.loadInitialState();
    await this.engine.start();
    this.registerListeners();
    await this.requestTabId();
    this.updateEngineTargets();
    this.scheduleAvailabilityPersist();
  }

  private registerListeners(): void {
    chrome.runtime.onMessage.addListener((message: unknown) => {
      if (isBackgroundMessage(message)) {
        this.handleBackgroundMessage(message);
        return;
      }
      if (isPopupMessage(message)) {
        this.handlePopupMessage(message);
      }
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') {
        return;
      }
      if (POPUP_STATE_STORAGE_KEY in changes) {
        const next = changes[POPUP_STATE_STORAGE_KEY]?.newValue as PopupPersistentState | undefined;
        if (next) {
          this.applyPopupState(next);
        }
      }
      if (MEDIA_AVAILABILITY_STORAGE_KEY in changes) {
        const next = changes[MEDIA_AVAILABILITY_STORAGE_KEY]?.newValue as MediaAvailabilityState | undefined;
        if (next) {
          this.handleAvailabilityStorage(next);
        }
      }
    });
  }

  private async loadInitialState(): Promise<void> {
    const data = await new Promise<Record<string, unknown>>((resolve) => {
      chrome.storage.local.get([POPUP_STATE_STORAGE_KEY, EFFECT_STORAGE_KEY, MEDIA_AVAILABILITY_STORAGE_KEY], resolve);
    });
    const popupState = data[POPUP_STATE_STORAGE_KEY] as PopupPersistentState | undefined;
    if (popupState) {
      this.baseSemitone = clamp(safeNumber(popupState.semitoneOffset, 0), -12, 12);
      this.baseSpeed = clamp(safeNumber(popupState.speedPercent, 100), 50, 200);
      if (popupState.mediaAvailability) {
        this.availability = {
          hasAnyMedia: Boolean(popupState.mediaAvailability.hasAnyMedia),
          hasUsableMedia: Boolean(popupState.mediaAvailability.hasUsableMedia),
          reason: popupState.mediaAvailability.reason
        };
      }
    }

    const effectState = data[EFFECT_STORAGE_KEY] as { semitoneOffset?: number; speedPercent?: number } | undefined;
    if (effectState) {
      this.effectTotals = {
        pitch: safeNumber(effectState.semitoneOffset, 0),
        speed: safeNumber(effectState.speedPercent, 0)
      };
      this.lastPublishedEffectTotals = { ...this.effectTotals };
    }

    const storedAvailability = data[MEDIA_AVAILABILITY_STORAGE_KEY] as MediaAvailabilityState | undefined;
    if (storedAvailability) {
      this.handleAvailabilityStorage(storedAvailability);
    }
  }

  private applyPopupState(state: PopupPersistentState): void {
    const nextSemitone = clamp(safeNumber(state.semitoneOffset, 0), -12, 12);
    const nextSpeed = clamp(safeNumber(state.speedPercent, 100), 50, 200);
    let changed = false;
    if (nextSemitone !== this.baseSemitone) {
      this.baseSemitone = nextSemitone;
      changed = true;
    }
    if (nextSpeed !== this.baseSpeed) {
      this.baseSpeed = nextSpeed;
      changed = true;
    }
    if (state.mediaAvailability) {
      this.availability = {
        hasAnyMedia: Boolean(state.mediaAvailability.hasAnyMedia),
        hasUsableMedia: Boolean(state.mediaAvailability.hasUsableMedia),
        reason: state.mediaAvailability.reason
      };
      this.scheduleAvailabilityPersist();
    }
    if (changed) {
      this.updateEngineTargets();
    }
  }

  private handleAvailabilityStorage(value: MediaAvailabilityState): void {
    if (typeof value.tabId === 'number' && this.tabId !== null && value.tabId !== this.tabId) {
      return;
    }
    this.availability = {
      hasAnyMedia: Boolean(value.hasAnyMedia),
      hasUsableMedia: Boolean(value.hasUsableMedia),
      reason: value.reason === 'drm_cors' || value.reason === 'no_media' ? value.reason : 'none'
    };
    this.scheduleAvailabilityPersist();
  }

  private async requestTabId(): Promise<void> {
    await new Promise<void>((resolve) => {
      chrome.runtime.sendMessage({ type: 'CONTENT_READY' }, (response?: { tabId?: number | null }) => {
        const error = chrome.runtime.lastError;
        if (!error && response && typeof response.tabId === 'number') {
          this.tabId = response.tabId;
        }
        resolve();
      });
    });
  }

  private async publishEffectTotals(): Promise<void> {
    const { pitch, speed } = this.effectTotals;
    if (
      pitch === this.lastPublishedEffectTotals.pitch &&
      speed === this.lastPublishedEffectTotals.speed
    ) {
      return;
    }
    this.lastPublishedEffectTotals = { pitch, speed };
    await chrome.storage.local.set({
      [EFFECT_STORAGE_KEY]: { semitoneOffset: pitch, speedPercent: speed }
    });
    const message: ContentToBackgroundMessage = {
      type: 'AUDIO_EFFECTS_UPDATE',
      payload: { semitoneOffset: pitch, speedPercent: speed }
    };
    chrome.runtime.sendMessage(message, () => {
      void chrome.runtime.lastError;
    });
  }

  private recomputeEffectTotals(): void {
    let pitchAdd = 0;
    let pitchSet: number | null = null;
    let speedAdd = 0;
    let speedSet: number | null = null;

    for (const contribution of this.activeEffects.values()) {
      if (contribution.pitch) {
        if (contribution.pitch.op === 'set') {
          pitchSet = contribution.pitch.value;
        } else {
          pitchAdd += contribution.pitch.value;
        }
      }
      if (contribution.speed) {
        if (contribution.speed.op === 'set') {
          speedSet = contribution.speed.value;
        } else {
          speedAdd += contribution.speed.value;
        }
      }
    }

    this.effectTotals = {
      pitch: (pitchSet ?? 0) + pitchAdd,
      speed: (speedSet ?? 0) + speedAdd
    };
  }

  private async onEffectsChanged(): Promise<void> {
    const previous = this.effectTotals;
    this.recomputeEffectTotals();
    if (
      previous.pitch !== this.effectTotals.pitch ||
      previous.speed !== this.effectTotals.speed
    ) {
      await this.publishEffectTotals();
      this.updateEngineTargets();
    }
  }

  private async handleEffectApply(message: BackgroundToContentMessage & { type: 'AUDIO_EFFECT_APPLY' }): Promise<void> {
    const contribution: EffectContribution = {};
    if (message.payload.pitch) {
      contribution.pitch = { op: message.payload.pitch.op, value: safeNumber(message.payload.pitch.semitones, 0) };
    }
    if (message.payload.speed) {
      contribution.speed = { op: message.payload.speed.op, value: safeNumber(message.payload.speed.percent, 0) };
    }
    this.activeEffects.set(message.payload.effectId, contribution);
    await this.onEffectsChanged();
  }

  private async handleEffectRevert(message: BackgroundToContentMessage & { type: 'AUDIO_EFFECT_REVERT' }): Promise<void> {
    if (this.activeEffects.delete(message.payload.effectId)) {
      await this.onEffectsChanged();
    }
  }

  private async handleBackgroundMessage(message: BackgroundToContentMessage): Promise<void> {
    switch (message.type) {
      case 'AUDIO_APPLY': {
        if (typeof message.payload?.semitoneOffset === 'number') {
          this.baseSemitone = clamp(message.payload.semitoneOffset, -12, 12);
        }
        if (typeof message.payload?.speedPercent === 'number') {
          this.baseSpeed = clamp(message.payload.speedPercent, 50, 200);
        }
        this.updateEngineTargets();
        break;
      }
      case 'AUDIO_RESET': {
        this.baseSemitone = 0;
        this.baseSpeed = 100;
        this.updateEngineTargets();
        break;
      }
      case 'AUDIO_EFFECT_APPLY':
        await this.handleEffectApply(message);
        break;
      case 'AUDIO_EFFECT_REVERT':
        await this.handleEffectRevert(message);
        break;
      case 'PING':
        chrome.runtime.sendMessage({ type: 'CONTENT_PONG' } satisfies ContentToBackgroundMessage, () => {
          void chrome.runtime.lastError;
        });
        break;
      default:
        break;
    }
  }

  private handlePopupMessage(message: PopupToContentMessage): void {
    switch (message.type) {
      case 'POPUP_APPLY_AUDIO':
        this.baseSemitone = clamp(message.payload.semitoneOffset, -12, 12);
        this.baseSpeed = clamp(message.payload.speedPercent, 50, 200);
        this.updateEngineTargets();
        break;
      case 'POPUP_RESET_AUDIO':
        this.baseSemitone = 0;
        this.baseSpeed = 100;
        this.updateEngineTargets();
        break;
      default:
        break;
    }
  }

  private async updateEngineTargets(): Promise<void> {
    const totalPitch = clamp(this.baseSemitone + this.effectTotals.pitch, -24, 24);
    const totalSpeed = Math.max(1, this.baseSpeed + this.effectTotals.speed);
    await this.engine.setTargets(totalPitch, totalSpeed);
  }

  private handleAvailabilityChange(state: MediaAvailabilityState): void {
    this.availability = {
      hasAnyMedia: Boolean(state.hasAnyMedia),
      hasUsableMedia: Boolean(state.hasUsableMedia),
      reason: state.reason === 'drm_cors' || state.reason === 'no_media' ? state.reason : 'none'
    };
    this.scheduleAvailabilityPersist();
  }

  private scheduleAvailabilityPersist(): void {
    if (this.availabilityTimer) {
      return;
    }
    this.availabilityTimer = window.setTimeout(() => {
      this.availabilityTimer = null;
      const payload: MediaAvailabilityState = {
        hasAnyMedia: this.availability.hasAnyMedia,
        hasUsableMedia: this.availability.hasUsableMedia,
        reason: this.availability.reason,
        tabId: this.tabId
      };
      const serialized = JSON.stringify(payload);
      if (serialized === this.lastAvailabilitySerialized) {
        return;
      }
      this.lastAvailabilitySerialized = serialized;
      chrome.storage.local.set({ [MEDIA_AVAILABILITY_STORAGE_KEY]: payload });
    }, 150);
  }
}

const controller = new ContentController();
void controller.init();

