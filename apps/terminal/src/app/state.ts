/**
 * What the surface shows, and what it can ask for.
 *
 * The rule the whole app is built on:
 *
 * > No TUI component decides anything.
 *
 * Components receive this state and emit a control. They do not read the
 * filesystem, they do not know what a project is, and they do not resolve a
 * binding. If a component needed to know any of that, it would be a place where
 * presentation and decision are mixed, which is the defect this whole project has
 * spent sixteen milestones refusing and which OBS-1, OBS-2 and OBS-3 each found
 * again in a smaller way.
 *
 * So the vocabulary here is deliberately not the core's vocabulary. The core says
 * `pendingEffect`, `revision`, `ArtifactStanding` and `CONFIRMED_COMPLETE`. This
 * says "five projects ready", "verifying", "completion unknown". The translation
 * happens once, in `producer/translate.ts`, and a component cannot reach the other
 * side.
 *
 * ## What V2 changed in this file
 *
 * The old `submit` control carried a `TurnIntent`, a five-case union decided by
 * exact string matching against hardcoded French phrase lists, and this file
 * answered it. The union is gone. `submit` carries the sentence, and only the
 * sentence:
 *
 * ```text
 * before  submit(turn: TurnIntent)  -> one of five canned replies
 * after   submit(text: string)      -> the sentence is recorded, and the producer runs
 * ```
 *
 * Two consequences, both of them the point. There is no longer a phrase that can
 * produce "name a project" or "not a goal", because there is no longer a place
 * where a phrase is classified. And `busy` is finally true when it is set: it is
 * set by the producer, at the moment it starts the real loop, which is the
 * admission this file made at line 125 in V1 and could not keep.
 *
 * VIEW-01 holds here and is asserted: this file observes nothing, imports
 * nothing, and `derive` is a pure function of its two arguments.
 */

/** How certain the surface is about something, in the four words it is allowed. */
export type Certainty = "confirmed" | "active" | "unknown" | "failed";

/**
 * The durable identity of one line.
 *
 * Opaque here. The surface only ever asks whether two of these are the same
 * string; who mints one and out of what is the producer's business and not this
 * file's.
 *
 * ## Why a line needs a name
 *
 * A reply rendered three times is not three replies. It is one reply the surface
 * could not recognise, because until now an entry was only its words, and words
 * cannot answer "have I already shown you this?". Two genuinely distinct replies
 * may read exactly the same, and one reply re-rendered must not be mistaken for
 * either of them, so identity cannot be read off the content either. It has to
 * be carried.
 *
 * So the producer says which line this is, and this file holds it. `translate.ts`
 * builds that name from the journal sequence of the event the line came from,
 * which is the one fact about a line that survives a replay, a reconnect and a
 * restart without being recomputed from anything a person can see.
 */
export type EntryId = string;

/** A reference describes observed work. It never confers execution authority. */
export interface WorkReference { id:string; source:number; objectiveId:string; objectiveRevision:number }
export interface WorkObject {
  id:string; kind:'intent'|'plan'|'task'|'agent'|'contribution'|'verification';
  title:string; status:string; detail:string; source:number; reference?:WorkReference;
}

/** Read-only semantic context; durable IDs do not confer completion authority. */
export interface WorkSurface {
  intent: string | null;
  objects?: readonly WorkObject[];
  criteria?: readonly string[];
  corrections: readonly string[];
  tasks: readonly {id:string;text:string}[];
  workers: readonly {id:string;label:string;role:string;task:string;phase:string;model?:string;result?:string;source?:number;helping?:string;routeReason?:string;assistancePhase?:string}[];
}

/**
 * One line in the timeline, as it reads. Five kinds, and the three that were
 * dead are live.
 *
 * This is what a line *says*, with no name attached. `Entry` is this plus the
 * identity that says it is the same line twice, and the difference matters: a
 * line that has already been written and is being settled keeps the name of the
 * row it settles, so the settled form is a body with the row's name, not a
 * freshly named line.
 */
export type EntryBody =
  | { readonly kind: "you"; readonly text: string }
  | { readonly kind: "cuesheet"; readonly text: string }
  /** A thing the producer did. Small, quiet, and never a paragraph. */
  | { readonly kind: "action"; readonly label: string; readonly detail?: string; readonly certainty: Certainty }
  /** The epistemic block: the one thing this surface can show that a log cannot. */
  | { readonly kind: "status"; readonly label: string; readonly value: string; readonly certainty: Certainty }
  /** Something went wrong, said plainly. */
  | { readonly kind: "failure"; readonly text: string };

