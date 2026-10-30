import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_UNPACK_LIMITS,
  unpackSkillZip,
} from "#/utils/skill-zip/unpack";
import { buildTestZip } from "./build-test-zip";

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

const SKILL_MD = "---\nname: demo\ndescription: demo skill\n---\nbody\n";

describe("unpackSkillZip happy paths", () => {
  it("unpacks a deflate fixture and strips the wrapping directory", () => {
    const result = unpackSkillZip(loadFixture("normal.zip"));

    expect(result.blockers).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.files.map((file) => file.path).sort()).toEqual([
      "SKILL.md",
      "scripts/run.sh",
    ]);
    expect(Buffer.from(result.files[0].bytes).toString("utf8")).toContain(
      "name: demo",
    );
    expect(result.scriptPaths).toEqual(["scripts/run.sh"]);
  });

  it("unpacks stored archives and keeps root-level content in place", () => {
    const result = unpackSkillZip(loadFixture("stored.zip"));

    expect(result.blockers).toEqual([]);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe("SKILL.md");
  });

  it("reports total inflated size", () => {
    const bytes = buildTestZip([
      { name: "SKILL.md", data: SKILL_MD },
      { name: "notes.md", data: "12345" },
    ]);

    const result = unpackSkillZip(bytes);

    expect(result.totalBytes).toBe(SKILL_MD.length + 5);
    expect(result.blockers).toEqual([]);
  });

  it("reports empty archives", () => {
    const result = unpackSkillZip(buildTestZip([]));

    expect(result.files).toEqual([]);
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0].code).toBe("no-entries");
  });
});

describe("unpackSkillZip rejects dangerous real-world fixtures", () => {
  it.each([
    ["encrypted.zip", "encrypted-entry"],
    ["symlink.zip", "symlink-entry"],
    ["traversal.zip", "forbidden-path"],
    ["bidi.zip", "forbidden-path"],
    ["duplicate.zip", "duplicate-entry"],
  ])("blocks %s with code %s", (fixture, code) => {
    const result = unpackSkillZip(loadFixture(fixture));

    expect(result.files).toEqual([]);
    expect(result.blockers.map((blocker) => blocker.code)).toContain(code);
  });

  it("blocks zip bombs by declared ratio even under a generous file limit", () => {
    const result = unpackSkillZip(loadFixture("bomb.zip"), {
      ...DEFAULT_UNPACK_LIMITS,
      maxFileBytes: 100 * 1024 * 1024,
    });

    expect(result.files).toEqual([]);
    // The fixture legitimately trips both the declared-total cap and the
    // ratio rule; the point is that the ratio rule catches it even when the
    // per-file limit is generous.
    const codes = result.blockers.map((blocker) => blocker.code);
    expect(codes).toContain("total-too-large");
    expect(codes).toContain("compression-ratio");
    const ratio = result.blockers.find(
      (blocker) => blocker.code === "compression-ratio",
    );
    expect(ratio?.entry).toBe("payload.bin");
  });

  it("warns on case-only path conflicts but still unpacks", () => {
    const result = unpackSkillZip(loadFixture("caseclash.zip"));

    expect(result.blockers).toEqual([]);
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "case-conflict",
    ]);
    expect(result.files).toHaveLength(3);
  });
});

