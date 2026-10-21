/**
 * Adapter: the session stores, read for a program that is not cuesheet.
 *
 * Two stores hold sessions on a machine, written by two surfaces:
 *
 * ```text
 * run and chat      CUESHEET_SESSIONS, else ~/.cuesheet/sessions
 *                   one <id>.jsonl per session
 * terminal          CUESHEET_SESSIONS, else $XDG_STATE_HOME/cuesheet/terminal/sessions,
 *                   else ~/.local/state/cuesheet/terminal/sessions
 *                   <id>.meta.json, <id>.jsonl and <id>.view.jsonl per session
 * ```
 *
 * Neither file layout is an interface. This listing is: `cuesheet sessions
 * --format json` prints it, the README documents it, and its `version` changes
 * when its shape does. A reader outside this repository reads that, never the
 * files.
 *
 * The rule the whole file runs on is that a reader writes nothing. It does not
 * construct a `SessionStore`, whose constructor creates its root, and it does
 * not touch a writer's claim. It lists directories, stats files and reads them.
 * An absent store is reported as absent, not created.
 *
 * The second rule is the one the rest of the repository already keeps: what
 * could not be read is reported as unread. An empty log is listed with zero
 * events, a damaged one with the events it attests and the reason it stops,
 * and a store that could not be listed says so instead of looking empty.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { EventStore, type Event } from "../core/store.ts";
import { attestJournal, type JournalDamage } from "./session-store.ts";

/** The shape version. A change a reader could notice is a new number. */
export const SESSION_LISTING_VERSION = 1;

export type SessionKind = "run" | "chat" | "terminal";

export interface ListedSession {
  id: string;
  kind: SessionKind;
  /** The working directory the session recorded, or null when it records none. */
  cwd: string | null;
  createdAt: string | null;
  lastEventAt: string | null;
  /** Events the journal attests. Zero for an empty log, which is still listed. */
  events: number;
  /** The goal state the core fold gives: open, closed, or null without a goal. */
  status: "open" | "closed" | null;
  /** Why the journal stops being readable, or null when all of it was. */
  damage: { why: string; line: number | null } | null;
  /** The journal this entry was read from. */
  file: string;
}

export interface ListedStore {
  kinds: SessionKind[];
  path: string;
  /** read: listed. absent: does not exist, so nothing was there. unreadable: unknown. */
  state: "read" | "absent" | "unreadable";
  error: string | null;
}

export interface SessionListing {
  version: typeof SESSION_LISTING_VERSION;
  stores: ListedStore[];
  filters: { since: string | null; cwd: string | null };
  sessions: ListedSession[];
}

export interface SessionRoots {
  runs: string;
  terminal: string;
}

/**
 * Where each store lives, resolved the way its writer resolves it.
 *
 * Restated rather than imported: `cli-run.ts` resolves the run root at module
 * scope and `terminalSessionRoot` lives beside the whole terminal journal. A
 * test holds both in step with the writers.
 */
export function sessionRoots(env: NodeJS.ProcessEnv = process.env): SessionRoots {
  const home = env.HOME || homedir();
  return {
    runs: env.CUESHEET_SESSIONS ?? join(home, ".cuesheet", "sessions"),
    terminal:
      env.CUESHEET_SESSIONS ||
      join(env.XDG_STATE_HOME || join(home, ".local", "state"), "cuesheet", "terminal", "sessions"),
  };
}

export interface ListOptions {
  /** Keep sessions active at or after this instant (last event, else creation). */
  since?: Date;
  /** Keep sessions whose cwd is this directory or inside it. */
  cwd?: string;
}

const terminalId = (id: string) => /^t-[A-Za-z0-9_-]+$/.test(id);

const iso = (ms: unknown): string | null =>
  typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;

function damageOf(damage: JournalDamage | null): ListedSession["damage"] {
  if (!damage) return null;
  return { why: damage.why, line: "line" in damage ? damage.line : null };
}

/** The core fold's goal state. A log the fold cannot read gives no status. */
function statusOf(events: Event[]): ListedSession["status"] {
  if (events.length === 0) return null;
  try {
    const store = new EventStore("listing", () => 0);
    for (const event of events) store.append(event);
    const goal = store.toSession().goal;
    return goal ? (goal.open ? "open" : "closed") : null;
  } catch {
    return null;
  }
}

/** When a file came to exist, for a log with no event to date it. */
function fileTime(file: string): string | null {
  try {
    const stat = statSync(file);
    return iso(stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs);
  } catch {
    return null;
  }
}

function runSession(dir: string, id: string): ListedSession {
  const file = join(dir, `${id}.jsonl`);
  const log = attestJournal(file);
  return {
    id,
    kind: id.startsWith("chat-") ? "chat" : "run",
    cwd: null,
    createdAt: iso(log.events[0]?.at) ?? fileTime(file),
    lastEventAt: iso(log.events.at(-1)?.at),
    events: log.events.length,
    status: statusOf(log.events),
    damage: damageOf(log.damage),
    file,
  };
}

