# Twitch AudioFX Extension (Phase 1)

This repository contains the Phase 1 scaffold for the Twitch AudioFX Chrome extension. The goal for this milestone is to deliver the full popup UI, persistent state management, and typed messaging stubs without integrating Twitch APIs or audio processing yet.

## Getting Started

```bash
npm install
npm run build
```

The build script bundles the background service worker, popup, and content script into `dist/` and copies the MV3 manifest plus locale files.

To load the extension in Chrome:

1. Run `npm run build`.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select the generated `dist` directory.

## Features Implemented in Phase 1

- Manifest V3 scaffold targeting Chrome 116+ with `identity`, `storage`, `scripting`, and `activeTab` permissions.
- Runtime language switching backed by JSON locale files discovered automatically at build time.
- Popup UI with:
  - Transpose and speed controls (UI state only) including sliders, +/- buttons, and reset actions.
  - Twitch status row with stubbed Connect/Disconnect button, capture toggle, and persisted state.
  - Test Events form gated behind a logged-in flag that logs simulated payloads and shows toasts.
  - Bindings list and add/edit flows with persistence, validation, unsaved-change confirmation, and delete/toggle interactions.
  - Collapsible diagnostics panel exposing stored state.
- Background and content script stubs with typed messaging channels prepared for later Twitch/EventSub and audio routing logic.
- Persistent popup state stored via `chrome.storage.local` through the background service worker.
- Simple toast and confirmation utilities for user feedback.

Future phases will add real Twitch authentication, EventSub WebSocket handling, audio effect engines, bindings execution, and packaged release assets.
