export type EventLogSource = 'real' | 'test';

export type EventLogEventType =
  | 'channel_points'
  | 'cheer'
  | 'sub'
  | 'gift_sub'
  | 'follow';

export type EventLogStatus = 'queued' | 'applied' | 'reverted' | 'skipped' | 'error';

export type EventLogAction =
  | { kind: 'pitch'; op: 'add' | 'set'; semitones: number }
  | { kind: 'speed'; op: 'add' | 'set'; percent: number }
  | { kind: 'chat'; template: string; sent?: boolean; messageId?: string; error?: string };

export interface EventLogBindingRef {
  id: string;
  label: string;
}

export interface EventLogEntry {
  id: string;
  ts: number;
  source: EventLogSource;
  eventType: EventLogEventType;
  userDisplay?: string;
  reward?: { id: string; title: string; cost?: number | null };
  bitsAmount?: number | null;
  subTier?: '1000' | '2000' | '3000';
  giftAmount?: number | null;
  matchedBindings: EventLogBindingRef[];
  actions: EventLogAction[];
  delaySec?: number | null;
  durationSec?: number | null;
  status: EventLogStatus;
  note?: string;
}

export const EVENT_LOG_STORAGE_KEY = 'eventLog';
export const EVENT_LOG_UPDATED_AT_KEY = 'eventLogUpdatedAt';
export const EVENT_LOG_LIMIT = 200;
