/**
 * CLI: run a goal under a session that owns its own state.
 *
 * Every subcommand here is a thin shell around the core. The point of the file
 * is not convenience, it is that the loop can be driven, interrupted, resumed
 * and inspected from a terminal, which is the only way to see whether a
 * session actually survives its process.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveCapabilities, type Capability } from "../src/core/capability.ts";
import { runAgentLoop, type ModelAdapter, type ToolRequest, type ToolResult } from "../src/core/loop.ts";
import { EventStore, type Event } from "../src/core/store.ts";
import { SkillsAdapter, type SkillListing } from "../src/adapters/skills.ts";
import { resolveModel } from "../src/adapters/default-model.ts";
import { SessionStore } from "../src/adapters/session-store.ts";
import { listSessions, sessionRoots } from "../src/adapters/session-reader.ts";
import { ShellToolRunner } from "../src/adapters/shell.ts";
import { isEntryPoint } from "./is-entry-point.ts";

// Overridable so an integration test can drive the real surface against a
// throwaway root instead of the real one. `rm -rf` on a developer's home is
// not a thing a test should need, and a test that cleans up after itself by
// deleting the user's sessions is not a test.
const SESSION_ROOT =
  process.env.CUESHEET_SESSIONS ?? join(homedir(), ".cuesheet", "sessions");
const SKILL_ROOTS = [join(homedir(), ".agents", "skills")];

function fail(message: string): never {
  console.error(`cuesheet: ${message}`);
  process.exit(2);
}

function usage(): never {
  console.log(`cuesheet, a session that owns its own state

  cuesheet run <goal> --in <dir> [--session <id>] [--max-steps N]
                     [--requires <file>] [--model <id>] [--allow tool,...]

  cuesheet resume <session> --in <dir> [--max-steps N]

  cuesheet sessions [--format json] [--since <iso>] [--cwd <dir>]
      list the sessions stored on this machine; --format json lists run, chat
      and terminal sessions in the versioned shape the README documents, and
      writes nothing

  cuesheet inspect <session>
      replay a session log and print what the log actually shows

  cuesheet capabilities
      resolve the live skill registry, the way a delegation would

A run needs a model. It uses the local opencode binary when one is installed, at
no credit cost; set CUESHEET_OPENCODE_BIN if it lives somewhere unusual. For the
paid provider, set CUESHEET_PROVIDER=openrouter and OPENROUTER_API_KEY. An
exported key alone does not switch providers, so a run's cost is never decided
by accident.
`);
  process.exit(2);
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

/** The live registry and the limits of what was observed, never just the list. */
function liveRegistry(): SkillListing {
  return new SkillsAdapter({ roots: SKILL_ROOTS }).listCapabilities();
}

function loadRequirements(file: string): Array<{ kind: string; name: string }> {
  if (!existsSync(file)) {
    fail(`requirements file not found: ${file}`);
  }
  const parsed = JSON.parse(readFileSync(file, "utf8")) as {
    requirements?: Array<{ kind: string; name: string }>;
  };
  if (!Array.isArray(parsed.requirements)) {
    fail(`${file} must be {"requirements": [{"kind": ..., "name": ...}]}`);
  }
  return parsed.requirements;
}

