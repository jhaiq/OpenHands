/**
 * Credential-leak scanning over unpacked skill files.
 *
 * Deliberately tight rules: a scanner that cries wolf on every `sk-` substring
 * would train users to ignore it. Rules require explicit token shapes with
 * boundary guards so library names like `sk-learn` or `risk-assessment` do not
 * match. Findings report file + line + rule name only — matched content is
 * never echoed, so the report itself cannot leak the secret.
 *
 * Scope limits: binary files are skipped, files above MAX_FILE_BYTES are
 * skipped, and scanning inside a file stops after SCAN_WINDOW_BYTES with a
 * "partially scanned" marker so users know coverage was incomplete.
 */

import type { UnpackedFile } from "./unpack";

export type SecretRuleName =
  | "openai-style-key"
  | "github-token"
  | "slack-token"
  | "aws-access-key"
  | "private-key"
  | "fernet-token"
  | "jwt";

export interface SecretFinding {
  file: string;
  line: number;
  rule: SecretRuleName;
}

export interface SecretScanResult {
  findings: SecretFinding[];
  /** Files excluded entirely, with the reason. */
  skipped: { file: string; reason: "binary" | "too-large" }[];
  /** Files scanned only up to the scan window. */
  partial: { file: string; reason: "truncated" }[];
}

/** Files larger than this are not scanned at all. */
export const SECRET_SCAN_MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Only the first N bytes of each file are scanned; the rest is reported as partial. */
export const SECRET_SCAN_WINDOW_BYTES = 1024 * 1024;

interface SecretRule {
  name: SecretRuleName;
  pattern: RegExp;
}

/**
 * `(?<![A-Za-z0-9_-])` keeps the match from starting inside a longer word or
 * hyphenated compound (`risk-`, `task-`); token bodies are length- and
 * alphabet-constrained per the credential format.
 */
const RULES: SecretRule[] = [
  {
    name: "openai-style-key",
    pattern: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/g,
  },
  {
    name: "github-token",
    pattern: /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g,
  },
  {
    name: "slack-token",
    pattern: /(?<![A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{10,}/g,
  },
  {
    name: "aws-access-key",
    pattern: /(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![0-9A-Z])/g,
  },
  { name: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  {
    name: "fernet-token",
    pattern: /(?<![A-Za-z0-9_-])gAAAAA[A-Za-z0-9_-]{20,}/g,
  },
  {
    name: "jwt",
    pattern:
      /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
];

const decoder = new TextDecoder("utf-8", { fatal: true });

export function scanFilesForSecrets(files: UnpackedFile[]): SecretScanResult {
  const findings: SecretFinding[] = [];
  const skipped: SecretScanResult["skipped"] = [];
  const partial: SecretScanResult["partial"] = [];

  for (const file of files) {
    if (file.bytes.length > SECRET_SCAN_MAX_FILE_BYTES) {
      skipped.push({ file: file.path, reason: "too-large" });
      continue;
    }

    let text: string;
    try {
      text = decoder.decode(file.bytes);
    } catch {
      skipped.push({ file: file.path, reason: "binary" });
      continue;
    }

    if (text.includes("\u0000")) {
      skipped.push({ file: file.path, reason: "binary" });
      continue;
    }

    const truncated = file.bytes.length > SECRET_SCAN_WINDOW_BYTES;
    if (truncated) {
      partial.push({ file: file.path, reason: "truncated" });
    }

    // Scan only the window; cutting at an arbitrary byte may split a token,
    // which at worst misses one finding — acceptable for a truncated scan.
    const windowText = truncated
      ? text.slice(0, SECRET_SCAN_WINDOW_BYTES)
      : text;
    const lines = windowText.split(/\r?\n/);

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      for (const rule of RULES) {
        const pattern = new RegExp(rule.pattern.source, "g");
        if (pattern.test(lines[lineIndex])) {
          findings.push({
            file: file.path,
            line: lineIndex + 1,
            rule: rule.name,
          });
        }
      }
    }
  }

  return { findings, skipped, partial };
}
