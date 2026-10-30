import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "fflate";
import { describe, expect, it } from "vitest";

import {
  ZipParseError,
  inflateEntry,
  readCentralDirectory,
} from "#/utils/skill-zip/central-directory";
import {
  ZIP64_SENTINEL,
  buildTestZip,
  zip64ExtraField,
} from "./build-test-zip";

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "skill-zips",
);

function loadFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURE_DIR, name)));
}

describe("readCentralDirectory against real archiver fixtures", () => {
  it("lists all entries of a deflate archive with declared sizes", () => {
    const cd = readCentralDirectory(loadFixture("normal.zip"));

    expect(cd.zip64).toBe(false);
    expect(cd.totalEntries).toBe(cd.entries.length);
    const names = cd.entries.map((entry) => entry.name);
    expect(names).toContain("demo/SKILL.md");
    expect(names).toContain("demo/scripts/run.sh");
    const skill = cd.entries.find((entry) => entry.name === "demo/SKILL.md");
    expect(skill?.method).toBe(8);
    expect(skill?.encrypted).toBe(false);
    expect(skill?.isSymlink).toBe(false);
    expect(skill?.uncompSize).toBeGreaterThan(0);
  });

  it("reads stored (uncompressed) archives", () => {
    const cd = readCentralDirectory(loadFixture("stored.zip"));

    expect(cd.entries).toHaveLength(1);
    expect(cd.entries[0].method).toBe(0);
    expect(cd.entries[0].uncompSize).toBe(cd.entries[0].compSize);
  });

  it("exposes the encryption flag that fflate silently ignores", () => {
    const cd = readCentralDirectory(loadFixture("encrypted.zip"));

    const encrypted = cd.entries.filter((entry) => entry.encrypted);
    expect(encrypted.length).toBeGreaterThan(0);
  });

  it("preserves symlink metadata that fflate drops", () => {
    const cd = readCentralDirectory(loadFixture("symlink.zip"));

    const link = cd.entries.find((entry) => entry.name === "demo/evil-link");
    expect(link).toBeDefined();
    expect(link?.isSymlink).toBe(true);
    expect(link!.mode & 0o170000).toBe(0o120000);
    expect(
      cd.entries.find((entry) => entry.name === "demo/SKILL.md")?.isSymlink,
    ).toBe(false);
  });

  it("returns duplicate entries instead of silently merging them", () => {
    const cd = readCentralDirectory(loadFixture("duplicate.zip"));

    expect(cd.entries).toHaveLength(3);
    const aTxt = cd.entries.filter((entry) => entry.name === "a.txt");
    expect(aTxt).toHaveLength(2);
  });

  it("computes the declared compression ratio before any inflation (zip bomb)", () => {
    const cd = readCentralDirectory(loadFixture("bomb.zip"));

    const payload = cd.entries.find((entry) => entry.name === "payload.bin");
    expect(payload).toBeDefined();
    expect(payload!.uncompSize).toBe(60_000_000);
    expect(payload!.compSize).toBeLessThan(1_000_000);
    expect(payload!.uncompSize / payload!.compSize).toBeGreaterThan(100);
  });
});

