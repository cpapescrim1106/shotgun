# Shotgun Mobile Implementation Plan

## Goal

Make Shotgun usable from an iPhone on Chris's Tailscale network while keeping the actual browser windows running locally on Iris. The mobile dashboard should support monitoring, screenshots, focus, and deliberate manual takeover controls for a selected session.

## Safety Boundaries

- No CAPTCHA bypass, queue bypass, proxy/IP rotation, registration automation, or stealth behavior.
- Remote control is manual input only: tap, type, scroll, and a small allow-list of keys.
- Network access is private and token-gated. Startup logs print the exact private URLs with the access token.

## Implemented Architecture

1. Express listens on `HOST`/`PORT`, defaulting to `0.0.0.0:3737` so iPhone access works over Tailscale.
2. A per-machine token is stored in `.shotgun-token` unless `SHOTGUN_ACCESS_TOKEN` or `SHOTGUN_TOKEN` is provided.
3. All `/api/*` requests require the token via `?token=` or `X-Shotgun-Token`.
4. Browser launch prefers installed Google Chrome via Playwright `channel: "chrome"` and falls back to bundled Chromium if Chrome is unavailable.
5. Screenshots return image data plus viewport metadata for correct mobile tap coordinate scaling.
6. Session cards include a mobile-friendly `Control` action that opens a screenshot controller modal.

## Mobile UX

- Sticky config/actions on phone-sized screens.
- Larger touch targets for primary and card actions.
- One-column session cards on mobile.
- Controller modal supports:
  - tap-to-click on the live screenshot
  - text entry with explicit Send
  - scroll up/down
  - Enter, Tab, Backspace, Escape
  - automatic screenshot refresh while open

## Verification

- Unit tests cover URL normalization, browser count limits, port parsing, singleton cleanup, queue summaries, token URL generation, and mobile input validation.
- Runtime smoke test should use `SHOTGUN_NO_OPEN=1 npm start`, then open the printed Tailscale URL from the iPhone.
