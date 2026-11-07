#!/usr/bin/env node
// mailbox.mjs: append-only message + claim log shared by several sessions working in one repo.
// No dependencies. See SKILL.md. File: .agents/scratches/session-mailbox.jsonl (git-ignored).
import fs from "node:fs";
import path from "node:path";

const FILE = process.env.MAILBOX_FILE || ".agents/scratches/session-mailbox.jsonl";
const CLAIM_TTL_HOURS = Number(process.env.MAILBOX_CLAIM_TTL_HOURS || 12);
const MAX_LINE_BYTES = 3500; // appends below ~4 KB are atomic on POSIX, so no locking is needed

const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

function die(message) {
  console.error(`mailbox: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) options[key] = true;
      else {
        options[key] = next;
        i++;
      }
    } else positional.push(arg);
  }
  return { positional, options };
}

function readEntries() {
  if (!fs.existsSync(FILE)) return [];
  const entries = [];
  for (const line of fs.readFileSync(FILE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A damaged line must never block the other sessions: skip it.
    }
  }
  return entries;
}

function append(entry) {
  const line = JSON.stringify(entry);
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) die(`entry too long (max ${MAX_LINE_BYTES} bytes), shorten it`);
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.appendFileSync(FILE, line + "\n", { flag: "a" });
  return entry;
}

function activeClaims(entries) {
  const cutoff = Date.now() - CLAIM_TTL_HOURS * 3600_000;
  const claims = new Map();
  for (const e of entries) {
    if (e.type === "claim") claims.set(e.id, e);
    else if (e.type === "release") {
      for (const [id, claim] of claims) {
        if (claim.from === e.from && (e.claim === "all" || e.claim === id)) claims.delete(id);
      }
    }
  }
  return [...claims.values()].filter((c) => Date.parse(c.ts) >= cutoff);
}

const normalise = (p) => p.replace(/^\.\//, "").replace(/\/\*\*$/, "/").replace(/\/+$/, "/");
function overlaps(a, b) {
  const [x, y] = [normalise(a), normalise(b)];
  const dirX = x.endsWith("/");
  const dirY = y.endsWith("/");
  if (dirX && (y.startsWith(x) || y + "/" === x)) return true;
  if (dirY && (x.startsWith(y) || x + "/" === y)) return true;
  return x === y;
}

function who(options) {
  const name = options.as || process.env.MAILBOX_NAME;
  if (!name || name === true) die("say who you are: --as <name> (or set MAILBOX_NAME)");
  return String(name);
}

const show = (e) =>
  e.type === "message"
    ? `[${e.ts}] ${e.from} -> ${e.to}: ${e.text}`
    : e.type === "claim"
      ? `[${e.ts}] CLAIM ${e.id} ${e.from}: ${e.paths.join(", ")}${e.note ? `  (${e.note})` : ""}`
      : `[${e.ts}] RELEASE ${e.from}: ${e.claim}`;

const commands = {
  send({ positional, options }) {
    const from = who(options);
    const to = options.to && options.to !== true ? String(options.to) : "all";
    const text = positional.join(" ").trim();
    if (!text) die('usage: send --as <name> [--to <name|all>] "text"');
    append({ id: newId(), ts: now(), type: "message", from, to, text });
    console.log(`sent to ${to}`);
  },

  claim({ positional, options }) {
    const from = who(options);
    if (!positional.length) die('usage: claim --as <name> [--note "why"] <path> [<path>...]');
    const conflicts = conflictsFor(from, positional);
    const entry = append({
      id: newId(),
      ts: now(),
      type: "claim",
      from,
      paths: positional,
      note: options.note && options.note !== true ? String(options.note) : undefined,
    });
    console.log(`claim ${entry.id} registered`);
    if (conflicts.length) {
      console.log("WARNING: overlaps with active claims of other sessions:");
      for (const c of conflicts) console.log("  " + show(c));
      process.exitCode = 1;
    }
  },

  release({ positional, options }) {
    const from = who(options);
    append({ id: newId(), ts: now(), type: "release", from, claim: positional[0] || "all" });
    console.log(`released ${positional[0] || "all your claims"}`);
  },

  // Exit code 1 if any given path overlaps an active claim of ANOTHER session.
  check({ positional, options }) {
    const from = who(options);
    const paths = positional.length ? positional : fs.readFileSync(0, "utf8").split("\n").filter(Boolean);
    const conflicts = conflictsFor(from, paths);
    if (!conflicts.length) return console.log("no conflicts");
    console.log("CONFLICT with active claims of other sessions:");
    for (const c of conflicts) console.log("  " + show(c));
    process.exitCode = 1;
  },

  read({ options }) {
    const entries = readEntries();
    const me = options.as && options.as !== true ? String(options.as) : process.env.MAILBOX_NAME;
    const tail = Number(options.tail || 20);
    const since = options.since && options.since !== true ? String(options.since) : "";
    const messages = entries.filter(
      (e) => e.type === "message" && (!me || e.to === "all" || e.to === me || e.from === me) && e.ts > since,
    );
    console.log(`--- messages${me ? ` for ${me}` : ""} (last ${tail}) ---`);
    for (const e of messages.slice(-tail)) console.log(show(e));
    commands.status({ options: {} });
  },

  status() {
    const claims = activeClaims(readEntries());
    console.log(`--- active claims (expire after ${CLAIM_TTL_HOURS} h) ---`);
    if (!claims.length) console.log("(none)");
    for (const c of claims) console.log(show(c));
  },
};

function conflictsFor(from, paths) {
  return activeClaims(readEntries()).filter(
    (c) => c.from !== from && c.paths.some((claimed) => paths.some((p) => overlaps(claimed, p))),
  );
}

const [command, ...rest] = process.argv.slice(2);
if (!command || !commands[command]) {
  die("commands: send | claim | release | check | read | status (see SKILL.md)");
}
commands[command](parseArgs(rest));
