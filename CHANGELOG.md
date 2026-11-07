# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
