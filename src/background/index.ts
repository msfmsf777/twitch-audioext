import {
  type PopupToBackgroundMessage,
  type ContentToBackgroundMessage,
  type BackgroundToPopupMessage,
  type BackgroundToContentMessage
} from '../shared/messages';
import {
  createDefaultPopupState,
  MEDIA_AVAILABILITY_STORAGE_KEY,
  POPUP_STATE_STORAGE_KEY,
  type PopupPersistentState,
  type BindingEventType,
  type SubTier,
  type TestEventType,
  type ChannelPointRewardSummary,
  type RangeConfig,
  type BindingDefinition,
  type MediaAvailabilityState,
  type MediaAvailabilityReason
} from '../shared/state';
import { loadFromStorage, removeFromStorage, saveToStorage } from '../shared/storage';
import {
  TWITCH_AUTH_BASE,
  TWITCH_AUTH_STORAGE_KEY,
  TWITCH_LEGACY_AUTH_STORAGE_KEYS,
  TWITCH_CLIENT_ID,
  TWITCH_EVENTSUB_WS,
  TWITCH_HELIX_BASE,
  TWITCH_REDIRECT_PATH,
  TWITCH_REQUIRED_SCOPES,
  createEmptyDiagnostics,
  getRequiredEventSubDefinitions,
  scopesMissing,
  type EventSubSubscriptionDefinition,
  type TwitchAuthData,
  type TwitchDiagnosticsSnapshot
} from '../shared/twitch';
import {
  EVENT_LOG_LIMIT,
  EVENT_LOG_STORAGE_KEY,
  EVENT_LOG_UPDATED_AT_KEY,
  type EventLogStatus,
  type EventLogAction,
  type EventLogEntry
} from '../shared/event-log';

const AUTH_EXPIRY_PADDING_MS = 60_000;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const STATE_BROADCAST_MIN_INTERVAL_MS = 500;
const SUBSCRIPTION_CREATE_WINDOW_MS = 10_000;
const CHANNEL_REWARD_REFRESH_INTERVAL_MS = 60_000;
const REWARD_REFRESH_DEBOUNCE_MS = 15_000;
const EVENT_LOG_WRITE_THROTTLE_MS = 500;
const MESSAGE_ID_TTL_MS = 5 * 60_000;
const EFFECT_STORAGE_KEY = 'effectAdjustments';
const CHANNEL_REWARDS_STORAGE_KEY = 'channelRewards';
const CHANNEL_REWARDS_UPDATED_AT_KEY = 'channelRewardsUpdatedAt';

type TimeoutHandle = ReturnType<typeof setTimeout>;

type EventSubConnectionState = 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'closed';

type RoutedEventSource = 'eventsub' | 'test';

interface RoutedEvent {
  source: RoutedEventSource;
  subscriptionType: string;
  bindingType: BindingEventType;
  receivedAt: number;
  payload: unknown;
  messageId: string;
}

type NormalizedEvent =
  | {
      type: 'channel_points';
      rewardId: string;
      rewardTitle?: string;
      rewardCost?: number | null;
      userDisplay: string;
    }
  | { type: 'cheer'; amount: number; userDisplay: string }
  | {
      type: 'sub';
      tier: '1000' | '2000' | '3000';
      isGift: boolean;
      giftAmount?: number | null;
      userDisplay: string;
    }
  | { type: 'follow'; userDisplay: string };

type EffectOperation =
  | { kind: 'pitch'; op: 'add' | 'set'; semitones: number }
  | { kind: 'speed'; op: 'add' | 'set'; percent: number }
  | { kind: 'chat'; template: string };

interface ScheduledEffect {
  id: string;
  bindingId: string;
  bindingLabel: string;
  operations: EffectOperation[];
  delayMs: number;
  durationMs: number | null;
  event: NormalizedEvent;
  eventSource: RoutedEventSource;
  eventLogId: string | null;
  applyTimer: TimeoutHandle | null;
  revertTimer: TimeoutHandle | null;
  applied: boolean;
}

interface HelixSubscription {
  id: string;
  status: string;
  type: string;
  version: string;
  condition: Record<string, string>;
  transport: {
    method: string;
    session_id?: string;
  };
}

interface OAuthValidateResponse {
  client_id: string;
  login: string;
  scopes: string[];
  user_id: string;
  expires_in: number;
}

class MissingClientIdError extends Error {
  constructor() {
    super('Missing Twitch client ID');
    this.name = 'MissingClientIdError';
  }
}

class MissingScopesError extends Error {
  constructor(public readonly missing: string[]) {
    super('Missing required Twitch scopes');
    this.name = 'MissingScopesError';
  }
}

class AuthCancelledError extends Error {
  constructor(message = 'Authentication cancelled') {
    super(message);
    this.name = 'AuthCancelledError';
  }
}

class TokenValidationError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message = 'Token validation failed'
  ) {
    super(message);
    this.name = 'TokenValidationError';
  }
}

class HelixRequestError extends Error {
  constructor(public readonly status: number, public readonly body: unknown, message = 'Helix request failed') {
    super(message);
    this.name = 'HelixRequestError';
  }
}

let cachedState: PopupPersistentState = createDefaultPopupState();
let twitchAuth: TwitchAuthData | null = null;
let diagnostics: TwitchDiagnosticsSnapshot = createEmptyDiagnostics();

let eventSubSocket: WebSocket | null = null;
let eventSubSessionId: string | null = null;
let eventSubReconnectTimer: TimeoutHandle | null = null;
let keepaliveTimer: TimeoutHandle | null = null;
let keepaliveTimeoutMs = 0;
let reconnectBackoffMs = INITIAL_BACKOFF_MS;
let eventSubConnectionState: EventSubConnectionState = 'idle';
let ensureSubscriptionsTimer: TimeoutHandle | null = null;
let subscriptionDeadlineTimer: TimeoutHandle | null = null;
let subscriptionsReady = false;
let subscriptionRetryBlocked = false;
let pendingBroadcastTimer: TimeoutHandle | null = null;
let lastBroadcastStateSerialized: string | null = null;
let lastBroadcastAt = 0;
let channelRewardTimer: TimeoutHandle | null = null;
let channelRewardLastFetchedAt = 0;
let ensureSubscriptionsInFlight = false;
let suppressedCloseSocket: WebSocket | null = null;
let channelRewardFetchInFlight = false;
let lastManualRewardRefreshAt = 0;
let channelRewards: ChannelPointRewardSummary[] = [];
let eventLog: EventLogEntry[] = [];
let lastEventLogSerialized: string | null = null;
let eventLogWriteTimer: TimeoutHandle | null = null;
let activeEffects: Map<string, ScheduledEffect> = new Map();
let processedMessageIds: Map<string, number> = new Map();
let effectAdjustments = { semitoneOffset: 0, speedPercent: 0 };
let activeContentTabId: number | null = null;

function sanitizeBindingDefinition(binding: BindingDefinition): BindingDefinition {
  if (!binding || typeof binding !== 'object') {
    return binding;
  }
  if (binding.config.type !== 'channel_points') {
    return binding;
  }
  const rawId = binding.config.rewardId;
  const trimmedId = typeof rawId === 'string' ? rawId.trim() : '';
  const rewardId = trimmedId.length > 0 ? trimmedId : null;
  const rawTitle = binding.config.rewardTitle;
  const trimmedTitle = typeof rawTitle === 'string' ? rawTitle.trim() : '';
  const rewardTitle = rewardId && trimmedTitle.length > 0 ? trimmedTitle : null;
  if (
    rewardId === binding.config.rewardId &&
    (rewardTitle ?? null) === (binding.config.rewardTitle ?? null)
  ) {
    return binding;
  }
  return {
    ...binding,
    config: {
      type: 'channel_points',
      rewardId,
      rewardTitle: rewardTitle ?? null
    }
  };
}

function sanitizeBindings(bindings: BindingDefinition[] | undefined | null): BindingDefinition[] {
  if (!Array.isArray(bindings)) {
    return [];
  }
  let changed = false;
  const sanitized = bindings.map((binding) => {
    const next = sanitizeBindingDefinition(binding);
    if (next !== binding) {
      changed = true;
    }
    return next;
  });
  return changed ? sanitized : bindings;
}

function sanitizeMediaAvailability(
  value: MediaAvailabilityState | undefined | null
): MediaAvailabilityState {
  if (value && typeof value === 'object') {
    const hasAny = typeof value.hasAnyMedia === 'boolean' ? value.hasAnyMedia : Boolean(value.hasAnyMedia);
    const hasUsable =
      typeof value.hasUsableMedia === 'boolean' ? value.hasUsableMedia : Boolean(value.hasUsableMedia);
    const reason: MediaAvailabilityReason =
      value.reason === 'drm_cors' || value.reason === 'no_media' ? value.reason : 'none';
    if (
      hasAny === value.hasAnyMedia &&
      hasUsable === value.hasUsableMedia &&
      reason === value.reason &&
      value.tabId === undefined
    ) {
      return value;
    }
    return { hasAnyMedia: hasAny, hasUsableMedia: hasUsable, reason };
  }
  return { hasAnyMedia: true, hasUsableMedia: true, reason: 'none' };
}

function sanitizePopupState(state: PopupPersistentState): PopupPersistentState {
  const sanitizedBindings = sanitizeBindings(state.bindings);
  const rewards = Array.isArray(state.channelPointRewards) ? state.channelPointRewards : [];
  const availability = sanitizeMediaAvailability(state.mediaAvailability);
  if (
    sanitizedBindings === state.bindings &&
    rewards === state.channelPointRewards &&
    availability === state.mediaAvailability
  ) {
    return state;
  }
  return {
    ...state,
    bindings: sanitizedBindings,
    channelPointRewards: rewards,
    mediaAvailability: availability
  };
}

