/**
 * Structure-aware unpacking of skill ZIP archives.
 *
 * Security properties (all enforced before a single byte is inflated):
 * - declared entry count / sizes / compression ratios are read from the
 *   central directory, so zip bombs are rejected without allocating;
 * - encrypted entries and symlinks are detected via header flags that generic
 *   unzip helpers silently ignore;
 * - duplicate entries are reported instead of silently merged;
 * - forbidden paths (traversal, absolute, devices, bidi) never reach staging.
 */

import { inflateSync } from "fflate";

import {
  ZipParseError,
  inflateEntry,
  isLocalHeaderPresent,
  readCentralDirectory,
} from "./central-directory";
import {
  countPathDepth,
  findForbiddenPathReason,
  normalizeEntryPath,
  stripSingleTopLevelDir,
} from "./entry-path";

export interface UnpackLimits {
  /** Maximum compressed size of the ZIP file itself. */
  maxZipBytes: number;
  /** Maximum number of entries (files + directories). */
  maxEntries: number;
  /** Maximum uncompressed size of a single file. */
  maxFileBytes: number;
  /** Maximum total uncompressed size of all files. */
  maxTotalBytes: number;
  /** Maximum per-entry compression ratio (uncompressed / compressed). */
  maxCompressionRatio: number;
  /** Maximum directory depth of a normalized entry path. */
  maxDepth: number;
}

export const DEFAULT_UNPACK_LIMITS: UnpackLimits = {
  maxZipBytes: 20 * 1024 * 1024,
  maxEntries: 500,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
  maxCompressionRatio: 100,
  maxDepth: 10,
};

export type UnpackBlockerCode =
  | "bad-zip"
  | "zip-too-large"
  | "too-many-entries"
  | "file-too-large"
  | "total-too-large"
  | "compression-ratio"
  | "depth-too-deep"
  | "encrypted-entry"
  | "symlink-entry"
  | "forbidden-path"
  | "duplicate-entry"
  | "corrupt-entry"
  | "inflated-size-mismatch"
  | "no-entries";

export type UnpackWarningCode = "case-conflict";

export interface UnpackIssue {
  code: UnpackBlockerCode | UnpackWarningCode;
  message: string;
  /** Entry name (normalized) the issue relates to, when applicable. */
  entry?: string;
}

export interface UnpackedFile {
  path: string;
  bytes: Uint8Array;
}

export interface UnpackResult {
  /** Inflated files, only present when there are no blockers. */
  files: UnpackedFile[];
  blockers: UnpackIssue[];
  warnings: UnpackIssue[];
  /** Total inflated size of all files, in bytes. */
  totalBytes: number;
  /** Names of scripts found in the archive, for the "executes code" warning. */
  scriptPaths: string[];
}

/** Files considered executable code for the capability warning. */
const SCRIPT_EXTENSIONS = new Set([
  "sh",
  "bash",
  "py",
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
]);

const MIN_COMPRESSED_SIZE_FOR_RATIO = 1;

/** Ratio checks only apply above this size: tiny files compress >100:1 trivially. */
const MIN_SIZE_FOR_RATIO_CHECK = 10 * 1024;

/**
 * Unpacks a skill ZIP, enforcing structural limits before inflating content.
 * Never throws for malformed archives — all problems are reported as blockers.
 */
