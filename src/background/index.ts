import {
  type PopupToBackgroundMessage,
  type ContentToBackgroundMessage,
  type BackgroundToPopupMessage,
  type BackgroundToContentMessage
} from '../shared/messages';
import {
  createDefaultPopupState,
  POPUP_STATE_STORAGE_KEY,
  type PopupPersistentState,
  type BindingEventType,
  type SubTier,
  type TestEventType
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

const AUTH_EXPIRY_PADDING_MS = 60_000;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

type TimeoutHandle = ReturnType<typeof setTimeout>;

type RoutedEventSource = 'eventsub' | 'test';

interface RoutedEvent {
  source: RoutedEventSource;
  subscriptionType: string;
  bindingType: BindingEventType;
  receivedAt: number;
  payload: unknown;
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

let cachedState: PopupPersistentState = createDefaultPopupState();
let twitchAuth: TwitchAuthData | null = null;
let diagnostics: TwitchDiagnosticsSnapshot = createEmptyDiagnostics();

let eventSubSocket: WebSocket | null = null;
let eventSubSessionId: string | null = null;
let eventSubReconnectTimer: TimeoutHandle | null = null;
let keepaliveTimer: TimeoutHandle | null = null;
let keepaliveTimeoutMs = 0;
let reconnectBackoffMs = INITIAL_BACKOFF_MS;

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
  cachedState = await loadFromStorage(POPUP_STATE_STORAGE_KEY, createDefaultPopupState());
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

function broadcastState(): void {
  try {
    chrome.runtime.sendMessage({ type: 'BACKGROUND_STATE', state: cachedState }, () => {
      void chrome.runtime.lastError;
    });
  } catch (error) {
    console.debug('[background] Failed to broadcast state', error);
  }
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

async function updateCachedState(
  partial: Partial<PopupPersistentState>,
  options: { persist?: boolean; broadcast?: boolean } = {}
): Promise<void> {
  const { persist = true, broadcast = true } = options;
  cachedState = { ...cachedState, ...partial };
  if (persist) {
    await persistCachedState();
  }
  if (broadcast) {
    broadcastState();
  }
}

async function syncStateWithAuth(options: { persist?: boolean; broadcast?: boolean } = {}): Promise<void> {
  const { persist = true, broadcast = true } = options;
  const loggedIn = twitchAuth !== null;
  const displayName = twitchAuth?.displayName ?? null;
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

async function setAuthData(next: TwitchAuthData | null, options: { broadcast?: boolean } = {}): Promise<void> {
  twitchAuth = next;
  if (next) {
    await saveToStorage(TWITCH_AUTH_STORAGE_KEY, next);
  } else {
    await removeFromStorage(TWITCH_AUTH_STORAGE_KEY);
  }
  await syncStateWithAuth({ broadcast: options.broadcast });
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

async function handleExpiredToken(message = 'Token expired'): Promise<void> {
  updateDiagnostics({
    lastError: message,
    websocketConnected: false,
    sessionId: null,
    subscriptions: 0,
    tokenType: null,
    tokenClientId: null,
    tokenExpiresIn: null
  });
  await setAuthData(null, { broadcast: true });
  cleanupEventSub();
}

async function handleAuthFailure(reason: unknown): Promise<void> {
  console.warn('[background] Twitch authentication failure', reason);
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
      await setAuthData(null, { broadcast: true });
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
      await setAuthData(null, { broadcast: true });
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
async function startEventSub(): Promise<void> {
  if (!twitchAuth) {
    throw new Error('Not authenticated with Twitch');
  }

  await ensureValidatedAuth();
  cleanupEventSub();
  connectEventSub();
}

function connectEventSub(url?: string): void {
  if (!twitchAuth || !isAuthUsable(twitchAuth)) {
    return;
  }
  const target = url ?? TWITCH_EVENTSUB_WS;
  try {
    const socket = new WebSocket(target);
    eventSubSocket = socket;
    updateDiagnostics({ websocketConnected: false, sessionId: null });

    socket.addEventListener('open', () => {
      updateDiagnostics({ websocketConnected: true, lastError: null });
    });

    socket.addEventListener('message', (event) => {
      handleEventSubMessage(String(event.data ?? ''));
    });

    socket.addEventListener('close', (event) => {
      console.info('[background] EventSub socket closed', event.code, event.reason);
      eventSubSocket = null;
      eventSubSessionId = null;
      reconnectBackoffMs = Math.min(reconnectBackoffMs * 2, MAX_BACKOFF_MS);
      clearKeepaliveTimer();
      updateDiagnostics({ websocketConnected: false, sessionId: null, subscriptions: 0 });
      scheduleReconnect('socket-close');
    });

    socket.addEventListener('error', (event) => {
      console.warn('[background] EventSub socket error', event);
      updateDiagnostics({ lastError: 'WebSocket error' });
    });
  } catch (error) {
    console.error('[background] Failed to open EventSub socket', error);
    scheduleReconnect('socket-error');
  }
}

function clearKeepaliveTimer(): void {
  if (keepaliveTimer) {
    clearTimeout(keepaliveTimer);
    keepaliveTimer = null;
  }
}

function scheduleReconnect(reason: string): void {
  if (!twitchAuth || !isAuthUsable(twitchAuth)) {
    return;
  }
  if (eventSubReconnectTimer) {
    return;
  }
  updateDiagnostics({ lastError: reason });
  const delay = reconnectBackoffMs;
  eventSubReconnectTimer = setTimeout(() => {
    eventSubReconnectTimer = null;
    connectEventSub();
  }, delay);
}

function cleanupEventSub(): void {
  if (eventSubReconnectTimer) {
    clearTimeout(eventSubReconnectTimer);
    eventSubReconnectTimer = null;
  }
  clearKeepaliveTimer();
  if (eventSubSocket) {
    try {
      eventSubSocket.close();
    } catch (error) {
      console.warn('[background] Error closing EventSub socket', error);
    }
  }
  eventSubSocket = null;
  eventSubSessionId = null;
  updateDiagnostics({ websocketConnected: false, sessionId: null, subscriptions: 0 });
  reconnectBackoffMs = INITIAL_BACKOFF_MS;
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
      handleNotification(parsed?.payload);
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
  reconnectBackoffMs = INITIAL_BACKOFF_MS;
  keepaliveTimeoutMs = (session?.keepalive_timeout_seconds ?? 10) * 1000;
  updateDiagnostics({ sessionId: eventSubSessionId, lastError: null });
  recordKeepalive();
  void ensureSubscriptions();
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

function handleNotification(payload: any): void {
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
    payload: payload?.event
  });
}

function handleSessionReconnect(payload: any): void {
  const url: string | null = payload?.session?.reconnect_url ?? null;
  console.info('[background] EventSub requested reconnect', url);
  cleanupEventSub();
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
  void ensureSubscriptions();
}

function handleSessionClose(payload: any): void {
  const status = payload?.session?.status ?? 'unknown';
  console.warn('[background] EventSub session closed', status);
  updateDiagnostics({ lastError: `Session closed: ${status}`, websocketConnected: false, sessionId: null, subscriptions: 0 });
  cleanupEventSub();
  scheduleReconnect('session-close');
}
async function ensureSubscriptions(): Promise<void> {
  if (!twitchAuth || !eventSubSessionId) {
    return;
  }
  try {
    const definitions = getRequiredEventSubDefinitions(twitchAuth.userId);
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

    updateDiagnostics({ subscriptions: active, lastError: null });
  } catch (error) {
    console.error('[background] Failed to ensure EventSub subscriptions', error);
    updateDiagnostics({ lastError: 'Subscription sync failed' });
    scheduleReconnect('ensure-subscriptions');
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
    throw new Error(`Failed to create subscription (${response.status})`);
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
    case 'channel.follow':
      return 'follow';
    default:
      return null;
  }
}
const TEST_EVENT_SUBSCRIPTION_MAP: Record<TestEventType, string> = {
  channel_points: 'channel.channel_points_custom_reward_redemption.add',
  bits: 'channel.cheer',
  gift_sub: 'channel.subscribe',
  sub: 'channel.subscribe',
  follow: 'channel.follow'
};

function routeEvent(event: RoutedEvent): void {
  updateDiagnostics({ lastNotificationAt: event.receivedAt, lastNotificationType: event.subscriptionType });
  if (!cachedState.captureEvents) {
    console.info('[background] Capture disabled; ignoring event', event.subscriptionType);
    return;
  }
  console.info('[background] Routed event', event.subscriptionType, event.payload);
  // Phase 4 will map events to bindings; for now this is a placeholder.
}

async function handleTestEvent(payload: {
  type: TestEventType;
  username: string;
  amount: number | null;
  rewardId: string | null;
  subTier: SubTier;
}): Promise<'processed' | 'ignored'> {
  const subscriptionType = TEST_EVENT_SUBSCRIPTION_MAP[payload.type];
  routeEvent({
    source: 'test',
    subscriptionType,
    bindingType: payload.type,
    receivedAt: Date.now(),
    payload
  });
  return cachedState.captureEvents ? 'processed' : 'ignored';
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
  await setAuthData(null, { broadcast: true });
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
  cachedState = {
    ...nextState,
    loggedIn: cachedState.loggedIn,
    twitchDisplayName: cachedState.twitchDisplayName
  };
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