function getAuthExpiry(auth: TwitchAuthData): number {
  return auth.obtainedAt + auth.expiresIn * 1000;
}

function getAuthRemainingMs(auth: TwitchAuthData): number {
  return Math.max(0, getAuthExpiry(auth) - Date.now());
}

async function migrateLegacyAuthStorage(): Promise<void> {
  const existing = await loadFromStorage(TWITCH_AUTH_STORAGE_KEY, null as TwitchAuthData | null);
  if (existing) {
    return;
  }

  for (const legacyKey of TWITCH_LEGACY_AUTH_STORAGE_KEYS) {
    const legacy = await loadFromStorage(legacyKey, null as any);
    if (!legacy) {
      continue;
    }

    try {
      const clientId = TWITCH_CLIENT_ID;
      if (!clientId || typeof legacy !== 'object' || !('accessToken' in legacy)) {
        continue;
      }

      const obtainedAt = Date.now();
      const expiresAt = typeof (legacy as any).expiresAt === 'number' ? (legacy as any).expiresAt : obtainedAt;
      const expiresIn = Math.max(0, Math.round((expiresAt - obtainedAt) / 1000));
      const userId: string | undefined =
        typeof (legacy as any).broadcasterId === 'string'
          ? (legacy as any).broadcasterId
          : typeof (legacy as any).userId === 'string'
          ? (legacy as any).userId
          : undefined;

      if (!userId) {
        continue;
      }

      const migrated: TwitchAuthData = {
        accessToken: String((legacy as any).accessToken ?? ''),
        tokenType: 'bearer',
        scopes: Array.isArray((legacy as any).scopes) ? (legacy as any).scopes : [],
        clientId,
        userId,
        displayName: typeof (legacy as any).displayName === 'string' ? (legacy as any).displayName : '',
        obtainedAt,
        expiresIn
      };

      if (!migrated.accessToken) {
        continue;
      }

      await saveToStorage(TWITCH_AUTH_STORAGE_KEY, migrated);
      return;
    } finally {
      await removeFromStorage(legacyKey);
    }
  }
}

async function init(): Promise<void> {
  await migrateLegacyAuthStorage();
  const storedState = await loadFromStorage(POPUP_STATE_STORAGE_KEY, createDefaultPopupState());
  const defaults = createDefaultPopupState();
  cachedState = {
    ...defaults,
    ...storedState,
    testEvents: { ...defaults.testEvents, ...(storedState.testEvents ?? {}) }
  };
  cachedState = sanitizePopupState(cachedState);
  channelRewards = await loadFromStorage(CHANNEL_REWARDS_STORAGE_KEY, [] as ChannelPointRewardSummary[]);
  if (channelRewards.length && cachedState.channelPointRewards.length === 0) {
    cachedState = { ...cachedState, channelPointRewards: channelRewards };
  }
  eventLog = await loadFromStorage(EVENT_LOG_STORAGE_KEY, [] as EventLogEntry[]);
  const effectState = await loadFromStorage(
    EFFECT_STORAGE_KEY,
    { semitoneOffset: 0, speedPercent: 0 } as { semitoneOffset: number; speedPercent: number }
  );
  effectAdjustments = effectState ?? { semitoneOffset: 0, speedPercent: 0 };
  cachedState = {
    ...cachedState,
    effectSemitoneOffset: effectAdjustments.semitoneOffset ?? 0,
    effectSpeedPercent: effectAdjustments.speedPercent ?? 0
  };
  twitchAuth = await loadFromStorage(TWITCH_AUTH_STORAGE_KEY, null);
  await syncStateWithAuth({ persist: false, broadcast: false });

  if (twitchAuth) {
    try {
      await ensureValidatedAuth();
      await refreshStoredProfile();
      await startEventSub();
    } catch (error) {
      console.warn('[background] Failed to resume Twitch session', error);
      await handleAuthFailure(error);
    }
  }
}

void init();

function performStateBroadcast(): void {
  const serialized = JSON.stringify(cachedState);
  if (lastBroadcastStateSerialized === serialized) {
    return;
  }
  lastBroadcastStateSerialized = serialized;
  lastBroadcastAt = Date.now();
  try {
    chrome.runtime.sendMessage({ type: 'BACKGROUND_STATE', state: cachedState }, () => {
      void chrome.runtime.lastError;
    });
  } catch (error) {
    console.debug('[background] Failed to broadcast state', error);
  }
}

function broadcastState(): void {
  const serialized = JSON.stringify(cachedState);
  if (lastBroadcastStateSerialized === serialized && !pendingBroadcastTimer) {
    return;
  }

  const now = Date.now();
  const elapsed = now - lastBroadcastAt;
  if (elapsed >= STATE_BROADCAST_MIN_INTERVAL_MS) {
    if (pendingBroadcastTimer) {
      clearTimeout(pendingBroadcastTimer);
      pendingBroadcastTimer = null;
    }
    performStateBroadcast();
    return;
  }

  if (pendingBroadcastTimer) {
    return;
  }

  const delay = Math.max(0, STATE_BROADCAST_MIN_INTERVAL_MS - elapsed);
  pendingBroadcastTimer = setTimeout(() => {
    pendingBroadcastTimer = null;
    performStateBroadcast();
  }, delay);
}

function pushDiagnostics(): void {
  try {
    chrome.runtime.sendMessage({ type: 'BACKGROUND_DIAGNOSTICS', diagnostics }, () => {
      void chrome.runtime.lastError;
    });
  } catch (error) {
    console.debug('[background] Failed to push diagnostics', error);
  }
}

async function persistCachedState(): Promise<void> {
  await saveToStorage(POPUP_STATE_STORAGE_KEY, cachedState);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (typeof left !== typeof right) {
    return false;
  }
  if (left === null || right === null) {
    return false;
  }
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    for (let index = 0; index < left.length; index += 1) {
      if (!valuesEqual(left[index], right[index])) {
        return false;
      }
    }
    return true;
  }
  if (typeof left === 'object') {
    const leftKeys = Object.keys(left as Record<string, unknown>);
    const rightKeys = Object.keys(right as Record<string, unknown>);
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }
    for (const key of leftKeys) {
      if (!valuesEqual((left as any)[key], (right as any)[key])) {
        return false;
      }
    }
    return true;
  }
  return false;
}

async function updateCachedState(
  partial: Partial<PopupPersistentState>,
  options: { persist?: boolean; broadcast?: boolean } = {}
): Promise<void> {
  const { persist = true, broadcast = true } = options;
  if (!partial || Object.keys(partial).length === 0) {
    return;
  }

  let changed = false;
  const next: PopupPersistentState = { ...cachedState };
  for (const [key, value] of Object.entries(partial) as [keyof PopupPersistentState, unknown][]) {
    if (!(key in next)) {
      continue;
    }
    if (typeof value === 'undefined') {
      continue;
    }
    let candidate: unknown = value;
    if (key === 'bindings') {
      candidate = sanitizeBindings(value as BindingDefinition[] | undefined | null);
    } else if (key === 'channelPointRewards') {
      candidate = Array.isArray(value) ? value : [];
    }
    if (!valuesEqual(next[key], candidate)) {
      next[key] = candidate as any;
      changed = true;
    }
  }

  if (!changed) {
    return;
  }

  cachedState = next;
  if (persist) {
    await persistCachedState();
  }
  if (broadcast) {
    broadcastState();
  }
}

async function syncStateWithAuth(
  options: { persist?: boolean; broadcast?: boolean; retainDisplayName?: boolean } = {}
): Promise<void> {
  const { persist = true, broadcast = true, retainDisplayName = false } = options;
  const loggedIn = twitchAuth !== null;
  const displayName = loggedIn
    ? twitchAuth?.displayName ?? null
    : retainDisplayName
    ? cachedState.twitchDisplayName
    : null;
  await updateCachedState(
    {
      loggedIn,
      twitchDisplayName: displayName
    },
    { persist, broadcast }
  );
}

function updateDiagnostics(partial: Partial<TwitchDiagnosticsSnapshot>): void {
  diagnostics = { ...diagnostics, ...partial };
  pushDiagnostics();
}

function isAuthUsable(auth: TwitchAuthData): boolean {
  return getAuthRemainingMs(auth) > AUTH_EXPIRY_PADDING_MS;
}

async function setAuthData(
  next: TwitchAuthData | null,
  options: { broadcast?: boolean; retainDisplayName?: boolean } = {}
): Promise<void> {
  const { broadcast = true, retainDisplayName = false } = options;
  twitchAuth = next;
  if (next) {
    await saveToStorage(TWITCH_AUTH_STORAGE_KEY, next);
  } else {
    await removeFromStorage(TWITCH_AUTH_STORAGE_KEY);
  }
  await syncStateWithAuth({ broadcast, retainDisplayName });
}
async function refreshStoredProfile(): Promise<void> {
  if (!twitchAuth) return;
  const response = await helixFetch('/users');
  if (!response.ok) {
    throw new Error(`Failed to refresh Twitch profile (${response.status})`);
  }
  const body = (await response.json()) as { data?: Array<{ id: string; display_name: string }> };
  const profile = body.data?.[0];
  if (!profile) {
    throw new Error('Missing Twitch user profile data');
  }

  const updates: Partial<TwitchAuthData> = {};
  if (profile.display_name && profile.display_name !== twitchAuth.displayName) {
    updates.displayName = profile.display_name;
  }
  if (profile.id && profile.id !== twitchAuth.userId) {
    updates.userId = profile.id;
  }

  if (Object.keys(updates).length > 0) {
    await setAuthData({ ...twitchAuth, ...updates });
  } else {
    await syncStateWithAuth();
  }
}

