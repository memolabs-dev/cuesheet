/**
 * CLI: read the portfolio's durable objects, and write the Frontier from them.
 *
 * The Frontier is generated, never maintained by hand. That is the whole point:
 * a hand-written summary of where the portfolio stands is a fourth place for
 * that state to be wrong, and its failure is silent.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_PROJECTS_ROOT,
  buildSnapshotFrontier,
  renderFrontier,
  snapshotPortfolio,
} from "../src/adapters/frontier.ts";
import type { DurableObject } from "../src/core/memory.ts";
import { wakeable } from "../src/core/memory.ts";
import { isEntryPoint } from "./is-entry-point.ts";

const DEFAULT_OBJECTS =
  join(homedir(), "Vault", "3-Garden", "research", "Future", "programs", "portfolio-objects.yaml");

/**
 * Read the durable objects out of the program file.
 *
 * A hand-rolled reader rather than a YAML dependency, because this repository
 * has zero dependencies by design and the shape it needs is small and fixed.
 * It therefore reads only the keys it knows and refuses loudly on anything it
 * does not understand, rather than skipping a field and letting a future edit
 * fail silently.
 */
function parseObjects(file: string): {
  objects: DurableObject[];
  measured: Record<string, number | boolean>;
} {
  const text = readFileSync(file, "utf8");
  const objects: DurableObject[] = [];
  const measured: Record<string, number | boolean> = {};

  // The program files list objects at column 0 ("- id:") with their keys at two
  // spaces. An earlier version of this reader assumed a deeper indent and
  // silently found nothing, which is the failure mode this whole project
  // exists to catch. Indent is therefore matched loosely, and an object whose
  // required keys are missing is reported rather than skipped.
  const blocks = text.split(/^\s*-\s+id:\s*/m).slice(1);
  for (const raw of blocks) {
    // The id was consumed by the split above, so it is recovered from the
    // leading text of this block rather than re-read as a key. Reading it as a
    // key returns undefined for every object, which silently drops the whole
    // file, so the id is taken from the split position itself.
    const id = raw.split("\n")[0].trim();
    if (!id) continue;
    const block = raw.slice(raw.indexOf("\n"));
    const scalar = (key: string): string | undefined => {
      const m = new RegExp(`^\\s*${key}:\\s*(.+)$`, "m").exec(block);
      return m?.[1]?.trim().replace(/^["']|["']$/g, "");
    };
    const list = (key: string): string[] => {
      // Inline list: [a, b, c]
      const inline = new RegExp(`^\\s*${key}:\\s*\\[(.*)\\]$`, "m").exec(block);
      if (inline) {
        return inline[1]
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
      }
      // Block list, on the following indented "- " lines.
      const m = new RegExp(`^\\s*${key}:\\s*\\n((?:\\s*-\\s*.+\\n)+)`, "m").exec(block);
      if (!m) return [];
      return m[1]
        .split("\n")
        .map((l) => l.replace(/^\s*-\s*/, "").trim())
        .filter(Boolean);
    };

    const status = scalar("status") ?? "active";
    const object: DurableObject = {
      id,
      kind: (scalar("kind") ?? "Finding") as DurableObject["kind"],
      horizon: (scalar("horizon") ?? "sleep") as DurableObject["horizon"],
      what: scalar("what") ?? "",
      why: scalar("why") ?? "",
      evidence: [],
      status: status as DurableObject["status"],
      related_to: list("related_to"),
    };

    const original = scalar("original_belief");
    if (original) object.original_belief = original;
    const counter = scalar("counterexample");
    if (counter) object.counterexample = counter;
    const replacement = scalar("replacement");
    if (replacement) object.replacement = replacement;

    const requires = scalar("requires");
    if (requires) {
      object.revisit_when = {
        signal: scalar("signal") ?? "",
        requires,
        satisfiedBy: list("satisfied_by"),
        matched: scalar("matched") === "true",
      };
    }

    objects.push(object);
  }

  // The measurements block: a flat yaml of name: value, with null meaning
  // absent rather than zero.
  const measureBlock = /## mesures connues\s*```yaml\s*\n([\s\S]*?)```/.exec(text);
  if (measureBlock) {
    for (const line of measureBlock[1].split("\n")) {
      const m = /^([a-z_]+):\s*(.*)$/.exec(line.trim());
      if (!m) continue;
      const [, name, raw] = m;
      if (raw === "null" || raw === "") continue;
      const n = Number(raw);
      measured[name] = Number.isFinite(n) ? n : raw === "true";
    }
  }

  return { objects, measured };
}
export function frontierMarkdown(objectsFile: string): string {
  const snapshot = snapshotPortfolio();
  // Refuse loudly, as parseObjects does on an unknown key: a frontier with an
  // empty portfolio and current-looking findings is worse than no frontier.
  if (snapshot.registry === null) {
    throw new Error(
      `No PROJECTS.md under ${DEFAULT_PROJECTS_ROOT}: refusing to publish an empty portfolio. ` +
        "Set MEMOLABS_ROOT to the registry root.",
    );
  }
  const { objects, measured } = parseObjects(objectsFile);
  const { frontier, unevaluable } = buildSnapshotFrontier({ objects, measured, snapshot });
  const woken = wakeable(objects, measured);
  return renderFrontier(frontier, snapshot, unevaluable, woken);
}

if (isEntryPoint(import.meta.url)) {
  const file = process.argv[2] ?? DEFAULT_OBJECTS;
  try {
    process.stdout.write(frontierMarkdown(file));
  } catch (error) {
    console.error(`cuesheet-frontier: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
