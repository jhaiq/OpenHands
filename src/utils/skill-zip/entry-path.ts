/**
 * Path handling for entries extracted from a skill ZIP archive.
 *
 * Entry names are attacker-controlled: they may carry traversal segments,
 * Windows-style absolute paths, reserved device names, bidirectional control
 * characters that visually reorder file extensions, or non-Unicode forms that
 * produce visually identical but distinct paths. Everything in this module is
 * pure string handling so it can be exhaustively unit tested.
 */

/** Bidirectional override/isolate characters that can fake file extensions. */
const BIDI_CONTROL_PATTERN = /[\u202A-\u202E\u2066-\u2069]/;

/** C0 control characters and DEL have no business in file names. */
// eslint-disable-next-line no-control-regex -- detecting control characters is exactly the point
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;

/** Windows reserved device names, with or without an extension. */
const RESERVED_DEVICE_PATTERN = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** A drive-letter prefix such as `C:` at the start of an entry name. */
const DRIVE_PREFIX_PATTERN = /^[A-Za-z]:/;

/**
 * Normalizes an entry name for comparison and staging:
 * Unicode NFC form, backslashes rejected upstream, duplicate slashes
 * collapsed, leading "./" removed, trailing slash removed (but not for pure
 * directory entries, which keep their trailing slash to stay recognizable).
 */
export function normalizeEntryPath(name: string): string {
  const nfc = name.normalize("NFC");
  const collapsed = nfc.replace(/\/{2,}/g, "/");
  const withoutDotSlash = collapsed.replace(/^(\.\/)+/, "");
  if (withoutDotSlash === "/") {
    return withoutDotSlash;
  }
  return withoutDotSlash.replace(/(.?)\/$/, "$1");
}

/**
 * Returns the reason an entry name must be rejected, or `null` when the name
 * is acceptable. Reasons are stable machine-readable codes used by the
 * validation report and the UI.
 */
export type ForbiddenPathReason =
  | "empty"
  | "bidi-control"
  | "control-character"
  | "absolute-path"
  | "drive-prefix"
  | "parent-traversal"
  | "reserved-device"
  | "backslash-separator";

export function findForbiddenPathReason(
  name: string,
): ForbiddenPathReason | null {
  if (name.length === 0 || name === "/" || name === ".") {
    return "empty";
  }
  if (BIDI_CONTROL_PATTERN.test(name)) {
    return "bidi-control";
  }
  if (CONTROL_CHARACTER_PATTERN.test(name)) {
    return "control-character";
  }
  if (name.startsWith("/") || name.startsWith("\\")) {
    return "absolute-path";
  }
  if (DRIVE_PREFIX_PATTERN.test(name)) {
    return "drive-prefix";
  }
  const segments = name.split(/[/\\]/);
  if (segments.some((segment) => segment === "..")) {
    return "parent-traversal";
  }
  if (segments.some((segment) => RESERVED_DEVICE_PATTERN.test(segment))) {
    return "reserved-device";
  }
  if (name.includes("\\")) {
    return "backslash-separator";
  }
  return null;
}

export function isForbiddenEntryPath(name: string): boolean {
  return findForbiddenPathReason(name) !== null;
}

/**
 * Determines whether every entry lives inside one single top-level directory
 * (the common `my-skill-1.0.0/...` layout produced by GitHub archives).
 *
 * Returns the top-level directory name and the paths with that prefix
 * stripped, or `null` when the archive already has content at its root.
 * Hidden root files (e.g. `.github/…` or a stray `.DS_Store` next to the
 * directory) prevent stripping so nothing silently disappears.
 */
export function stripSingleTopLevelDir(
  paths: string[],
): { topDir: string; paths: string[] } | null {
  if (paths.length === 0) {
    return null;
  }

  const firstSegments = new Set<string>();
  for (const path of paths) {
    const slashIndex = path.indexOf("/");
    if (slashIndex < 0) {
      // A file at the archive root means there is no wrapping directory.
      return null;
    }
    firstSegments.add(path.slice(0, slashIndex));
  }

  if (firstSegments.size !== 1) {
    return null;
  }

  const topDir = firstSegments.values().next().value as string;
  const stripped = paths
    .map((path) => path.slice(topDir.length + 1))
    .filter((path) => path.length > 0)
    .map((path) => path.replace(/\/$/, ""));
  return { topDir, paths: stripped };
}

/**
 * Counts the directory depth of a normalized relative path. `SKILL.md` is 1,
 * `scripts/run.sh` is 2, a trailing slash does not add depth.
 */
export function countPathDepth(path: string): number {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments.length;
}
