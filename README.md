# cuesheet

Invariants discovered by running a personal agent control plane, extracted once
they have survived contact with real work.

This is deliberately tiny. A handful of primitives, no dependencies.

## Why it exists

A personal setup grows useful behaviour by accident. Sessions in parallel, a
dirty tree that is not abandoned work, an unpushed commit that means the job
is not done, a stale path in a routing table. Each of these started as a local
script and a sentence in a prompt. Each was then a thing that had to be
remembered, and being remembered is not a design.

The split:

```text
personal system      the proving ground, rich and specific
        |
     adapters         translate one runtime into concepts this repo owns
        |
      core            primitives with no name, no path, no user
```

The core does not know who runs it, where their projects live, or what agent
runtime they use. That is enforced by reading `src/core/`, not by intention.

## Admission rule

Nothing enters Core until it has existed as a working local solution and
produced evidence that the problem it solves recurs.

```text
real work -> friction observed -> local solution -> result observed
          -> pattern recurs -> invariant identified
          -> adapter boundary identifiable -> testable primitive -> Core
```

Both halves matter. A primitive with no evidence is speculation. A workaround
that never gets extracted stays a trap for the next person, including the
author.

## Portability

Three levels, deliberately not conflated, because claiming the third while
having the first is how a tool stops working on anyone else's machine:

```text
PORTABLE    the code does not depend on the machine it was written on
INSTALLABLE someone can install it without reading the source
PUBLISHABLE we are ready to promise it works on their machine
```

This repository claims **PORTABLE**, and the claim is a test, not a promise.
`test/portability.test.ts` holds twenty cases across five invariants:

- **PORT-01** no path, home directory, working directory, or I/O module
  appears under `src/core`, and core imports nothing but its own siblings
- **PORT-02** adapters take their roots from the caller; a `homedir()` default
  is allowed only when an option can override it
- **PORT-03** the shim is machine-local and says so; it is asserted rather
  than tolerated
- **PORT-04** a disposable layout shaped nothing like `~/Users/memo/projects`
  is built in a temporary directory and actually read
- **PORT-05** no dependency is declared at all, and no test depends on this
  machine's real projects

PORT-04 is the one that matters. It creates a registry, a category tree and a
git repository under `/tmp/.../srv/people/amina/work/projects`, and reads it
without editing a line. That is the difference between portable and claimed
portable.

The shim names no machine either. Run from a checkout, `bin/cuesheet` finds
the checkout it sits in; installed, it carries the runtime and node that
`scripts/install.sh` wrote into it on the machine where it ran. PORT-03 asserts
that the file in the repository holds no home directory and no project path.
That is still short of INSTALLABLE for someone else, which is not claimed.

## Layout

```text
src/core/ownership.ts     resolveOwnership(): who may write where. No I/O.
src/core/capability.ts    resolveCapabilities(): requirements at delegation time. No I/O.
src/core/delegation.ts    preflightDelegation(): the gate, composed from the two above.
src/core/store.ts         EventStore: the append-only log a session is.
src/core/loop.ts          runAgentLoop(): observe, compile, infer, act, never trust a claim.
src/core/memory.ts        durable objects and the conditions that wake them.
src/adapters/             the only places allowed to do I/O.
src/state.ts              the fold a view renders. Observes nothing, imports nothing that could.
src/affordances.ts        what the state permits. Pure; the surface asks and renders.
src/effects.ts            an effect asked for, and what came back. Never the same event.
src/reconcile.ts           what happened to an effect nobody watched. Five answers, one null.
src/spawn.ts               naming an effect before anything about it exists.
src/work.ts                what the work produced, which is not what the spawn was.
src/verify.ts              whether the work counts, decided by something other than the producer.
src/worker.ts              the first worker: deterministic, and unable to lie.
src/projections.ts        one event log, two renderings: interactive, machine.
src/cuesheet.ts           the installed command's dispatcher.
src/adapters/session-reader.ts  the session listing other programs read. Writes nothing.
bin/cuesheet              the PATH shim, installed by scripts/install.sh.
scripts/install.sh        build, copy the runtime out of the checkout, install the shim.
test/                     352 tests
```

## The primitive

`resolveOwnership()` decides whether a project can accept a writer, given the
sessions an adapter reports and the project state the caller measured. It
performs no I/O, so it is fully testable without a machine.

