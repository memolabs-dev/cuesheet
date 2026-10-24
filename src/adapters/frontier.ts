/**
 * Adapter: the portfolio, read from the repositories that actually exist.
 *
 * This is the generator behind `FRONTIER.md`. A frontier written by hand is a
 * fourth place where the portfolio's state can be wrong, and the failure is
 * silent: an agent reads a confident summary of work that has moved. So the
 * frontier is derived from things that cannot drift quietly: the registry of
 * projects, their git state, and the durable objects.
 *
 * The Frontier is the answer to "where do we stand", and it is deliberately
 * small. A session that must read 480 KB of research to learn its own direction
 * will not read it, and will instead re-derive direction from whatever it
 * touched.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { DurableObject, Frontier } from "../core/memory.ts";
import { buildFrontier, wakeable } from "../core/memory.ts";

/**
 * Where the portfolio lives on the machine that is not asking.
 *
 * The registry root: `$MEMOLABS_ROOT` (default `~/memolabs`), whose PROJECTS.md
 * Path cells are relative to it. It used to be `~/projects` as a module
 * constant, which meant the adapter could not be pointed at any other layout at
 * all; `~/projects` was retired on 2026-10-14. It is a default that every entry
 * point can override, so a second person can read their own portfolio without
 * editing this file. See test/portability.test.ts.
 */
export const DEFAULT_PROJECTS_ROOT = (()=>{try{return process.env["MEMOLABS_ROOT"] || join(homedir(),"memolabs");}catch{return "";}})();

/**
 * The top-level directories of the registry root since the 2026-10-14 layout. The
 * undeclared scan also walks the first segment of every registry path, so a
 * layout that adds a directory is covered as soon as the registry names it.
 */
const TOP_LEVEL = ["os", "lab", "products", "research", "clients", "studio"];

export interface FrontierOptions {
  /** Where the registry root is. Defaults to `$MEMOLABS_ROOT`, else `~/memolabs`. */
  projectsRoot?: string;
}

/** What the registry says, which is the declared truth about what exists. */
export interface RegistryEntry {
  name: string;
  path: string;
  kind: string;
  status: string;
  nature: string;
  stack: string;
}

/** What the repository itself says, which is what actually happened. */
export interface RepoReality {
  entry: RegistryEntry;
  exists: boolean;
  branch: string | null;
  dirty: number;
  ahead: number;
  hasRemote: boolean;
}

