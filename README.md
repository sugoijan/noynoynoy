[Play here](https://sugoijan.dev/noynoynoy)

Silly game inspired by [Find the Invisible Cow](https://findtheinvisiblecow.com/) and themed for [Noy](https://www.twitch.tv/noyururukavt).

Any source can be considered [MIT License](LICENSE.txt), but all the art/audio is copyrighted to Noy.

Built with the help of ChatGPT through codex-cli.

Contributions are welcomed.

## Develop and build

- Local dev: no build required. Serve root with `python -m http.server 8000` (or equivalent) and open http://localhost:8000/.
- CI build: Parcel bundles on GitHub Actions with content‑hashed assets and rewrites references automatically; Pages serves `dist/`.
- To test the build locally (optional):
  - Install Node 20 and Yarn (Corepack works: `corepack enable`)
  - `yarn install`
  - `yarn build`
  - Serve `dist/`: `python3 -m http.server 8000 -d dist`
