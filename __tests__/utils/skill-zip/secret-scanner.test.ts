import { describe, expect, it } from "vitest";

import { scanFilesForSecrets } from "#/utils/skill-zip/secret-scanner";
import type { UnpackedFile } from "#/utils/skill-zip/unpack";

function file(path: string, content: string | Uint8Array): UnpackedFile {
  return {
    path,
    bytes:
      typeof content === "string" ? new TextEncoder().encode(content) : content,
  };
}

// Deterministic fake credentials that satisfy each rule's shape but are not real.
const FAKE_OPENAI = "sk-abcdefghijklmnopqrstuvwxyz123456";
const FAKE_GITHUB = `ghp_${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"}`; // 36 chars
const FAKE_SLACK = "xoxb-1234567890abcdef";
const FAKE_AWS = "AKIAIOSFODNN7EXAMPLE"; // AKIA + 16, canonical doc example
const FAKE_FERNET = `gAAAAA${"aB3dEf7hIj9lMn2pQr5tUv8xYz1_-"}`; // >20 tail chars
const FAKE_JWT = `eyJ${"a".repeat(12)}.${"b".repeat(12)}.${"c".repeat(12)}`;
const PRIVATE_KEY_HEADER = "-----BEGIN RSA PRIVATE KEY-----";

describe("scanFilesForSecrets", () => {
  it("flags each known credential shape with rule and line number", () => {
    const text = [
      "harmless first line",
      `token: ${FAKE_OPENAI}`,
      "third line",
      `github: ${FAKE_GITHUB}`,
      `slack: ${FAKE_SLACK}`,
      `aws: ${FAKE_AWS}`,
      `fernet: ${FAKE_FERNET}`,
      `jwt: ${FAKE_JWT}`,
      PRIVATE_KEY_HEADER,
    ].join("\n");

    const result = scanFilesForSecrets([file("SKILL.md", text)]);
    const rules = result.findings.map((finding) => finding.rule);

    expect(rules).toContain("openai-style-key");
    expect(rules).toContain("github-token");
    expect(rules).toContain("slack-token");
    expect(rules).toContain("aws-access-key");
    expect(rules).toContain("fernet-token");
    expect(rules).toContain("jwt");
    expect(rules).toContain("private-key");

    const openaiFinding = result.findings.find(
      (f) => f.rule === "openai-style-key",
    );
    expect(openaiFinding?.file).toBe("SKILL.md");
    expect(openaiFinding?.line).toBe(2);
    expect(result.findings.find((f) => f.rule === "github-token")?.line).toBe(
      4,
    );
  });

  it.each([
    ["sk-learn is a library name", "no secret"],
    ["risk-assessment workflow", "no secret"],
    ["task-oriented planning", "no secret"],
  ])("does not flag %s", (line) => {
    const result = scanFilesForSecrets([file("notes.md", `${line}\n`)]);

    expect(result.findings).toEqual([]);
  });

  it("never echoes the matched secret content", () => {
    const result = scanFilesForSecrets([
      file("SKILL.md", `key = "${FAKE_OPENAI}"\n`),
    ]);
    const serialized = JSON.stringify(result);

    expect(result.findings).toHaveLength(1);
    expect(serialized).not.toContain(FAKE_OPENAI);
  });

  it("scans multiple files and dedupes identical findings per line", () => {
    const result = scanFilesForSecrets([
      file("SKILL.md", `a: ${FAKE_OPENAI}\n`),
      file("scripts/x.py", `token = "${FAKE_OPENAI}"\n`),
    ]);

    expect(result.findings).toHaveLength(2);
    expect(result.findings.map((finding) => finding.file).sort()).toEqual([
      "SKILL.md",
      "scripts/x.py",
    ]);
  });

  it("skips binary files entirely", () => {
    const binary = new Uint8Array([0x64, 0x00, 0x8f, 0xe2, 0xab, 0x00, 0x37]);

    const result = scanFilesForSecrets([file("assets/logo.png", binary)]);

    expect(result.findings).toEqual([]);
    expect(result.skipped).toEqual([
      { file: "assets/logo.png", reason: "binary" },
    ]);
  });

  it("skips files above the size limit without scanning them", () => {
    // 3MB of harmless padding with a secret pasted near the start.
    const buffer = new Uint8Array(3 * 1024 * 1024);
    buffer.set(new TextEncoder().encode(`${FAKE_OPENAI}\n`), 0);

    const result = scanFilesForSecrets([file("real.txt", buffer)]);

    expect(result.findings).toEqual([]);
    expect(result.skipped).toEqual([{ file: "real.txt", reason: "too-large" }]);
  });

  it("truncates scanning at the per-file scan limit and reports it", () => {
    const head = `early: ${FAKE_OPENAI}\n`;
    const filler = "x".repeat(1024 * 1024);
    const tail = `late: ${FAKE_OPENAI}\n`;
    const content = head + filler + tail;

    const result = scanFilesForSecrets([file("SKILL.md", content)]);

    // The early secret is found, the late one is beyond the truncated window.
    expect(result.findings).toHaveLength(1);
    expect(result.partial).toEqual([{ file: "SKILL.md", reason: "truncated" }]);
  });
});
