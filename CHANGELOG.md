# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-11-27

### "Little by little, one travels far." - J. R. R. Tolkien

- **Architecture & Bugfixes:**
  - Upgraded `@small-world-machine/engine` from `packages-0.129.2` to `packages-0.129.3` and raised `app.json` engine floor to `>=0.129.3`.

## [0.1.1] - 2026-11-24

### "Speak clearly, if you speak at all; carve every word before you let it fall." - Oliver Wendell Holmes

- **Features:**
  - Added root `Makefile` (`dev`, `start`, `restart`, `kill`, `check`, `typecheck`, `test`, `build`, `clean`) and standalone root `index.html` entry in `vite.config.ts`.
- **Architecture & Bugfixes:**
  - Upgraded `@small-world-machine/engine` to `packages-0.129.2` (incorporating `0.129.0`/`0.129.1`/`0.129.2` releases) and raised `app.json` engine floor to `>=0.129.2`.
  - Synchronized `GlobalUniforms` std140 block layout in `src/voxel/material/shaders/BlockMaterial.vert.glsl` (`u_toneMappingMode`, `u_toneMappingWhite`, `u_ambientGround`) and updated `BlockMaterial.ts` compatibility.
  - Fixed `REPO_ROOT` path resolution in `scripts/check-voxel-m7.mjs` and `scripts/check-voxel-webgl1.mjs` for standalone execution.
- **Housekeeping & Docs:**
  - Upgraded devDependencies (`typescript` 7.0.2, `vite` 8.3.8, `vitest` 5.1.1, `puppeteer` 25.18.1, `jsdom` 31.0.1, `@types/node`, `@webgpu/types`), added `.gitignore` entries, and updated `AGENTS.md` and `docs/log.md`.

## [0.1.0] - 2026-11-05

### "The stone does not desire to be anything other than a stone, but collaborating with other stones, it becomes a temple." - Antoine de Saint-Exupéry

- **Features:**
  - Initial standalone release of Minceraft, an infinite chunk-streamed voxel world sandbox.
  - Multi-worker greedy and naive meshing pool with baked daylight and ambient occlusion.
  - OPFS and IndexedDB delta persistence and AABB sweep collision physics.
- **Architecture & Bugfixes:**
  - Standalone project decoupling from the Small World Machine monorepo.
  - Pure package dependency on `@small-world-machine/engine` via GitHub release URL.
  - Consolidated shader typings into `src/types/vite-env.d.ts` and separated root `tests/` harness.
  - Fixed mouse wheel debounce initial condition (`-Infinity`) to ensure reliable slot cycling at startup.
- **Housekeeping & Docs:**
  - Standardized project layout: `src/`, `public/`, `tests/`, `docs/`, `scripts/`, `AGENTS.md`.
  - Added standalone `public/assets/` structure and game favicon.
