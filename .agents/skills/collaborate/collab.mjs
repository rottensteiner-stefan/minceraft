#!/usr/bin/env node
// collab.mjs — deterministische Zustandsmaschine für das collaborate-Protokoll (siehe SKILL.md, Abschnitt 11).
// Keine Abhängigkeiten. Ersetzt das händische JSON-Editieren der <topic>.pid: Index-Arithmetik, revision,
// atomares Schreiben (tmp + rename) und eine echte Sperre (O_EXCL-Lockfile) liegen hier, nicht beim LLM.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const DEFAULT_DIR = '.agents/collaborate';
const LOCK_STALE_MS = 120_000;
const DEFAULT_NAMES = ['Alice', 'Bob', 'Charly', 'Dave', 'Erin', 'Frank']; // Reihenfolge für Einladungen ohne Namen
const BLOCKED_BEGIN = ['paused', 'terminated', 'deadlock', 'waiting_for_moderator'];

const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

class CollabError extends Error {}

// Wirft statt process.exit, damit das finally in withLock die Sperre auch bei Fehlern freigibt.
function fail(msg) {
  throw new CollabError(msg);
}

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) opt[a.slice(2)] = true;
    else { opt[a.slice(2)] = next; i++; }
  }
  return { pos, opt };
}

function resolvePid(topic) {
  if (!topic) fail('Topic-Datei fehlt.');
  let t = topic;
  if (!t.includes('/') && !fs.existsSync(t)) t = path.join(DEFAULT_DIR, t);
  return t.replace(/\.[^./]+$/, '') + '.pid';
}

function resolveBoard(topic) {
  if (!topic) fail('Topic-Datei fehlt.');
  let t = topic;
  if (!t.includes('/') && !fs.existsSync(t)) t = path.join(DEFAULT_DIR, t);
  if (t.endsWith('.board.jsonl')) return t;
  return t.replace(/\.[^./]+$/, '') + '.board.jsonl';
}

function readBoardEvents(boardPath) {
  if (!fs.existsSync(boardPath)) fail(`${boardPath} existiert nicht (zuerst "board-init").`);
  const content = fs.readFileSync(boardPath, 'utf8');
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  const events = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      events.push(JSON.parse(lines[i]));
    } catch (e) {
      fail(`Korrupte Zeile ${i + 1} in ${boardPath}: ${e.message}`);
    }
  }
  return events;
}

function appendBoardEvent(boardPath, event) {
  event.timestamp ??= now();
  const dir = path.dirname(boardPath);
  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify(event) + '\n';
  fs.appendFileSync(boardPath, line, { flag: 'a' });
  return event;
}

function projectBoard(events) {
  const state = {
    topic: null,
    mode: 'plan',
    status: 'active',
    coordinator: null,
    max_agents: null,
    created_at: null,
    resolved_at: null,
    outcome: null,
    summary: null,
    roster: {},
    tasks: {},
    findings: [],
    proposals: {},
    notes: [],
    eventCount: events.length,
  };

  for (const ev of events) {
    switch (ev.type) {
      case 'board_initialized':
        state.topic = ev.topic;
        state.mode = ev.mode ?? 'plan';
        state.coordinator = ev.coordinator ?? null;
        state.max_agents = ev.max_agents ? Number(ev.max_agents) : null;
        state.created_at = ev.timestamp;
        if (ev.coordinator) {
          state.roster[ev.coordinator] = {
            name: ev.coordinator,
            role: 'Coordinator',
            stance: null,
            joinedAt: ev.timestamp,
          };
        }
        break;

      case 'board_limit_set':
        state.max_agents = Number(ev.limit);
        break;

      case 'agent_evicted':
        delete state.roster[ev.agent];
        for (const task of Object.values(state.tasks)) {
          if (task.assignedTo === ev.agent && task.status !== 'completed') {
            task.assignedTo = null;
            task.status = 'open';
            task.claimedAt = null;
          }
        }
        break;

      case 'agent_joined':
        state.roster[ev.agent] = {
          name: ev.agent,
          role: ev.role ?? '',
          stance: ev.stance ?? null,
          joinedAt: ev.timestamp,
        };
        break;

      case 'task_posted':
        state.tasks[ev.taskId] = {
          id: ev.taskId,
          title: ev.title,
          assignedTo: ev.assignedTo ?? null,
          status: ev.assignedTo ? 'claimed' : 'open',
          createdBy: ev.author,
          createdAt: ev.timestamp,
          claimedAt: ev.assignedTo ? ev.timestamp : null,
          completedAt: null,
          result: null,
        };
        if (ev.author && !state.roster[ev.author]) {
          state.roster[ev.author] = { name: ev.author, role: '', stance: null, joinedAt: ev.timestamp };
        }
        break;

      case 'task_claimed':
        if (state.tasks[ev.taskId]) {
          state.tasks[ev.taskId].assignedTo = ev.agent;
          state.tasks[ev.taskId].status = 'in_progress';
          state.tasks[ev.taskId].claimedAt = ev.timestamp;
        }
        if (ev.agent && !state.roster[ev.agent]) {
          state.roster[ev.agent] = { name: ev.agent, role: '', stance: null, joinedAt: ev.timestamp };
        }
        break;

      case 'task_completed':
        if (state.tasks[ev.taskId]) {
          state.tasks[ev.taskId].status = 'completed';
          state.tasks[ev.taskId].completedAt = ev.timestamp;
          state.tasks[ev.taskId].result = ev.result ?? null;
          if (ev.agent) state.tasks[ev.taskId].assignedTo = ev.agent;
        }
        break;

      case 'finding_posted':
        state.findings.push({
          id: ev.findingId ?? `F${state.findings.length + 1}`,
          taskId: ev.taskId ?? null,
          severity: ev.severity ?? 'info',
          file: ev.file ?? null,
          line: ev.line ?? null,
          title: ev.title,
          description: ev.description ?? '',
          author: ev.author,
          timestamp: ev.timestamp,
        });
        if (ev.author && !state.roster[ev.author]) {
          state.roster[ev.author] = { name: ev.author, role: '', stance: null, joinedAt: ev.timestamp };
        }
        break;

      case 'proposal_posted':
        state.proposals[ev.proposalId] = {
          id: ev.proposalId,
          title: ev.title,
          description: ev.description ?? '',
          proposedBy: ev.author,
          timestamp: ev.timestamp,
          votes: {},
          status: 'open',
        };
        state.proposals[ev.proposalId].votes[ev.author] = {
          vote: 'AGREE',
          reason: 'Proposer',
          timestamp: ev.timestamp,
        };
        if (ev.author && !state.roster[ev.author]) {
          state.roster[ev.author] = { name: ev.author, role: '', stance: null, joinedAt: ev.timestamp };
        }
        break;

      case 'vote_posted':
        if (state.proposals[ev.proposalId]) {
          state.proposals[ev.proposalId].votes[ev.agent] = {
            vote: ev.vote,
            reason: ev.reason ?? null,
            timestamp: ev.timestamp,
          };
        }
        if (ev.agent && !state.roster[ev.agent]) {
          state.roster[ev.agent] = { name: ev.agent, role: '', stance: null, joinedAt: ev.timestamp };
        }
        break;

      case 'board_resolved':
        state.status = 'resolved';
        state.outcome = ev.outcome;
        state.summary = ev.summary ?? null;
        state.resolved_at = ev.timestamp;
        break;

      case 'note_posted':
        state.notes.push({
          text: ev.text,
          author: ev.author,
          timestamp: ev.timestamp,
        });
        break;
    }
  }

  const rosterNames = Object.keys(state.roster);
  for (const p of Object.values(state.proposals)) {
    if (state.status === 'resolved') break;
    const agreeVotes = Object.values(p.votes).filter((v) => v.vote === 'AGREE');
    if (rosterNames.length > 0 && agreeVotes.length >= rosterNames.length) {
      p.status = 'accepted';
    } else if (Object.values(p.votes).some((v) => v.vote === 'DISAGREE')) {
      p.status = 'disputed';
    }
  }

  return state;
}

