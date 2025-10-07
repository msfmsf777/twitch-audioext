# Twitch AudioFX Extension (Phase 2)

This repository delivers the Phase 2 milestone for the Twitch AudioFX Chrome extension. The popup and bindings UX from Phase 1 r
emain unchanged, but the extension now authenticates with Twitch and listens for real EventSub notifications from the backgroun
d service worker.

## Getting Started

```bash
npm install
TWITCH_CLIENT_ID=your_client_id npm run build
```

The build script bundles the background service worker, popup, and content script into `dist/` and copies the MV3 manifest plus
locale files.

To load the extension in Chrome:

1. Run `npm run build`.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select the generated `dist` directory.

### Twitch OAuth Setup

1. Call `chrome.identity.getRedirectURL('twitch')` in the extension console to obtain the redirect URI. Unless you override the p
ath it will be `https://<EXTENSION_ID>.chromiumapp.org/twitch`.
2. Configure your Twitch developer application with that redirect URI and note the client ID.
3. Provide the client ID at build time via the `TWITCH_CLIENT_ID` environment variable. Optionally set `TWITCH_REDIRECT_PATH` to
 adjust the redirect suffix (defaults to `twitch`).
4. Grant the application the following scopes, which the extension requires when authenticating:
   - `channel:read:redemptions`
   - `bits:read`
   - `channel:read:subscriptions`

## Features Implemented in Phase 2

- Manifest V3 configuration targeting Chrome 116+ with `identity`, `storage`, `scripting`, `activeTab`, and host permissions for
 `https://id.twitch.tv/*` and `https://api.twitch.tv/*`.
- OAuth connect/reconnect/disconnect flows that persist the broadcaster's access token, scopes, display name, and user ID in `chr
ome.storage.local`.
- Background EventSub WebSocket client that automatically creates WebSocket-transport subscriptions for channel points redemptio
ns, cheers, subscriptions, and follows. Keepalive tracking, exponential reconnect backoff, subscription cleanup, and Helix rate-
limit handling are built in.
- The capture toggle now gates live EventSub notifications, while the Test Events form sends structured payloads through the sam
e routing path for quick verification.
- The diagnostics panel reports WebSocket connectivity, current session ID, active subscription count, last keepalive time, last 
notification type/time, and the most recent error.
- Popup toasts surface authentication success/failure, missing scope requirements, capture-disabled warnings, and test-event sta
tus updates based on background action responses.

## Debugging Tips

- Open `chrome://extensions`, locate the loaded extension, and use the **Service worker** → **Inspect views** link to watch cons
ole logs and network activity.
- From the same page, the **View service worker** link shows lifecycle state and lets you manually restart the worker while testi
ng reconnect scenarios.
- Authentication or subscription issues will be logged in the service worker console; watch for `401` (token expired) or `429` (r
ate limit) responses when exercising the Twitch APIs.