```ts
const ownership = resolveOwnership(projects, sessions, states, { now });
const free = availableProjects(ownership);
```

Three rules, each of which is a bug that already happened:

- **A recent session holds the project.** Live owner, not history.
- **A dirty tree holds the project**, with or without a session. Uncommitted
  work means someone started and did not finish. It is never evidence that
  they abandoned it, and never an invitation to clean it up.
- **Unpushed commits hold the project** and set `needsPush`. The next action is
  then PUSH, not IMPLEMENT.

The window is an inference, not a lock: a long single step and an abandoned
session are indistinguishable from outside. The default is deliberately
conservative, because the cost of a false `available` is a corrupted checkout.

The fourth rule is the one that was missing, and it is a fourth rule because a
count that was never read is not a count of zero:

- **A project nobody looked at is held.** An adapter that could not read the
  repository reports `observed: false` with the reason, and the project is held
  on that ground alone. A project absent from the map entirely is also held.
  The earlier version defaulted an unobserved project to zero dirty files and
  zero unpushed commits, which is the one fact that authorises a second writer,
  invented from nothing. The same rule runs through the capability registry: a
  `SKILL.md` that cannot be read is reported as unreadable, never as an absent
  skill, and an unreadable root marks the resolution `registryUnverified` so a
  blocked requirement says absence is not evidence.

## Running it

```bash
npm test
```

