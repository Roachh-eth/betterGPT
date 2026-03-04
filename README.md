# betterGPT (Chrome Extension, MV3)

This extension reduces lag in long ChatGPT threads by virtualizing older messages. It keeps only the most relevant message window rendered in the DOM and replaces older messages with lightweight placeholders.

## Features

- Runs only on `https://chatgpt.com/*`
- Default active message limit: `15` (configurable in popup)
- Older messages are dehydrated into placeholders:
  - `Message hidden to reduce lag — click to render`
- Older messages stay hidden by default until clicked, keeping active DOM size bounded.
- Badge indicator:
  - Green `ON` when limiter is active on a ChatGPT tab
  - Empty when disabled or not active
- Popup controls:
  - On/Off toggle
  - Message limit slider
  - Stats: hidden messages, active messages, DOM nodes removed, estimated memory saved

## Install (Load Unpacked)

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the cloned/downloaded extension folder
5. Open `https://chatgpt.com` and use the extension popup to configure limits

## How It Works (High Level)

1. Content script detects message elements in the ChatGPT thread.
2. It maintains an active render window (last `N` messages by default).
3. Messages outside the active window are dehydrated:
   - Existing child nodes are moved into an in-memory fragment
   - A lightweight placeholder remains in the DOM with preserved approximate height
4. New messages and thread DOM changes trigger a debounced re-check that keeps only the latest `N` messages fully rendered.
5. Clicking a placeholder temporarily re-renders that message for inspection.

## Known Limitations

- ChatGPT DOM structure can change; selectors are resilient but still heuristic-based.
- Memory savings are estimated from removed DOM nodes and should be treated as rough approximations.
- Some React-managed internal behavior may vary if ChatGPT changes rendering internals.
- Clicking many hidden placeholders in a short window can temporarily increase active messages until the temporary pin window expires.