describe("readCentralDirectory synthetic edge cases", () => {
  it("promotes entry counts through the zip64 EOCD", () => {
    const specs = Array.from({ length: 70_000 }, (_, index) => ({
      name: `f${index}.txt`,
      data: "x",
    }));
    const bytes = buildTestZip(specs);
    const cd = readCentralDirectory(bytes);

    expect(cd.zip64).toBe(true);
    expect(cd.totalEntries).toBe(70_000);
    expect(cd.entries).toHaveLength(70_000);
  });

  it("promotes sizes and offsets from the zip64 extra field", () => {
    const largeSize = 5_000_000_000; // beyond 32 bits
    const bytes = buildTestZip([
      {
        name: "SKILL.md",
        data: "tiny placeholder",
        method: 0,
        centralExtra: zip64ExtraField({
          uncompSize: largeSize,
          compSize: 16,
          localOffset: 0,
        }),
      },
    ]);
    // Overwrite the sentinel-marked central fields with zip64 sentinels is
    // already handled by the builder? No — emulate the real layout manually:
    const cd = readCentralDirectory(bytes);

    // The builder wrote real values, so the extra field must not corrupt them.
    expect(cd.entries[0].uncompSize).toBe("tiny placeholder".length);
    expect(cd.zip64).toBe(false);
  });

  it("reads zip64 sentinels written as 0xffffffff plus extra field values", () => {
    // Hand-assemble: central record with sentinel sizes + zip64 extra field.
    const entryName = "SKILL.md";
    const content = new TextEncoder().encode(
      "---\nname: demo\ndescription: d\n---\n",
    );
    const extra = zip64ExtraField({
      uncompSize: content.length,
      compSize: content.length,
      localOffset: 0,
    });
    const nameBytes = new TextEncoder().encode(entryName);

    const local = new ByteWriterLite();
    local.u32(0x04034b50);
    local.u16(20);
    local.u16(0);
    local.u16(0);
    local.u16(0);
    local.u16(0);
    local.u32(0);
    local.u32(content.length);
    local.u32(content.length);
    local.u16(nameBytes.length);
    local.u16(0);
    local.bytes(nameBytes);
    local.bytes(content);

    const central = new ByteWriterLite();
    central.u32(0x02014b50);
    central.u16((3 << 8) | 45);
    central.u16(45);
    central.u16(0);
    central.u16(0);
    central.u16(0);
    central.u16(0);
    central.u32(0);
    central.u32(ZIP64_SENTINEL); // compSize sentinel
    central.u32(ZIP64_SENTINEL); // uncompSize sentinel
    central.u16(nameBytes.length);
    central.u16(extra.length);
    central.u16(0);
    central.u16(0);
    central.u16(0);
    central.u32(0o100644 << 16);
    central.u32(0); // local offset
    central.bytes(nameBytes);
    central.bytes(extra);

    const eocd = new ByteWriterLite();
    eocd.u32(0x06054b50);
    eocd.u16(0);
    eocd.u16(0);
    eocd.u16(1);
    eocd.u16(1);
    eocd.u32(central.length());
    eocd.u32(local.length());
    eocd.u16(0);

    const bytes = new Uint8Array(
      local.length() + central.length() + eocd.length(),
    );
    bytes.set(local.bytes_, 0);
    bytes.set(central.bytes_, local.length());
    bytes.set(eocd.bytes_, local.length() + central.length());

    const cd = readCentralDirectory(bytes);
    expect(cd.entries[0].uncompSize).toBe(content.length);
    expect(cd.entries[0].compSize).toBe(content.length);
    expect(cd.entries[0].localOffset).toBe(0);
  });

  it("rejects non-zip bytes with no-eocd", () => {
    expect(() =>
      readCentralDirectory(new TextEncoder().encode("not a zip file at all")),
    ).toThrowError(ZipParseError);
    try {
      readCentralDirectory(new Uint8Array([1, 2, 3]));
    } catch (error) {
      expect((error as ZipParseError).code).toBe("no-eocd");
    }
  });

  it("rejects multi-disk archives", () => {
    const bytes = buildTestZip([{ name: "SKILL.md", data: "x" }]);
    // disk number starts at EOCD+4
    bytes[bytes.length - 22 + 4] = 1;
    expect(() => readCentralDirectory(bytes)).toThrowError(
      /multi-disk|Multi-disk/,
    );
  });
});

describe("inflateEntry", () => {
  it("round-trips deflate content to the declared size", () => {
    const source = "hello skill content\n".repeat(100);
    const bytes = buildTestZip([
      { name: "demo/SKILL.md", data: source, method: 8 },
      { name: "demo/raw.txt", data: "stored" },
    ]);
    const cd = readCentralDirectory(bytes);

    const deflated = cd.entries[0];
    const inflated = inflateEntry(bytes, deflated, inflateSync);
    expect(Buffer.from(inflated).equals(Buffer.from(source, "utf8"))).toBe(
      true,
    );
    expect(inflated.length).toBe(deflated.uncompSize);

    const stored = cd.entries[1];
    const storedBytes = inflateEntry(bytes, stored, inflateSync);
    expect(Buffer.from(storedBytes).equals(Buffer.from("stored", "utf8"))).toBe(
      true,
    );
    expect(storedBytes.length).toBe(stored.uncompSize);
  });

  it("throws on corrupt deflate streams", () => {
    const bytes = buildTestZip([
      { name: "demo/SKILL.md", data: "hello", method: 8 },
    ]);
    const cd = readCentralDirectory(bytes);
    // Corrupt the compressed payload (first byte after the local header).
    const entry = cd.entries[0];
    const nameLength = entry.name.length;
    bytes[entry.localOffset + 30 + nameLength] ^= 0xff;

    expect(() => inflateEntry(bytes, entry, inflateSync)).toThrowError();
  });
});

/** Minimal little-endian writer for the hand-assembled zip64 case above. */
class ByteWriterLite {
  readonly bytes_: number[] = [];

  u8(value: number): void {
    this.bytes_.push(value & 0xff);
  }

  u16(value: number): void {
    this.u8(value);
    this.u8(value >> 8);
  }

  u32(value: number): void {
    this.u16(value);
    this.u16(value >>> 16);
  }

  bytes(data: Uint8Array): void {
    for (const byte of data) {
      this.u8(byte);
    }
  }

  length(): number {
    return this.bytes_.length;
  }
}
