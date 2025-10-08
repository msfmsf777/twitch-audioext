# Twitch AudioFX Extension (Phase 3)

This repository delivers the Phase 3 milestone for the Twitch AudioFX Chrome extension. Building on the Phase 1 UI and Phase 2 Twitch wiring, the extension now processes real-time audio in the active tab while continuing to authenticate with Twitch and listen for EventSub notifications from the background service worker.

## Getting Started

```bash
npm install

$env:TWITCH_CLIENT_ID="o9c3l0dqqadjyvgmdjqrojmwil3q1v"
npm run build
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
   - `moderator:read:followers`
   - `user:write:chat`

## Features Implemented in Phase 3

- Manifest V3 configuration targeting Chrome 116+ with `identity`, `storage`, `scripting`, `activeTab`, and host permissions for `https://id.twitch.tv/*` and `https://api.twitch.tv/*`.
- OAuth connect/reconnect/disconnect flows that persist the broadcaster's access token, scopes, display name, and user ID in `chrome.storage.local`.
- Background EventSub WebSocket client that automatically creates WebSocket-transport subscriptions for channel points redemptions, cheers, subscriptions, and follows. A single socket instance is managed with keepalive tracking, exponential reconnect backoff, subscription cleanup, and Helix rate-limit handling.
- Channel Points rewards are fetched after successful authentication and refreshed every 60 seconds so bindings and test events can reference live reward metadata without repeatedly polling. A **Refresh rewards** button in the Twitch connection card lets you trigger an immediate update when needed.
- The capture toggle now gates live EventSub notifications, while the Test Events form sends structured payloads through the same routing path for quick verification.
- The diagnostics panel reports WebSocket connectivity, current session ID, active subscription count, last keepalive time, last 
notification type/time, and the most recent error.
- Popup toasts surface authentication success/failure, missing scope requirements, capture-disabled warnings, and test-event sta
tus updates based on background action responses.
- A collapsible **Event Log** lists the last 200 real and test events with matched bindings, status transitions, and chat message results so you can confirm automation activity at a glance.
- Matched bindings schedule effect stacks (pitch/speed adjustments plus optional chat messages) with delay/duration timers, and Send Chat Message calls post templated responses directly into your Twitch chat using the broadcaster token.

- The content script now hosts a per-tab audio engine that applies Rubber Band–powered pitch shifting (±12 semitones) alongside synchronized playback speed control, automatically disabling the controls when no playable media is detected or when DRM/CORS rules prevent capture.

## Rubber Band Licensing

This project currently integrates the GPL-licensed Rubber Band Library WASM build for pitch shifting. If you intend to distribute the extension under a different license or for commercial use, you must either comply with the GPL’s requirements or secure a commercial Rubber Band license from https://www.breakfastquay.com/rubberband/.

## Debugging Tips

- Open `chrome://extensions`, locate the loaded extension, and use the **Service worker** → **Inspect views** link to watch cons
ole logs and network activity.
- From the same page, the **View service worker** link shows lifecycle state and lets you manually restart the worker while testi
ng reconnect scenarios.
- Authentication or subscription issues will be logged in the service worker console; watch for `401` (token expired) or `429` (r
ate limit) responses when exercising the Twitch APIs.