export function parseRegistry(projectsRoot: string): RegistryEntry[] {
  if(!projectsRoot)throw new Error("Projects root unavailable: configure a project directory; no home directory could be resolved.");
  const registry = join(projectsRoot, "PROJECTS.md");
  if (!existsSync(registry)) {
    return [];
  }
  const out: RegistryEntry[] = [];
  for (const line of readFileSync(registry, "utf8").split("\n")) {
    if (!line.startsWith("| ")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    // Header and separator rows carry no project.
    if (cells.length < 6) continue;
    if (cells[0] === "Name" || cells[0].startsWith("---")) continue;
    out.push({
      name: cells[0],
      path: cells[1],
      kind: cells[2],
      status: cells[3],
      nature: cells[4],
      stack: cells[5],
    });
  }
  return out;
}

function probe(entry: RegistryEntry, projectsRoot: string): RepoReality {
  const dir = join(projectsRoot, entry.path);
  if (!existsSync(join(dir, ".git"))) {
    return {
      entry,
      exists: existsSync(dir),
      branch: null,
      dirty: 0,
      ahead: 0,
      hasRemote: false,
    };
  }
  const run = (args: string[]): string => {
    try {
      // stderr is discarded on purpose: a repo with no upstream makes git
      // write "fatal: no upstream configured" on every probe, and 44 of those
      // lines would drown the Frontier this function is generating. The number
      // that matters is the empty result, not the complaint about it.
      return execFileSync("git", ["-C", dir, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return "";
    }
  };
  return {
    entry,
    exists: true,
    branch: run(["rev-parse", "--abbrev-ref", "HEAD"]) || null,
    dirty: run(["status", "--porcelain"]).split("\n").filter(Boolean).length,
    ahead: Number(run(["rev-list", "--count", "@{u}..HEAD"]) || "0"),
    hasRemote: run(["remote"]).length > 0,
  };
}

export interface PortfolioSnapshot {
  projects: RepoReality[];
  /** Projects the registry names but that are not on disk. */
  declaredButMissing: string[];
  /** Projects on disk that the registry does not name. */
  presentButUndeclared: string[];
  /** A project is writable when it is clean, pushed, and has a remote. */
  free: string[];
  /** A project is held when there is unfinished or unpushed work. */
  held: string[];
  /**
   * The PROJECTS.md that was read, or null when the root has none. An absent
   * registry and a registry that declares nothing both give zero projects; this
   * is what tells them apart.
   */
  registry?: string | null;
}

/**
 * Read the portfolio. Every number here is read from git rather than recalled,
 * which is the only reason the Frontier can be trusted to describe the present.
 */
export function snapshotPortfolio(options: FrontierOptions = {}): PortfolioSnapshot {
  const projectsRoot = options.projectsRoot ?? DEFAULT_PROJECTS_ROOT;
  const entries = parseRegistry(projectsRoot);
  const projects = entries
    .filter((e) => e.kind === "repo")
    .map((e) => probe(e, projectsRoot));

  const declared = new Set(projects.map((p) => p.entry.path));

  const categories = new Set(TOP_LEVEL);
  for (const e of entries) {
    const first = e.path.split("/")[0];
    if (first && first !== "." && first !== "..") categories.add(first);
  }
  const presentButUndeclared: string[] = [];
  for (const category of categories) {
    const dir = join(projectsRoot, category);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const rel = `${category}/${name}`;
      if (!existsSync(join(dir, name, ".git"))) continue;
      if (!declared.has(rel)) presentButUndeclared.push(rel);
    }
  }

  const free: string[] = [];
  const held: string[] = [];
  for (const p of projects) {
    if (p.dirty > 0 || p.ahead > 0) {
      held.push(p.entry.name);
    } else {
      free.push(p.entry.name);
    }
  }

  return {
    projects,
    declaredButMissing: projects
      .filter((p) => !p.exists)
      .map((p) => p.entry.name),
    presentButUndeclared,
    free,
    held,
    registry: existsSync(join(projectsRoot, "PROJECTS.md")) ? join(projectsRoot, "PROJECTS.md") : null,
  };
}

export interface FrontierInput {
  objects: DurableObject[];
  measured: Record<string, number | boolean>;
  snapshot?: PortfolioSnapshot;
}

/**
 * Build the frontier. Now and watch come from the durable objects, woken comes
 * from the conditions, and the portfolio facts are attached rather than
 * summarised, so a reader can see which repositories can actually be written
 * to without asking.
 */
export function buildSnapshotFrontier(input: FrontierInput): {
  frontier: Frontier;
  snapshot: PortfolioSnapshot | null;
  unevaluable: Array<{ id: string; why: string }>;
} {
  const frontier = buildFrontier(input.objects, input.measured);
  const snapshot = input.snapshot ?? snapshotPortfolio();

  const unevaluable: Array<{ id: string; why: string }> = [];
  for (const object of input.objects) {
    if (object.status !== "active" || !object.revisit_when) continue;
    const missing = object.revisit_when.satisfiedBy.filter(
      (m) => !(m in input.measured),
    );
    if (missing.length > 0) {
      unevaluable.push({
        id: object.id,
        why: `missing measurement(s): ${missing.join(", ")}`,
      });
    }
  }

  return { frontier, snapshot, unevaluable };
}

/** Render the frontier as the Markdown a session reads. Size is the budget. */
export function renderFrontier(
  frontier: Frontier,
  snapshot: PortfolioSnapshot | null,
  unevaluable: Array<{ id: string; why: string }>,
  woken: DurableObject[],
): string {
  const lines: string[] = [];
  const line = (s = ""): void => void lines.push(s);

  line("# Frontier");
  line();
  line("<!-- GENERATED by `cuesheet frontier`. Do not edit by hand: this file is");
  line("     derived from the project registry, git state and durable objects, and");
  line("     a hand-edited frontier is a second place for the portfolio to be wrong. -->");
  line();

  line("## Now");
  if (frontier.now.length === 0) {
    line("_nothing in the now horizon_");
  }
  for (const o of frontier.now) {
    line(`### ${o.what}`);
    line(`- kind: ${o.kind} (${o.id})`);
    line(`- why: ${o.why}`);
    if (o.evidence.length > 0) {
      line(`- evidence: ${o.evidence.map((e) => e.source).join(", ")}`);
    }
    if (o.related_to.length > 0) {
      line(`- related: ${o.related_to.join(", ")}`);
    }
    line();
  }

  line("## Woken this session");
  if (woken.length === 0) {
    line("_no wake condition met_");
  }
  for (const o of woken) {
    line(`- **${o.what}**: ${o.revisit_when?.signal ?? ""}`);
  }
  line();

  line("## Watch");
  if (frontier.watch.length === 0) {
    line("_nothing in the watch horizon_");
  }
  for (const o of frontier.watch) {
    line(`### ${o.what}`);
    if (o.revisit_when) {
      line(`- wake when: ${o.revisit_when.requires}`);
    }
    line();
  }

  line("## Asleep");
  if (frontier.asleep.length === 0) {
    line("_nothing dormant_");
  }
  for (const o of frontier.asleep) {
    line(`- ${o.what}`);
  }
  line();

  line("## Falsified, kept as lessons");
  if (frontier.lessons.length === 0) {
    line("_nothing falsified yet_");
  }
  for (const l of frontier.lessons) {
    if (!l || l.believed === undefined) continue;
    line(`- believed: ${l.believed}`);
    line(`  broken by: ${l.counterexample}`);
    line(`  now: ${l.now}`);
  }
  line();

  if (unevaluable.length > 0) {
    line("## Conditions that could not be evaluated");
    line();
    line("An unevaluable condition is not a met condition. These are missing data, not a verdict.");
    line();
    for (const u of unevaluable) {
      line(`- \`${u.id}\`: ${u.why}`);
    }
    line();
  }

  if (snapshot) {
    line("## Portfolio reality");
    line();
    line(`- declared repositories: ${snapshot.projects.length}`);
    line(`- free to write: ${snapshot.free.length}`);
    line(`- held: ${snapshot.held.length}${snapshot.held.length > 0 ? ` (${snapshot.held.join(", ")})` : ""}`);
    if (snapshot.declaredButMissing.length > 0) {
      line(`- declared but not on disk: ${snapshot.declaredButMissing.join(", ")}`);
    }
    if (snapshot.presentButUndeclared.length > 0) {
      line(`- on disk but undeclared: ${snapshot.presentButUndeclared.join(", ")}`);
    }
    line();
  }

  return lines.join("\n");
}
