export type BindingEventType =
  | 'channel_points'
  | 'bits'
  | 'gift_sub'
  | 'sub'
  | 'follow';

export interface RangeConfig {
  mode: 'exact' | 'range';
  exact?: number | null;
  min?: number | null;
  max?: number | null;
}

export type SubTier = 'tier1' | 'tier2' | 'tier3';

export interface ChannelPointRewardSummary {
  id: string;
  title: string;
  cost?: number | null;
}

export interface BindingAction {
  type: 'pitch' | 'speed';
  amount: number;
}

export interface BindingConfigChannelPoints {
  type: 'channel_points';
  rewardId: string | null;
  rewardTitle?: string | null;
}

export interface BindingConfigBits {
  type: 'bits';
  range: RangeConfig;
}

export interface BindingConfigGiftSub {
  type: 'gift_sub';
  range: RangeConfig;
}

export interface BindingConfigSub {
  type: 'sub';
  tiers: SubTier[];
}

export interface BindingConfigFollow {
  type: 'follow';
}

export type BindingConfig =
  | BindingConfigChannelPoints
  | BindingConfigBits
  | BindingConfigGiftSub
  | BindingConfigSub
  | BindingConfigFollow;

export interface BindingDefinition {
  id: string;
  label: string;
  enabled: boolean;
  eventType: BindingEventType;
  config: BindingConfig;
  action: BindingAction;
  delaySeconds?: number | null;
  durationSeconds?: number | null;
  chatTemplate: string;
}

export type TestEventType = 'channel_points' | 'bits' | 'gift_sub' | 'sub' | 'follow';

export interface TestEventsState {
  type: TestEventType;
  username: string;
  amount: string;
  channelPointsRewardId: string | null;
  subTier: SubTier;
}

export interface PopupPersistentState {
  language: string;
  semitoneOffset: number;
  speedPercent: number;
  effectSemitoneOffset: number;
  effectSpeedPercent: number;
  captureEvents: boolean;
  loggedIn: boolean;
  twitchDisplayName: string | null;
  channelPointRewards: ChannelPointRewardSummary[];
  testEvents: TestEventsState;
  bindings: BindingDefinition[];
  diagnosticsExpanded: boolean;
  eventLogExpanded: boolean;
  mediaAvailability: MediaAvailabilityState;
  activeTabId: number | null;
}

export const POPUP_STATE_STORAGE_KEY = 'popupState';
export const MEDIA_AVAILABILITY_STORAGE_KEY = 'mediaAvailability';
export const MEDIA_AVAILABILITY_BY_TAB_STORAGE_KEY = 'mediaAvailabilityByTab';
export const MANUAL_AUDIO_STATE_STORAGE_KEY = 'manualAudioStateByTab';

export type MediaAvailabilityReason = 'none' | 'no_media' | 'drm_cors';

export interface MediaAvailabilityState {
  hasAnyMedia: boolean;
  hasUsableMedia: boolean;
  reason: MediaAvailabilityReason;
  tabId?: number | null;
}

export interface ManualAudioState {
  semitoneOffset: number;
  speedPercent: number;
}

export function createDefaultPopupState(): PopupPersistentState {
  return {
    language: 'en',
    semitoneOffset: 0,
    speedPercent: 100,
    effectSemitoneOffset: 0,
    effectSpeedPercent: 0,
    captureEvents: false,
    loggedIn: false,
    twitchDisplayName: null,
    channelPointRewards: [],
    testEvents: {
      type: 'channel_points',
      username: '',
      amount: '',
      channelPointsRewardId: null,
      subTier: 'tier1'
    },
    bindings: [],
    diagnosticsExpanded: false,
    eventLogExpanded: false,
    mediaAvailability: {
      hasAnyMedia: true,
      hasUsableMedia: true,
      reason: 'none'
    },
    activeTabId: null
  };
}
