/**
 * Minimal ZIP central directory reader.
 *
 * The generic unzip helpers available in the browser cannot support the
 * security pre-checks we need before installing a skill from a ZIP archive:
 * they silently return garbage for encrypted entries, drop symlink metadata,
 * merge duplicate entries and cannot enforce limits before decompressing.
 * Reading the central directory ourselves gives us per-entry flags, declared
 * sizes and Unix mode bits before a single byte is inflated.
 *
 * Scope: local-file-head ZIPs with the standard layouts produced by common
 * tools (Info-ZIP, Python zipfile, macOS Archive Utility). Encrypted,
 * spanned and multi-disk archives are rejected by callers via entry flags.
 */

export type ZipParseErrorCode =
  | "no-eocd"
  | "bad-eocd"
  | "bad-zip64-eocd"
  | "bad-central-directory"
  | "multi-disk";

export class ZipParseError extends Error {
  readonly code: ZipParseErrorCode;

  constructor(code: ZipParseErrorCode, message: string) {
    super(message);
    this.name = "ZipParseError";
    this.code = code;
  }
}

/** One entry as declared by the ZIP central directory (nothing is inflated). */
export interface ZipCentralDirectoryEntry {
  /** Entry name decoded from UTF-8 (bit 11) or the cp437-like fallback. */
  name: string;
  /** General purpose bit 0: the entry is encrypted. */
  encrypted: boolean;
  /** General purpose bit 3: sizes in the local header are in a data descriptor. */
  hasDataDescriptor: boolean;
  /** Compression method (0 = stored, 8 = deflate). */
  method: number;
  /** Compressed size in bytes as declared by the central directory. */
  compSize: number;
  /** Uncompressed size in bytes as declared by the central directory. */
  uncompSize: number;
  /** High 16 bits of the external attributes (Unix permission bits + file type). */
  mode: number;
  /** The entry is a Unix symlink (S_IFLNK). */
  isSymlink: boolean;
  /** The entry is a directory (trailing slash or MS-DOS directory attribute). */
  isDir: boolean;
  /** Offset of the entry's local file header. */
  localOffset: number;
}

export interface ZipCentralDirectory {
  /** True when the entry count or offsets were promoted via the zip64 EOCD. */
  zip64: boolean;
  /** Number of entries declared by the EOCD (equals entries.length on success). */
  totalEntries: number;
  entries: ZipCentralDirectoryEntry[];
}

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CENTRAL_DIR_SIG = 0x02014b50;

/** EOCD is at least 22 bytes; the comment may add up to 65535 bytes. */
const MAX_EOCD_SCAN = 22 + 0xffff;
const CENTRAL_DIR_HEADER_SIZE = 46;

function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function readU64(bytes: Uint8Array, offset: number): number {
  // Safe for archive metadata far below Number.MAX_SAFE_INTEGER.
  return readU32(bytes, offset) + readU32(bytes, offset + 4) * 0x100000000;
}

function decodeEntryName(
  bytes: Uint8Array,
  start: number,
  length: number,
  utf8: boolean,
): string {
  const slice = bytes.subarray(start, start + length);
  if (utf8) {
    return new TextDecoder("utf-8").decode(slice);
  }
  // cp437 names are supersets of latin-1 for printable ASCII; decode the
  // single-byte range instead of letting UTF-8 produce replacement glyphs.
  let out = "";
  for (let i = 0; i < slice.length; i += 1) {
    out += String.fromCharCode(slice[i]);
  }
  return out;
}

interface EndOfCentralDirectory {
  zip64: boolean;
  totalEntries: number;
  centralDirSize: number;
  centralDirOffset: number;
}