function newId(): string {
  return "ses_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

async function cmdRun(argv: string[]): Promise<number> {
  const goal = argv.find((a) => !a.startsWith("--"));
  if (!goal) fail("run needs a goal as its first argument");
  const flags = parseArgs(argv);
  const dir = flags.in ?? process.cwd();
  const maxSteps = Number(flags["max-steps"] ?? 8);
  if (!Number.isFinite(maxSteps) || maxSteps <= 0) fail("--max-steps needs a positive number");

  // The model, resolved the way every other surface resolves it. This used to
  // demand `OPENROUTER_API_KEY` and announce that no local runtime existed on
  // this machine, which was false: one is installed and configured. `--model`
  // still overrides, and an explicit `CUESHEET_PROVIDER=openrouter` still opts
  // into the paid provider.
  const resolved = resolveModel({ project: dir, model: flags.model });
  if ("missing" in resolved) {
    fail(resolved.missing);
  }

  const requires = flags.requires ? loadRequirements(flags.requires) : [];
  const model = resolved.adapter;
  console.error(`model: ${resolved.name} (${resolved.why})`);

  const allow = (flags.allow ?? "node,git,rg,ls,cat").split(",").map((a) => a.trim()).filter(Boolean);
  const tools = new ShellToolRunner({
    allow,
    roots: [dir],
    defaultCwd: dir,
  });

  const sessionId = flags.session ?? newId();
  const durable = new SessionStore({ root: SESSION_ROOT });
  const store = new EventStore(sessionId, () => Date.now());

  // Rehydrate an existing session so resume and run share one code path.
  for (const event of durable.read(sessionId)) {
    store.append(event);
  }

  // Tell the model which verbs this run can actually run.
  //
  // It was never told, on any provider, and the cost was invisible until a live
  // run: the allow list was enforced at the runner, so a model proposing a verb
  // outside it got `exit: 127` and no explanation of why the verb was unavailable.
  // A real run recorded the model saying it could not act because no
  // directives declared a vocabulary, which was true and unhelpful.
  //
  // Declared here rather than in the runner because the runner must not grow a
  // second opinion about what it is allowed to run, and the core must not know
  // any provider's vocabulary.
  store.append({
    kind: "directive",
    subject: flags.subject ?? "builder",
    data: { text: `tools: ${allow.join(", ")}` },
  });

  const outcome = await runAgentLoop(store, model, tools, {
    subject: flags.subject ?? "builder",
    goal,
    requires,
    registry: liveRegistry().capabilities,
    maxSteps,
  });

  // Persist whatever the loop appended, so the session outlives this process.
  const before = durable.read(sessionId).length;
  const all = outcome.session.events;
  // These are already-sequenced events coming out of the loop's own store, so
  // their order is history rather than something to re-derive. Replay preserves
  // it; `append` would renumber and rewrite it.
  durable.replayAll(sessionId, all.slice(before));

  printOutcome(outcome, sessionId, dir);
  return outcome.stop.reason === "blocked" ? 1 : 0;
}

function printOutcome(
  outcome: Awaited<ReturnType<typeof runAgentLoop>>,
  sessionId: string,
  dir: string,
): void {
  console.log(`session: ${sessionId}`);
  console.log(`  goal      : ${outcome.session.goal?.text ?? "(none)"}`);
  console.log(`  events    : ${outcome.session.events.length}`);
  console.log(`  evidence  : ${outcome.session.evidence.length}`);
  console.log(`  claims    : ${outcome.claims.length} (a claim is not evidence)`);

  if (outcome.session.evidence.length > 0) {
    console.log("\nevidence:");
    for (const e of outcome.session.evidence) {
      console.log(`  - ${e.claim}  [backing: ${e.backing || "none recorded"}]`);
    }
  }

  console.log(`\nstop: ${outcome.stop.reason}`);
  if (outcome.stop.reason === "blocked") {
    console.log(`  missing: ${outcome.stop.missing.join(", ")}`);
  }
  console.log(`\nresume with: cuesheet resume ${sessionId} --in ${dir}`);
}

async function cmdResume(argv: string[]): Promise<number> {
  const sessionId = argv.find((a) => !a.startsWith("--"));
  if (!sessionId) fail("resume needs a session id");
  const flags = parseArgs(argv);
  const dir = flags.in ?? process.cwd();
  const durable = new SessionStore({ root: SESSION_ROOT });
  const events = durable.read(sessionId);
  if (events.length === 0) fail(`no events for session ${sessionId}`);

  const store = new EventStore(sessionId, () => Date.now());
  for (const event of events) {
    store.append(event);
  }
  const session = store.toSession();

  console.log(`session: ${sessionId}   replayed ${events.length} events`);
  console.log(`  goal       : ${session.goal?.text ?? "(none)"}`);
  console.log(`  goal open  : ${session.goal?.open ?? "n/a"}`);
  console.log(`  evidence   : ${session.evidence.length}`);
  console.log(`  open directives : ${session.openDirectives.length}`);
  for (const [subject, binding] of session.models) {
    console.log(`  model ${subject} : ${binding.model}`);
  }
  return 0;
}

function cmdSessions(argv: string[]): number {
  const flags = parseArgs(argv);
  const format = flags.format ?? "text";
  if (format !== "text" && format !== "json") fail(`--format must be text or json, not ${format}`);
  if (format === "json") return cmdSessionsJson(flags);
  if (flags.since || flags.cwd) fail("--since and --cwd filter the JSON listing: add --format json");

  const dir = SESSION_ROOT;
  // Checked before the store exists, because constructing one creates its root
  // and a listing has no business creating anything.
  if (!existsSync(dir)) {
    console.log("no sessions yet");
    return 0;
  }
  const durable = new SessionStore({ root: SESSION_ROOT });
  const files = execFileSync("ls", [dir], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".jsonl"));
  if (files.length === 0) {
    console.log("no sessions yet");
    return 0;
  }
  // One damaged session must not make the others unreachable.
  //
  // `read()` throws on a journal whose tail was never committed, so a listing
  // that used it showed nothing at all: the one broken file removed the ability
  // to see the healthy ones. And the fix must not go the other way either, by
  // treating an unreadable session as an empty one, which is the same silence
  // from the opposite direction. So damage is shown as damage.
  let damaged = 0;
  for (const file of files) {
    const id = file.replace(/\.jsonl$/, "");
    const attested = durable.attest(id);
    if (attested.damage) {
      damaged += 1;
      // The intact prefix is real and worth showing, because "I could not read
      // all of it" and "there was nothing there" are different facts.
      console.log(
        `${id}  DAMAGED  ${attested.damage.why}${attested.damage.line ? ` at line ${attested.damage.line}` : ""}` +
          `  (${attested.events.length} event(s) readable)`,
      );
      continue;
    }
    const events = attested.events;
    const goal = events.find((e) => e.kind === "goal");
    const evidence = events.filter((e) => e.kind === "evidence").length;
    console.log(
      `${id}  events=${String(events.length).padStart(3)}  evidence=${evidence}  ${String(goal?.data.text ?? "").slice(0, 60)}`,
    );
  }
  if (damaged > 0) {
    console.log(`\n${damaged} session(s) damaged. cuesheet inspect <id> for what survived.`);
  }
  return 0;
}

