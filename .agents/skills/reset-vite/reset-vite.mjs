#!/usr/bin/env node

/**
 * reset-vite.mjs
 * Finds and kills processes occupying typical Vite ports (5173-5185, 4173-4185, etc.)
 * or running Vite / VitePress servers.
 *
 * Usage:
 *   node .agents/skills/reset-vite/reset-vite.mjs [--dry-run] [--force] [--port 5173,3000]
 *   npm run kill:vite
 */

import { execSync } from "node:child_process";
import process from "node:process";

const DEFAULT_PORT_SPECS = ["5173-5185", "4173-4185", "24678", "51204"];

const HELP_TEXT = `Usage: node reset-vite.mjs [options]

Kills all processes occupying typical Vite ports or running Vite / VitePress dev servers.

Options:
  -n, --dry-run      Show matching processes without killing them
  -f, --force        Force kill immediately with SIGKILL (-9)
  -p, --port <ports> Additional or custom port ranges (e.g. 5173-5175,3000)
  -h, --help         Show this help message

Examples:
  node .agents/skills/reset-vite/reset-vite.mjs
  npm run kill:vite
  npm run kill:vite -- --dry-run
  npm run kill:vite -- -p 3000,8080
`;

function parseCliArgs(args) {
  const options = {
    dryRun: false,
    force: false,
    ports: [...DEFAULT_PORT_SPECS],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") {
      console.log(HELP_TEXT);
      process.exit(0);
    } else if (arg === "-n" || arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "-f" || arg === "--force") {
      options.force = true;
    } else if (arg === "-p" || arg === "--port") {
      const val = args[++i];
      if (!val) {
        console.error("Error: --port requires a port argument (e.g. 5173 or 5173-5179,3000)");
        process.exit(1);
      }
      options.ports.push(...val.split(",").map((s) => s.trim()).filter(Boolean));
    } else if (arg.startsWith("-")) {
      console.error(`Unknown option: ${arg}\nRun with --help for options.`);
      process.exit(1);
    } else {
      // Allow positional port arguments like `node reset-vite.mjs 3000`
      options.ports.push(...arg.split(",").map((s) => s.trim()).filter(Boolean));
    }
  }

  return options;
}

function getAncestorPids() {
  const ancestors = new Set([process.pid]);
  let currentPid = process.ppid;
  while (currentPid > 1) {
    ancestors.add(currentPid);
    try {
      const output = execSync(`ps -o ppid= -p ${currentPid}`, { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
      const ppid = parseInt(output.trim(), 10);
      if (!ppid || ppid === currentPid || isNaN(ppid)) break;
      currentPid = ppid;
    } catch {
      break;
    }
  }
  return ancestors;
}

function getProcessesByPorts(portSpecs) {
  const results = new Map(); // pid -> { pid, ports: Set<number>, command: string }
  const portArg = portSpecs.join(",");
  let stdout;

  try {
    stdout = execSync(`lsof -nP -iTCP:${portArg} -sTCP:LISTEN`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch {
    // lsof returns exit code 1 if no matching process is found
    return results;
  }

  const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^(\S+)\s+(\d+)\s+.*:(\d+)\s+\(LISTEN\)/);
    if (!match) continue;

    const [, command, pidStr, portStr] = match;
    const pid = parseInt(pidStr, 10);
    const port = parseInt(portStr, 10);

    if (!results.has(pid)) {
      results.set(pid, { pid, ports: new Set([port]), command, reason: "listening on Vite port" });
    } else {
      results.get(pid).ports.add(port);
    }
  }

  return results;
}

function getViteNamedProcesses() {
  const results = new Map();
  let stdout;

  try {
    stdout = execSync("ps -eo pid,command", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch {
    return results;
  }

  const lines = stdout.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const match = line.match(/^(\d+)\s+(.+)$/);
    if (!match) continue;

    const pid = parseInt(match[1], 10);
    const command = match[2];

    // Detect node running vite, vitepress, or vite dev
    const isViteProcess =
      /\b(node|bun|pnpm|npx)\b.*(\/|\\|\s)(vite|vitepress)(\.js|\b)/i.test(command) ||
      /\/node_modules\/\.bin\/(vite|vitepress)\b/i.test(command);

    if (isViteProcess) {
      results.set(pid, { pid, ports: new Set(), command, reason: "running Vite/VitePress command" });
    }
  }

  return results;
}

function getProcessCommandDetails(pid) {
  try {
    const output = execSync(`ps -o command= -p ${pid}`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    return output.trim();
  } catch {
    return "";
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const ignoredPids = getAncestorPids();

  const portTargets = getProcessesByPorts(options.ports);
  const viteTargets = getViteNamedProcesses();

  // Combine targets
  const combined = new Map();

  for (const [pid, info] of portTargets) {
    if (!ignoredPids.has(pid)) {
      combined.set(pid, info);
    }
  }

  for (const [pid, info] of viteTargets) {
    if (ignoredPids.has(pid)) continue;
    if (combined.has(pid)) {
      const existing = combined.get(pid);
      existing.reason = `${existing.reason} + ${info.reason}`;
    } else {
      combined.set(pid, info);
    }
  }

  if (combined.size === 0) {
    console.log(`[reset-vite] No active Vite processes found on monitored ports (${options.ports.join(", ")}).`);
    return;
  }

  console.log(`[reset-vite] Found ${combined.size} matching process${combined.size > 1 ? "es" : ""}:`);

  for (const [pid, info] of combined) {
    const fullCommand = getProcessCommandDetails(pid) || info.command;
    const portsStr = info.ports.size > 0 ? ` (port: ${Array.from(info.ports).join(", ")})` : "";
    const shortCmd = fullCommand.length > 80 ? fullCommand.slice(0, 77) + "..." : fullCommand;

    console.log(`  • PID ${pid}${portsStr} [${info.reason}]`);
    console.log(`    ↳ ${shortCmd}`);

    if (options.dryRun) {
      console.log(`    [DRY RUN] Would kill PID ${pid}`);
      continue;
    }

    if (options.force) {
      try {
        process.kill(pid, "SIGKILL");
        console.log(`    ✔ Force-killed with SIGKILL (PID ${pid})`);
      } catch (err) {
        console.log(`    ✖ Could not kill PID ${pid}: ${err.message}`);
      }
      continue;
    }

    // Graceful kill: SIGTERM first, wait up to 500ms, then SIGKILL if still alive
    try {
      process.kill(pid, "SIGTERM");
      let killed = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        await sleep(100);
        if (!isPidAlive(pid)) {
          killed = true;
          break;
        }
      }

      if (!killed && isPidAlive(pid)) {
        process.kill(pid, "SIGKILL");
        console.log(`    ✔ Terminated with SIGKILL after SIGTERM timeout (PID ${pid})`);
      } else {
        console.log(`    ✔ Gracefully terminated with SIGTERM (PID ${pid})`);
      }
    } catch (err) {
      console.log(`    ✖ Failed to kill PID ${pid}: ${err.message}`);
    }
  }

  if (options.dryRun) {
    console.log("[reset-vite] Dry run complete. No processes were terminated.");
  } else {
    console.log("[reset-vite] Done.");
  }
}

main().catch((err) => {
  console.error("[reset-vite] Fatal error:", err);
  process.exit(1);
});
