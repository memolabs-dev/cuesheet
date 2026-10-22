import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { verifyComposition } from "../src/adapters/integration-controller.ts";
import { capture, type CapturedArtifact } from "../src/adapters/artifact-capture.ts";
import { runAgainstArtifact } from "../src/adapters/artifact-verifier.ts";
import type { VerificationVerdict } from "../src/verify.ts";

/* H06.3 — isolation, capture d'artefact figé, vérification du résultat composé.

Deux workers écrivent chacun dans leur propre workspace (isolation). Chaque
workspace est capturé (figé, content-addressé) puis vérifié indépendamment par
une commande qui tourne contre la capture et rien d'autre. Le résultat composé
est VERIFIED seulement si chaque artefact est VERIFIED.

Le test aussi prouve que vandaliser le workspace *après* la capture ne déplace
pas le verdict (ART-04), et qu'un résultat obsolète est refusé plutôt que
d'être intégré silencieusement.

Le module sous test n'existe pas encore : ce test est rouge par construction. */

function writeFile(dir: string, name: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content, { encoding: "utf8" });
}

/** Lance un processus worker qui écrit un fichier dans un workspace. */
function workerWrites(workspace: string, fileName: string, content: string): void {
  const script = join(import.meta.dirname, "..", "src", "adapters", "integration-worker.ts");
  const result = spawnSync(process.execPath, [script, workspace, fileName, content], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`integration worker failed: status=${result.status} stderr=${result.stderr ?? ""}`);
  }
}

/** Commande de vérification : le fichier existe et contient exactement le contenu attendu. */
function verifyCommand(expectedContent: string): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [
      "-e",
      `const fs=require("fs");const c=fs.readFileSync(process.argv[1],"utf8");process.exit(c===${JSON.stringify(expectedContent)}?0:1)`,
      "result.txt",
    ],
  };
}

test("two isolated workspaces are captured, verified independently, and the composition is VERIFIED", () => {
  const root = mkdtempSync(join(tmpdir(), "cuesheet-h063-"));
  try {
    const ws1 = join(root, "ws1");
    const ws2 = join(root, "ws2");

    // Deux workers réels, deux workspaces disjoints, écriture isolée.
    workerWrites(ws1, "result.txt", "result-a");
    workerWrites(ws2, "result.txt", "result-b");

    const composed = verifyComposition(
      [
        {
          sessionId: "session-alpha",
          effectId: "E1",
          workspace: ws1,
          ...verifyCommand("result-a"),
        },
        {
          sessionId: "session-beta",
          effectId: "E2",
          workspace: ws2,
          ...verifyCommand("result-b"),
        },
      ],
      { root },
    );

    // Le résultat composé est VERIFIED seulement si chaque artefact est VERIFIED.
    assert.strictEqual(composed.verdict, "VERIFIED");
    assert.strictEqual(composed.artifacts.length, 2);

    // Chaque artefact est content-addressé et désigne son propre effet.
    const byEffect = new Map(composed.artifacts.map((a) => [a.artifact.producerEffectId, a]));
    assert.ok(byEffect.has("E1"));
    assert.ok(byEffect.has("E2"));

    // Chacune des deux vérifications porte sur son propre digest.
    const e1 = byEffect.get("E1")!;
    const e2 = byEffect.get("E2")!;
    assert.notStrictEqual(e1.artifact.artifactId, e2.artifact.artifactId);
    assert.strictEqual(e1.verification.target.effectId, "E1");
    assert.strictEqual(e2.verification.target.effectId, "E2");

    // Les preuves nomment l'artefact évalué, pas une opinion du producteur.
    for (const artifact of composed.artifacts) {
      assert.ok(artifact.verification.evidence.some((e) => e.kind === "target_digest"));
    }

    // Le verdict composé décrit le tout.
    assert.ok(typeof composed.verdict === "string");
    const v = composed.verdict as VerificationVerdict;
    assert.ok(v === "VERIFIED" || v === "REJECTED" || v === "INCONCLUSIVE");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a workspace vandalized after capture does not move the verdict (ART-04)", () => {
  const root = mkdtempSync(join(tmpdir(), "cuesheet-h063b-"));
  try {
    const ws1 = join(root, "ws1");
    writeFile(ws1, "result.txt", "result-a");

    // Capture une fois : les bytes figés ont un digest.
    const artifact: CapturedArtifact = capture({
      sessionId: "session-gamma",
      effectId: "E3",
      workspace: ws1,
      root,
    });
    assert.strictEqual(artifact.covers.includes("result.txt"), true);

    // Vérifier contre la capture : VERIFIED.
    const before = runAgainstArtifact({
      artifact,
      ...verifyCommand("result-a"),
    });
    assert.strictEqual(before.verdict, "VERIFIED");
    const digestBefore = artifact.digest;

    // Quelqu'un (ou un autre worker) touche le workspace vivant après la capture.
    writeFile(ws1, "result.txt", "tampered");

    // La capture est figée : vérifier contre les mêmes bytes figés donne
    // le même verdict. Le workspace vivant a changé mais l'artefact non.
    const after = runAgainstArtifact({
      artifact,
      ...verifyCommand("result-a"),
    });
    assert.strictEqual(after.verdict, before.verdict);
    assert.strictEqual(artifact.digest, digestBefore);

    // La vérification porte sur l'artefact (copie figée), pas sur le workspace vivant.
    assert.ok(after.evidence.some((e) => e.kind === "target_digest"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stale result is refused rather than integrated silently", () => {
  const root = mkdtempSync(join(tmpdir(), "cuesheet-h063c-"));
  try {
    const ws1 = join(root, "ws1");
    writeFile(ws1, "result.txt", "result-a");

    // Le contenu attendu ne correspond pas à ce que le worker a produit.
    const composed = verifyComposition(
      [
        {
          sessionId: "session-delta",
          effectId: "E4",
          workspace: ws1,
          command: process.execPath,
          args: [
            "-e",
            `const fs=require("fs");const c=fs.readFileSync(process.argv[1],"utf8");process.exit(c==="wrong"?0:1)`,
            "result.txt",
          ],
        },
      ],
      { root },
    );

    // Le résultat ne satisfait pas ce qui a été demandé : REJECTED, pas VERIFIED.
    assert.strictEqual(composed.verdict, "REJECTED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
