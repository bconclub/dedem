# DevDemo

Preview any website **desktop + mobile side-by-side**, with **synced scrolling** — one beautiful screen to share on Google Meet before a demo.

## Run

```bash
npm install      # first time only
npm start
```

Then open **http://localhost:5173**, paste a URL, hit **Load**.

- Works with **live URLs** (e.g. `yoursite.vercel.app`) and **local dev servers** (e.g. `localhost:3000`).
- Scroll either panel — the other follows proportionally. Toggle **Sync** off for independent scroll.
- Switch desktop viewport width between **1280** and **1440**.

## How it works

A tiny local proxy fetches the target page server-side, strips the headers that
block iframe embedding (`X-Frame-Options` / CSP), and serves it same-origin so
the two preview frames can scroll together. The site's own CSS/JS/images load
directly from its real origin via an injected `<base>` tag.

## Notes

- Local dev **live-reload (HMR)** may not tunnel through the proxy — the page
  renders fine, just hit **↻ Refresh** after changes. Deployed URLs are seamless.
- Most sites work — static, Next.js, and Vite/React SPAs (client-side routing,
  absolute API calls, and cross-origin data are all handled).
- **Some sites can't be previewed** and will show a clean "Can't preview this
  site" message instead: those that hard-block framing (`X-Frame-Options: DENY`)
  **and** pair it with anti-frame detection, or that depend on realtime
  **WebSockets** (e.g. Supabase realtime) — an HTTP proxy can't tunnel `wss://`.
  These render only in a real browser tab.
