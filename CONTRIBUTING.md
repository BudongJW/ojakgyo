# Contributing to ojakgyo

Thanks for helping build the bridge! 🌉 Bug reports, docs fixes, new platforms and new actions are all welcome.

## Getting started

```bash
git clone https://github.com/BudongJW/ojakgyo.git
cd ojakgyo
npm install
npm test          # unit + end-to-end tests, no real accounts needed
npm run dev       # runs `ojakgyo start` from source
```

The test suite spins up fake CHZZK, OBS and VTube Studio servers, so you can work on connectors and outputs without live credentials.

## Project layout

| Path | What lives there |
| --- | --- |
| `src/core/` | Unified event model, hub, rule engine, templates, speech cleanup |
| `src/connectors/` | Platforms in: one folder per platform (`chzzk/`, …) |
| `src/outputs/` | Things we drive: VTube Studio, OBS, TTS |
| `src/server/`, `web/` | Local HTTP/WebSocket server, dashboard and overlays |
| `test/` | Vitest suites and fake servers |

## Adding a platform

1. Create `src/connectors/<platform>/` with a mapper that returns the unified `OjakgyoEvent` shapes from `src/core/events.ts`.
2. Use **official, documented APIs only**. No page scraping, no internal endpoints.
3. Report health with `hub.setStatus('<platform>', '<Label>', state)` so the dashboard shows it.
4. Add a fake-server test like `test/chzzk.test.ts`.

## Adding an action

1. Add a schema to `ActionSchema` in `src/config.ts`.
2. Register a handler in `App.registerActions()` (`src/app.ts`).
3. Document it in the README's action table and add a test.

## Pull requests

- Keep PRs focused; one feature or fix per PR.
- `npm run typecheck`, `npm test` and `npm run build` must pass. CI runs them on Linux and Windows with Node 22 and 24.
- CI installs with `npm ci`, so `package-lock.json` must list every package. npm 11 on Windows can leave out the dependencies of wasm-only optional packages (`@emnapi/core`, `@emnapi/runtime`). If CI reports them missing from the lock file, put those entries back rather than dropping them.
- Write commit messages and code comments in English. Korean is welcome in user-facing strings and examples.
- Be kind. We're all here to make streams more fun.
