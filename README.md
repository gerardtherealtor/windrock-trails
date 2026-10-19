# Windrock Trails

Offline-capable trail map, GPS HUD and ride recorder for Windrock, Brimstone, Royal Blue and Coal Creek.
Static site: no build step. Deploys from `main` via Vercel's GitHub integration.

- `index.html`, `app.js`, `app.css` – the app
- `sw.js` – service worker (offline shell + map tile cache)
- `manifest.webmanifest`, `icon-*.png` – installable PWA

Deploys automatically from `main` via the Vercel GitHub integration.