async function handleExpiredToken(
  message = 'Token expired',
  options: { retainDisplayName?: boolean; preserveDiagnostics?: boolean } = {}
): Promise<void> {
  const { retainDisplayName = true, preserveDiagnostics = false } = options;
  const diagnosticsUpdate: Partial<TwitchDiagnosticsSnapshot> = {
    websocketConnected: false,
    sessionId: null,
    subscriptions: 0,
    tokenType: null,
    tokenClientId: null,
    tokenExpiresIn: null
  };
  if (!preserveDiagnostics) {
    diagnosticsUpdate.lastError = message;
  }
  updateDiagnostics(diagnosticsUpdate);
  subscriptionRetryBlocked = true;
  clearChannelRewardTimer();
  channelRewardLastFetchedAt = 0;
  channelRewardFetchInFlight = false;
  channelRewards = [];
  await chrome.storage.local.set({
    [CHANNEL_REWARDS_STORAGE_KEY]: [],
    [CHANNEL_REWARDS_UPDATED_AT_KEY]: Date.now()
  });
  await clearAllScheduledEffects('skipped');
  effectAdjustments = { semitoneOffset: 0, speedPercent: 0 };
  await chrome.storage.local.set({ [EFFECT_STORAGE_KEY]: effectAdjustments });
  await updateCachedState({ effectSemitoneOffset: 0, effectSpeedPercent: 0 });
  if (cachedState.channelPointRewards?.length) {
    await updateCachedState({ channelPointRewards: [] });
  }
  await setAuthData(null, { broadcast: true, retainDisplayName });
  cleanupEventSub();
}

async function handleAuthFailure(reason: unknown): Promise<void> {
  console.warn('[background] Twitch authentication failure', reason);
  if (reason instanceof TokenValidationError || reason instanceof MissingScopesError) {
    return;
  }
  const message = typeof reason === 'string' ? reason : 'Authentication required';
  await handleExpiredToken(message);
}

async function performOAuthFlow(): Promise<TwitchAuthData> {
  ensureClientId();
  const redirectUri = chrome.identity.getRedirectURL(TWITCH_REDIRECT_PATH);
  const state = generateState();
  const authUrl = new URL('https://id.twitch.tv/oauth2/authorize');
  authUrl.searchParams.set('client_id', TWITCH_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'token');
  authUrl.searchParams.set('scope', TWITCH_REQUIRED_SCOPES.join(' '));
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('force_verify', 'true');

  const redirectUrl = await new Promise<string>((resolve, reject) => {
    try {
      chrome.identity.launchWebAuthFlow({ url: authUrl.toString(), interactive: true }, (responseUrl) => {
        if (chrome.runtime.lastError) {
          reject(new AuthCancelledError(chrome.runtime.lastError.message));
          return;
        }
        if (!responseUrl) {
          reject(new AuthCancelledError());
          return;
        }
        resolve(responseUrl);
      });
    } catch (error) {
      reject(error);
    }
  });

  const parsed = new URL(redirectUrl);
  const fragment = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash;
  const params = new URLSearchParams(fragment);
  const returnedState = params.get('state');
  const accessToken = params.get('access_token');
  const scopeFragment = params.get('scope')?.split(' ').filter(Boolean) ?? [];

  if (!accessToken) {
    throw new Error('Missing access token from Twitch redirect');
  }
  if (returnedState !== state) {
    throw new Error('OAuth state mismatch');
  }

  const validation = await validateAccessToken(accessToken);
  if (validation.client_id && TWITCH_CLIENT_ID && validation.client_id !== TWITCH_CLIENT_ID) {
    throw new Error('Token was issued for a different client');
  }

  const grantedScopes = validation.scopes?.length ? validation.scopes : scopeFragment;
  const missingScopes = scopesMissing(TWITCH_REQUIRED_SCOPES, grantedScopes);
  if (missingScopes.length > 0) {
    throw new MissingScopesError(missingScopes);
  }

  if (!validation.user_id) {
    throw new Error('Missing user identifier from validation');
  }

  const profile = await fetchProfileWithToken(accessToken);
  const obtainedAt = Date.now();

  return {
    accessToken,
    tokenType: 'bearer',
    scopes: grantedScopes,
    clientId: validation.client_id,
    userId: validation.user_id,
    displayName: profile.display_name,
    obtainedAt,
    expiresIn: validation.expires_in
  };
}

async function fetchProfileWithToken(token: string): Promise<{ id: string; display_name: string }> {
  ensureClientId();
  const response = await fetch(`${TWITCH_HELIX_BASE}/users`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Client-Id': TWITCH_CLIENT_ID
    }
  });
  if (!response.ok) {
    if (response.status === 401) {
      throw new AuthCancelledError('Authorization rejected');
    }
    throw new Error(`Failed to fetch Twitch profile (${response.status})`);
  }
  const body = (await response.json()) as { data?: Array<{ id: string; display_name: string }> };
  const profile = body.data?.[0];
  if (!profile) {
    throw new Error('Twitch profile payload missing');
  }
  return profile;
}

function ensureClientId(): void {
  if (!TWITCH_CLIENT_ID) {
    throw new MissingClientIdError();
  }
}

function generateState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sanitizeForDiagnostics(input: unknown): unknown {
  if (!input || typeof input !== 'object') {
    return input;
  }
  if (Array.isArray(input)) {
    return input.map((value) => sanitizeForDiagnostics(value));
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (key.toLowerCase().includes('token')) {
      continue;
    }
    result[key] = sanitizeForDiagnostics(value);
  }
  return result;
}

async function validateAccessToken(token: string): Promise<OAuthValidateResponse> {
  const response = await fetch(`${TWITCH_AUTH_BASE}/validate`, {
    headers: {
      Authorization: `OAuth ${token}`
    }
  });

  if (!response.ok) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch (error) {
      try {
        body = await response.text();
      } catch {
        body = null;
      }
    }
    throw new TokenValidationError(response.status, sanitizeForDiagnostics(body));
  }

  return (await response.json()) as OAuthValidateResponse;
}

async function ensureValidatedAuth(): Promise<TwitchAuthData> {
  if (!twitchAuth) {
    throw new Error('Not authenticated with Twitch');
  }

  if (!isAuthUsable(twitchAuth)) {
    await handleExpiredToken('Token expired');
    throw new Error('Token expired');
  }

  try {
    const validation = await validateAccessToken(twitchAuth.accessToken);
    const grantedScopes = validation.scopes?.length ? validation.scopes : twitchAuth.scopes;
    const missing = scopesMissing(TWITCH_REQUIRED_SCOPES, grantedScopes);
    if (missing.length > 0) {
      throw new MissingScopesError(missing);
    }

    const next: TwitchAuthData = {
      ...twitchAuth,
      tokenType: 'bearer',
      scopes: grantedScopes,
      clientId: validation.client_id,
      userId: validation.user_id,
      obtainedAt: Date.now(),
      expiresIn: validation.expires_in
    };

    await setAuthData(next, { broadcast: true });
    updateDiagnostics({
      tokenType: 'user',
      tokenClientId: validation.client_id,
      tokenExpiresIn: validation.expires_in,
      lastError: null
    });
    return next;
  } catch (error) {
    if (error instanceof TokenValidationError) {
      updateDiagnostics({
        lastError: JSON.stringify({ status: error.status, body: error.body }),
        tokenType: null,
        tokenClientId: null,
        tokenExpiresIn: null,
        websocketConnected: false,
        sessionId: null,
        subscriptions: 0
      });
      subscriptionRetryBlocked = true;
      await setAuthData(null, { broadcast: true, retainDisplayName: true });
      cleanupEventSub();
      throw error;
    }
    if (error instanceof MissingScopesError) {
      updateDiagnostics({
        lastError: `Missing scopes: ${error.missing.join(', ')}`,
        tokenType: null,
        tokenClientId: null,
        tokenExpiresIn: null
      });
      subscriptionRetryBlocked = true;
      await setAuthData(null, { broadcast: true, retainDisplayName: true });
      cleanupEventSub();
      throw error;
    }
    throw error;
  }
}

