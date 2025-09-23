# Repository Guidelines

## Project Structure & Module Organization
- Static site at repo root; no build step.
- `index.html` (markup), `script.js` (game logic, Web Audio), `style.css` (CSS variables + layout).
- Assets: `audio/` (e.g., `noy1.ogg`…`noy6.ogg`), `img/` (`noy.png`).
- CI/CD: `.github/workflows/pages.yml` deploys the root to GitHub Pages on pushes to `main`/`master`.

## Build, Test, and Development Commands
- Run locally with a static server (required for audio fetch/decode):
  - `python3 -m http.server 8000` → open `http://localhost:8000/`.
- No build or package manager required. Deploys automatically via GitHub Actions.

## Coding Style & Naming Conventions
- JavaScript: 2‑space indent; semicolons; `const`/`let`; arrow functions; keep code in a file‑scoped IIFE; prefer Web APIs over libraries.
- CSS: use variables in `:root`; simple selectors (`#field`, `#hud`, `#target`, `.overlay`, `.hidden`); toggle classes for state.
- Assets: lowercase, hyphenated filenames; follow existing patterns (`audio/noy{1..6}.ogg`, `img/noy.png`).
- Keep the project framework‑free and single‑file JS/CSS unless absolutely necessary.

## Testing Guidelines
- No automated tests. Perform manual QA for each change:
  - Start overlay appears; game starts; proximity increases loudness; crossfades are smooth.
  - Target reveals, centers, and scales correctly; restart works.
  - Resize/mobile viewport still keeps target in bounds; test Chrome/Safari/Firefox.

## Commit & Pull Request Guidelines
- Commits: short, imperative, scoped (e.g., "Fix audio crossfade timing").
- PRs: include a concise summary, steps to verify locally, and before/after screenshots or a short GIF. Link related issues. Note any asset changes.

## Agent‑Specific Instructions
- Do not introduce bundlers or heavy deps; keep it a static site.
- Preserve structure and style; make small, focused diffs. Keep `README.md` simple.
- Avoid touching the Pages workflow unless required for deployment.