function renderBoardToMarkdown(state, topicPath) {
  const lines = [];
  const title = path.basename(topicPath).replace(/\.[^./]+$/, '');
  lines.push(`# Blackboard: ${title}\n`);
  const maxInfo = state.max_agents ? ` | **Max Agents:** ${state.max_agents}` : '';
  lines.push(`> **Mode:** \`${state.mode}\` | **Status:** \`${state.status}\` | **Coordinator:** ${state.coordinator ? `**${state.coordinator}**` : '—'}${maxInfo} | **Events:** ${state.eventCount}`);
  if (state.resolved_at) {
    lines.push(`> **Outcome:** \`${state.outcome}\` | **Resolved At:** ${state.resolved_at}`);
  }
  lines.push('');

  lines.push('## 👥 Roster\n');
  const rosterEntries = Object.values(state.roster);
  if (rosterEntries.length === 0) {
    lines.push('*No agents registered yet.*\n');
  } else {
    lines.push('| Agent | Role | Stance | Joined |');
    lines.push('| :--- | :--- | :--- | :--- |');
    for (const r of rosterEntries) {
      lines.push(`| **${r.name}** | ${r.role || '—'} | ${r.stance || '—'} | ${r.joinedAt || '—'} |`);
    }
    lines.push('');
  }

  lines.push('## 📋 Tasks\n');
  const taskEntries = Object.values(state.tasks);
  if (taskEntries.length === 0) {
    lines.push('*No tasks posted yet.*\n');
  } else {
    lines.push('| ID | Title | Assigned To | Status | Result / Summary |');
    lines.push('| :--- | :--- | :--- | :--- | :--- |');
    for (const t of taskEntries) {
      const statusIcon = t.status === 'completed' ? '✅ completed' : t.status === 'in_progress' ? '⚡ in_progress' : t.status === 'claimed' ? '📌 claimed' : '⏳ open';
      lines.push(`| \`${t.id}\` | ${t.title} | ${t.assignedTo ? `**${t.assignedTo}**` : '—'} | ${statusIcon} | ${t.result || '—'} |`);
    }
    lines.push('');
  }

  if (state.findings.length > 0) {
    lines.push('## 🔍 Findings\n');
    lines.push('| ID | Task | Severity | Location | Title & Description | Author |');
    lines.push('| :--- | :--- | :--- | :--- | :--- | :--- |');
    for (const f of state.findings) {
      const loc = f.file ? (f.line ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``) : '—';
      const desc = f.description ? `<br>*${f.description}*` : '';
      lines.push(`| \`${f.id}\` | ${f.taskId ? `\`${f.taskId}\`` : '—'} | \`${f.severity}\` | ${loc} | **${f.title}**${desc} | **${f.author}** |`);
    }
    lines.push('');
  }

  if (Object.keys(state.proposals).length > 0) {
    lines.push('## ⚖️ Proposals & Consensus\n');
    for (const p of Object.values(state.proposals)) {
      lines.push(`### Proposal \`${p.id}\`: ${p.title}`);
      lines.push(`- **Proposed by:** **${p.proposedBy}** at ${p.timestamp}`);
      lines.push(`- **Status:** \`${p.status}\``);
      if (p.description) {
        lines.push(`- **Description:** ${p.description}`);
      }
      lines.push('- **Votes:**');
      const votes = Object.entries(p.votes);
      if (votes.length === 0) {
        lines.push('  - *No votes recorded.*');
      } else {
        for (const [agent, v] of votes) {
          const reason = v.reason ? ` (*${v.reason}*)` : '';
          lines.push(`  - **${agent}**: \`${v.vote}\`${reason}`);
        }
      }
      lines.push('');
    }
  }

  if (state.notes.length > 0) {
    lines.push('## 📝 Notes & Discussion\n');
    for (const n of state.notes) {
      lines.push(`- **[${n.timestamp}] ${n.author}:** ${n.text}`);
    }
    lines.push('');
  }

  if (state.status === 'resolved') {
    lines.push('---\n');
    lines.push('## 🏁 Final Resolution\n');
    lines.push(`- **Outcome:** \`${state.outcome}\``);
    lines.push(`- **Resolved At:** ${state.resolved_at}`);
    if (state.summary) {
      lines.push(`- **Summary:**\n\n${state.summary}\n`);
    }
  }

  return lines.join('\n');
}

// ---- Sperre + atomares Schreiben -----------------------------------------------------------

function withLock(pidPath, fn) {
  const lockPath = `${pidPath}.lock`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx');
  } catch {
    const age = Date.now() - fs.statSync(lockPath).mtimeMs;
    fail(`Sperre ${lockPath} gehalten (Alter ${Math.round(age / 1000)}s). ` +
      (age > LOCK_STALE_MS ? 'Veraltet — falls kein Zug läuft, Datei löschen.' : 'Ein anderer Zug läuft — warten.'));
  }
  fs.writeSync(fd, `${process.pid} ${now()}\n`);
  fs.closeSync(fd);
  try {
    return fn();
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}

function load(pidPath) {
  if (!fs.existsSync(pidPath)) fail(`${pidPath} existiert nicht (zuerst "init" bzw. "invite").`);
  const s = JSON.parse(fs.readFileSync(pidPath, 'utf8'));
  s.mode ??= 'plan';
  s.outcome ??= null;
  s.consensus ??= { reached: false, proposal_id: null, proposed_by: null, signatures: [] };
  return s;
}

