/**
 * Correctness/legitimacy validation of an unpacked skill package.
 *
 * This is the second layer of the three-layer check pipeline (structure ->
 * correctness -> security). It operates on the files produced by
 * `unpackSkillZip`, i.e. paths are already normalized, top-level wrapping
 * directories already stripped, and structural threats already blocked.
 */

import type { UnpackedFile } from "./unpack";
import { isScriptPath } from "./unpack";
import { parseSkillFrontmatter } from "./frontmatter";

export type ValidatorBlockerCode =
  | "missing-skill-md"
  | "missing-frontmatter"
  | "unterminated-frontmatter"
  | "invalid-frontmatter"
  | "missing-name"
  | "missing-description"
  | "invalid-name"
  | "reserved-name";

export interface SkillPackageIssue {
  code: ValidatorBlockerCode;
  message: string;
}

export interface SkillPackageInfo {
  /** Frontmatter name, or "" when it could not be determined. */
  name: string;
  fileCount: number;
  /** Total inflated size of all files, in bytes. */
  totalSize: number;
  /** Whether the package contains executable scripts (.sh/.py/.js/...). */
  hasScripts: boolean;
}

export interface SkillPackageValidation {
  blockers: SkillPackageIssue[];
  info: SkillPackageInfo;
}

/** Mirrors the server-side SKILL_NAME_PATTERN. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Names the installed-skills layout reserves for its own use. */
const RESERVED_NAMES = new Set([
  "installed",
  "skills",
  "agents",
  "marketplace",
]);

export function validateSkillPackage(
  files: UnpackedFile[],
): SkillPackageValidation {
  const totalSize = files.reduce((sum, file) => sum + file.bytes.length, 0);
  const hasScripts = files.some((file) => isScriptPath(file.path));

  const info: SkillPackageInfo = {
    name: "",
    fileCount: files.length,
    totalSize,
    hasScripts,
  };

  const skillMd = files.find((file) => file.path === "SKILL.md");
  if (!skillMd) {
    return {
      blockers: [
        {
          code: "missing-skill-md",
          message: "The package does not contain a SKILL.md at its root",
        },
      ],
      info,
    };
  }

  const markdown = new TextDecoder().decode(skillMd.bytes);
  const parsed = parseSkillFrontmatter(markdown);
  if (!parsed.ok) {
    const code: ValidatorBlockerCode =
      parsed.code === "invalid-line" ? "invalid-frontmatter" : parsed.code;
    return {
      blockers: [{ code, message: parsed.message }],
      info,
    };
  }

  const name = parsed.frontmatter.name;
  info.name = name;

  const blockers: SkillPackageIssue[] = [];
  if (!NAME_PATTERN.test(name)) {
    blockers.push({
      code: "invalid-name",
      message: `Skill name "${name}" is invalid: use lowercase letters, digits and hyphens (max 64 chars, starting with a letter or digit)`,
    });
  } else if (RESERVED_NAMES.has(name)) {
    blockers.push({
      code: "reserved-name",
      message: `"${name}" is a reserved skill name and cannot be used`,
    });
  }

  return { blockers, info };
}
