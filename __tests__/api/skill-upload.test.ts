import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockUploadFile, mockGetHome, mockInstallSkillFromDirectory } =
  vi.hoisted(() => ({
    mockUploadFile: vi.fn(),
    mockGetHome: vi.fn(),
    mockInstallSkillFromDirectory: vi.fn(),
  }));

vi.mock("@openhands/typescript-client/clients", () => ({
  FileClient: vi.fn(function FileClientMock() {
    return { uploadFile: mockUploadFile, getHome: mockGetHome };
  }),
}));

vi.mock("#/api/agent-server-home", () => ({
  getAgentServerHomeDir: vi.fn(async () => "/home/tester"),
  resolveAbsoluteAgentServerPath: vi.fn(),
  clearAgentServerHomeDirCache: vi.fn(),
}));

vi.mock("#/api/skills-service", () => ({
  default: { installSkillFromDirectory: mockInstallSkillFromDirectory },
}));

import {
  installUploadedSkill,
  uploadSkillPackage,
  SkillUploadError,
} from "#/api/skill-upload";
import type { UnpackedFile } from "#/utils/skill-zip/unpack";

function entriesOf(files: Record<string, string>): UnpackedFile[] {
  return Object.entries(files).map(([path, text]) => ({
    path,
    bytes: new TextEncoder().encode(text),
  }));
}

const SKILL_ENTRIES = entriesOf({
  "SKILL.md": "---\nname: demo-skill\ndescription: demo\n---\n",
  "scripts/run.sh": "#!/bin/sh\necho hi\n",
});

beforeEach(() => {
  vi.clearAllMocks();
  mockUploadFile.mockResolvedValue({ success: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("uploadSkillPackage", () => {
  it("stages files under <home>/.openhands/tmp/skill-upload/<id>/<name>/", async () => {
    const result = await uploadSkillPackage(SKILL_ENTRIES, "demo-skill");

    expect(result.skillDir).toMatch(
      /^\/home\/tester\/\.openhands\/tmp\/skill-upload\/[0-9a-f-]{36}\/demo-skill$/,
    );
    expect(result.fileCount).toBe(2);
    expect(mockUploadFile).toHaveBeenCalledTimes(2);

    // `/api/file/upload?path=` receives the absolute file path.
    const destinations = mockUploadFile.mock.calls.map(
      ([, destination]) => destination,
    );
    expect(destinations).toEqual(
      expect.arrayContaining([
        `${result.skillDir}/SKILL.md`,
        `${result.skillDir}/scripts/run.sh`,
      ]),
    );
  });

  it("falls back to ~/.cache when the primary staging root is rejected", async () => {
    mockUploadFile
      .mockRejectedValueOnce({ status: 403 })
      .mockResolvedValue({ success: true });

    const result = await uploadSkillPackage(SKILL_ENTRIES, "demo-skill");

    expect(result.stagingRoot).toBe(
      "/home/tester/.cache/agent-canvas-skill-upload",
    );
    expect(result.skillDir).toContain(
      "/home/tester/.cache/agent-canvas-skill-upload/",
    );
  });

  it("falls back when the primary root answers 500", async () => {
    mockUploadFile
      .mockRejectedValueOnce({ status: 500 })
      .mockResolvedValue({ success: true });

    const result = await uploadSkillPackage(SKILL_ENTRIES, "demo-skill");

    expect(result.stagingRoot).toBe(
      "/home/tester/.cache/agent-canvas-skill-upload",
    );
  });

  it("aborts on the first failure and reports the failing entry", async () => {
    mockUploadFile.mockImplementation(async (_content, destination) => {
      if (destination.endsWith("/run.sh")) {
        throw { status: 507, detail: "disk full" };
      }
      return { success: true };
    });

    const error = await uploadSkillPackage(SKILL_ENTRIES, "demo-skill").catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(SkillUploadError);
    expect((error as SkillUploadError).failedPath).toBe("scripts/run.sh");
    // The primary attempt failed with a non-permission error, so no retry.
    expect(mockUploadFile).toHaveBeenCalledTimes(2);
  });

  it("never exceeds five concurrent uploads", async () => {
    let inFlight = 0;
    let peak = 0;
    mockUploadFile.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { success: true };
    });

    const many = entriesOf(
      Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [`file-${index}.md`, "x"]),
      ),
    );

    await uploadSkillPackage(many, "demo-skill");

    expect(peak).toBeLessThanOrEqual(5);
    expect(mockUploadFile).toHaveBeenCalledTimes(12);
  });

  it("reports progress for every uploaded file", async () => {
    const onProgress = vi.fn();

    await uploadSkillPackage(SKILL_ENTRIES, "demo-skill", { onProgress });

    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ completed: 2, total: 2 }),
    );
  });

  it("rejects entry paths that escape the skill directory", async () => {
    const hostile: UnpackedFile[] = [
      { path: "../escape.md", bytes: new TextEncoder().encode("x") },
    ];

    await expect(uploadSkillPackage(hostile, "demo-skill")).rejects.toThrow(
      /escapes the skill directory/,
    );
  });

  it("stops when the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      uploadSkillPackage(SKILL_ENTRIES, "demo-skill", {
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/i);
    expect(mockUploadFile).not.toHaveBeenCalled();
  });
});

describe("installUploadedSkill", () => {
  it("installs from the staged directory and forwards force", async () => {
    mockInstallSkillFromDirectory.mockResolvedValue({ name: "demo-skill" });

    const result = await installUploadedSkill(
      "/home/tester/.openhands/tmp/skill-upload/id/demo-skill",
      { force: true },
    );

    expect(mockInstallSkillFromDirectory).toHaveBeenCalledWith(
      "/home/tester/.openhands/tmp/skill-upload/id/demo-skill",
      { force: true },
    );
    expect(result).toEqual({ name: "demo-skill" });
  });
});