async function helixFetch(path: string, init: RequestInit = {}, attempt = 0): Promise<Response> {
  const auth = await ensureValidatedAuth();
  const headers = new Headers(init.headers ?? {});
  headers.set('Authorization', `Bearer ${auth.accessToken}`);
  headers.set('Client-Id', auth.clientId);
  if (init.method === 'POST' || init.method === 'PATCH') {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${TWITCH_HELIX_BASE}${path}`, { ...init, headers });
  if (response.status === 401) {
    await handleExpiredToken('Unauthorized');
    return response;
  }
  if (response.status === 429 && attempt < 3) {
    const reset = response.headers.get('Ratelimit-Reset');
    const now = Date.now();
    let delay = Math.pow(2, attempt) * 1000;
    if (reset) {
      const resetEpoch = Number.parseInt(reset, 10) * 1000;
      if (!Number.isNaN(resetEpoch)) {
        delay = Math.max(resetEpoch - now, delay);
      }
    }
    await wait(delay);
    return helixFetch(path, init, attempt + 1);
  }
  return response;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractDisplayName(payload: any): string {
  return (
    payload?.user_name ||
    payload?.user_display_name ||
    payload?.user_login ||
    payload?.from_broadcaster_user_name ||
    payload?.login ||
    payload?.username ||
    ''
  );
}

function normalizeEvent(
  bindingType: BindingEventType,
  payload: unknown,
  subscriptionType: string
): NormalizedEvent | null {
  const data = payload as any;
  switch (bindingType) {
    case 'channel_points': {
      const reward = data?.reward;
      const rewardId: string | null = reward?.id ?? data?.id ?? null;
      if (!rewardId) {
        return null;
      }
      return {
        type: 'channel_points',
        rewardId,
        rewardTitle: reward?.title ?? reward?.prompt ?? data?.reward_title ?? rewardId,
        rewardCost: typeof reward?.cost === 'number' ? reward.cost : null,
        userDisplay: extractDisplayName(data)
      };
    }
    case 'bits': {
      const amount = Number.parseInt(String(data?.bits ?? data?.amount ?? '0'), 10);
      if (!Number.isFinite(amount) || amount <= 0) {
        return null;
      }
      return { type: 'cheer', amount, userDisplay: extractDisplayName(data) };
    }
    case 'gift_sub':
    case 'sub': {
      const tier: string = data?.tier ?? data?.sub_tier ?? '1000';
      const normalizedTier = tier === '2000' || tier === '3000' ? tier : '1000';
      const isGift = Boolean(data?.is_gift || subscriptionType === 'channel.subscription.gift');
      let giftAmount: number | null = null;
      if (subscriptionType === 'channel.subscription.gift') {
        const total = Number.parseInt(String(data?.total ?? data?.cumulative_total ?? 0), 10);
        giftAmount = Number.isFinite(total) && total > 0 ? total : 1;
      } else if (isGift) {
        giftAmount = 1;
      }
      return {
        type: 'sub',
        tier: normalizedTier as '1000' | '2000' | '3000',
        isGift,
        giftAmount,
        userDisplay: extractDisplayName(data)
      };
    }
    case 'follow': {
      return { type: 'follow', userDisplay: extractDisplayName(data) };
    }
    default:
      return null;
  }
}

function rangeMatches(range: RangeConfig, value: number): boolean {
  if (range.mode === 'exact') {
    const exact = range.exact;
    return typeof exact === 'number' && exact === value;
  }
  const minOk = typeof range.min === 'number' ? value >= range.min : true;
  const maxOk = typeof range.max === 'number' ? value <= range.max : true;
  return minOk && maxOk;
}

function matchBindings(
  normalized: NormalizedEvent,
  bindingType: BindingEventType
): Array<{ binding: BindingDefinition; operations: EffectOperation[] }> {
  const matches: Array<{ binding: BindingDefinition; operations: EffectOperation[] }> = [];
  for (const binding of cachedState.bindings) {
    if (!binding.enabled || binding.eventType !== bindingType) {
      continue;
    }
    let matched = false;
    switch (bindingType) {
      case 'channel_points': {
        if (
          normalized.type === 'channel_points' &&
          binding.config.type === 'channel_points' &&
          binding.config.rewardId &&
          normalized.rewardId === binding.config.rewardId
        ) {
          matched = true;
        }
        break;
      }
      case 'bits': {
        if (normalized.type === 'cheer' && binding.config.type === 'bits') {
          matched = rangeMatches(binding.config.range, normalized.amount);
        }
        break;
      }
      case 'gift_sub': {
        if (normalized.type === 'sub' && binding.config.type === 'gift_sub' && normalized.isGift) {
          const giftCount = normalized.giftAmount ?? 1;
          matched = rangeMatches(binding.config.range, giftCount);
        }
        break;
      }
      case 'sub': {
        if (normalized.type === 'sub' && binding.config.type === 'sub' && !normalized.isGift) {
          const tiers = binding.config.tiers ?? [];
          matched = tiers.length === 0 || tiers.includes(mapTierToSubTier(normalized.tier));
        }
        break;
      }
      case 'follow': {
        if (normalized.type === 'follow' && binding.config.type === 'follow') {
          matched = true;
        }
        break;
      }
      default:
        matched = false;
    }
    if (!matched) {
      continue;
    }
    const operations: EffectOperation[] = [];
    if (binding.action.type === 'pitch') {
      operations.push({ kind: 'pitch', op: 'add', semitones: binding.action.amount });
    } else if (binding.action.type === 'speed') {
      operations.push({ kind: 'speed', op: 'add', percent: binding.action.amount });
    }
    if (binding.chatTemplate.trim()) {
      operations.push({ kind: 'chat', template: binding.chatTemplate });
    }
    if (operations.length > 0) {
      matches.push({ binding, operations });
    }
  }
  return matches;
}

function mapTierToSubTier(tier: '1000' | '2000' | '3000'): SubTier {
  switch (tier) {
    case '2000':
      return 'tier2';
    case '3000':
      return 'tier3';
    default:
      return 'tier1';
  }
}

function mapSubTierToTier(tier: SubTier): '1000' | '2000' | '3000' {
  switch (tier) {
    case 'tier2':
      return '2000';
    case 'tier3':
      return '3000';
    default:
      return '1000';
  }
}

function mapEventType(normalized: NormalizedEvent, bindingType: BindingEventType): EventLogEntry['eventType'] {
  if (bindingType === 'gift_sub' || (normalized.type === 'sub' && normalized.isGift)) {
    return 'gift_sub';
  }
  switch (bindingType) {
    case 'channel_points':
      return 'channel_points';
    case 'bits':
      return 'cheer';
    case 'sub':
      return 'sub';
    case 'follow':
      return 'follow';
    default:
      return 'follow';
  }
}

function createEventLogEntryForEffect(
  event: NormalizedEvent,
  binding: BindingDefinition,
  bindingType: BindingEventType,
  operations: EffectOperation[],
  source: RoutedEventSource,
  delaySeconds: number | null,
  durationSeconds: number | null
): EventLogEntry {
  const id = crypto.randomUUID();
  const entry: EventLogEntry = {
    id,
    ts: Date.now(),
    source: source === 'test' ? 'test' : 'real',
    eventType: mapEventType(event, bindingType),
    userDisplay: event.userDisplay ?? undefined,
    reward:
      event.type === 'channel_points'
        ? { id: event.rewardId, title: event.rewardTitle ?? event.rewardId, cost: event.rewardCost }
        : undefined,
    bitsAmount: event.type === 'cheer' ? event.amount : undefined,
    subTier: event.type === 'sub' ? event.tier : undefined,
    giftAmount: event.type === 'sub' && event.isGift ? event.giftAmount ?? 1 : undefined,
    matchedBindings: [{ id: binding.id, label: binding.label }],
    actions: operations.map((operation) => ({ ...operation } as EventLogAction)),
    delaySec: delaySeconds ?? undefined,
    durationSec: durationSeconds ?? undefined,
    status: 'queued'
  };
  appendEventLogEntry(entry);
  return entry;
}

function logSkippedEvent(
  event: NormalizedEvent,
  bindingType: BindingEventType,
  source: RoutedEventSource,
  note: string
): void {
  appendEventLogEntry({
    id: crypto.randomUUID(),
    ts: Date.now(),
    source: source === 'test' ? 'test' : 'real',
    eventType: mapEventType(event, bindingType),
    userDisplay: event.userDisplay ?? undefined,
    reward:
      event.type === 'channel_points'
        ? { id: event.rewardId, title: event.rewardTitle ?? event.rewardId, cost: event.rewardCost }
        : undefined,
    bitsAmount: event.type === 'cheer' ? event.amount : undefined,
    subTier: event.type === 'sub' ? event.tier : undefined,
    giftAmount: event.type === 'sub' && event.isGift ? event.giftAmount ?? 1 : undefined,
    matchedBindings: [],
    actions: [],
    status: 'skipped',
    note
  });
}

async function updateEffectAdjustmentsFromStorageValue(value: unknown): Promise<void> {
  const data = (value as { semitoneOffset?: number; speedPercent?: number }) ?? {};
  const semitone = Number.isFinite(data.semitoneOffset) ? Number(data.semitoneOffset) : 0;
  const speed = Number.isFinite(data.speedPercent) ? Number(data.speedPercent) : 0;
  effectAdjustments = { semitoneOffset: semitone, speedPercent: speed };
  await updateCachedState(
    { effectSemitoneOffset: semitone, effectSpeedPercent: speed },
    { persist: true, broadcast: true }
  );
}

async function pushEffectAdjustmentsFromActive(): Promise<void> {
  let semitone = 0;
  let speed = 0;
  for (const effect of activeEffects.values()) {
    if (!effect.applied) {
      continue;
    }
    for (const op of effect.operations) {
      if (op.kind === 'pitch') {
        semitone += op.semitones;
      } else if (op.kind === 'speed') {
        speed += op.percent;
      }
    }
  }
  if (
    effectAdjustments.semitoneOffset === semitone &&
    effectAdjustments.speedPercent === speed
  ) {
    return;
  }
  effectAdjustments = { semitoneOffset: semitone, speedPercent: speed };
  await chrome.storage.local.set({
    [EFFECT_STORAGE_KEY]: effectAdjustments
  });
  await updateCachedState(
    { effectSemitoneOffset: semitone, effectSpeedPercent: speed },
    { persist: true, broadcast: true }
  );
}

async function sendChatMessage(
  template: string,
  event: NormalizedEvent
): Promise<{ messageId?: string; error?: string }> {
  try {
    const auth = await ensureValidatedAuth();
    const message = template.replace(/%user%/gi, () => event.userDisplay ?? '');
    if (!message.trim()) {
      return { error: 'empty_message' };
    }
    const response = await helixFetch('/chat/messages', {
      method: 'POST',
      body: JSON.stringify({
        broadcaster_id: auth.userId,
        sender_id: auth.userId,
        message
      })
    });
    if (!response.ok) {
      let body: unknown = null;
      try {
        body = await response.json();
      } catch (error) {
        try {
          body = await response.text();
        } catch {
          body = null;
        }
      }
      const sanitized = sanitizeForDiagnostics(body);
      return { error: JSON.stringify({ status: response.status, body: sanitized }) };
    }
    const parsed = (await response.json()) as { data?: Array<{ message_id?: string; id?: string }> };
    const record = parsed.data?.[0];
    const messageId = record?.message_id ?? record?.id ?? undefined;
    return { messageId };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

async function sendEffectMessage(message: BackgroundToContentMessage, targetTabId?: number): Promise<void> {
  try {
    const tabId = typeof targetTabId === 'number' ? targetTabId : activeContentTabId;
    if (typeof tabId !== 'number') {
      return;
    }
    await new Promise<void>((resolve) => {
      chrome.tabs.sendMessage(tabId, message, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    });
  } catch (error) {
    console.warn('[background] Failed to send effect message', error);
  }
}

async function rehydrateActiveEffectsForTab(tabId: number): Promise<void> {
  for (const effect of activeEffects.values()) {
    if (!effect.applied) {
      continue;
    }
    const pitchOp = effect.operations.find((operation) => operation.kind === 'pitch') as
      | Extract<EffectOperation, { kind: 'pitch' }>
      | undefined;
    const speedOp = effect.operations.find((operation) => operation.kind === 'speed') as
      | Extract<EffectOperation, { kind: 'speed' }>
      | undefined;
    await sendEffectMessage(
      {
        type: 'AUDIO_EFFECT_APPLY',
        payload: {
          effectId: effect.id,
          pitch: pitchOp ? { op: pitchOp.op, semitones: pitchOp.semitones } : null,
          speed: speedOp ? { op: speedOp.op, percent: speedOp.percent } : null,
          delayMs: effect.delayMs,
          durationMs: effect.durationMs,
          source: effect.eventSource === 'test' ? 'test' : 'event'
        }
      },
      tabId
    );
  }
  await sendEffectMessage(
    {
      type: 'AUDIO_EFFECTS_UPDATE',
      payload: {
        semitoneOffset: effectAdjustments.semitoneOffset,
        speedPercent: effectAdjustments.speedPercent
      }
    },
    tabId
  );
}

async function applyScheduledEffect(effectId: string): Promise<void> {
  const effect = activeEffects.get(effectId);
  if (!effect || effect.applied) {
    return;
  }
  if (effect.applyTimer) {
    clearTimeout(effect.applyTimer);
    effect.applyTimer = null;
  }
  const pitchOp = effect.operations.find((op) => op.kind === 'pitch') as
    | Extract<EffectOperation, { kind: 'pitch' }>
    | undefined;
  const speedOp = effect.operations.find((op) => op.kind === 'speed') as
    | Extract<EffectOperation, { kind: 'speed' }>
    | undefined;
  await sendEffectMessage({
    type: 'AUDIO_EFFECT_APPLY',
    payload: {
      effectId: effect.id,
      pitch: pitchOp ? { op: pitchOp.op, semitones: pitchOp.semitones } : null,
      speed: speedOp ? { op: speedOp.op, percent: speedOp.percent } : null,
      delayMs: effect.delayMs,
      durationMs: effect.durationMs,
      source: effect.eventSource === 'test' ? 'test' : 'event'
    }
  });
  effect.applied = true;
  updateEventLogEntry(effect.eventLogId ?? '', { status: 'applied' });
  await pushEffectAdjustmentsFromActive();
  if (effect.durationMs !== null) {
    effect.revertTimer = setTimeout(() => {
      void revertScheduledEffect(effect.id);
    }, effect.durationMs);
  }
}

async function revertScheduledEffect(effectId: string, status: EventLogStatus = 'reverted'): Promise<void> {
  const effect = activeEffects.get(effectId);
  if (!effect) {
    return;
  }
  if (effect.applyTimer) {
    clearTimeout(effect.applyTimer);
    effect.applyTimer = null;
  }
  if (effect.revertTimer) {
    clearTimeout(effect.revertTimer);
    effect.revertTimer = null;
  }
  if (effect.applied) {
    await sendEffectMessage({ type: 'AUDIO_EFFECT_REVERT', payload: { effectId } });
  }
  activeEffects.delete(effectId);
  if (effect.eventLogId) {
    updateEventLogEntry(effect.eventLogId, { status });
  }
  await pushEffectAdjustmentsFromActive();
}

async function handleChatOperations(effect: ScheduledEffect): Promise<void> {
  for (const op of effect.operations) {
    if (op.kind !== 'chat') {
      continue;
    }
    const result = await sendChatMessage(op.template, effect.event);
    if (effect.eventLogId) {
      updateEventLogEntry(
        effect.eventLogId,
        {},
        (actions) =>
          actions.map((action) => {
            if (action.kind !== 'chat' || action.template !== op.template) {
              return action;
            }
            return {
              ...action,
              sent: !result.error,
              messageId: result.messageId,
              error: result.error
            };
          })
      );
    }
  }
}

async function queueEffect(
  binding: BindingDefinition,
  normalized: NormalizedEvent,
  bindingType: BindingEventType,
  operations: EffectOperation[],
  source: RoutedEventSource
): Promise<void> {
  const delaySeconds = binding.delaySeconds ?? null;
  const durationSeconds = binding.durationSeconds ?? null;
  const entry = createEventLogEntryForEffect(
    normalized,
    binding,
    bindingType,
    operations,
    source,
    delaySeconds,
    durationSeconds
  );
  const effect: ScheduledEffect = {
    id: crypto.randomUUID(),
    bindingId: binding.id,
    bindingLabel: binding.label,
    operations,
    delayMs: Math.max(0, (delaySeconds ?? 0) * 1000),
    durationMs: durationSeconds != null ? Math.max(0, durationSeconds * 1000) : null,
    event: normalized,
    eventSource: source,
    eventLogId: entry.id,
    applyTimer: null,
    revertTimer: null,
    applied: false
  };
  activeEffects.set(effect.id, effect);
  if (operations.some((operation) => operation.kind === 'chat')) {
    void handleChatOperations(effect);
  }
  if (effect.delayMs > 0) {
    effect.applyTimer = setTimeout(() => {
      void applyScheduledEffect(effect.id);
    }, effect.delayMs);
  } else {
    queueMicrotask(() => {
      void applyScheduledEffect(effect.id);
    });
  }
}

async function clearAllScheduledEffects(status: EventLogStatus = 'skipped'): Promise<void> {
  const ids = Array.from(activeEffects.keys());
  for (const id of ids) {
    await revertScheduledEffect(id, status);
  }
}

function scheduleEventLogPersist(): void {
  if (eventLogWriteTimer) {
    return;
  }
  eventLogWriteTimer = setTimeout(() => {
    eventLogWriteTimer = null;
    void persistEventLogNow();
  }, EVENT_LOG_WRITE_THROTTLE_MS);
}

function pruneProcessedMessageIds(): void {
  const cutoff = Date.now() - MESSAGE_ID_TTL_MS;
  for (const [messageId, seenAt] of processedMessageIds.entries()) {
    if (seenAt < cutoff) {
      processedMessageIds.delete(messageId);
    }
  }
}

function hasSeenMessage(messageId: string): boolean {
  pruneProcessedMessageIds();
  return processedMessageIds.has(messageId);
}

function markMessageSeen(messageId: string): void {
  processedMessageIds.set(messageId, Date.now());
  pruneProcessedMessageIds();
}

async function persistEventLogNow(): Promise<void> {
  const serialized = JSON.stringify(eventLog);
  if (serialized === lastEventLogSerialized) {
    return;
  }
  lastEventLogSerialized = serialized;
  await chrome.storage.local.set({
    [EVENT_LOG_STORAGE_KEY]: eventLog,
    [EVENT_LOG_UPDATED_AT_KEY]: Date.now()
  });
}

function appendEventLogEntry(entry: EventLogEntry): EventLogEntry {
  eventLog = [entry, ...eventLog].slice(0, EVENT_LOG_LIMIT);
  scheduleEventLogPersist();
  return entry;
}

function updateEventLogEntry(
  id: string,
  updates: Partial<EventLogEntry>,
  actionUpdater?: (actions: EventLogAction[]) => EventLogAction[]
): void {
  let changed = false;
  eventLog = eventLog.map((entry) => {
    if (entry.id !== id) {
      return entry;
    }
    const nextActions = actionUpdater ? actionUpdater(entry.actions) : entry.actions;
    const nextEntry: EventLogEntry = {
      ...entry,
      ...updates,
      actions: nextActions
    };
    if (!valuesEqual(entry, nextEntry)) {
      changed = true;
      return nextEntry;
    }
    return entry;
  });
  if (changed) {
    scheduleEventLogPersist();
  }
}
async function startEventSub(): Promise<void> {
  if (!twitchAuth) {
    throw new Error('Not authenticated with Twitch');
  }

  await ensureValidatedAuth();
  subscriptionRetryBlocked = false;
  reconnectBackoffMs = INITIAL_BACKOFF_MS;
  prepareForNewConnection();
  connectEventSub();
  scheduleChannelRewardRefresh(0);
}

function connectEventSub(url?: string): void {
  if (!twitchAuth || !isAuthUsable(twitchAuth) || subscriptionRetryBlocked) {
    return;
  }
  if (eventSubConnectionState === 'connecting' || eventSubConnectionState === 'ready') {
    return;
  }

  prepareForNewConnection();

  const target = url ?? TWITCH_EVENTSUB_WS;
  eventSubConnectionState = 'connecting';
  updateDiagnostics({ websocketConnected: false, sessionId: null });

  try {
    const socket = new WebSocket(target);
    eventSubSocket = socket;

    socket.addEventListener('open', () => {
      updateDiagnostics({ websocketConnected: true, lastError: null });
    });

    socket.addEventListener('message', (event) => {
      handleEventSubMessage(String(event.data ?? ''));
    });

    socket.addEventListener('close', (event) => {
      console.info('[background] EventSub socket closed', event.code, event.reason);
      if (eventSubSocket === socket) {
        eventSubSocket = null;
      }
      eventSubConnectionState = 'closed';
      prepareForNewConnection();
      updateDiagnostics({ websocketConnected: false, sessionId: null, subscriptions: 0 });
      if (suppressedCloseSocket === socket) {
        suppressedCloseSocket = null;
        return;
      }
      scheduleReconnect('socket-close');
    });

    socket.addEventListener('error', (event) => {
      console.warn('[background] EventSub socket error', event);
      updateDiagnostics({ lastError: 'WebSocket error' });
    });
  } catch (error) {
    console.error('[background] Failed to open EventSub socket', error);
    eventSubConnectionState = 'idle';
    scheduleReconnect('socket-error');
  }
}

function clearKeepaliveTimer(): void {
  if (keepaliveTimer) {
    clearTimeout(keepaliveTimer);
    keepaliveTimer = null;
  }
}

function clearSubscriptionTimers(): void {
  if (ensureSubscriptionsTimer) {
    clearTimeout(ensureSubscriptionsTimer);
    ensureSubscriptionsTimer = null;
  }
  if (subscriptionDeadlineTimer) {
    clearTimeout(subscriptionDeadlineTimer);
    subscriptionDeadlineTimer = null;
  }
}

function clearReconnectTimer(): void {
  if (eventSubReconnectTimer) {
    clearTimeout(eventSubReconnectTimer);
    eventSubReconnectTimer = null;
  }
}

function clearChannelRewardTimer(): void {
  if (channelRewardTimer) {
    clearTimeout(channelRewardTimer);
    channelRewardTimer = null;
  }
}

function closeEventSubSocket(options: { suppressReconnect?: boolean } = {}): void {
  const socket = eventSubSocket;
  if (!socket) {
    return;
  }
  if (options.suppressReconnect) {
    suppressedCloseSocket = socket;
  }
  try {
    socket.close();
  } catch (error) {
    console.warn('[background] Error closing EventSub socket', error);
  }
  eventSubSocket = null;
}

function prepareForNewConnection(): void {
  clearReconnectTimer();
  clearSubscriptionTimers();
  clearKeepaliveTimer();
  closeEventSubSocket({ suppressReconnect: true });
  eventSubSessionId = null;
  subscriptionsReady = false;
  ensureSubscriptionsInFlight = false;
}

function scheduleSubscriptionSync(delayMs = 0): void {
  if (subscriptionRetryBlocked) {
    return;
  }
  if (ensureSubscriptionsTimer) {
    clearTimeout(ensureSubscriptionsTimer);
  }
  ensureSubscriptionsTimer = setTimeout(() => {
    ensureSubscriptionsTimer = null;
    void ensureSubscriptions();
  }, delayMs);

  if (subscriptionDeadlineTimer) {
    clearTimeout(subscriptionDeadlineTimer);
  }
  subscriptionDeadlineTimer = setTimeout(() => {
    subscriptionDeadlineTimer = null;
    if (!subscriptionsReady) {
      updateDiagnostics({ lastError: 'Subscription creation timeout', subscriptions: 0 });
      cleanupEventSub({ resetBackoff: false });
      scheduleReconnect('subscription-timeout');
    }
  }, SUBSCRIPTION_CREATE_WINDOW_MS);
}

function scheduleChannelRewardRefresh(delayMs = CHANNEL_REWARD_REFRESH_INTERVAL_MS): void {
  if (!twitchAuth || !isAuthUsable(twitchAuth)) {
    clearChannelRewardTimer();
    return;
  }
  if (delayMs === 0 && channelRewardLastFetchedAt > 0) {
    const elapsed = Date.now() - channelRewardLastFetchedAt;
    if (elapsed < CHANNEL_REWARD_REFRESH_INTERVAL_MS) {
      delayMs = CHANNEL_REWARD_REFRESH_INTERVAL_MS - elapsed;
    }
  }
  if (channelRewardTimer) {
    clearTimeout(channelRewardTimer);
  }
  channelRewardTimer = setTimeout(() => {
    channelRewardTimer = null;
    void refreshChannelRewards();
  }, Math.max(0, delayMs));
}

async function refreshChannelRewards(): Promise<void> {
  if (!twitchAuth || channelRewardFetchInFlight) {
    return;
  }
  channelRewardFetchInFlight = true;
  try {
    const auth = await ensureValidatedAuth();
    const params = new URLSearchParams({ broadcaster_id: auth.userId });
    const response = await helixFetch(`/channel_points/custom_rewards?${params.toString()}`);
    if (!response.ok) {
      return;
    }
    const body = (await response.json()) as {
      data?: Array<{ id: string; title?: string; prompt?: string }>;
    };
    const rewards: ChannelPointRewardSummary[] = (body.data ?? [])
      .map((reward) => ({
        id: reward.id,
        title: reward.title?.trim() || reward.prompt?.trim() || reward.id,
        cost: typeof (reward as any).cost === 'number' ? (reward as any).cost : null
      }))
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));

    channelRewardLastFetchedAt = Date.now();
    if (!valuesEqual(channelRewards, rewards)) {
      channelRewards = rewards;
      await updateCachedState({ channelPointRewards: rewards });
      await chrome.storage.local.set({
        [CHANNEL_REWARDS_STORAGE_KEY]: rewards,
        [CHANNEL_REWARDS_UPDATED_AT_KEY]: Date.now()
      });
    }
  } catch (error) {
    console.warn('[background] Failed to refresh channel point rewards', error);
  } finally {
    channelRewardFetchInFlight = false;
    scheduleChannelRewardRefresh(CHANNEL_REWARD_REFRESH_INTERVAL_MS);
  }
}

function scheduleReconnect(reason: string): void {
  if (!twitchAuth || !isAuthUsable(twitchAuth) || subscriptionRetryBlocked) {
    return;
  }
  if (eventSubReconnectTimer) {
    return;
  }
  updateDiagnostics({ lastError: reason, websocketConnected: false });
  const delay = reconnectBackoffMs;
  reconnectBackoffMs = Math.min(reconnectBackoffMs * 2, MAX_BACKOFF_MS);
  eventSubConnectionState = 'reconnecting';
  eventSubReconnectTimer = setTimeout(() => {
    eventSubReconnectTimer = null;
    connectEventSub();
  }, delay);
}

function cleanupEventSub(options: { resetBackoff?: boolean } = {}): void {
  const { resetBackoff = true } = options;
  prepareForNewConnection();
  eventSubConnectionState = 'idle';
  if (resetBackoff) {
    reconnectBackoffMs = INITIAL_BACKOFF_MS;
  }
  void clearAllScheduledEffects('skipped');
  updateDiagnostics({ websocketConnected: false, sessionId: null, subscriptions: 0 });
}

function handleEventSubMessage(raw: string): void {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn('[background] Failed to parse EventSub message', error);
    return;
  }
  const type: string | undefined = parsed?.metadata?.message_type;
  switch (type) {
    case 'session_welcome':
      handleSessionWelcome(parsed?.payload);
      break;
    case 'session_keepalive':
      recordKeepalive();
      break;
    case 'notification':
      handleNotification(parsed?.payload, parsed?.metadata);
      break;
    case 'session_reconnect':
      handleSessionReconnect(parsed?.payload);
      break;
    case 'revocation':
      handleRevocation(parsed?.payload);
      break;
    case 'session_close':
      handleSessionClose(parsed?.payload);
      break;
    default:
      console.debug('[background] Unhandled EventSub message type', type);
      break;
  }
}

function handleSessionWelcome(payload: any): void {
  const session = payload?.session;
  eventSubSessionId = session?.id ?? null;
  eventSubConnectionState = 'ready';
  reconnectBackoffMs = INITIAL_BACKOFF_MS;
  keepaliveTimeoutMs = (session?.keepalive_timeout_seconds ?? 10) * 1000;
  subscriptionsReady = false;
  ensureSubscriptionsInFlight = false;
  updateDiagnostics({ sessionId: eventSubSessionId, lastError: null });
  recordKeepalive();
  scheduleSubscriptionSync();
}

function recordKeepalive(): void {
  clearKeepaliveTimer();
  const now = Date.now();
  updateDiagnostics({ lastKeepaliveAt: now });
  if (keepaliveTimeoutMs > 0) {
    keepaliveTimer = setTimeout(() => {
      console.warn('[background] EventSub keepalive timeout');
      updateDiagnostics({ lastError: 'Keepalive timeout', websocketConnected: false, sessionId: null });
      cleanupEventSub();
      scheduleReconnect('keepalive-timeout');
    }, keepaliveTimeoutMs + 5_000);
  }
}

function handleNotification(payload: any, metadata: any): void {
  const subscriptionType: string = payload?.subscription?.type ?? 'unknown';
  const bindingType = mapSubscriptionToBinding(subscriptionType);
  updateDiagnostics({
    lastNotificationAt: Date.now(),
    lastNotificationType: subscriptionType
  });
  if (!bindingType) {
    console.debug('[background] Ignoring unsupported subscription type', subscriptionType);
    return;
  }
  routeEvent({
    source: 'eventsub',
    subscriptionType,
    bindingType,
    receivedAt: Date.now(),
    payload: payload?.event,
    messageId: String(metadata?.message_id ?? crypto.randomUUID())
  });
}

function handleSessionReconnect(payload: any): void {
  const url: string | null = payload?.session?.reconnect_url ?? null;
  console.info('[background] EventSub requested reconnect', url);
  cleanupEventSub({ resetBackoff: false });
  reconnectBackoffMs = INITIAL_BACKOFF_MS;
  if (url) {
    connectEventSub(url);
  } else {
    scheduleReconnect('session-reconnect');
  }
}

function handleRevocation(payload: any): void {
  const type: string = payload?.subscription?.type ?? 'unknown';
  console.warn('[background] Subscription revoked', type, payload?.status);
  updateDiagnostics({ lastError: `Revoked: ${type}` });
  scheduleSubscriptionSync();
}

function handleSessionClose(payload: any): void {
  const status = payload?.session?.status ?? 'unknown';
  console.warn('[background] EventSub session closed', status);
  updateDiagnostics({ lastError: `Session closed: ${status}`, websocketConnected: false, sessionId: null, subscriptions: 0 });
  cleanupEventSub();
  scheduleReconnect('session-close');
}
async function ensureSubscriptions(): Promise<void> {
  if (!twitchAuth || !eventSubSessionId || subscriptionRetryBlocked || ensureSubscriptionsInFlight) {
    return;
  }

  ensureSubscriptionsInFlight = true;
  try {
    const broadcasterId = twitchAuth.userId;
    const moderatorId = twitchAuth.userId;
    if (!broadcasterId || !moderatorId) {
      subscriptionRetryBlocked = true;
      updateDiagnostics({ lastError: 'Missing follow subscription identifiers', subscriptions: 0 });
      clearSubscriptionTimers();
      clearChannelRewardTimer();
      cleanupEventSub({ resetBackoff: false });
      return;
    }

    const definitions = getRequiredEventSubDefinitions(broadcasterId, moderatorId);
    const existing = await listSubscriptions();
    let active = 0;

    for (const definition of definitions) {
      const match = existing.find((entry) => subscriptionMatchesDefinition(entry, definition, eventSubSessionId));
      if (match && match.status === 'enabled') {
        active += 1;
      } else {
        await createSubscription(definition);
        active += 1;
      }

      const stale = existing.filter(
        (entry) =>
          subscriptionMatchesDefinition(entry, definition) &&
          entry.transport?.method === 'websocket' &&
          entry.transport?.session_id &&
          entry.transport.session_id !== eventSubSessionId
      );
      for (const entry of stale) {
        await deleteSubscription(entry.id);
      }
    }

    subscriptionsReady = true;
    updateDiagnostics({ subscriptions: active, lastError: null });
    if (subscriptionDeadlineTimer) {
      clearTimeout(subscriptionDeadlineTimer);
      subscriptionDeadlineTimer = null;
    }
  } catch (error) {
    if (error instanceof HelixRequestError && error.status === 403) {
      subscriptionRetryBlocked = true;
      updateDiagnostics({ lastError: JSON.stringify({ status: error.status, body: error.body }) });
      clearSubscriptionTimers();
      clearChannelRewardTimer();
      cleanupEventSub({ resetBackoff: false });
      return;
    }
    console.error('[background] Failed to ensure EventSub subscriptions', error);
    updateDiagnostics({ lastError: 'Subscription sync failed' });
    scheduleReconnect('ensure-subscriptions');
  } finally {
    ensureSubscriptionsInFlight = false;
  }
}

async function listSubscriptions(): Promise<HelixSubscription[]> {
  const response = await helixFetch('/eventsub/subscriptions');
  if (!response.ok) {
    throw new Error(`Failed to list EventSub subscriptions (${response.status})`);
  }
  const body = (await response.json()) as { data?: HelixSubscription[] };
  return body.data ?? [];
}

async function createSubscription(definition: EventSubSubscriptionDefinition): Promise<void> {
  if (!eventSubSessionId) {
    return;
  }
  const response = await helixFetch('/eventsub/subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      type: definition.type,
      version: definition.version,
      condition: definition.condition,
      transport: { method: 'websocket', session_id: eventSubSessionId }
    })
  });
  if (!response.ok) {
    let body: unknown = null;
    try {
      body = sanitizeForDiagnostics(await response.json());
    } catch (error) {
      try {
        body = await response.text();
      } catch {
        body = null;
      }
    }
    throw new HelixRequestError(response.status, body, `Failed to create subscription (${response.status})`);
  }
}

async function deleteSubscription(id: string): Promise<void> {
  const response = await helixFetch(`/eventsub/subscriptions?id=${encodeURIComponent(id)}`, {
    method: 'DELETE'
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Failed to delete subscription (${response.status})`);
  }
}