The installed command with no arguments opens the chat: one surface, lines
typed as intentions, the tooling serves them. A question the live state can
answer (sessions, capabilities, a session's log) is answered from state;
anything else is a goal, which the admission gate evaluates before the first
inference, and which is then run and persisted event by event. A line starting
with `!` overrides a refusal explicitly, which is owner authority rather than
a bypass.

The subcommands remain for scripts and for people who know the primitive they
want:

```bash
cuesheet projects --root ~/projects/<a> --root ~/projects/<b>
cuesheet gate --requirements brief.json --skill-root ~/.agents/skills
cuesheet capabilities
cuesheet run <goal> --in <dir> --session <id>
cuesheet sessions
cuesheet inspect <session>
cuesheet frontier
```

`--help` works on the tool and on every subcommand, and `--version` prints the
version from `package.json`. `projects` also takes `--format json`, which is
what makes it usable as a sensor rather than something a human has to watch.
In that output an unobserved project's `dirtyFiles` is `null` and its
availability is `held`: never a `0` dressed up as an observation.

To install it for your user, from a checkout with its dependencies installed:

```bash
pnpm install --frozen-lockfile
scripts/install.sh
```

The script builds `dist/`, copies it to
`${XDG_DATA_HOME:-~/.local/share}/cuesheet/runtime`, and writes the shim to
`~/.local/bin/cuesheet` with two absolute paths filled in: that runtime, and
the node found on PATH while installing. The runtime is a copy, so switching
branches or removing the checkout changes nothing about the installed command,
and the absolute node is what lets Finder, launchd or a hook run it with a bare
PATH. The script does not finish until the installed command answers `--help`
that way. `CUESHEET_RUNTIME`, `CUESHEET_BIN_DIR` and `CUESHEET_NODE` choose other
locations; `CUESHEET_ROOT` and `CUESHEET_NODE` also override the installed shim
at run time. Rerun the script to update: the runtime is replaced whole.

Without installing, `bin/cuesheet` runs `src/cuesheet.ts` from the checkout it
sits in.

The raw entry points still work and are what the shim calls: `src/cli.ts`
(ownership and the gate, flag-driven), `src/cli-run.ts` (sessions, subcommand
driven), `src/frontier-cli.ts` (frontier generation), `src/replay.ts`
(historical replay).

Before a worker is briefed, its requirements can be gated:

```bash
cuesheet gate --requirements brief.json --skill-root ~/.agents/skills
```

This resolves the capabilities the brief declares against the live skill
roots, prints a conformance-style verdict, and exits 1 when blocked (2 on a
broken invocation), so it chains into a script as a gate. The declaration
shape and the verdict lines are specified in docs/requirements.md.

A run also exists: `cuesheet run <goal> --in <dir>` starts a session that owns
its own event log, drives a model through OpenRouter, and persists every event
so the session survives its process. It needs `OPENROUTER_API_KEY`; there is
no unauthenticated fallback, on purpose. Shadow mode, which observes real
delegations without blocking them, lives in the OpenCode plugin in
`plugin-opencode/`.

## Reading sessions from another program

`cuesheet sessions --format json` is the supported way for another program to
read the sessions on a machine. The files behind it are not an interface and
change without notice; this listing is versioned and changes only with its
`version`.

```bash
cuesheet sessions --format json [--since <iso>] [--cwd <dir>]
```

It reads and writes nothing else: no directory is created, no file written, no
writer's lock touched, so it is safe on a store the reader must not change. It
lists both stores. Run and chat sessions live in `CUESHEET_SESSIONS`, else
`~/.cuesheet/sessions`; terminal sessions in `CUESHEET_SESSIONS`, else
`$XDG_STATE_HOME/cuesheet/terminal/sessions`, else
`~/.local/state/cuesheet/terminal/sessions`.

<!-- sessions-json:begin -->
```json
{
  "version": 1,
  "stores": [
    { "kinds": ["run", "chat"], "path": "/home/amina/.cuesheet/sessions", "state": "read", "error": null },
    { "kinds": ["terminal"], "path": "/home/amina/.local/state/cuesheet/terminal/sessions", "state": "absent", "error": null }
  ],
  "filters": { "since": null, "cwd": null },
  "sessions": [
    {
      "id": "t-2f6c1d0e-9a4b-4c1e-8f3a-5b7d2e9c0a11",
      "kind": "terminal",
      "cwd": "/home/amina/work/atlas",
      "createdAt": "2026-10-21T08:12:03.418Z",
      "lastEventAt": "2026-10-21T09:40:55.002Z",
      "events": 42,
      "status": "open",
      "damage": null,
      "file": "/home/amina/.local/state/cuesheet/terminal/sessions/t-2f6c1d0e-9a4b-4c1e-8f3a-5b7d2e9c0a11.jsonl"
    },
    {
      "id": "chat-001xntmuobq2cd",
      "kind": "chat",
      "cwd": null,
      "createdAt": "2026-10-20T17:02:11.950Z",
      "lastEventAt": null,
      "events": 0,
      "status": null,
      "damage": null,
      "file": "/home/amina/.cuesheet/sessions/chat-001xntmuobq2cd.jsonl"
    }
  ]
}
```
<!-- sessions-json:end -->

- `version` is `1`. A change a reader could notice gets a new number.
- `stores` names each directory read. `state` is `read`, `absent` (nothing
  there, and nothing created) or `unreadable`, with the error code in `error`.
  An unreadable store is not an empty one. When `CUESHEET_SESSIONS` points both
  writers at one directory, it appears once with all three kinds.
- `sessions` holds one object per session, most recent activity first:
  - `kind` is `run`, `chat` or `terminal`.
  - `cwd` is the working directory the session recorded. Terminal sessions
    record one; run and chat journals do not, so theirs is `null`.
  - `createdAt` and `lastEventAt` are ISO 8601 in UTC. `createdAt` comes from
    the terminal manifest or the first event, and for an empty log from the
    file itself. `lastEventAt` is `null` for an empty log; for a terminal
    session it is the later of the session journal and its conversation.
  - `events` counts the events the journal attests. An empty log is listed
    with `0`, never hidden.
  - `status` is the goal state the core fold gives: `open`, `closed`, or `null`
    when the log holds no goal.
  - `damage` is `null`, or `{ "why", "line" }` saying where the journal stops
    being readable (`unreadable`, `out_of_sequence`, `unreadable_file`), or what
    a terminal session is missing (`metadata_missing`, `metadata_invalid`,
    `journal_missing`). `events` then counts what was readable before it.
  - `file` is the journal read. A terminal session also has
    `<id>.meta.json` and `<id>.view.jsonl` beside it.
- `--since <iso>` keeps sessions whose last activity (`lastEventAt`, else
  `createdAt`) is at or after that instant. `--cwd <dir>` keeps sessions whose
  `cwd` is that directory or inside it; `/srv/atlas` does not match
  `/srv/atlas-old`, and a session with no `cwd` never matches.

## Not here yet, on purpose

No graph, no scheduler, no agent runtime abstraction, no UI, no config schema.
Each waits for a primitive that needs it. A folder with nothing in it is a
promise nobody has to keep, and it is indistinguishable from a plan.

Adding a second primitive is the next step, and it should be `drift`: detecting
that a document and a repository disagree, which cost real time before it had a
name.