function save(pidPath, s) {
  const errs = validate(s);
  if (errs.length) fail(`Invariante verletzt, nichts geschrieben: ${errs.join('; ')}`);
  s.revision += 1;
  const tmp = `${pidPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
  fs.renameSync(tmp, pidPath);
}

function log(s, agent, action, extra = {}) {
  s.history.push({ round: s.current_round, agent, action, ...extra, timestamp: now() });
}

function validate(s) {
  const errs = [];
  if (!Number.isInteger(s.revision) || s.revision < 0) errs.push('revision ungültig');
  if (!['plan', 'decide'].includes(s.mode)) errs.push(`mode ungültig: ${s.mode}`);
  const names = s.roster.map((r) => r.name);
  if (new Set(names).size !== names.length) errs.push('Roster-Namen nicht eindeutig');
  const expected = s.roster[s.turn_index]?.name ?? null;
  if (s.active_agent !== expected) errs.push(`active_agent (${s.active_agent}) ≠ roster[turn_index] (${expected})`);
  if (s.status === 'working' && !s.active_agent) errs.push('working ohne active_agent');
  return errs;
}

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const blindPath = (pidPath, agent) => `${pidPath.replace(/\.pid$/, '')}.blind.${agent}.md`;
const blindHash = (s, agent) => s.history.findLast((h) => h.action === 'blind_submitted' && h.agent === agent)?.hash;

const soloPlan = (s) => s.mode === 'plan' && s.roster.length === 1;

function mustBeActive(s, agent, needStatus = 'working') {
  if (s.active_agent !== agent) fail(`${agent} ist nicht dran (aktiv: ${s.active_agent}).`);
  if (s.status !== needStatus) fail(`Status ist "${s.status}", erwartet "${needStatus}".`);
}

function out(s, extra = {}) {
  console.log(JSON.stringify({
    status: s.status, round: `${s.current_round}/${s.max_rounds}`, active_agent: s.active_agent,
    revision: s.revision, outcome: s.outcome, timestamp: s.history.at(-1)?.timestamp, ...extra,
  }, null, 2));
}

// ---- Handover (Section 5, Step 3) ----------------------------------------------------------

function handover(s, agent, skipLimit = false) {
  const n = s.roster.length;
  const turns = s.history.filter((h) => h.action === 'turn_completed');
  if (s.mode === 'decide' && turns.length >= n && turns.slice(-n).every((h) => h.novelty === false)) {
    s.status = 'deadlock';
    log(s, agent, 'deadlock_stalled');
    return { deadlock: 'stalled' };
  }
  const next = (s.turn_index + 1) % n;
  if (next === 0) s.current_round += 1;
  if (!skipLimit && s.current_round > s.max_rounds) {
    const c = s.consensus;
    const open = c.proposal_id && !c.reached;
    // Spec 5 Step 3 (Unterschriftsrunde): Das Limit ruht, bis jedes andere Roster-Mitglied nach dem Vorschlag
    // einen Zug hatte — aber nur für einen Vorschlag, der innerhalb des Limits gestellt wurde (sonst Endlos-Kette).
    const at = s.history.findLastIndex((h) => h.action === 'proposal' && h.proposal === c.proposal_id);
    const proposedInRound = at >= 0 ? s.history[at].round : Infinity;
    const hadTurn = new Set(s.history.slice(at + 1).filter((h) => h.action === 'turn_completed').map((h) => h.agent));
    const missing = s.roster.filter((r) => r.name !== c.proposed_by && !hadTurn.has(r.name));
    if (open && missing.length && proposedInRound <= s.max_rounds) {
      if (c.grace_for !== c.proposal_id) {
        c.grace_for = c.proposal_id;
        log(s, agent, 'signing_round_granted', { proposal: c.proposal_id });
      }
    } else {
      s.status = 'deadlock';
      log(s, agent, 'deadlock_round_limit');
      return { deadlock: 'round_limit' };
    }
  }
  s.turn_index = next;
  s.active_agent = s.roster[next].name;
  s.status = s.consensus.reached && s.status === 'consensus_reached' ? 'consensus_reached' : 'idle';
  return {};
}

// ---- Befehle -------------------------------------------------------------------------------

const commands = {
  init(pidPath, pos, opt) {
    if (fs.existsSync(pidPath)) fail(`${pidPath} existiert bereits.`);
    const mode = opt.mode ?? 'plan';
    if (!['plan', 'decide'].includes(mode)) fail('--mode plan|decide');
    const s = {
      protocol_version: '1.1', mode,
      topic_file: pidPath.replace(/\.pid$/, '.md'), pid_file: pidPath,
      revision: 0, max_rounds: Number(opt['max-rounds'] ?? 5), current_round: 1, turn_index: 0,
      active_agent: null, status: 'waiting_for_moderator', paused_agent: null, roster: [],
      consensus: { reached: false, proposal_id: null, proposed_by: null, signatures: [] },
      outcome: null, history: [], custom_data: {},
    };
    log(s, 'moderator', 'session_initialized');
    save(pidPath, s);
    if (!opt._quiet) out(s);
  },

  invite(pidPath, pos, opt) {
    if (!fs.existsSync(pidPath)) commands.init(pidPath, [], { ...opt, _quiet: true });
    const s = load(pidPath);
    // Ohne Namen: erster freier Standardname (Alice, Bob, Charly, Dave, Erin, Frank).
    const name = pos[0] ?? DEFAULT_NAMES.find((n) => !s.roster.some((r) => r.name === n));
    if (!name) fail('Alle Standardnamen (Alice … Frank) sind vergeben — bitte einen Namen angeben: invite <topic> <AgentName>');
    if (s.roster.some((r) => r.name === name)) return out(s, { name, roster: s.roster.map((r) => r.name), note: `${name} bereits registriert` });
    if (!['waiting_for_moderator', 'idle', 'paused', 'consensus_reached'].includes(s.status)) {
      fail(`Spät-Einstieg nur bei idle/paused, Status ist "${s.status}".`);
    }
    const entry = { name, role: opt.role ?? '', channel: opt.channel ?? 'manual' };
    if (opt.stance) entry.stance = String(opt.stance);
    if (entry.channel === 'unix_signal') {
      if (!opt.pid) fail('channel unix_signal braucht --pid <OS-PID>');
      entry.pid = Number(opt.pid);
    }
    s.roster.push(entry);
    if (s.roster.length === 1) { s.turn_index = 0; s.active_agent = name; }
    log(s, name, 'agent_invited');
    save(pidPath, s);
    out(s, { name, roster: s.roster.map((r) => r.name) });
  },

  start(pidPath, pos) {
    const s = load(pidPath);
    if (s.status !== 'waiting_for_moderator') fail(`start nur bei waiting_for_moderator, Status ist "${s.status}".`);
    if (s.roster.length < 1) fail('Mindestens 1 Agent nötig.');
    const idx = pos[0] ? s.roster.findIndex((r) => r.name === pos[0]) : 0;
    if (idx < 0) fail(`Starter ${pos[0]} nicht im Roster.`);
    s.turn_index = idx; s.active_agent = s.roster[idx].name; s.current_round = 1; s.status = 'working';
    log(s, s.active_agent, 'session_started');
    save(pidPath, s);
    out(s);
  },

  'begin-turn'(pidPath, pos) {
    const s = load(pidPath);
    const agent = pos[0];
    if (BLOCKED_BEGIN.includes(s.status) || (s.mode === 'decide' && s.status === 'consensus_reached')) {
      fail(`Kein Zug möglich: Status "${s.status}" (Statuszeile: Waiting).`);
    }
    if (s.active_agent !== agent) fail(`${agent} ist nicht dran (aktiv: ${s.active_agent}) — Waiting.`);
    // Läuft der Zug schon, darf nur der frisch übergebene Zug (nach start/resume) betreten werden.
    const last = s.history.at(-1)?.action;
    if (s.status === 'working' && !['session_started', 'session_resumed_by_moderator'].includes(last)) {
      fail(`Zug von ${agent} läuft bereits. Ist die Instanz abgestürzt: pause, dann resume --agent ${agent}.`);
    }
    s.status = 'working';
    log(s, agent, 'turn_started');
    save(pidPath, s);
    out(s);
  },

  'end-turn'(pidPath, pos, opt) {
    const s = load(pidPath);
    const agent = pos[0];
    if (s.active_agent !== agent) fail(`${agent} ist nicht dran (aktiv: ${s.active_agent}).`);
    if (s.status !== 'working') fail(`Status ist "${s.status}", erwartet "working" (begin-turn vergessen oder Moderator-Eingriff).`);
    if (s.mode === 'decide' && opt.novelty === undefined) fail('Modus decide: --novelty true|false ist Pflicht.');
    if (s.mode === 'decide' && s.roster.length > 1 && s.current_round === 1 && !blindHash(s, agent)) {
      fail('Runde 1 (decide) ist blind: zuerst blind <topic> <Agent> (Beitrag in <topic>.blind.<Agent>.md).');
    }
    log(s, agent, 'turn_completed', opt.novelty === undefined ? {} : { novelty: opt.novelty === 'true' });
    let result = {};
    if (opt.consensus) {
      const c = s.consensus;
      const required = s.roster.map((r) => r.name);
      if (soloPlan(s)) required.push('moderator'); // Selbst-Planung: Moderator ist zweiter Teilnehmer (--approve)
      const missing = required.filter((n) => !c.signatures.includes(n));
      if (!c.proposal_id || missing.length) fail(`Konsens nicht belegt: Vorschlag ${c.proposal_id}, es fehlen Unterschriften von: ${missing.join(', ') || '—'}`);
      c.reached = true; s.status = 'consensus_reached'; s.outcome = 'CONSENSUS';
      log(s, agent, 'consensus_reached', { proposal: c.proposal_id });
      if (s.mode === 'decide') { save(pidPath, s); return out(s, { next: 'Endzustand — der Ergebnis-Block (10.6) muss im Topic-Dokument stehen (vorher schreiben, danach sind keine Züge mehr möglich)' }); }
    }
    result = handover(s, agent, Boolean(opt.consensus)); // Konsenszug ist vom Limit ausgenommen
    save(pidPath, s);
    out(s, { ...result, handoff: s.status === 'deadlock' ? null : `/collaborate --invite ${s.active_agent} ${topic}` });
  },

  propose(pidPath, pos) {
    const s = load(pidPath);
    const [agent, id] = pos;
    mustBeActive(s, agent);
    if (!id) fail('propose <topic> <Agent> <P<n>>');
    if (s.history.some((h) => h.action === 'proposal' && h.proposal === id)) fail(`Vorschlags-ID ${id} wurde schon verwendet.`);
    s.consensus = { reached: false, proposal_id: id, proposed_by: agent, signatures: [agent] };
    log(s, agent, 'proposal', { proposal: id });
    save(pidPath, s);
    out(s, { proposal: id });
  },

  sign(pidPath, pos) {
    const s = load(pidPath);
    const agent = pos[0];
    mustBeActive(s, agent);
    const c = s.consensus;
    if (!c.proposal_id) fail('Kein offener Vorschlag.');
    if (!c.signatures.includes(agent)) c.signatures.push(agent);
    log(s, agent, 'signed', { proposal: c.proposal_id });
    save(pidPath, s);
    const missing = s.roster.filter((r) => !c.signatures.includes(r.name)).map((r) => r.name);
    out(s, { proposal: c.proposal_id, missing });
  },

  blind(pidPath, pos) {
    const s = load(pidPath);
    const agent = pos[0];
    if (s.mode !== 'decide' || s.roster.length < 2) fail('blind gilt nur im Modus decide mit mindestens 2 Agenten.');
    if (s.current_round !== 1) fail('Blind-Beiträge gibt es nur in Runde 1.');
    mustBeActive(s, agent);
    const file = blindPath(pidPath, agent);
    if (!fs.existsSync(file)) fail(`${file} fehlt — zuerst den Blind-Beitrag dort schreiben.`);
    if (blindHash(s, agent)) fail(`${agent} hat bereits eingereicht (Hash festgeschrieben).`);
    const hash = sha(fs.readFileSync(file, 'utf8'));
    log(s, agent, 'blind_submitted', { hash });
    save(pidPath, s);
    out(s, { committed: hash.slice(0, 12) });
  },

  reveal(pidPath, pos) {
    const s = load(pidPath);
    const agent = pos[0];
    mustBeActive(s, agent);
    if (s.mode !== 'decide' || s.current_round !== 1) fail('reveal nur in Runde 1 (decide).');
    if (agent !== s.roster.at(-1).name) fail(`Aufdecken darf nur der letzte Agent der Rotation (${s.roster.at(-1).name}).`);
    const parts = [];
    for (const r of s.roster) {
      const hash = blindHash(s, r.name);
      if (!hash) fail(`${r.name} hat keinen Blind-Beitrag eingereicht.`);
      const text = fs.readFileSync(blindPath(pidPath, r.name), 'utf8');
      if (sha(text) !== hash) fail(`${r.name}: Blind-Datei wurde nach dem Einreichen verändert (Hash stimmt nicht).`);
      parts.push(`## Round 1: ${r.name} (blind)\n\n${text.trim()}\n`);
    }
    log(s, agent, 'blind_revealed');
    save(pidPath, s);
    console.log(parts.join('\n'));
  },

  approve(pidPath, pos) {
    const s = load(pidPath);
    if (!soloPlan(s)) fail('approve gilt nur im Modus plan mit genau 1 Agent (Selbst-Planung); sonst unterschreiben die Agenten.');
    if (['terminated', 'waiting_for_moderator'].includes(s.status)) fail(`approve nicht möglich im Status "${s.status}".`);
    const c = s.consensus;
    if (!c.proposal_id || c.reached) fail('Kein offener Vorschlag.');
    if (pos[0] && pos[0] !== c.proposal_id) fail(`Offener Vorschlag ist ${c.proposal_id}, nicht ${pos[0]}.`);
    if (!c.signatures.includes('moderator')) c.signatures.push('moderator');
    const ts = now();
    s.history.push({ round: s.current_round, agent: 'moderator', action: 'moderator_approval', proposal: c.proposal_id, timestamp: ts });
    save(pidPath, s);
    console.log(`[MODERATOR_APPROVAL ${c.proposal_id} ${ts}]`);
  },

  pause(pidPath) {
    const s = load(pidPath);
    if (['paused', 'terminated'].includes(s.status)) return out(s, { note: 'No-op (bereits ' + s.status + ')' });
    if (s.status === 'waiting_for_moderator') fail('pause erst nach start (nichts zu pausieren).');
    s.paused_agent = s.active_agent; s.status = 'paused';
    log(s, s.active_agent, 'session_paused_by_moderator');
    save(pidPath, s);
    out(s, { paused_agent: s.paused_agent });
  },

  resume(pidPath, pos, opt) {
    const s = load(pidPath);
    if (s.status !== 'paused') return out(s, { note: 'No-op (nicht pausiert)' });
    s.status = opt.agent && opt.agent === s.paused_agent ? 'working' : 'idle';
    s.active_agent = s.paused_agent;
    s.turn_index = s.roster.findIndex((r) => r.name === s.paused_agent);
    log(s, s.active_agent, 'session_resumed_by_moderator');
    save(pidPath, s);
    out(s);
  },

  stop(pidPath, pos, opt) {
    const s = load(pidPath);
    if (s.status === 'terminated') return out(s, { note: 'No-op (bereits terminated)' });
    const before = s.status;
    s.status = 'terminated';
    if (opt.outcome) {
      if (opt.outcome === 'MAJORITY_WITH_DISSENT') {
        const c = s.consensus;
        const votes = c.signatures.filter((n) => s.roster.some((r) => r.name === n)).length;
        if (s.mode !== 'decide' || before !== 'deadlock' || !c.proposal_id) fail('MAJORITY_WITH_DISSENT nur im Modus decide, Status deadlock, mit offenem Vorschlag.');
        if (votes * 2 <= s.roster.length) fail(`Keine Mehrheit: ${votes} von ${s.roster.length} haben unterschrieben (> 50 % nötig).`);
      } else if (opt.outcome !== 'NO_CONSENSUS') {
        fail('stop --outcome erlaubt nur NO_CONSENSUS oder MAJORITY_WITH_DISSENT (Entscheidung des Moderators: decide).');
      }
      s.outcome = String(opt.outcome);
    }
    else if (!s.outcome && !s.consensus.reached) s.outcome = s.mode === 'decide' ? 'NO_CONSENSUS' : null;
    log(s, s.active_agent, 'session_terminated_by_moderator');
    save(pidPath, s);
    out(s);
  },

  decide(pidPath, pos) {
    const s = load(pidPath);
    if (s.status === 'terminated') fail('Session ist bereits beendet.');
    if (!pos[0]) fail('decide <topic> "<Entscheidung>"');
    s.status = 'terminated'; s.outcome = 'MODERATOR_DECISION';
    log(s, 'moderator', 'moderator_decision', { text: pos[0] });
    save(pidPath, s);
    out(s, { next: 'Ergebnis-Block schreiben (10.6)' });
  },

  extend(pidPath, pos) {
    const s = load(pidPath);
    const k = Number(pos[0]);
    if (!Number.isInteger(k) || k < 1) fail('extend <topic> <Runden>');
    s.max_rounds += k;
    if (s.status === 'deadlock') s.status = 'idle';
    log(s, 'moderator', 'rounds_extended', { by: k });
    save(pidPath, s);
    out(s);
  },

  note(pidPath, pos) {
    const s = load(pidPath);
    if (!pos[0]) fail('note <topic> "<Text>"');
    const ts = now();
    s.history.push({ round: s.current_round, agent: 'moderator', action: 'moderator_note', timestamp: ts });
    save(pidPath, s);
    console.log(`[MODERATOR_NOTE ${ts}] ${pos[0]}`);
  },

  kick(pidPath, pos) {
    const s = load(pidPath);
    const name = pos[0];
    const old = s.roster.findIndex((r) => r.name === name);
    if (old < 0) fail(`${name} nicht im Roster.`);
    const wasActive = s.active_agent === name;
    const prev = s.active_agent;
    const nextName = s.roster[(old + 1) % s.roster.length].name;
    const wrapped = wasActive && old === s.roster.length - 1;
    s.roster.splice(old, 1);
    s.consensus.signatures = s.consensus.signatures.filter((n) => n !== name);
    const orphan = s.consensus.proposed_by === name && s.consensus.proposal_id && !s.consensus.reached;
    if (orphan) s.consensus = { reached: false, proposal_id: null, proposed_by: null, signatures: [] };
    let extra = {};
    if (s.roster.length === 0) {
      s.status = 'terminated'; s.active_agent = null; s.turn_index = 0;
    } else if (wasActive) {
      s.turn_index = s.roster.findIndex((r) => r.name === nextName);
      s.active_agent = nextName; s.status = 'idle';
      if (wrapped) {
        s.current_round += 1;
        if (s.current_round > s.max_rounds) { s.status = 'deadlock'; extra = { deadlock: 'round_limit' }; }
      }
    } else {
      s.turn_index = s.roster.findIndex((r) => r.name === prev);
    }
    log(s, 'moderator', 'agent_kicked_by_moderator', { removed: name, case: wasActive ? 'B' : 'A', ...(orphan ? { withdrawn_proposal: true } : {}) });
    save(pidPath, s);
    out(s, extra);
  },

  // Rolling Archive (SKILL.md Abschnitt 5, Step 2): verschiebt `## Round <n>`-Abschnitte mit n <= --upto
  // (Standard: current_round - 2) wörtlich nach <topic>.archive.md und lässt eine Stub-Zeile stehen.
  // Verbatim und idempotent; der Abschnitt mit dem offenen Vorschlag bleibt stehen (zum Unterschreiben).
  // Läuft nur im eigenen Zug des aktiven Agenten (nach begin-turn) — dann schreibt sonst niemand ins Dokument.
  archive(pidPath, pos, opt) {
    const s = load(pidPath);
    const topicPath = s.topic_file;
    if (!fs.existsSync(topicPath)) fail(`${topicPath} existiert nicht.`);
    const upto = opt.upto === undefined ? s.current_round - 2 : Number(opt.upto);
    if (!Number.isInteger(upto)) fail('--upto <N> erwartet eine ganze Zahl.');
    const c = s.consensus;
    const openId = c.proposal_id && !c.reached ? c.proposal_id : null;
    const openProposal = openId && new RegExp(`\\[(CONSENSUS|DECISION)_PROPOSAL: ?${openId}\\b`);

    const lines = fs.readFileSync(topicPath, 'utf8').split('\n');
    const sections = []; // { start, end } je `## `-Abschnitt; Fences (```) werden übersprungen
    let fence = false;
    lines.forEach((l, i) => {
      if (/^\s*```/.test(l)) fence = !fence;
      if (!fence && /^## /.test(l)) sections.push({ start: i, end: lines.length });
      if (sections.length > 1 && sections.at(-1).start === i) sections.at(-2).end = i;
    });

    const archiveName = path.basename(topicPath).replace(/\.[^./]+$/, '') + '.archive.md';
    const archivePath = path.join(path.dirname(topicPath), archiveName);
    const moved = [];
    const kept = [];
    let cursor = 0;
    for (const sec of sections) {
      const m = /^## Round (\d+):/.exec(lines[sec.start]);
      const body = lines.slice(sec.start, sec.end);
      if (!m || Number(m[1]) > upto || (openProposal && openProposal.test(body.join('\n')))) continue;
      kept.push(...lines.slice(cursor, sec.start), `## [ARCHIVED] ${lines[sec.start].slice(3)} → ${archiveName}`, '');
      moved.push({ heading: lines[sec.start], body });
      cursor = sec.end;
    }
    if (!moved.length) return out(s, { archived: 0, note: `nichts zu archivieren (upto=${upto})` });
    kept.push(...lines.slice(cursor));

    const header = fs.existsSync(archivePath) ? '' : `# Archive — ${path.basename(topicPath)}\n\nWörtlich aus dem Topic-Dokument verschobene Runden (collab.mjs archive). Beweiskräftig für [AGREED]/[OBJECTION] wie im Original.\n\n`;
    fs.appendFileSync(archivePath, header + moved.map((x) => x.body.join('\n').replace(/\n+$/, '')).join('\n\n') + '\n\n');
    const tmp = `${topicPath}.tmp`;
    fs.writeFileSync(tmp, kept.join('\n'));
    fs.renameSync(tmp, topicPath);
    out(s, { archived: moved.length, sections: moved.map((x) => x.heading), bytes_moved: moved.reduce((n, x) => n + Buffer.byteLength(x.body.join('\n')), 0), archive: archivePath });
  },

  validate(pidPath) {
    const errs = validate(load(pidPath));
    if (errs.length) {
      const e = new CollabError(`INVALID: ${errs.join('; ')}`);
      e.exitCode = 2;
      throw e;
    }
    console.log('OK');
  },

  async watch(pidPath, pos, opt) {
    const agent = pos[0];
    if (!agent) fail('watch <topic> <AgentName> [--timeout <Sekunden>] [--interval <ms>]');
    const timeoutSec = opt.timeout !== undefined ? Number(opt.timeout) : 0;
    const intervalMs = opt.interval !== undefined ? Number(opt.interval) : 1000;

    const check = () => {
      if (!fs.existsSync(pidPath)) return null;
      try {
        const s = load(pidPath);
        if (s.status === 'terminated' || s.status === 'deadlock') {
          return { done: true, event: 'session_ended', status: s.status, outcome: s.outcome, round: s.current_round };
        }
        if (s.active_agent === agent && ['idle', 'working'].includes(s.status)) {
          return { done: true, event: 'turn_ready', agent, round: s.current_round, status: s.status, timestamp: now() };
        }
        return { done: false, active_agent: s.active_agent, status: s.status };
      } catch {
        return null;
      }
    };

    const initial = check();
    if (initial?.done) {
      console.log(JSON.stringify(initial, null, 2));
      return;
    }

    return new Promise((resolve, reject) => {
      let timeoutTimer = null;
      let intervalTimer = null;
      let fsWatcher = null;
      let dirWatcher = null;
      let finished = false;

      const cleanup = () => {
        finished = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (intervalTimer) clearInterval(intervalTimer);
        if (fsWatcher) { try { fsWatcher.close(); } catch {} }
        if (dirWatcher) { try { dirWatcher.close(); } catch {} }
      };

      const onStateChange = () => {
        if (finished) return;
        const res = check();
        if (res?.done) {
          cleanup();
          console.log(JSON.stringify(res, null, 2));
          resolve();
        }
      };

      const dir = path.dirname(pidPath);
      try {
        if (fs.existsSync(dir)) {
          dirWatcher = fs.watch(dir, (eventType, filename) => {
            if (!filename || filename === path.basename(pidPath)) {
              onStateChange();
            }
          });
        }
      } catch {}

      try {
        if (fs.existsSync(pidPath)) {
          fsWatcher = fs.watch(pidPath, () => onStateChange());
        }
      } catch {}

      intervalTimer = setInterval(onStateChange, intervalMs);

      if (timeoutSec > 0) {
        timeoutTimer = setTimeout(() => {
          cleanup();
          const lastState = check();
          const err = new CollabError(`Timeout (${timeoutSec}s) beim Warten auf Zug von ${agent}. Aktueller Status: ${lastState?.status ?? 'unbekannt'}, aktiv: ${lastState?.active_agent ?? 'unbekannt'}`);
          err.exitCode = 3;
          reject(err);
        }, timeoutSec * 1000);
      }
    });
  },

  status() {
    const dir = DEFAULT_DIR;
    const pidFiles = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.pid')) : [];
    const boardFiles = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.board.jsonl')) : [];
    if (!pidFiles.length && !boardFiles.length) return console.log(`Keine Sessions in ${dir}.`);

    if (pidFiles.length) {
      console.log('### 🔄 Round-Robin Sessions (.pid)\n');
      console.log('| Thema | Modus | Status | Runde | Aktiv | Letzter Eintrag |\n| :-- | :-- | :-- | :-- | :-- | :-- |');
      for (const f of pidFiles) {
        try {
          const s = load(path.join(dir, f));
          const last = s.history.at(-1)?.timestamp ?? '—';
          console.log(`| ${f.replace(/\.pid$/, '')} | ${s.mode} | ${s.status} | ${s.current_round}/${s.max_rounds} | ${s.active_agent ?? '—'} | ${last} |`);
        } catch {}
      }
      console.log('');
    }

    if (boardFiles.length) {
      console.log('### 📋 Blackboard Sessions (.board.jsonl)\n');
      console.log('| Thema | Modus | Status | Coordinator | Tasks (Offen/Gesamt) | Events | Letzter Eintrag |\n| :-- | :-- | :-- | :-- | :-- | :-- | :-- |');
      for (const f of boardFiles) {
        try {
          const boardPath = path.join(dir, f);
          const events = readBoardEvents(boardPath);
          const state = projectBoard(events);
          const tasks = Object.values(state.tasks);
          const openTasks = tasks.filter((t) => t.status !== 'completed').length;
          const last = events.at(-1)?.timestamp ?? '—';
          console.log(`| ${f.replace(/\.board\.jsonl$/, '')} | ${state.mode} | ${state.status} | ${state.coordinator ?? '—'} | ${openTasks}/${tasks.length} | ${events.length} | ${last} |`);
        } catch {}
      }
    }
  },

  'board-init'(boardPath, pos, opt) {
    if (fs.existsSync(boardPath)) fail(`${boardPath} existiert bereits.`);
    const coordinator = pos[0] ?? opt.coordinator ?? null;
    const mode = opt.mode ?? 'plan';
    const topic = path.basename(boardPath).replace(/\.board\.jsonl$/, '');
    const max_agents = opt['max-agents'] ? Number(opt['max-agents']) : null;
    appendBoardEvent(boardPath, {
      type: 'board_initialized',
      topic,
      coordinator,
      mode,
      ...(max_agents ? { max_agents } : {}),
    });
    if (coordinator && opt.role) {
      appendBoardEvent(boardPath, {
        type: 'agent_joined',
        agent: coordinator,
        role: opt.role,
        stance: opt.stance ?? null,
      });
    }
    const state = projectBoard(readBoardEvents(boardPath));
    console.log(JSON.stringify({
      status: state.status,
      mode: state.mode,
      coordinator: state.coordinator,
      max_agents: state.max_agents,
      board: boardPath,
      events: state.eventCount,
    }, null, 2));
  },

  'board-limit'(boardPath, pos, opt) {
    const rawLimit = pos[0] ?? opt.limit;
    if (!rawLimit) fail('board-limit <topic> <N>');
    const limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1) fail('board-limit: N muss eine positive ganze Zahl sein.');

    const events = readBoardEvents(boardPath);
    const state = projectBoard(events);
    const rosterList = Object.keys(state.roster);

    appendBoardEvent(boardPath, {
      type: 'board_limit_set',
      limit,
    });

    const evicted = [];
    const reallocatedTasks = [];

    if (rosterList.length > limit) {
      // Keep coordinator if possible, evict most recently joined agents beyond limit
      const candidates = rosterList.filter((name) => name !== state.coordinator);
      const toRemoveCount = rosterList.length - limit;
      const agentsToEvict = candidates.slice(-toRemoveCount);

      for (const agent of agentsToEvict) {
        appendBoardEvent(boardPath, {
          type: 'agent_evicted',
          agent,
          reason: `Reduced team limit to ${limit}`,
        });
        evicted.push(agent);
      }

      // Check tasks previously assigned to evicted agents that need reassignment
      for (const t of Object.values(state.tasks)) {
        if (agentsToEvict.includes(t.assignedTo) && t.status !== 'completed') {
          reallocatedTasks.push(t.id);
        }
      }
    }

    const updatedState = projectBoard(readBoardEvents(boardPath));
    console.log(JSON.stringify({
      status: 'limit_updated',
      max_agents: limit,
      active_agents: Object.keys(updatedState.roster),
      evicted,
      tasks_reopened_for_reassignment: reallocatedTasks,
    }, null, 2));
  },

  'board-join'(boardPath, pos, opt) {
    const agent = pos[0];
    if (!agent) fail('board-join <topic> <Agent> [--role <Role>] [--stance <Stance>]');
    const events = readBoardEvents(boardPath);
    const state = projectBoard(events);
    if (state.max_agents && Object.keys(state.roster).length >= state.max_agents && !state.roster[agent]) {
      fail(`Team-Limit (${state.max_agents} Agenten) bereits erreicht.`);
    }
    appendBoardEvent(boardPath, {
      type: 'agent_joined',
      agent,
      role: opt.role ?? '',
      stance: opt.stance ?? null,
    });
    console.log(JSON.stringify({ agent, role: opt.role ?? '', stance: opt.stance ?? null }, null, 2));
  },

  'post-task'(boardPath, pos, opt) {
    const author = pos[0];
    const title = pos[1] ?? opt.title;
    if (!author || !title) fail('post-task <topic> <Author> "<Title>" [--assign <Agent>] [--id <TaskId>]');
    const events = readBoardEvents(boardPath);
    const state = projectBoard(events);
    const taskId = opt.id ?? pos[2] ?? `T${Object.keys(state.tasks).length + 1}`;
    const assignedTo = opt.assign ?? null;

    appendBoardEvent(boardPath, {
      type: 'task_posted',
      taskId,
      title,
      author,
      assignedTo,
    });
    console.log(JSON.stringify({ taskId, title, assignedTo, author, status: assignedTo ? 'claimed' : 'open' }, null, 2));
  },

  'claim-task'(boardPath, pos) {
    const [agent, taskId] = pos;
    if (!agent || !taskId) fail('claim-task <topic> <Agent> <TaskId>');
    const events = readBoardEvents(boardPath);
    const state = projectBoard(events);
    if (!state.tasks[taskId]) fail(`Task ${taskId} existiert nicht.`);
    if (state.tasks[taskId].status === 'completed') fail(`Task ${taskId} ist bereits abgeschlossen.`);

    appendBoardEvent(boardPath, {
      type: 'task_claimed',
      taskId,
      agent,
    });
    console.log(JSON.stringify({ taskId, agent, status: 'in_progress' }, null, 2));
  },

  'complete-task'(boardPath, pos, opt) {
    const [agent, taskId] = pos;
    if (!agent || !taskId) fail('complete-task <topic> <Agent> <TaskId> [--result "<Summary>"]');
    const events = readBoardEvents(boardPath);
    const state = projectBoard(events);
    if (!state.tasks[taskId]) fail(`Task ${taskId} existiert nicht.`);

    const result = opt.result ?? pos[2] ?? null;
    appendBoardEvent(boardPath, {
      type: 'task_completed',
      taskId,
      agent,
      result,
    });
    console.log(JSON.stringify({ taskId, agent, status: 'completed', result }, null, 2));
  },

  'post-finding'(boardPath, pos, opt) {
    const agent = pos[0];
    const title = opt.title ?? pos[1];
    if (!agent || !title) fail('post-finding <topic> <Agent> --title "<Title>" [--task <TaskId>] [--severity info|minor|major|critical] [--file <Path>] [--line <N>] [--desc "<Desc>"]');
    const events = readBoardEvents(boardPath);
    const state = projectBoard(events);
    const findingId = opt.id ?? `F${state.findings.length + 1}`;

    appendBoardEvent(boardPath, {
      type: 'finding_posted',
      findingId,
      taskId: opt.task ?? null,
      severity: opt.severity ?? 'info',
      file: opt.file ?? null,
      line: opt.line ? Number(opt.line) : null,
      title,
      description: opt.desc ?? opt.description ?? '',
      author: agent,
    });
    console.log(JSON.stringify({ findingId, taskId: opt.task ?? null, severity: opt.severity ?? 'info', title, author: agent }, null, 2));
  },

  'post-proposal'(boardPath, pos, opt) {
    const [agent, proposalId, titleArg] = pos;
    const title = titleArg ?? opt.title;
    if (!agent || !proposalId || !title) fail('post-proposal <topic> <Agent> <P<n>> "<Title>" [--desc "<Desc>"]');
    const events = readBoardEvents(boardPath);
    const state = projectBoard(events);
    if (state.proposals[proposalId]) fail(`Vorschlags-ID ${proposalId} existiert bereits.`);

    appendBoardEvent(boardPath, {
      type: 'proposal_posted',
      proposalId,
      title,
      description: opt.desc ?? opt.description ?? '',
      author: agent,
    });
    console.log(JSON.stringify({ proposalId, title, proposedBy: agent }, null, 2));
  },

  'post-vote'(boardPath, pos, opt) {
    const [agent, proposalId, voteArg] = pos;
    const vote = (voteArg ?? opt.vote ?? '').toUpperCase();
    if (!agent || !proposalId || !['AGREE', 'DISAGREE', 'DISSENT'].includes(vote)) {
      fail('post-vote <topic> <Agent> <P<n>> <AGREE|DISAGREE|DISSENT> [--reason "<Reason>"]');
    }
    const events = readBoardEvents(boardPath);
    const state = projectBoard(events);
    if (!state.proposals[proposalId]) fail(`Vorschlag ${proposalId} existiert nicht.`);

    appendBoardEvent(boardPath, {
      type: 'vote_posted',
      proposalId,
      agent,
      vote,
      reason: opt.reason ?? null,
    });
    console.log(JSON.stringify({ proposalId, agent, vote, reason: opt.reason ?? null }, null, 2));
  },

  'resolve-board'(boardPath, pos, opt) {
    const author = pos[0];
    const outcome = opt.outcome ?? pos[1];
    if (!author || !outcome) fail('resolve-board <topic> <Author> --outcome <Outcome> [--summary "<Summary>"]');

    appendBoardEvent(boardPath, {
      type: 'board_resolved',
      outcome,
      summary: opt.summary ?? pos[2] ?? null,
      author,
    });
    console.log(JSON.stringify({ outcome, summary: opt.summary ?? null, status: 'resolved' }, null, 2));
  },

  board(boardPath, pos, opt) {
    const events = readBoardEvents(boardPath);
    const state = projectBoard(events);
    if (opt.json) {
      console.log(JSON.stringify(state, null, 2));
    } else {
      const tasks = Object.values(state.tasks);
      const openTasks = tasks.filter((t) => t.status !== 'completed');
      console.log(JSON.stringify({
        topic: state.topic,
        status: state.status,
        mode: state.mode,
        coordinator: state.coordinator,
        max_agents: state.max_agents,
        roster: Object.keys(state.roster),
        tasks_total: tasks.length,
        tasks_open: openTasks.map((t) => ({ id: t.id, title: t.title, assignedTo: t.assignedTo, status: t.status })),
        findings: state.findings.length,
        proposals: Object.keys(state.proposals).map((k) => ({ id: k, status: state.proposals[k].status, votes: Object.keys(state.proposals[k].votes).length })),
        outcome: state.outcome,
        events: state.eventCount,
      }, null, 2));
    }
  },

  render(boardPath, pos, opt) {
    const events = readBoardEvents(boardPath);
    const state = projectBoard(events);
    const topicPath = boardPath.replace(/\.board\.jsonl$/, '.md');
    const md = renderBoardToMarkdown(state, topicPath);
    if (opt.stdout) {
      console.log(md);
    } else {
      fs.writeFileSync(topicPath, md + '\n', 'utf8');
      console.log(JSON.stringify({ rendered: topicPath, events: events.length, status: state.status }, null, 2));
    }
  },

  async 'board-watch'(boardPath, pos, opt) {
    const taskId = opt.task;
    const agent = opt.agent;
    const timeoutSec = opt.timeout !== undefined ? Number(opt.timeout) : 0;
    const intervalMs = opt.interval !== undefined ? Number(opt.interval) : 500;

    let lastEventCount = fs.existsSync(boardPath) ? readBoardEvents(boardPath).length : 0;

    const check = () => {
      if (!fs.existsSync(boardPath)) return null;
      try {
        const events = readBoardEvents(boardPath);
        const state = projectBoard(events);

        if (state.status === 'resolved') {
          return { done: true, event: 'board_resolved', outcome: state.outcome, summary: state.summary };
        }

        if (taskId && state.tasks[taskId]) {
          const task = state.tasks[taskId];
          if (task.status === 'completed' || (agent && task.assignedTo === agent)) {
            return { done: true, event: 'task_updated', task };
          }
        }

        if (agent) {
          const assigned = Object.values(state.tasks).find((t) => t.assignedTo === agent && t.status !== 'completed');
          if (assigned) {
            return { done: true, event: 'task_assigned', task: assigned };
          }
        }

        if (!taskId && !agent && events.length > lastEventCount) {
          return { done: true, event: 'new_events', count: events.length - lastEventCount, lastEvent: events.at(-1) };
        }

        return { done: false, eventCount: events.length, status: state.status };
      } catch {
        return null;
      }
    };

    const initial = check();
    if (initial?.done) {
      console.log(JSON.stringify(initial, null, 2));
      return;
    }

    return new Promise((resolve, reject) => {
      let timeoutTimer = null;
      let intervalTimer = null;
      let fsWatcher = null;
      let dirWatcher = null;
      let finished = false;

      const cleanup = () => {
        finished = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (intervalTimer) clearInterval(intervalTimer);
        if (fsWatcher) { try { fsWatcher.close(); } catch {} }
        if (dirWatcher) { try { dirWatcher.close(); } catch {} }
      };

      const onEvent = () => {
        if (finished) return;
        const res = check();
        if (res?.done) {
          cleanup();
          console.log(JSON.stringify(res, null, 2));
          resolve();
        }
      };

      const dir = path.dirname(boardPath);
      try {
        if (fs.existsSync(dir)) {
          dirWatcher = fs.watch(dir, (eventType, filename) => {
            if (!filename || filename === path.basename(boardPath)) {
              onEvent();
            }
          });
        }
      } catch {}

      try {
        if (fs.existsSync(boardPath)) {
          fsWatcher = fs.watch(boardPath, () => onEvent());
        }
      } catch {}

      intervalTimer = setInterval(onEvent, intervalMs);

      if (timeoutSec > 0) {
        timeoutTimer = setTimeout(() => {
          cleanup();
          const err = new CollabError(`Timeout (${timeoutSec}s) beim Warten auf Blackboard-Event in ${boardPath}.`);
          err.exitCode = 3;
          reject(err);
        }, timeoutSec * 1000);
      }
    });
  },
};