function readEndOfCentralDirectory(bytes: Uint8Array): EndOfCentralDirectory {
  let eocdOffset = -1;
  const minOffset = Math.max(0, bytes.length - MAX_EOCD_SCAN);
  for (let i = bytes.length - 22; i >= minOffset; i -= 1) {
    if (readU32(bytes, i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new ZipParseError(
      "no-eocd",
      "End of central directory record not found",
    );
  }

  const diskNumber = readU16(bytes, eocdOffset + 4);
  const centralDirDisk = readU16(bytes, eocdOffset + 6);
  if (diskNumber !== 0 || centralDirDisk !== 0) {
    throw new ZipParseError(
      "multi-disk",
      "Multi-disk archives are not supported",
    );
  }

  let totalEntries = readU16(bytes, eocdOffset + 10);
  let centralDirSize = readU32(bytes, eocdOffset + 12);
  let centralDirOffset = readU32(bytes, eocdOffset + 16);
  let zip64 = false;

  // A zip64 EOCD locator, when present, sits directly in front of the EOCD.
  if (
    eocdOffset >= 20 &&
    readU32(bytes, eocdOffset - 20) === EOCD64_LOCATOR_SIG
  ) {
    const eocd64Offset = readU64(bytes, eocdOffset - 20 + 8);
    if (readU32(bytes, eocd64Offset) !== EOCD64_SIG) {
      throw new ZipParseError(
        "bad-zip64-eocd",
        "Malformed zip64 end of central directory",
      );
    }
    zip64 = true;
    totalEntries = readU64(bytes, eocd64Offset + 32);
    centralDirSize = readU64(bytes, eocd64Offset + 40);
    centralDirOffset = readU64(bytes, eocd64Offset + 48);
  }

  return { zip64, totalEntries, centralDirSize, centralDirOffset };
}

/** Reads the zip64 extra field (id 0x0001) and resolves sentinel sizes. */
function resolveZip64Sizes(
  bytes: Uint8Array,
  extraStart: number,
  extraLength: number,
  sizes: {
    compSize: number;
    uncompSize: number;
    localOffset: number;
  },
): { compSize: number; uncompSize: number; localOffset: number } {
  const resolved = { ...sizes };
  let cursor = extraStart;
  const end = extraStart + extraLength;
  while (cursor + 4 <= end) {
    const fieldId = readU16(bytes, cursor);
    const fieldSize = readU16(bytes, cursor + 2);
    if (fieldId === 0x0001) {
      let valueOffset = cursor + 4;
      if (resolved.uncompSize === 0xffffffff) {
        resolved.uncompSize = readU64(bytes, valueOffset);
        valueOffset += 8;
      }
      if (resolved.compSize === 0xffffffff) {
        resolved.compSize = readU64(bytes, valueOffset);
        valueOffset += 8;
      }
      if (resolved.localOffset === 0xffffffff) {
        resolved.localOffset = readU64(bytes, valueOffset);
      }
      return resolved;
    }
    cursor += 4 + fieldSize;
  }
  return resolved;
}

function readCentralDirectoryEntries(
  bytes: Uint8Array,
  eocd: EndOfCentralDirectory,
): ZipCentralDirectoryEntry[] {
  const entries: ZipCentralDirectoryEntry[] = [];
  let cursor = eocd.centralDirOffset;
  const end = cursor + eocd.centralDirSize;

  for (let index = 0; index < eocd.totalEntries; index += 1) {
    if (
      cursor + CENTRAL_DIR_HEADER_SIZE > end ||
      readU32(bytes, cursor) !== CENTRAL_DIR_SIG
    ) {
      throw new ZipParseError(
        "bad-central-directory",
        `Malformed central directory entry at index ${index}`,
      );
    }

    const flags = readU16(bytes, cursor + 8);
    const method = readU16(bytes, cursor + 10);
    const nameLength = readU16(bytes, cursor + 28);
    const extraLength = readU16(bytes, cursor + 30);
    const commentLength = readU16(bytes, cursor + 32);
    const externalAttributes = readU32(bytes, cursor + 38);
    const localOffset = readU32(bytes, cursor + 42);
    const nameStart = cursor + CENTRAL_DIR_HEADER_SIZE;

    const sized = resolveZip64Sizes(
      bytes,
      nameStart + nameLength,
      extraLength,
      {
        compSize: readU32(bytes, cursor + 20),
        uncompSize: readU32(bytes, cursor + 24),
        localOffset,
      },
    );

    const mode = externalAttributes >>> 16;
    const name = decodeEntryName(
      bytes,
      nameStart,
      nameLength,
      (flags & 0x0800) !== 0,
    );

    entries.push({
      name,
      encrypted: (flags & 0x0001) !== 0,
      hasDataDescriptor: (flags & 0x0008) !== 0,
      method,
      compSize: sized.compSize,
      uncompSize: sized.uncompSize,
      mode,
      isSymlink: (mode & 0o170000) === 0o120000,
      isDir: name.endsWith("/") || (externalAttributes & 0x10) !== 0,
      localOffset: sized.localOffset,
    });

    cursor = nameStart + nameLength + extraLength + commentLength;
  }

  return entries;
}

/**
 * Parses the central directory of a ZIP archive without inflating any entry.
 * Throws {@link ZipParseError} when the archive structure is unreadable.
 */
export function readCentralDirectory(bytes: Uint8Array): ZipCentralDirectory {
  const eocd = readEndOfCentralDirectory(bytes);
  const entries = readCentralDirectoryEntries(bytes, eocd);
  return { zip64: eocd.zip64, totalEntries: eocd.totalEntries, entries };
}

/**
 * Inflates a single entry identified by its central directory metadata.
 * Returns the decompressed bytes; throws when the deflate stream is corrupt.
 * The caller is responsible for size checks — this slices exactly
 * `entry.compSize` bytes, so declared-size limits hold here too.
 */
export function inflateEntry(
  bytes: Uint8Array,
  entry: ZipCentralDirectoryEntry,
  inflateSync: (data: Uint8Array) => Uint8Array,
): Uint8Array {
  if (entry.method !== 0 && entry.method !== 8) {
    throw new ZipParseError(
      "bad-central-directory",
      `Unsupported compression method ${entry.method} for "${entry.name}"`,
    );
  }
  const localNameLength = readU16(bytes, entry.localOffset + 26);
  const localExtraLength = readU16(bytes, entry.localOffset + 28);
  const dataStart = entry.localOffset + 30 + localNameLength + localExtraLength;
  const compressed = bytes.subarray(dataStart, dataStart + entry.compSize);
  if (entry.method === 0) {
    return compressed.slice();
  }
  return inflateSync(compressed);
}

export function isLocalHeaderPresent(
  bytes: Uint8Array,
  entry: ZipCentralDirectoryEntry,
): boolean {
  return readU32(bytes, entry.localOffset) === 0x04034b50;
}
