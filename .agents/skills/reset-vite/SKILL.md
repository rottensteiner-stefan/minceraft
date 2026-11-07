---
name: reset-vite
description: Kill processes occupying Vite ports (5173-5185, 4173-4185, 24678, etc.) or running Vite / VitePress servers to resolve port conflicts and free resources.
---

# Reset Vite

## Trigger

Use this skill whenever:
- Vite starts on an unexpected port (e.g. `http://localhost:5174/` or `5175` instead of `5173`) because a previous instance did not shut down cleanly.
- Vite dev server or Vitest hangs, fails with `EADDRINUSE`, or orphaned Node processes block development ports.
- The user asks to "kill vite", "reset vite", "ports freigeben", "vite port belegt", or stop lingering dev servers.

## Workflow

1. **Inspect / Kill Vite Processes**:
   Run the repository's dedicated kill script:
   ```bash
   npm run kill:vite
   ```
   Or directly:
   ```bash
   node scripts/kill-vite.mjs
   ```

2. **Dry-Run (Optional)**:
   If the user wants to check which processes are running without killing them:
   ```bash
   npm run kill:vite -- --dry-run
   ```

3. **Custom Ports / Force (Optional)**:
   - To force immediate termination (`SIGKILL / -9`):
     ```bash
     npm run kill:vite -- --force
     ```
   - To target additional or non-standard ports (e.g. 3000, 8080):
     ```bash
     npm run kill:vite -- -p 3000,8080
     ```

4. **Verify & Restart**:
   - Confirm output indicates the processes were terminated and ports freed.
   - If requested by the user, restart the dev server:
     ```bash
     npm run dev
     ```

## Monitored Defaults

- `5173 - 5185`: Vite Dev Server (default and auto-incremented ports)
- `4173 - 4185`: Vite Preview Server
- `24678`: Vite HMR / WebSocket fallback
- `51204`: Vitest UI
- Node processes executing `vite` or `vitepress`