/** One line in the timeline: what it reads, and which line it is. */
export type Entry = EntryBody & { readonly id: EntryId };

/** One project the surface can offer, and the reason it is on offer. */
export interface Option {
  readonly name: string;
  readonly path: string;
  /** Why this one is a candidate. Carried so a choice is checkable. */
  readonly why: string;
}

/**
 * Settle the row at this index, rather than appending a second one.
 *
 * The producer opens an action row at `active` and then learns the exit code.
 * Appending the settled row instead of replacing the open one would show every
 * call twice, once forever claiming to be in progress, which is both ugly and a
 * lie: a person scanning the timeline would count work that had already finished
 * as still running.
 *
 * An index rather than an id because entries are immutable and the producer owns
 * the only thing that appends them, so it already knows where it wrote.
 */

/** The whole visible state. One object, passed down, never mutated in a component. */
export interface SurfaceState {
  readonly project: string | null;
  readonly entries: readonly Entry[];
  readonly composer: string;
  /** Which overlay is open, if any. Overlays are a state, not a component. */
  readonly overlay: "none" | "palette" | "projects" | "inspect" | "work" | "help" | "models" | "sessions" | "changes";
  /**
   * The choices an ambiguous sentence produced.
   *
   * Empty is the normal case. Non-empty means the producer found more than one
   * project defending itself and refused to guess, which BIND-05 requires and
   * which is a question to a person rather than a guess about one.
   */
  readonly choices: readonly Option[];
  /** The raw log, only ever read by the inspect overlay. */
  readonly log: readonly string[];
  readonly statusRight: string;
  readonly busy: boolean;
  readonly reasoning?:string;
  readonly progressKind?:"reasoning"|"text";
  /** Cumulative consumption across the session, projected from usage receipts. */
  readonly consumption?: { readonly inputTokens: number; readonly outputTokens: number; readonly requests: number; readonly costCents: number };
  /**
   * Every line this surface has ever put on the timeline, by identity,
   * including the ones the cap has since scrolled off the end.
   *
   * Held for the whole session rather than read off `entries`, because the cap
   * makes `entries` a window: a line that has left it is still a line this
   * surface has shown, and a second delivery of it must not walk back in. The
   * set is what turns "append" into "append unless this surface already holds
   * it", which is the whole of the invariant that one reply renders once.
   *
   * Rebuilt by replay from the same controls that built it the first time, so it
   * is a fact about the control stream and not about how many times this surface
   * has been mounted.
   */
  readonly seen: ReadonlySet<EntryId>;
  /**
   * How many names this surface has given to the lines it writes itself.
   *
   * Four controls have the surface author their own lines rather than receive
   * them: `submit`, `scoped`, `offered`, `choose`, and `noted` for the notices a
   * component raises about itself. Their names have to come from somewhere, and
   * it cannot be from what the line says, for the reason on `EntryId`: the same
   * sentence sent twice and the same directory named twice are two lines, and
   * both of them stay. So the name is a count of what has already been written.
   */
  readonly minted: number;
}

