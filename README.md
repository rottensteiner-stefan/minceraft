# Minceraft

A chunk-streamed voxel sandbox (worker meshing, baked AO and daylight, IndexedDB/OPFS delta persistence). A standalone
project: it **uses** [Small World Machine](https://github.com/rottensteiner-stefan/small-world-machine) like any
third party would, as a versioned npm package through its public API only. This repo contains no engine source.

## Engine dependency

`@small-world-machine/engine` is installed from the engine repo's GitHub release (URL dependency in `package.json`,
currently `packages-0.122.0`). Import from the package root only; never from internal paths. If the project needs something
the public API does not expose, change the engine and take a new release (point the URL in `package.json` at it,
`npm install`, `npm run typecheck && npm test`).

## Setup

```sh
git clone <this repo>
npm install
```

## Commands

| Command | Purpose |
| :--- | :--- |
| `npm run dev` | Vite dev server |
| `npm run build` | Production build into `dist/` |
| `npm run typecheck` | `tsc --noEmit` over `src/**` and `tests/**` |
| `npm test` | Vitest, `tests/**/*.test.ts` |
| `npm run check:voxel-m7` | Headless live gate: worker pool + persistence round-trip (needs a fresh `npm run build`) |
| `npm run check:voxel-webgl1` | Headless live gate on the WebGL1 tier (needs a fresh `npm run build`) |

## Layout

- `src/` — the game: `voxel/` (world, meshing, worker, persistence, physics), `types/` (ambient declarations for `?raw` shader imports), `App.ts`, `index.ts`, `index.html`
- `docs/` — `log.md` living dev log, `concept-dossier.html`, `controls.md`, `adr/` (ADRs), `research/` (performance benchmark notes)
- `tests/` — Vitest suite (`setup.ts`, `*.test.ts`)
- `scripts/` — Puppeteer live gates and their helpers