async function deleteAllSubscriptions(): Promise<void> {
  if (!twitchAuth) {
    return;
  }
  try {
    const subs = await listSubscriptions();
    for (const sub of subs) {
      if (subscriptionOwnedByBroadcaster(sub, twitchAuth.userId)) {
        await deleteSubscription(sub.id);
      }
    }
  } catch (error) {
    console.warn('[background] Failed to clean subscriptions', error);
  }
}

function subscriptionMatchesDefinition(
  entry: HelixSubscription,
  definition: EventSubSubscriptionDefinition,
  sessionId?: string | null
): boolean {
  if (entry.type !== definition.type || entry.version !== definition.version) {
    return false;
  }
  const requiredEntries = Object.entries(definition.condition);
  for (const [key, value] of requiredEntries) {
    if (entry.condition?.[key] !== value) {
      return false;
    }
  }
  if (sessionId) {
    return entry.transport?.session_id === sessionId;
  }
  return true;
}

function subscriptionOwnedByBroadcaster(sub: HelixSubscription, userId: string): boolean {
  const conditionValues = Object.values(sub.condition ?? {});
  return conditionValues.includes(userId);
}

function mapSubscriptionToBinding(type: string): BindingEventType | null {
  switch (type) {
    case 'channel.channel_points_custom_reward_redemption.add':
      return 'channel_points';
    case 'channel.cheer':
      return 'bits';
    case 'channel.subscribe':
      return 'sub';
    case 'channel.subscription.gift':
      return 'gift_sub';
    case 'channel.follow':
      return 'follow';
    default:
      return null;
  }
}
const TEST_EVENT_SUBSCRIPTION_MAP: Record<TestEventType, string> = {
  channel_points: 'channel.channel_points_custom_reward_redemption.add',
  bits: 'channel.cheer',
  gift_sub: 'channel.subscription.gift',
  sub: 'channel.subscribe',
  follow: 'channel.follow'
};