/** What a component may ask for. Nothing else crosses the boundary. */
export type Control =
  | {readonly type:"reasoning";readonly text:string;readonly kind?:"reasoning"|"text"}
  /** A sentence, verbatim. There is no classifier between this and the producer. */
  | { readonly type: "submit"; readonly text: string }
  | { readonly type: "compose"; readonly text: string }
  | { readonly type: "open"; readonly overlay: SurfaceState["overlay"] }
  | { readonly type: "close" }
  /** A choice was made from the options the producer offered. */
  | { readonly type: "choose"; readonly option: Option }
  | { readonly type: "quit" }
  /** Producer-only. The run started, with real work behind it. */
  | { readonly type: "began" }
  /** Producer-only. The run ended. */
  | { readonly type: "ended" }
  | { readonly type: "interrupted" }
  /**
   * Producer-only. Lines translated from the core's vocabulary, each carrying
   * the identity the producer gave it.
   *
   * A line whose identity this surface already holds is dropped rather than
   * appended. That is not a de-duplication of words, it is a refusal to show the
   * same line twice, and it is what makes the second delivery of a provider
   * event, a replay of the view, a reconnect, a resume after an interruption and
   * a remount all leave the timeline saying the same thing exactly once.
   */
  | { readonly type: "observed"; readonly entries: readonly Entry[] }
  /**
   * Producer-only. Settle the action row at `at`, which was opened `active`.
   *
   * Replacing rather than appending, because a row that said "reading" and was
   * never updated would leave work that finished still claiming to be in progress
   * for the rest of the session.
   *
   * The body, not an `Entry`, because the row keeps the identity it was opened
   * with: it is the same line, now told what happened.
   */
  | { readonly type: "settled"; readonly at: number; readonly entry: EntryBody }
  /**
   * Producer-only, and also reachable from the component layer. One line the
   * surface writes about itself, with no name attached.
   *
   * Exists so that a notice raised by a component does not have to invent an
   * identity, and so the counting that gives these lines their names stays in one
   * place rather than being reimplemented per call site with a clock or a counter
   * that restarts on the next mount.
   */
  | { readonly type: "noted"; readonly entry: EntryBody }
  /** Producer-only. Cumulative consumption updated from usage receipts. */
  | { readonly type: "consumed"; readonly inputTokens: number; readonly outputTokens: number; readonly requests: number; readonly costCents: number }
  /** Producer-only. A line for the raw log, read only by inspect. */
  | { readonly type: "logged"; readonly line: string }
  /** Producer-only. The scope was resolved, one way or another. */
  | { readonly type: "scoped"; readonly project: string; readonly where: string }
  /** Producer-only. More than one project defended itself. */
  | { readonly type: "offered"; readonly choices: readonly Option[] };

/** The empty state. A surface that has to be built before it can be shown is not shown. */
export const emptySurface: SurfaceState = {
  project: null,
  entries: [],
  composer: "",
  overlay: "none",
  choices: [],
  log: [],
  statusRight: "",
  busy: false,
  seen: new Set<EntryId>(),
  minted: 0,
  consumption: undefined,
};

/** Cap the timeline. A day of work is a long log and a terminal is not a scrollback. */
const MAX_ENTRIES = 400;
const MAX_LOG = 200;

/**
 * Put lines on the end, and record that this surface now holds them.
 *
 * Both halves together on purpose. Appending without recording would leave a
 * line that later scrolled off the cap unrecognised, and the second delivery of
 * it would walk back onto a timeline that had already moved past it.
 *
 * Pure. The set is rebuilt rather than added to, so the state handed in is never
 * touched and calling this twice on the same input gives the same result.
 */
const added = (
  state: SurfaceState,
  entries: readonly Entry[],
): Pick<SurfaceState, "entries" | "seen"> => ({
  entries: [...state.entries, ...entries].slice(-MAX_ENTRIES),
  seen: new Set<EntryId>([...state.seen, ...entries.map((entry) => entry.id)]),
});

/**
 * Name the lines this surface writes for itself.
 *
 * `submit`, `scoped`, `offered`, `choose` and `noted` are the controls whose
 * lines are authored here rather than received, so the count of what has already
 * been written is the only honest source for their names. Reading the words off
 * the line instead would collapse the second time a person sent the same
 * sentence into the first, which is a different sentence arriving, not a repeat
 * of one line being drawn.
 *
 * Pure, and therefore replayable: the same controls in the same order produce the
 * same names, which is what lets a restored view be the same view.
 */
const named = (
  state: SurfaceState,
  bodies: readonly EntryBody[],
): { readonly entries: readonly Entry[]; readonly minted: number } => ({
  entries: bodies.map((body, index) => ({ ...body, id: `s:${state.minted + index}` })),
  minted: state.minted + bodies.length,
});

/**
 * The surface, as a reducer over controls.
 *
 * Pure. No filesystem, no clock, no network. That is what makes every word in
 * this file assertable, which is the property the first surface lacked and the
 * reason its output could only be read by spawning a terminal.
 *
 * Every word a person reads is decided either here or in `producer/translate.ts`,
 * and nowhere else. The producer decides what happened; this decides what that
 * looks like.
 */
