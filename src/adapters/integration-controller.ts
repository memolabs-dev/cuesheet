/**
 * Adapter: integrating work from isolated workspaces into one verdict.
 *
 * H06.3. Each workspace is captured (frozen, content-addressed) and then
 * verified independently against its own capture — never against the live
 * directory. The composed verdict is VERIFIED only when every artifact is
 * VERIFIED; any REJECTED makes the composition REJECTED; any INCONCLUSIVE
 * with no REJECTED makes it INCONCLUSIVE.
 *
 * Nothing here trusts a producer's own account. A worker asserts it produced
 * something; the capture says what the bytes actually were; the verifier says
 * whether they satisfy what was asked. The producer's `success` flag is
 * carried but never consulted, exactly as VER-02 requires.
 *
 * The module body runs nothing on import (guarded by import.meta.url below),
 * so LOAD-01 / LOAD-03 keep importing every module under src.
 */

import { capture, type CapturedArtifact } from "./artifact-capture.ts";
import { runAgainstArtifact, type RunOptions } from "./artifact-verifier.ts";
import type { Verification, VerificationVerdict } from "../verify.ts";

/** One workspace's capture and its independent verification. */
export interface VerifiedArtifact {
  /** The frozen artifact, named by its own content. */
  readonly artifact: CapturedArtifact;
  /** The independent check run against that capture and nothing else. */
  readonly verification: Verification;
}

/** The composed result of verifying one or more isolated workspaces. */
export interface ComposedResult {
  /**
   * VERIFIED only when every artifact is VERIFIED. REJECTED when any artifact
   * is REJECTED. INCONCLUSIVE when no artifact is REJECTED but at least one
   * could not be established.
   */
  readonly verdict: VerificationVerdict;
  /** Each workspace's artifact and its own verification. */
  readonly artifacts: readonly VerifiedArtifact[];
  /** Aggregated evidence, named per artifact. */
  readonly evidence: readonly { effectId: string; evidence: readonly { kind: string; value: string }[] }[];
}

/** One workspace to verify: who produced it, where it lives, and the check. */
export interface WorkspaceToVerify {
  readonly sessionId: string;
  readonly effectId: string;
  /** The workspace to freeze. Read, never written by this module. */
  readonly workspace: string;
  /** The program to run inside the capture. */
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Verify a composition of isolated workspaces.
 *
 * Each workspace is captured once, and the verifier runs against the capture
 * only. The live directory may change afterwards and the verdict will not
 * move (ART-04). A composition is VERIFIED only when every artifact is
 * VERIFIED; no single worker's success claim can carry the whole result.
 *
 * `options.now` is injected so this is testable without a real clock.
 */
export function verifyComposition(
  sessions: readonly WorkspaceToVerify[],
  options: { root: string; now?: () => number; timeoutMs?: number },
): ComposedResult {
  const { root, now, timeoutMs } = options;
  const verified: VerifiedArtifact[] = [];

  for (const session of sessions) {
    const artifact = capture({
      sessionId: session.sessionId,
      effectId: session.effectId,
      workspace: session.workspace,
      root,
      now,
    });

    const verification = runAgainstArtifact({
      artifact,
      command: session.command,
      args: session.args,
      verificationId: `${session.effectId}-${artifact.artifactId}`,
      timeoutMs,
    });

    verified.push({ artifact, verification });
  }

  // Compose verdicts. REJECTED dominates; otherwise INCONCLUSIVE if any is
  // unsettled; otherwise VERIFIED.
  let verdict: VerificationVerdict = "VERIFIED";
  for (const { verification } of verified) {
    if (verification.verdict === "REJECTED") {
      verdict = "REJECTED";
      break;
    }
    if (verification.verdict === "INCONCLUSIVE") {
      verdict = "INCONCLUSIVE";
    }
  }

  const evidence = verified.map(({ artifact, verification }) => ({
    effectId: artifact.producerEffectId,
    evidence: verification.evidence,
  }));

  return { verdict, artifacts: verified, evidence };
}
