/**
 * Adapter: a single isolated workspace writer process.
 *
 * Invoked from the command line with three arguments:
 *
 *   <workspace> <fileName> <content>
 *
 * It writes `<content>` to `<workspace>/<fileName>` and exits 0. Nothing
 * else: no network, no other process, no shared state. This is the H06.3
 * isolation boundary — one worker, one workspace, no interference.
 *
 * The module body runs nothing on import (guarded below), so LOAD-01 /
 * LOAD-03 keep importing every module under src.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

function run(args: string[]): void {
  const [workspace, fileName, content] = args;

  if (!workspace || !fileName || content === undefined) {
    console.error(
      "usage: integration-worker.ts <workspace> <fileName> <content>",
    );
    process.exit(2);
  }

  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, fileName), content, { encoding: "utf8" });
  process.exit(0);
}

// Only run when this file is the entry point, never on import.
if (import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2));
}