/** The fields of a terminal manifest this listing uses, or null if it is not one. */
function terminalMetadata(dir: string, id: string): { cwd: string; createdAt: number } | null {
  try {
    const value = JSON.parse(readFileSync(join(dir, `${id}.meta.json`), "utf8")) as Record<string, unknown>;
    if (value.version !== 1 || value.id !== id) return null;
    if (typeof value.cwd !== "string" || !value.cwd.startsWith("/")) return null;
    if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) return null;
    return { cwd: value.cwd, createdAt: value.createdAt };
  } catch {
    return null;
  }
}

function terminalSession(dir: string, id: string, names: Set<string>): ListedSession {
  const file = join(dir, `${id}.jsonl`);
  const hasMeta = names.has(`${id}.meta.json`);
  const metadata = hasMeta ? terminalMetadata(dir, id) : null;
  const core = names.has(`${id}.jsonl`) ? attestJournal(file) : null;
  const view = names.has(`${id}.view.jsonl`) ? attestJournal(join(dir, `${id}.view.jsonl`)) : null;
  const events = core?.events ?? [];
  // The conversation journal moves too, so the last activity is the later of the two.
  const last = Math.max(events.at(-1)?.at ?? -Infinity, view?.events.at(-1)?.at ?? -Infinity);
  let damage = damageOf(core?.damage ?? null);
  if (!damage && !hasMeta) damage = { why: "metadata_missing", line: null };
  if (!damage && !metadata) damage = { why: "metadata_invalid", line: null };
  if (!damage && !core) damage = { why: "journal_missing", line: null };
  return {
    id,
    kind: "terminal",
    cwd: metadata?.cwd ?? null,
    createdAt: iso(metadata?.createdAt) ?? iso(events[0]?.at) ?? fileTime(file),
    lastEventAt: iso(last),
    events: events.length,
    status: statusOf(events),
    damage,
    file,
  };
}

/** Sessions in one directory, classified by file name. Nothing else is opened. */
function scan(dir: string, names: string[], runs: boolean, terminal: boolean): ListedSession[] {
  const present = new Set(names);
  const out: ListedSession[] = [];
  const seenTerminal = new Set<string>();
  for (const name of names) {
    if (name.endsWith(".view.jsonl")) continue; // a terminal conversation, part of its session
    if (name.endsWith(".meta.json")) {
      const id = name.slice(0, -".meta.json".length);
      if (terminal && terminalId(id) && !seenTerminal.has(id)) {
        seenTerminal.add(id);
        out.push(terminalSession(dir, id, present));
      }
      continue;
    }
    if (!name.endsWith(".jsonl")) continue; // locks, pending writes, trash
    const id = name.slice(0, -".jsonl".length);
    if (terminal && terminalId(id)) {
      if (!seenTerminal.has(id)) {
        seenTerminal.add(id);
        out.push(terminalSession(dir, id, present));
      }
      continue;
    }
    if (runs) out.push(runSession(dir, id));
  }
  return out;
}

function list(dir: string): { names: string[] } | { state: "absent" | "unreadable"; error: string | null } {
  try {
    return { names: readdirSync(dir) };
  } catch (err) {
    const code = typeof err === "object" && err !== null && "code" in err ? String(err.code) : "unknown";
    return code === "ENOENT" ? { state: "absent", error: null } : { state: "unreadable", error: code };
  }
}

const activity = (s: ListedSession) => Date.parse(s.lastEventAt ?? s.createdAt ?? "") || -Infinity;

function insideDirectory(cwd: string, prefix: string): boolean {
  return cwd === prefix || cwd.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}

/** Every session both stores hold, read without writing anything. */
export function listSessions(roots: SessionRoots, options: ListOptions = {}): SessionListing {
  const runsDir = resolve(roots.runs);
  const terminalDir = resolve(roots.terminal);
  // CUESHEET_SESSIONS points both writers at one directory; it is then read once.
  const passes =
    runsDir === terminalDir
      ? [{ dir: runsDir, runs: true, terminal: true }]
      : [
          { dir: runsDir, runs: true, terminal: false },
          { dir: terminalDir, runs: false, terminal: true },
        ];

  const stores: ListedStore[] = [];
  let sessions: ListedSession[] = [];
  for (const pass of passes) {
    const kinds: SessionKind[] = [...(pass.runs ? (["run", "chat"] as const) : []), ...(pass.terminal ? (["terminal"] as const) : [])];
    const listed = list(pass.dir);
    if ("names" in listed) {
      stores.push({ kinds, path: pass.dir, state: "read", error: null });
      sessions.push(...scan(pass.dir, listed.names.sort(), pass.runs, pass.terminal));
    } else {
      stores.push({ kinds, path: pass.dir, state: listed.state, error: listed.error });
    }
  }

  const cwd = options.cwd ? resolve(options.cwd) : null;
  if (options.since) {
    const since = options.since.getTime();
    sessions = sessions.filter((s) => activity(s) >= since);
  }
  if (cwd) {
    sessions = sessions.filter((s) => s.cwd !== null && insideDirectory(s.cwd, cwd));
  }
  sessions.sort((a, b) => activity(b) - activity(a) || a.id.localeCompare(b.id));

  return {
    version: SESSION_LISTING_VERSION,
    stores,
    filters: { since: options.since ? options.since.toISOString() : null, cwd },
    sessions,
  };
}