export function unpackSkillZip(
  bytes: Uint8Array,
  limits: UnpackLimits = DEFAULT_UNPACK_LIMITS,
): UnpackResult {
  const empty: UnpackResult = {
    files: [],
    blockers: [],
    warnings: [],
    totalBytes: 0,
    scriptPaths: [],
  };

  if (bytes.length > limits.maxZipBytes) {
    return withBlocker(
      empty,
      "zip-too-large",
      `ZIP is ${(bytes.length / 1024 / 1024).toFixed(1)}MB, the limit is ${(limits.maxZipBytes / 1024 / 1024).toFixed(0)}MB`,
    );
  }

  let cd;
  try {
    cd = readCentralDirectory(bytes);
  } catch (error) {
    const message =
      error instanceof ZipParseError
        ? error.message
        : "Unknown ZIP parsing error";
    return withBlocker(
      empty,
      "bad-zip",
      `Not a readable ZIP archive: ${message}`,
    );
  }

  if (cd.entries.length === 0) {
    return withBlocker(empty, "no-entries", "The ZIP archive is empty");
  }
  if (cd.entries.length > limits.maxEntries) {
    return withBlocker(
      empty,
      "too-many-entries",
      `The archive declares ${cd.entries.length} entries, the limit is ${limits.maxEntries}`,
    );
  }

  const blockers: UnpackIssue[] = [];
  const warnings: UnpackIssue[] = [];

  // Normalize all names up front; structural checks operate on paths.
  const normalized = cd.entries.map((entry) => ({
    entry,
    path:
      entry.isDir && entry.name.endsWith("/")
        ? normalizeEntryPath(entry.name)
        : normalizeEntryPath(entry.name),
  }));

  const nameCounts = new Map<string, number>();
  for (const { path } of normalized) {
    nameCounts.set(path, (nameCounts.get(path) ?? 0) + 1);
  }

  let declaredTotal = 0;
  let totalLimitExceeded = false;

  for (const { entry, path } of normalized) {
    const forbidden = findForbiddenPathReason(path);
    if (forbidden) {
      blockers.push({
        code: "forbidden-path",
        entry: path,
        message: `Entry path is not allowed (${forbidden.replace(/-/g, " ")})`,
      });
      continue;
    }
    if (entry.encrypted) {
      blockers.push({
        code: "encrypted-entry",
        entry: path,
        message:
          "Entry is encrypted; encrypted skill packages are not supported",
      });
      continue;
    }
    if (entry.isSymlink) {
      blockers.push({
        code: "symlink-entry",
        entry: path,
        message:
          "Entry is a symlink; links are not allowed inside skill packages",
      });
      continue;
    }
    if (entry.isDir) {
      continue;
    }

    if (entry.uncompSize > limits.maxFileBytes) {
      blockers.push({
        code: "file-too-large",
        entry: path,
        message: `Entry inflates to ${(entry.uncompSize / 1024 / 1024).toFixed(1)}MB, the per-file limit is ${(limits.maxFileBytes / 1024 / 1024).toFixed(0)}MB`,
      });
      continue;
    }

    const depth = countPathDepth(path);
    if (depth > limits.maxDepth) {
      blockers.push({
        code: "depth-too-deep",
        entry: path,
        message: `Entry is ${depth} levels deep, the limit is ${limits.maxDepth}`,
      });
    }

    if (!totalLimitExceeded) {
      declaredTotal += entry.uncompSize;
      if (declaredTotal > limits.maxTotalBytes) {
        totalLimitExceeded = true;
        blockers.push({
          code: "total-too-large",
          message: `Archive inflates to more than ${(limits.maxTotalBytes / 1024 / 1024).toFixed(0)}MB in total`,
        });
      }
    }

    const ratio =
      entry.uncompSize /
      Math.max(entry.compSize, MIN_COMPRESSED_SIZE_FOR_RATIO);
    if (
      entry.method !== 0 &&
      entry.uncompSize >= MIN_SIZE_FOR_RATIO_CHECK &&
      ratio > limits.maxCompressionRatio
    ) {
      blockers.push({
        code: "compression-ratio",
        entry: path,
        message: `Entry compresses ${Math.round(ratio)}:1, the limit is ${limits.maxCompressionRatio}:1 (possible zip bomb)`,
      });
    }
  }

  // Duplicate entries (exact) are blockers; case-only conflicts are warnings.
  const seenExact = new Set<string>();
  const seenFolded = new Map<string, string>();
  for (const { path } of normalized) {
    if (nameCounts.get(path)! > 1) {
      if (!seenExact.has(path)) {
        seenExact.add(path);
        blockers.push({
          code: "duplicate-entry",
          entry: path,
          message: "The archive contains duplicate entries for this path",
        });
      }
      continue;
    }
    const folded = path.toLowerCase();
    const existing = seenFolded.get(folded);
    if (existing !== undefined && existing !== path) {
      warnings.push({
        code: "case-conflict",
        entry: path,
        message: `Path differs only in case from "${existing}"`,
      });
    } else {
      seenFolded.set(folded, path);
    }
  }

  if (blockers.length > 0) {
    return { ...empty, blockers, warnings };
  }

  // All structural checks passed — inflate per entry with size verification.
  const files: UnpackedFile[] = [];
  let totalBytes = 0;

  for (const { entry, path } of normalized) {
    if (entry.isDir) {
      continue;
    }
    let content: Uint8Array;
    try {
      if (!isLocalHeaderPresent(bytes, entry)) {
        blockers.push({
          code: "corrupt-entry",
          entry: path,
          message: "Local file header is missing or corrupt",
        });
        continue;
      }
      content = inflateEntry(bytes, entry, inflateSync);
    } catch (error) {
      blockers.push({
        code: "corrupt-entry",
        entry: path,
        message: `Failed to inflate entry: ${error instanceof Error ? error.message : "unknown error"}`,
      });
      continue;
    }

    if (content.length !== entry.uncompSize) {
      blockers.push({
        code: "inflated-size-mismatch",
        entry: path,
        message: `Entry inflated to ${content.length} bytes but declared ${entry.uncompSize}`,
      });
      continue;
    }

    totalBytes += content.length;
    files.push({ path, bytes: content });
  }

  if (blockers.length > 0) {
    return { files: [], blockers, warnings, totalBytes: 0, scriptPaths: [] };
  }

  // GitHub-style wrapping directory: SKILL.md may sit one level down.
  const topLevel = stripSingleTopLevelDir(files.map((file) => file.path));
  const finalFiles = topLevel
    ? files.map((file) => ({
        path: file.path.slice(topLevel.topDir.length + 1),
        bytes: file.bytes,
      }))
    : files;

  return {
    files: finalFiles,
    blockers,
    warnings,
    totalBytes,
    scriptPaths: finalFiles
      .filter((file) => isScriptPath(file.path))
      .map((file) => file.path),
  };
}

function withBlocker(
  result: UnpackResult,
  code: UnpackBlockerCode,
  message: string,
): UnpackResult {
  return { ...result, blockers: [{ code, message }] };
}

export function isScriptPath(path: string): boolean {
  const dotIndex = path.lastIndexOf(".");
  if (dotIndex < 0 || dotIndex === path.length - 1) {
    return false;
  }
  return SCRIPT_EXTENSIONS.has(path.slice(dotIndex + 1).toLowerCase());
}