describe("unpackSkillZip structural limits", () => {
  it("blocks oversized ZIP files before parsing", () => {
    const result = unpackSkillZip(loadFixture("bomb.zip"), {
      ...DEFAULT_UNPACK_LIMITS,
      maxZipBytes: 100,
    });

    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0].code).toBe("zip-too-large");
  });

  it("blocks archives with too many entries", () => {
    const bytes = buildTestZip(
      Array.from({ length: 501 }, (_, index) => ({
        name: `f${index}.txt`,
        data: "1",
      })),
    );

    const result = unpackSkillZip(bytes);

    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0].code).toBe("too-many-entries");
  });

  it("blocks entries inflating beyond the per-file limit", () => {
    const bytes = buildTestZip([
      { name: "SKILL.md", data: SKILL_MD },
      { name: "big.txt", data: "x".repeat(100) },
    ]);

    const result = unpackSkillZip(bytes, {
      ...DEFAULT_UNPACK_LIMITS,
      maxFileBytes: 60,
    });

    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0].code).toBe("file-too-large");
    expect(result.blockers[0].entry).toBe("big.txt");
  });

  it("blocks archives inflating beyond the total limit", () => {
    const bytes = buildTestZip([
      { name: "SKILL.md", data: SKILL_MD },
      { name: "a.txt", data: "x".repeat(30) },
      { name: "b.txt", data: "y".repeat(30) },
    ]);

    const result = unpackSkillZip(bytes, {
      ...DEFAULT_UNPACK_LIMITS,
      maxTotalBytes: 70,
    });

    expect(result.blockers.map((blocker) => blocker.code)).toContain(
      "total-too-large",
    );
  });

  it("blocks deflate entries beyond the compression ratio limit but not stored ones", () => {
    // 20KB of a single repeated byte compresses far beyond 100:1; a stored
    // entry of the same size is ratio-neutral. Small files (<10KB) are
    // exempt from ratio checks because tiny texts compress >100:1 trivially.
    const bytes = buildTestZip([
      { name: "SKILL.md", data: SKILL_MD, method: 8 },
      { name: "bomb.txt", data: "a".repeat(20_000), method: 8 },
      { name: "kept.txt", data: "b".repeat(20_000), method: 0 },
    ]);

    const result = unpackSkillZip(bytes);

    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0].code).toBe("compression-ratio");
    expect(result.blockers[0].entry).toBe("bomb.txt");
  });

  it("blocks entries nested too deeply", () => {
    const bytes = buildTestZip([
      { name: "SKILL.md", data: SKILL_MD },
      { name: "a/b/c.txt", data: "deep" },
    ]);

    const result = unpackSkillZip(bytes, {
      ...DEFAULT_UNPACK_LIMITS,
      maxDepth: 2,
    });

    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0].code).toBe("depth-too-deep");
    expect(result.blockers[0].entry).toBe("a/b/c.txt");
  });

  it("blocks entries with unsupported compression methods instead of throwing", () => {
    const bytes = buildTestZip([
      { name: "SKILL.md", data: SKILL_MD },
      { name: "weird.txt", data: "some content" },
    ]);
    // Flip the compression method of the second entry inside the central
    // directory to an unsupported value (deterministic, unlike bit flips in
    // raw deflate streams which carry no checksum).
    const eocdOffset = bytes.length - 22;
    const cdSize =
      bytes[eocdOffset + 12] |
      (bytes[eocdOffset + 13] << 8) |
      (bytes[eocdOffset + 14] << 16) |
      (bytes[eocdOffset + 15] << 24);
    const centralDirStart = eocdOffset - cdSize;

    // Walk central directory records properly (header is 46 bytes + name).
    let cursor = centralDirStart;
    let found = 0;
    while (cursor < eocdOffset) {
      const isCentralSig =
        bytes[cursor] === 0x50 &&
        bytes[cursor + 1] === 0x4b &&
        bytes[cursor + 2] === 0x01 &&
        bytes[cursor + 3] === 0x02;
      if (!isCentralSig) {
        break;
      }
      found += 1;
      if (found === 2) {
        bytes[cursor + 10] = 9; // unsupported compression method
        break;
      }
      const nameLength = bytes[cursor + 28] | (bytes[cursor + 29] << 8);
      cursor += 46 + nameLength;
    }

    const result = unpackSkillZip(bytes);

    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0].code).toBe("corrupt-entry");
    expect(result.blockers[0].entry).toBe("weird.txt");
  });

  it("blocks entries whose inflated size contradicts the declared size", () => {
    const bytes = buildTestZip([
      {
        name: "SKILL.md",
        data: SKILL_MD,
        declaredUncompSize: SKILL_MD.length + 5,
      },
    ]);

    const result = unpackSkillZip(bytes);

    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0].code).toBe("inflated-size-mismatch");
  });

  it("rejects plain garbage as bad-zip", () => {
    const result = unpackSkillZip(
      new TextEncoder().encode("definitely not a zip"),
    );

    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0].code).toBe("bad-zip");
  });
});
