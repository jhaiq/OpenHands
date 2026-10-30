import { deflateSync } from "fflate";

/**
 * Test-only ZIP builder.
 *
 * Produces standard local-file-header ZIP archives byte by byte so tests can
 * synthesize edge cases (encrypted flags, symlinks, duplicate entries, zip64
 * records) that real archivers cannot easily emit on demand.
 */

export interface TestZipEntrySpec {
  /** Entry name, including a trailing slash for directory entries. */
  name: string;
  /** Entry content. For symlink entries this is the target path bytes. */
  data?: Uint8Array | string;
  /** Compression method: 0 = stored (default), 8 = deflate. */
  method?: 0 | 8;
  /** General purpose bit flags, e.g. 0x1 for the encryption marker. */
  flags?: number;
  /** Unix mode written into the high 16 bits of the external attributes. */
  mode?: number;
  /** Additional raw extra-field bytes appended to the central directory record. */
  centralExtra?: Uint8Array;
  /** Override the uncompressed size written into the central directory record. */
  declaredUncompSize?: number;
  /** Force a zip64 EOCD + locator even when the classic record would suffice. */
  forceZip64Eocd?: boolean;
}

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const EOCD64_SIG = 0x06064b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;

class ByteWriter {
  private readonly chunks: number[] = [];

  u8(value: number): void {
    this.chunks.push(value & 0xff);
  }

  u16(value: number): void {
    this.u8(value);
    this.u8(value >> 8);
  }

  u32(value: number): void {
    this.u16(value);
    this.u16(value >>> 16);
  }

  u64(value: number): void {
    this.u32(value >>> 0);
    this.u32(Math.floor(value / 0x100000000));
  }

  bytes(data: Uint8Array | string): void {
    const view =
      typeof data === "string" ? new TextEncoder().encode(data) : data;
    for (const byte of view) {
      this.u8(byte);
    }
  }

  get length(): number {
    return this.chunks.length;
  }

  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

function normalizeContent(data: Uint8Array | string | undefined): Uint8Array {
  if (data === undefined) {
    return new Uint8Array(0);
  }
  return typeof data === "string" ? new TextEncoder().encode(data) : data;
}

export function buildTestZip(specs: TestZipEntrySpec[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;
  const needsZip64 =
    specs.length > 0xffff || specs.some((spec) => spec.forceZip64Eocd);

  for (const spec of specs) {
    const content = normalizeContent(spec.data);
    const stored = spec.method === 8 ? deflateSync(content) : content;
    const nameBytes = new TextEncoder().encode(spec.name);
    const flags = spec.flags ?? 0;
    const method = spec.method ?? 0;
    const mode = spec.mode ?? 0o100644;

    const local = new ByteWriter();
    local.u32(LOCAL_HEADER_SIG);
    local.u16(20); // version needed
    local.u16(flags);
    local.u16(method);
    local.u16(0); // mod time
    local.u16(0); // mod date
    local.u32(0); // crc32 (not verified by the code under test)
    local.u32(stored.length);
    local.u32(content.length);
    local.u16(nameBytes.length);
    local.u16(0); // local extra length
    local.bytes(nameBytes);
    local.bytes(stored);
    localParts.push(local.toUint8Array());

    const central = new ByteWriter();
    central.u32(CENTRAL_HEADER_SIG);
    central.u16((3 << 8) | 20); // version made by: unix, 2.0
    central.u16(20); // version needed
    central.u16(flags);
    central.u16(method);
    central.u16(0);
    central.u16(0);
    central.u32(0); // crc32
    central.u32(stored.length);
    central.u32(spec.declaredUncompSize ?? content.length);
    central.u16(nameBytes.length);
    central.u16(spec.centralExtra?.length ?? 0);
    central.u16(0); // comment length
    central.u16(0); // disk number start
    central.u16(0); // internal attributes
    central.u32(mode << 16);
    central.u32(localOffset);
    central.bytes(nameBytes);
    if (spec.centralExtra) {
      central.bytes(spec.centralExtra);
    }
    centralParts.push(central.toUint8Array());

    localOffset += local.length;
  }

  const centralDirectory = concatParts(centralParts);
  const end: ByteWriter = new ByteWriter();

  if (needsZip64) {
    const totalEntries = specs.length;
    const zip64RecordOffset = localOffset + centralDirectory.length;
    const zip64 = new ByteWriter();
    zip64.u32(EOCD64_SIG);
    zip64.u64(44); // size of remaining record
    zip64.u16((3 << 8) | 45); // version made by
    zip64.u16(45); // version needed
    zip64.u32(0); // this disk
    zip64.u32(0); // central directory disk
    zip64.u64(totalEntries);
    zip64.u64(totalEntries);
    zip64.u64(centralDirectory.length);
    zip64.u64(localOffset);
    const zip64Record = zip64.toUint8Array();

    const locator = new ByteWriter();
    locator.u32(EOCD64_LOCATOR_SIG);
    locator.u32(0); // zip64 EOCD disk
    locator.u64(zip64RecordOffset);
    locator.u32(1); // total disks

    end.bytes(zip64Record);
    end.bytes(locator.toUint8Array());
  }

  const totalEntries = specs.length;
  end.u32(EOCD_SIG);
  end.u16(0); // this disk
  end.u16(0); // central directory disk
  end.u16(Math.min(totalEntries, 0xffff));
  end.u16(Math.min(totalEntries, 0xffff));
  end.u32(Math.min(centralDirectory.length, 0xffffffff));
  end.u32(Math.min(localOffset, 0xffffffff));
  end.u16(0); // comment length

  return concatParts([...localParts, centralDirectory, end.toUint8Array()]);
}

function concatParts(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Builds a zip64 extra field (id 0x0001) carrying explicit 64-bit values. */
export function zip64ExtraField(options: {
  uncompSize?: number;
  compSize?: number;
  localOffset?: number;
}): Uint8Array {
  const payload = new ByteWriter();
  if (options.uncompSize !== undefined) {
    payload.u64(options.uncompSize);
  }
  if (options.compSize !== undefined) {
    payload.u64(options.compSize);
  }
  if (options.localOffset !== undefined) {
    payload.u64(options.localOffset);
  }
  const header = new ByteWriter();
  header.u16(0x0001);
  header.u16(payload.length);
  return concatParts([header.toUint8Array(), payload.toUint8Array()]);
}

/** Sentinel values that mark a central directory field as stored in zip64. */
export const ZIP64_SENTINEL = 0xffffffff;