export function derive(state: SurfaceState, control: Control): SurfaceState {
  switch (control.type) {
    case "compose":
      return { ...state, composer: control.text };

    case "close":
      // Closing an overlay returns the choices with it: an offer that is no
      // longer on screen is not an offer, and leaving it behind would let a
      // later sentence be answered against a question the person already
      // dismissed.
      return { ...state, overlay: "none", choices: [] };

    case "open":
      return { ...state, overlay: control.overlay };

    case "quit":
      return state;

    case "submit": {
      const said = control.text.trim();
      if (!said) return state;
      // The whole of `submit`. The sentence is recorded verbatim and the
      // producer is told. It does not decide what the sentence meant, and there
      // is no branch here that could answer it.
      //
      // `busy` is left alone on purpose. The person typed; that is not work.
      // `began` sets busy, and only the producer sends it, at the moment the
      // real loop starts.
      const wrote = named(state, [{ kind: "you", text: said }]);
      return {
        ...state,
        ...added(state, wrote.entries),
        composer: "",
        choices: [],
        overlay: "none",
        minted: wrote.minted,
      };
    }

    case "reasoning":
      return {...state,reasoning:control.text.slice(-16000),progressKind:control.kind};
    case "began":
      return { ...state, reasoning:"", busy: true, overlay: "none" };

    case "ended":
      return { ...state, reasoning:"", busy: false };

    case "interrupted":
      return { ...state, reasoning:"", busy: false, entries: state.entries.map(entry =>
        (entry.kind === "action" || entry.kind === "status") && entry.certainty === "active"
          ? { ...entry, certainty: "unknown" as const } : entry) };

    case "observed": {
      if (control.entries.length === 0) return state;
      // The invariant, in one place: one line, one rendering.
      //
      // The test is the identity the producer carried, never the words. Words
      // cannot decide this: two replies that happen to read the same are two
      // replies and both stay, and one reply arriving twice is one reply and the
      // second is dropped. A set is carried across the batch so a single control
      // holding the same line twice is held once as well.
      const fresh: Entry[] = [];
      const held = new Set<EntryId>(state.seen);
      for (const entry of control.entries) {
        if (held.has(entry.id)) continue;
        held.add(entry.id);
        fresh.push(entry);
      }
      // Nothing new means nothing changed, and returning `state` itself is what
      // keeps a repeated delivery from repainting a timeline that did not move.
      if (fresh.length === 0) return state;
      return { ...state, ...added(state, fresh) };
    }

    case "consumed": {
      return {
        ...state,
        consumption: {
          inputTokens: control.inputTokens,
          outputTokens: control.outputTokens,
          requests: control.requests,
          costCents: control.costCents,
        },
      };
    }

    case "noted": {
      const wrote = named(state, [control.entry]);
      return { ...state, ...added(state, wrote.entries), minted: wrote.minted };
    }

    case "settled": {
      // Out of range means the timeline was trimmed past this row between the
      // call starting and returning. That is not an error: the row is gone, the
      // work happened, and the log still holds it.
      const existing = state.entries[control.at];
      if (!existing || existing.kind !== "action") return state;
      const entries = [...state.entries];
      // The row keeps the name it was opened with. It is the same line, told
      // what happened, and a line that changed its name on the way would take
      // the renderer's key for it with it and be drawn as a stranger.
      entries[control.at] = { ...control.entry, id: existing.id };
      return { ...state, entries };
    }

    case "logged":
      return { ...state, log: [...state.log, control.line].slice(-MAX_LOG) };

    case "scoped":
      // One line, once, in the surface's own words. The path is the fact a
      // person needs to check the surface picked the right directory, and it is
      // shown in full rather than shortened: a truncated path is a path that
      // looks like a different directory.
      {
        const wrote = named(state, [
          { kind: "status", label: "working in", value: control.where, certainty: "confirmed" },
        ]);
        return {
          ...state,
          ...added(state, wrote.entries),
          project: control.project,
          minted: wrote.minted,
        };
      }

    case "offered":
      // More than one candidate is a question to a person, not a guess. The
      // question rides in the timeline as entries so it is part of the
      // conversation, and the options ride alongside it for the overlay to draw.
      if (control.choices.length === 0) return state;
      {
        const wrote = named(state, [
          {
            kind: "status",
            label: "which one",
            value: control.choices.map((c) => c.name).join(", "),
            certainty: "unknown" as const,
          },
        ]);
        return {
          ...state,
          ...added(state, wrote.entries),
          busy: false,
          overlay: "projects",
          choices: control.choices,
          minted: wrote.minted,
        };
      }

    case "choose": {
      const picked = state.choices.find((c) => c.path === control.option.path);
      if (!picked) return state;
      const wrote = named(state, [
        { kind: "status", label: "working in", value: picked.path, certainty: "confirmed" },
      ]);
      return {
        ...state,
        ...added(state, wrote.entries),
        project: picked.name,
        overlay: "none",
        choices: [],
        minted: wrote.minted,
      };
    }
  }
}
