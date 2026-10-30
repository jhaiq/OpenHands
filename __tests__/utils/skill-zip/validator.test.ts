import { describe, expect, it } from "vitest";

import { validateSkillPackage } from "#/utils/skill-zip/validator";
import type { UnpackedFile } from "#/utils/skill-zip/unpack";

function file(path: string, text: string): UnpackedFile {
  return { path, bytes: new TextEncoder().encode(text) };
}

const VALID_SKILL_MD = `---
name: demo-skill
description: A demo skill for tests
---
# Demo
`;

function blockerCodes(
  result: ReturnType<typeof validateSkillPackage>,
): string[] {
  return result.blockers.map((blocker) => blocker.code);
}

describe("validateSkillPackage", () => {
  it("accepts a package with a root SKILL.md and valid frontmatter", () => {
    const result = validateSkillPackage([
      file("SKILL.md", VALID_SKILL_MD),
      file("scripts/run.py", "print('hi')\n"),
    ]);

    expect(result.blockers).toEqual([]);
    expect(result.info).toEqual({
      name: "demo-skill",
      fileCount: 2,
      totalSize: expect.any(Number),
      hasScripts: true,
    });
  });

  it("blocks when SKILL.md is missing entirely", () => {
    const result = validateSkillPackage([file("README.md", "no skill here\n")]);

    expect(blockerCodes(result)).toContain("missing-skill-md");
    expect(result.info?.name).toBe("");
  });

  it("blocks when SKILL.md has no frontmatter block", () => {
    const result = validateSkillPackage([
      file("SKILL.md", "# Just markdown\n"),
    ]);

    expect(blockerCodes(result)).toContain("missing-frontmatter");
  });

  it("blocks when frontmatter lacks name or description", () => {
    const noName = validateSkillPackage([
      file("SKILL.md", "---\ndescription: only description\n---\nbody\n"),
    ]);
    expect(blockerCodes(noName)).toContain("missing-name");

    const noDescription = validateSkillPackage([
      file("SKILL.md", "---\nname: demo-skill\n---\nbody\n"),
    ]);
    expect(blockerCodes(noDescription)).toContain("missing-description");
  });

  it.each([
    ["Uppercase-Name", "invalid-name"],
    ["-starts-with-hyphen", "invalid-name"],
    ["has_underscore", "invalid-name"],
    ["a".repeat(65), "invalid-name"],
  ])("rejects illegal name %s", (name, code) => {
    const result = validateSkillPackage([
      file("SKILL.md", `---\nname: ${name}\ndescription: desc\n---\nbody\n`),
    ]);

    expect(blockerCodes(result)).toContain(code);
  });

  it.each(["installed", "skills", "agents", "marketplace"])(
    "rejects reserved name %s",
    (name) => {
      const result = validateSkillPackage([
        file("SKILL.md", `---\nname: ${name}\ndescription: desc\n---\nbody\n`),
      ]);

      expect(blockerCodes(result)).toContain("reserved-name");
    },
  );

  it("reports info for an empty package without crashing", () => {
    const result = validateSkillPackage([]);

    expect(blockerCodes(result)).toContain("missing-skill-md");
    expect(result.info).toEqual({
      name: "",
      fileCount: 0,
      totalSize: 0,
      hasScripts: false,
    });
  });
});