function routeEvent(event: RoutedEvent): void {
  updateDiagnostics({ lastNotificationAt: event.receivedAt, lastNotificationType: event.subscriptionType });
  if (event.source === 'eventsub') {
    if (hasSeenMessage(event.messageId)) {
      return;
    }
    markMessageSeen(event.messageId);
  }
  const normalized = normalizeEvent(event.bindingType, event.payload, event.subscriptionType);
  if (!normalized) {
    return;
  }
  if (!cachedState.captureEvents) {
    logSkippedEvent(normalized, event.bindingType, event.source, 'capture_disabled');
    return;
  }
  const matches = matchBindings(normalized, event.bindingType);
  if (matches.length === 0) {
    logSkippedEvent(normalized, event.bindingType, event.source, 'no_matching_bindings');
    return;
  }
  for (const match of matches) {
    void queueEffect(match.binding, normalized, event.bindingType, match.operations, event.source);
  }
}

async function handleTestEvent(payload: {
  type: TestEventType;
  username: string;
  amount: number | null;
  rewardId: string | null;
  subTier: SubTier;
}): Promise<'processed' | 'ignored'> {
  const subscriptionType = TEST_EVENT_SUBSCRIPTION_MAP[payload.type];
  const syntheticPayload = buildTestEventPayload(payload);
  routeEvent({
    source: 'test',
    subscriptionType,
    bindingType: payload.type,
    receivedAt: Date.now(),
    payload: syntheticPayload,
    messageId: `test-${Date.now()}-${Math.random().toString(16).slice(2)}`
  });
  return cachedState.captureEvents ? 'processed' : 'ignored';
}

