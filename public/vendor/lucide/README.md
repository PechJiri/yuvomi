# Lucide (vendored)

- **Version:** 0.469.0
- **File:** lives at `public/lucide.min.js` — *outside* this folder. The path predates the
  `public/vendor/` convention and is referenced by the app shell and the service-worker
  precache, so it stays where it is; this folder only carries the license and update notes.
- **Source:** UMD build `lucide.min.js` from the [`lucide`](https://github.com/lucide-icons/lucide) npm package.
- **License:** ISC, full text in `LICENSE` (the minified header points at a LICENSE file
  "in the root directory of this source tree" — this is that file).
- **Newer standalone glyph:** `public/pages/calendar.js` carries only the Balloon SVG
  paths from Lucide v0.557.0 as a custom event icon. Keeping that one licensed glyph
  local avoids upgrading the entire v0.469.0 bundle for a single generated event type.

## Updating

1. Fetch the new version's UMD build from `https://registry.npmjs.org/lucide/-/lucide-<version>.tgz`
   (`dist/umd/lucide.min.js`).
2. Replace `public/lucide.min.js`, keeping the upstream `@license` header intact.
3. Replace `LICENSE` if it changed upstream, and bump the version in this README.
