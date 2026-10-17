# Cuesheet — Mergify automatic landing canary

This documentation-only change verifies the Cuesheet low-risk merge lane following the
controlled cutover from the former GitHub auto-merge workflow to Mergify.

- Memo Bridge creates and pushes the agent branch with an isolated issue claim.
- GitHub Actions runs the `Core and integration tests` job.
- Mergify admits and squash-merges the PR automatically after that check succeeds.
- No reviewer, manual approval label or direct merge command is used on this canary.
- The old auto-merge workflow stays disabled, and draft PR #57 stays untouched.

Issue: memolabs-dev/cuesheet#75
Date: 2026-10-16

## 2026-10-17: autoloop policy

The pilot rules above (bot author only, created-at cutoff, size caps, code paths excluded) are
replaced by the Memo Labs fleet template (memolabs-dev/memo-bridge
`docs/MERGIFY_FLEET_ADOPTION.md`): a green PR from `memo-labs-automation[bot]` or the owner
lands; `.github/`, `.mergify.yml`, `CODEOWNERS`, the root `AGENTS.md`, `deploy/`, `infra/`,
`stacks/`, `ansible/`, `migrations/` and `.env*` wait for the owner. The disabled
`auto-merge.yml` workflow is deleted in the same change.