function buildTestEventPayload(payload: {
  type: TestEventType;
  username: string;
  amount: number | null;
  rewardId: string | null;
  subTier: SubTier;
}): unknown {
  switch (payload.type) {
    case 'channel_points': {
      const rewardId = payload.rewardId ?? '';
      const reward = channelRewards.find((item) => item.id === rewardId);
      return {
        user_name: payload.username,
        reward: {
          id: payload.rewardId,
          title: reward?.title ?? rewardId,
          cost: reward?.cost ?? null
        }
      };
    }
    case 'bits':
      return { user_name: payload.username, bits: payload.amount ?? 0 };
    case 'gift_sub':
      return {
        user_name: payload.username,
        tier: mapSubTierToTier(payload.subTier),
        is_gift: true,
        total: payload.amount ?? 1
      };
    case 'sub':
      return { user_name: payload.username, tier: mapSubTierToTier(payload.subTier), is_gift: false };
    case 'follow':
    default:
      return { user_name: payload.username };
  }
}

async function ensureFreshAuth(): Promise<boolean> {
  if (!twitchAuth) return false;
  try {
    await ensureValidatedAuth();
    return true;
  } catch (error) {
    console.warn('[background] ensureFreshAuth failed', error);
    return false;
  }
}
type ActionResult = {
  status: 'ok' | 'error';
  messageKey?: string;
  messageParams?: Record<string, string | number>;
};

