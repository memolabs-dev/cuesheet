import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractSkillRequirements } from "../src/core/extract.ts";

describe("extractSkillRequirements", () => {
  // The admission fixture: the real text of the 2026-09-29 incident, taken
  // from the session database rather than reconstructed. At the time of the
  // incident `github-readme` did not exist in the registry, which is exactly
  // why name-against-registry matching could never have seen this.
  it("the incident: 'load the `github-readme` skill' is a directive requirement", () => {
    const text =
      "Make the public GitHub page of `uni-protocol` impeccable.\n\n" +
      "STEP 1, before anything else: load the `github-readme` skill and follow it.";

    const r = extractSkillRequirements(text);

    assert.deepEqual(
      r.requirements.map((q) => q.name),
      ["github-readme"],
    );
    const match = r.matches[0];
    assert.equal(match.directive, true, "load is an instruction, not a mention");
    assert.match(match.snippet, /load the `github-readme` skill/);
  });

  it("a bare quoted mention is a requirement with lower confidence", () => {
    const r = extractSkillRequirements("The `humanizer` skill covers the voice rules.");
    assert.deepEqual(r.requirements.map((q) => q.name), ["humanizer"]);
    assert.equal(r.matches[0].directive, false);
  });

  it("'use the X skill' with no quotes is still a directive", () => {
    const r = extractSkillRequirements("Use the tdd skill for this change.");
    assert.deepEqual(r.requirements.map((q) => q.name), ["tdd"]);
    assert.equal(r.matches[0].directive, true);
  });

  it("'skill named X' is a directive", () => {
    const r = extractSkillRequirements("There is a skill named qa-only that reports without fixing.");
    assert.deepEqual(r.requirements.map((q) => q.name), ["qa-only"]);
    assert.equal(r.matches[0].directive, true);
  });

  it("plural skills with a list of names are each extracted", () => {
    const r = extractSkillRequirements("Load the `cso` skill and the `security-arsenal` skill.");
    assert.deepEqual(
      r.requirements.map((q) => q.name).sort(),
      ["cso", "security-arsenal"],
    );
  });

  it("a name inside a code fence is documentation, not an instruction", () => {
    const text = [
      "Steps:",
      "```",
      "load the `some-skill` skill",
      "```",
      "Then run the tests.",
    ].join("\n");
    assert.deepEqual(extractSkillRequirements(text).requirements, []);
  });

  it("an inline code span is stripped, for the same reason", () => {
    const text = "Reference: `run the fake-skill skill` in the docs.";
    assert.deepEqual(extractSkillRequirements(text).requirements, []);
  });

  it("a word next to 'skill' that is not quoted and not directed is not a requirement", () => {
    // "agent skill handling" or prose like "skills are loaded" must not
    // manufacture a requirement named `agent` or `loaded`.
    const r = extractSkillRequirements("Skills are loaded at session start in this runtime.");
    assert.deepEqual(r.requirements, []);
  });

  it("prose with no skill references extracts nothing", () => {
    const r = extractSkillRequirements("Fix the failing test in packages/core/src/index.ts.");
    assert.deepEqual(r.requirements, []);
    assert.deepEqual(r.matches, []);
  });

  it("a directive outranks a bare mention for the same name", () => {
    const text = "The `k1` skill exists. Load the `k1` skill before writing.";
    const r = extractSkillRequirements(text);
    assert.equal(r.requirements.length, 1);
    assert.equal(r.matches[0].directive, true);
  });

  it("an empty or whitespace text extracts nothing", () => {
    assert.deepEqual(extractSkillRequirements("").requirements, []);
    assert.deepEqual(extractSkillRequirements("   \n  ").requirements, []);
  });

  it("the extractor is not fooled by the word 'skills' alone", () => {
    const r = extractSkillRequirements("No skills here, just work.");
    assert.deepEqual(r.requirements, []);
  });

  // cuesheet#77. French writes the name after the keyword, "utiliser la skill
  // `x`", which none of the English patterns reach. 726 passages in the local
  // brief corpus mention a skill; the forms below were chosen by reading what
  // each candidate pattern extracts from them, not by widening until the
  // French sentence passed.
  it("a French instruction to use a skill is a directive requirement", () => {
    const r = extractSkillRequirements(
      "Tu dois utiliser la skill `adversarial-qa` avant de merger.",
    );
    assert.deepEqual(
      r.requirements.map((q) => q.name),
      ["adversarial-qa"],
    );
    assert.equal(r.matches[0].directive, true);
  });

  it("a French mention beside the keyword is a requirement with lower confidence", () => {
    const r = extractSkillRequirements("La skill `humanizer` couvre les règles de voix.");
    assert.deepEqual(
      r.requirements.map((q) => q.name),
      ["humanizer"],
    );
    assert.equal(r.matches[0].directive, false);
  });

  it("a word after the keyword that is not quoted is prose, not a name", () => {
    // Measured: 568 of those 726 passages carry a word right after "skill",
    // and the words are ordinary text, "de" included. The quoted form is the
    // one that names a skill.
    const r = extractSkillRequirements(
      "Il faut utiliser la skill de session avant de merger.",
    );
    assert.deepEqual(r.requirements, []);
  });

  it("a negated naming declares the opposite, so it is not a requirement", () => {
    // cuesheet#77: this sentence manufactured a requirement named `here`,
    // inside the gate's own sensor, before any verdict was joined to it.
    const r = extractSkillRequirements("There is no skill named here at all.");
    assert.deepEqual(r.requirements, []);
  });

  it("a negated instruction is not a requirement either", () => {
    assert.deepEqual(
      extractSkillRequirements("Do not use the `destructive-verb` skill here.")
        .requirements,
      [],
    );
    assert.deepEqual(
      extractSkillRequirements("Ne pas utiliser la skill `destructive-verb` ici.")
        .requirements,
      [],
    );
  });
});