/**
 * The listing for programs: both stores, one object per session, read only.
 *
 * This is the interface the README documents for readers outside this
 * repository. It opens files for reading and nothing else, so a reader can run
 * it against a store it must not change.
 */
function cmdSessionsJson(flags: Record<string, string>): number {
  let since: Date | undefined;
  if (flags.since) {
    since = new Date(flags.since);
    if (Number.isNaN(since.getTime())) fail(`--since needs an ISO 8601 date, not ${flags.since}`);
  }
  if (flags.cwd === "true") fail("--cwd needs a directory");
  const listing = listSessions(sessionRoots(), { since, cwd: flags.cwd });
  console.log(JSON.stringify(listing, null, 2));
  return 0;
}

function cmdInspect(argv: string[]): number {
  const sessionId = argv[0];
  if (!sessionId) fail("inspect needs a session id");
  const durable = new SessionStore({ root: SESSION_ROOT });
  const events: Event[] = durable.read(sessionId);
  if (events.length === 0) fail(`no events for session ${sessionId}`);

  console.log(`${sessionId}: ${events.length} events\n`);
  for (const event of events) {
    const data = JSON.stringify(event.data);
    const preview = data.length > 90 ? `${data.slice(0, 90)}...` : data;
    console.log(`  ${String(event.seq).padStart(3)}  ${event.kind.padEnd(12)} ${event.subject.padEnd(10)} ${preview}`);
  }
  return 0;
}

function cmdCapabilities(): number {
  const listing = liveRegistry();
  const caps = listing.capabilities;
  console.log(`${caps.length} capabilities in the live registry\n`);
  for (const c of caps.slice(0, 40)) {
    console.log(`  ${c.name.padEnd(34)} ${c.version}`);
  }
  if (caps.length > 40) {
    console.log(`  ... and ${caps.length - 40} more`);
  }
  // A folder that looks like a skill and cannot be read is not a capability
  // and not a proven absence, so it is named rather than omitted.
  for (const u of listing.unreadable) {
    console.log(`  ${u.folder.padEnd(34)} UNREADABLE: ${u.reason}`);
  }
  if (listing.anyRootUnreadable) {
    console.log("\n  at least one root could not be read: absence is not evidence");
  }
  return 0;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "run":
      return cmdRun(rest);
    case "resume":
      return cmdResume(rest);
    case "sessions":
      return cmdSessions(rest[0] === "list" ? rest.slice(1) : rest);
    case "inspect":
      return cmdInspect(rest);
    case "capabilities":
      return cmdCapabilities();
    default:
      return usage();
  }
}

/**
 * Run only when this file is the program, not when it is imported.
 *
 * The other two entry scripts in this repository already carry this guard.
 * Without it, importing `cli-run.ts` runs the whole command dispatcher against
 * whatever `process.argv` happens to be, which is why it could not be loaded
 * by test/loadability.test.ts and why nothing noticed: every caller spawns it
 * as a process, so the missing guard was invisible from the outside.
 */
if (isEntryPoint(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(`cuesheet: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