async function handleManualRewardRefresh(): Promise<ActionResult> {
  if (!twitchAuth) {
    return { status: 'error', messageKey: 'toasts.rewardsRefreshAuth' };
  }
  const now = Date.now();
  if (channelRewardFetchInFlight) {
    return { status: 'error', messageKey: 'toasts.rewardsRefreshPending' };
  }
  if (now - lastManualRewardRefreshAt < REWARD_REFRESH_DEBOUNCE_MS) {
    return { status: 'error', messageKey: 'toasts.rewardsRefreshTooSoon' };
  }
  lastManualRewardRefreshAt = now;
  await refreshChannelRewards();
  return { status: 'ok', messageKey: 'toasts.rewardsRefreshed' };
}

async function initiateConnect(): Promise<ActionResult> {
  try {
    const auth = await performOAuthFlow();
    await setAuthData(auth, { broadcast: true });
    await startEventSub();
    return { status: 'ok', messageKey: 'toasts.twitchConnected' };
  } catch (error) {
    if (error instanceof AuthCancelledError) {
      return { status: 'error', messageKey: 'toasts.twitchAuthCancelled' };
    }
    if (error instanceof MissingClientIdError) {
      return { status: 'error', messageKey: 'toasts.twitchMissingClientId' };
    }
    if (error instanceof MissingScopesError) {
      return {
        status: 'error',
        messageKey: 'toasts.twitchMissingScopes',
        messageParams: { scopes: error.missing.join(', ') }
      };
    }
    console.error('[background] Twitch connect failed', error);
    return { status: 'error', messageKey: 'toasts.twitchAuthFailed' };
  }
}

async function initiateReconnect(): Promise<ActionResult> {
  try {
    if (!(await ensureFreshAuth())) {
      return await initiateConnect();
    }
    await startEventSub();
    return { status: 'ok', messageKey: 'toasts.twitchReconnected' };
  } catch (error) {
    console.error('[background] Twitch reconnect failed', error);
    return { status: 'error', messageKey: 'toasts.twitchAuthFailed' };
  }
}

async function disconnectFromTwitch(): Promise<ActionResult> {
  if (twitchAuth) {
    await deleteAllSubscriptions();
  }
  cleanupEventSub();
  clearChannelRewardTimer();
  channelRewardLastFetchedAt = 0;
  channelRewardFetchInFlight = false;
  subscriptionRetryBlocked = false;
  channelRewards = [];
  await chrome.storage.local.set({
    [CHANNEL_REWARDS_STORAGE_KEY]: [],
    [CHANNEL_REWARDS_UPDATED_AT_KEY]: Date.now()
  });
  await clearAllScheduledEffects('skipped');
  effectAdjustments = { semitoneOffset: 0, speedPercent: 0 };
  await chrome.storage.local.set({ [EFFECT_STORAGE_KEY]: effectAdjustments });
  await updateCachedState({ effectSemitoneOffset: 0, effectSpeedPercent: 0 });
  if (cachedState.channelPointRewards?.length) {
    await updateCachedState({ channelPointRewards: [] });
  }
  await setAuthData(null, { broadcast: true, retainDisplayName: false });
  updateDiagnostics({ lastError: null, subscriptions: 0, sessionId: null, websocketConnected: false });
  return { status: 'ok', messageKey: 'toasts.twitchDisconnected' };
}

function respondToPopup(sendResponse: (response?: BackgroundToPopupMessage) => void, message: BackgroundToPopupMessage): void {
  sendResponse(message);
}

function sendActionResponse(
  sendResponse: (response?: BackgroundToPopupMessage) => void,
  result: ActionResult
): void {
  respondToPopup(sendResponse, {
    type: 'BACKGROUND_ACTION_RESULT',
    status: result.status,
    messageKey: result.messageKey,
    messageParams: result.messageParams,
    state: cachedState
  });
}
async function acceptPopupState(nextState: PopupPersistentState): Promise<void> {
  cachedState = sanitizePopupState({
    ...nextState,
    loggedIn: cachedState.loggedIn,
    twitchDisplayName: cachedState.twitchDisplayName,
    mediaAvailability: cachedState.mediaAvailability
  });
  await persistCachedState();
}

async function handlePopupMessage(
  message: PopupToBackgroundMessage,
  sendResponse: (response?: BackgroundToPopupMessage) => void
): Promise<void> {
  switch (message.type) {
    case 'POPUP_READY':
    case 'POPUP_REQUEST_STATE': {
      respondToPopup(sendResponse, { type: 'BACKGROUND_STATE', state: cachedState });
      pushDiagnostics();
      return;
    }
    case 'POPUP_UPDATE_STATE': {
      await acceptPopupState(message.state);
      respondToPopup(sendResponse, { type: 'BACKGROUND_STATE', state: cachedState });
      return;
    }
    case 'POPUP_TOGGLE_DEVTOOLS': {
      await updateCachedState({ diagnosticsExpanded: message.expanded });
      respondToPopup(sendResponse, { type: 'BACKGROUND_DEVTOOLS', expanded: message.expanded });
      return;
    }
    case 'POPUP_TWITCH_CONNECT': {
      const result = await initiateConnect();
      sendActionResponse(sendResponse, result);
      return;
    }
    case 'POPUP_TWITCH_RECONNECT': {
      const result = await initiateReconnect();
      sendActionResponse(sendResponse, result);
      return;
    }
    case 'POPUP_TWITCH_DISCONNECT': {
      const result = await disconnectFromTwitch();
      sendActionResponse(sendResponse, result);
      return;
    }
    case 'POPUP_REFRESH_REWARDS': {
      const result = await handleManualRewardRefresh();
      sendActionResponse(sendResponse, result);
      return;
    }
    case 'POPUP_TRIGGER_TEST_EVENT': {
      const status = await handleTestEvent(message.payload);
      const result: ActionResult =
        status === 'processed'
          ? { status: 'ok', messageKey: 'toasts.testFired' }
          : { status: 'error', messageKey: 'toasts.captureDisabled' };
      sendActionResponse(sendResponse, result);
      return;
    }
    default:
      return;
  }
}

function handleContentMessage(
  message: ContentToBackgroundMessage,
  sender?: chrome.runtime.MessageSender,
  sendResponse?: (response?: unknown) => void
): boolean {
  switch (message.type) {
    case 'CONTENT_READY': {
      console.info('[background] Content script is ready');
      const tabId = sender?.tab?.id ?? null;
      if (typeof tabId === 'number') {
        activeContentTabId = tabId;
        void rehydrateActiveEffectsForTab(tabId);
      }
      sendResponse?.({ tabId });
      return false;
    }
    case 'CONTENT_PONG':
      console.debug('[background] Received pong from content script');
      return false;
    case 'AUDIO_STATUS':
      console.debug('[background] Audio status update', message.status);
      return false;
    case 'AUDIO_EFFECTS_UPDATE':
      effectAdjustments = {
        semitoneOffset: message.payload.semitoneOffset,
        speedPercent: message.payload.speedPercent
      };
      void updateCachedState(
        {
          effectSemitoneOffset: message.payload.semitoneOffset,
          effectSpeedPercent: message.payload.speedPercent
        },
        { persist: true, broadcast: true }
      );
      return false;
    default:
      return false;
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
    return handleContentMessage(message, _sender, sendResponse);
  }

  return false;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') {
    return;
  }
  if (CHANNEL_REWARDS_STORAGE_KEY in changes) {
    const next = (changes as any)[CHANNEL_REWARDS_STORAGE_KEY]?.newValue as ChannelPointRewardSummary[] | undefined;
    if (next && !valuesEqual(channelRewards, next)) {
      channelRewards = next;
      void updateCachedState({ channelPointRewards: next });
    }
  }
  if (EFFECT_STORAGE_KEY in changes) {
    const next = (changes as any)[EFFECT_STORAGE_KEY]?.newValue;
    void updateEffectAdjustmentsFromStorageValue(next);
  }
  if (EVENT_LOG_STORAGE_KEY in changes) {
    const next = (changes as any)[EVENT_LOG_STORAGE_KEY]?.newValue as EventLogEntry[] | undefined;
    if (Array.isArray(next) && !valuesEqual(eventLog, next)) {
      eventLog = next.slice(0, EVENT_LOG_LIMIT);
      lastEventLogSerialized = JSON.stringify(eventLog);
    }
  }
  if (MEDIA_AVAILABILITY_STORAGE_KEY in changes) {
    const next = (changes as any)[MEDIA_AVAILABILITY_STORAGE_KEY]?.newValue as MediaAvailabilityState | undefined;
    if (next) {
      const normalized = sanitizeMediaAvailability(next);
      if (typeof next.tabId === 'number' && activeContentTabId !== null && next.tabId !== activeContentTabId) {
        return;
      }
      void updateCachedState({ mediaAvailability: normalized });
    }
  }
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
