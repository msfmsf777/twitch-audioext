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

export interface BindingAction {
  type: 'pitch' | 'speed';
  amount: number;
}

export interface BindingConfigChannelPoints {
  type: 'channel_points';
  rewardId: string | null;
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

export interface TestEventRangeState {
  mode: 'exact' | 'range';
  exact?: number | null;
  min?: number | null;
  max?: number | null;
}

export interface TestEventsState {
  channelPointsRewardId: string | null;
  bits: TestEventRangeState;
  giftSubs: TestEventRangeState;
  subTiers: SubTier[];
}

export interface PopupPersistentState {
  language: string;
  semitoneOffset: number;
  speedPercent: number;
  captureEvents: boolean;
  loggedIn: boolean;
  twitchDisplayName: string | null;
  testEvents: TestEventsState;
  bindings: BindingDefinition[];
  diagnosticsExpanded: boolean;
}

export const POPUP_STATE_STORAGE_KEY = 'popupState';

export function createDefaultPopupState(): PopupPersistentState {
  return {
    language: 'en',
    semitoneOffset: 0,
    speedPercent: 100,
    captureEvents: false,
    loggedIn: false,
    twitchDisplayName: null,
    testEvents: {
      channelPointsRewardId: null,
      bits: { mode: 'exact', exact: null, min: null, max: null },
      giftSubs: { mode: 'exact', exact: null, min: null, max: null },
      subTiers: ['tier1']
    },
    bindings: [],
    diagnosticsExpanded: false
  };
}