// ---- Einstieg ------------------------------------------------------------------------------

const BOARD_COMMANDS = new Set([
  'board-init', 'board-limit', 'board-join', 'post-task', 'claim-task', 'complete-task',
  'post-finding', 'post-proposal', 'post-vote', 'resolve-board',
  'board', 'render', 'board-watch',
]);

const READ_ONLY_COMMANDS = new Set(['validate', 'watch', 'status', 'board', 'render', 'board-watch', 'archive']); // archive schreibt nur das Topic-Dokument, nie die .pid

const { pos, opt } = parseArgs(process.argv.slice(2));
const [cmd, topic, ...rest] = pos;
if (!cmd || !commands[cmd]) {
  console.error(`Befehle: ${Object.keys(commands).join(' | ')}\nBeispiel: node collab.mjs end-turn diorama.md Alice --novelty true`);
  process.exit(1);
}
if (cmd === 'status') { commands.status(); process.exit(0); }

const targetPath = BOARD_COMMANDS.has(cmd) ? resolveBoard(topic) : resolvePid(topic);
try {
  if (READ_ONLY_COMMANDS.has(cmd) || BOARD_COMMANDS.has(cmd)) {
    await commands[cmd](targetPath, rest, opt);
  } else {
    await withLock(targetPath, async () => commands[cmd](targetPath, rest, opt));
  }
} catch (e) {
  if (!(e instanceof CollabError)) throw e;
  console.error(`ERROR: ${e.message}`);
  process.exitCode = e.exitCode ?? 1;
}

