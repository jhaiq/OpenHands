import { describe, expect, it } from "vitest";

import {
  countPathDepth,
  findForbiddenPathReason,
  isForbiddenEntryPath,
  normalizeEntryPath,
  stripSingleTopLevelDir,
} from "#/utils/skill-zip/entry-path";

describe("normalizeEntryPath", () => {
  it("keeps plain relative paths unchanged", () => {
    expect(normalizeEntryPath("SKILL.md")).toBe("SKILL.md");
    expect(normalizeEntryPath("scripts/run.sh")).toBe("scripts/run.sh");
  });

  it("applies Unicode NFC normalization", () => {
    const decomposed = "cafe\u0301.txt"; // é as e + combining accent
    expect(normalizeEntryPath(decomposed)).toBe("caf\u00e9.txt");
  });

  it("collapses duplicate slashes and strips leading ./ segments", () => {
    expect(normalizeEntryPath("./demo//SKILL.md")).toBe("demo/SKILL.md");
    expect(normalizeEntryPath(".//./a//b///c")).toBe("a/b/c");
  });

  it("trims a trailing slash but keeps bare directory entries recognizable", () => {
    expect(normalizeEntryPath("demo/")).toBe("demo");
    expect(normalizeEntryPath("/")).toBe("/");
  });
});

describe("findForbiddenPathReason", () => {
  it.each([
    ["../evil.sh", "parent-traversal"],
    ["demo/../../evil.sh", "parent-traversal"],
    ["..\\evil.sh", "parent-traversal"],
    ["/etc/passwd", "absolute-path"],
    ["\\Windows\\evil.exe", "absolute-path"],
    ["C:evil.txt", "drive-prefix"],
    ["C:\\evil.txt", "drive-prefix"],
    ["doc\u202egnp.exe", "bidi-control"],
    ["report\u2066x\u2069.txt", "bidi-control"],
    ["bad\u0000name.txt", "control-character"],
    ["line\nbreak.txt", "control-character"],
    ["CON", "reserved-device"],
    ["nul.txt", "reserved-device"],
    ["scripts/COM1.log", "reserved-device"],
    ["demo\\run.sh", "backslash-separator"],
  ])("rejects %s with reason %s", (name, expected) => {
    expect(findForbiddenPathReason(name)).toBe(expected);
    expect(isForbiddenEntryPath(name)).toBe(true);
  });

  it.each([
    "SKILL.md",
    "scripts/run.sh",
    "deep/nested/but/valid/file.md",
    "caf\u00e9-notes.md",
    "file..double..dot.md",
    "not..traversal/ok.md",
  ])("accepts %s", (name) => {
    expect(findForbiddenPathReason(name)).toBeNull();
    expect(isForbiddenEntryPath(name)).toBe(false);
  });

  it("does not flag inner double dots that stay inside a segment", () => {
    expect(findForbiddenPathReason("file..md")).toBeNull();
    expect(findForbiddenPathReason("a.b.c/file..md")).toBeNull();
  });

  it("treats empty and dot names as empty entries", () => {
    expect(findForbiddenPathReason("")).toBe("empty");
    expect(findForbiddenPathReason(".")).toBe("empty");
    expect(findForbiddenPathReason("/")).toBe("empty");
  });
});

describe("stripSingleTopLevelDir", () => {
  it("strips a wrapping GitHub-style directory", () => {
    const result = stripSingleTopLevelDir([
      "my-skill-1.0.0/SKILL.md",
      "my-skill-1.0.0/scripts/run.sh",
      "my-skill-1.0.0/scripts/",
    ]);

    expect(result).toEqual({
      topDir: "my-skill-1.0.0",
      paths: ["SKILL.md", "scripts/run.sh", "scripts"],
    });
  });

  it("returns null when files exist at the archive root", () => {
    expect(stripSingleTopLevelDir(["SKILL.md", "pkg/SKILL.md"])).toBeNull();
  });

  it("returns null when several top-level directories exist", () => {
    expect(stripSingleTopLevelDir(["a/SKILL.md", "b/SKILL.md"])).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(stripSingleTopLevelDir([])).toBeNull();
  });

  it("does not strip when a hidden root file would disappear", () => {
    expect(stripSingleTopLevelDir(["pkg/SKILL.md", ".DS_Store"])).toBeNull();
  });
});

describe("countPathDepth", () => {
  it.each([
    ["SKILL.md", 1],
    ["scripts/run.sh", 2],
    ["a/b/c/d/e/f/g/h/i/j/k.txt", 11],
    ["demo/", 1],
  ])("counts %s as %i", (path, expected) => {
    expect(countPathDepth(path)).toBe(expected);
  });
});
