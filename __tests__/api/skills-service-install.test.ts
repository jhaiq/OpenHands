import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetActiveStoreForTests,
  setActiveSelection,
  setRegisteredBackends,
} from "#/api/backend-registry/active-store";
import type { Backend } from "#/api/backend-registry/types";

const {
  mockInstallSkill,
  mockListInstalledSkills,
  mockUninstallSkill,
  mockGetSkills,
} = vi.hoisted(() => ({
  mockInstallSkill: vi.fn(),
  mockListInstalledSkills: vi.fn(),
  mockUninstallSkill: vi.fn(),
  mockGetSkills: vi.fn(),
}));

vi.mock("@openhands/typescript-client/clients", () => ({
  SkillsClient: vi.fn(function SkillsClientMock() {
    return {
      installSkill: mockInstallSkill,
      listInstalledSkills: mockListInstalledSkills,
      uninstallSkill: mockUninstallSkill,
      getSkills: mockGetSkills,
    };
  }),
  AgentServerClient: vi.fn(function AgentServerClientMock() {
    return { get: vi.fn() };
  }),
}));

vi.mock("@openhands/extensions/skills", () => ({
  SKILLS_CATALOG: [],
}));

import SkillsService, {
  SkillInstallError,
  __resetInstallSupportCacheForTests,
} from "#/api/skills-service";

const localBackend: Backend = {
  id: "local",
  name: "Local",
  host: "http://127.0.0.1:8000",
  apiKey: "",
  kind: "local",
};

const cloudBackend: Backend = {
  id: "cloud",
  name: "Cloud",
  host: "https://app.all-hands.dev",
  apiKey: "",
  kind: "cloud",
};

function useBackend(backend: Backend): void {
  setRegisteredBackends([backend]);
  setActiveSelection({ backendId: backend.id, orgId: null });
}

const installedSkill = {
  name: "demo-skill",
  version: "1.0.0",
  description: "A demo skill",
  enabled: true,
  source: "/home/.openhands/tmp/skill-upload/abc/demo-skill",
  installed_at: "2026-10-30T00:00:00Z",
  install_path: "/home/.openhands/skills/installed/demo-skill",
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetActiveStoreForTests();
  __resetInstallSupportCacheForTests();
  setRegisteredBackends([localBackend]);
  setActiveSelection({ backendId: localBackend.id });
});

afterEach(() => {
  __resetActiveStoreForTests();
});

describe("SkillsService.installSkillFromDirectory", () => {
  it("installs from a local directory and forwards force", async () => {
    useBackend(localBackend);
    mockInstallSkill.mockResolvedValue(installedSkill);

    const result = await SkillsService.installSkillFromDirectory(
      "/home/.openhands/tmp/skill-upload/abc/demo-skill",
      { force: true },
    );

    expect(mockInstallSkill).toHaveBeenCalledWith({
      source: "/home/.openhands/tmp/skill-upload/abc/demo-skill",
      force: true,
    });
    expect(result).toEqual(installedSkill);
  });

  it("defaults force to false", async () => {
    useBackend(localBackend);
    mockInstallSkill.mockResolvedValue(installedSkill);

    await SkillsService.installSkillFromDirectory(
      "/home/.openhands/tmp/skill-upload/abc/demo-skill",
    );

    expect(mockInstallSkill).toHaveBeenCalledWith({
      source: "/home/.openhands/tmp/skill-upload/abc/demo-skill",
      force: false,
    });
  });

  it("maps 409 to a conflict error", async () => {
    useBackend(localBackend);
    mockInstallSkill.mockRejectedValue({
      status: 409,
      detail: "Skill 'demo-skill' is already installed",
    });

    await expect(
      SkillsService.installSkillFromDirectory("/tmp/x/demo-skill"),
    ).rejects.toMatchObject({
      name: "SkillInstallError",
      code: "conflict",
      detail: "Skill 'demo-skill' is already installed",
    });
  });

  it("maps 422 to an invalid error carrying the server detail", async () => {
    useBackend(localBackend);
    mockInstallSkill.mockRejectedValue({
      status: 422,
      detail: "Invalid SKILL.md: name must match ^[a-z0-9-]+$",
    });

    const error = await SkillsService.installSkillFromDirectory(
      "/tmp/x/bad-skill",
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SkillInstallError);
    expect((error as SkillInstallError).code).toBe("invalid");
    expect((error as SkillInstallError).detail).toContain("name must match");
  });

  it("maps 400 to an unreadable error", async () => {
    useBackend(localBackend);
    mockInstallSkill.mockRejectedValue({ status: 400, detail: "not found" });

    await expect(
      SkillsService.installSkillFromDirectory("/tmp/x/missing"),
    ).rejects.toMatchObject({ code: "unreadable" });
  });

  it("refuses to install on a cloud backend", async () => {
    useBackend(cloudBackend);

    await expect(
      SkillsService.installSkillFromDirectory("/tmp/x/demo-skill"),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(mockInstallSkill).not.toHaveBeenCalled();
  });
});

describe("SkillsService.listInstalledSkills", () => {
  it("returns installed skills from the local backend", async () => {
    useBackend(localBackend);
    mockListInstalledSkills.mockResolvedValue({ skills: [installedSkill] });

    await expect(SkillsService.listInstalledSkills()).resolves.toEqual([
      installedSkill,
    ]);
  });

  it("returns an empty list on a cloud backend", async () => {
    useBackend(cloudBackend);

    await expect(SkillsService.listInstalledSkills()).resolves.toEqual([]);
    expect(mockListInstalledSkills).not.toHaveBeenCalled();
  });

  it("swallows transport errors into an empty list", async () => {
    useBackend(localBackend);
    mockListInstalledSkills.mockRejectedValue({ status: 500 });

    await expect(SkillsService.listInstalledSkills()).resolves.toEqual([]);
  });
});

describe("SkillsService.uninstallSkill", () => {
  it("uninstalls an installed skill", async () => {
    useBackend(localBackend);
    mockUninstallSkill.mockResolvedValue({ message: "uninstalled" });

    await SkillsService.uninstallSkill("demo-skill");

    expect(mockUninstallSkill).toHaveBeenCalledWith("demo-skill");
  });

  it("treats a 404 as already uninstalled", async () => {
    useBackend(localBackend);
    mockUninstallSkill.mockRejectedValue({ status: 404 });

    await expect(
      SkillsService.uninstallSkill("demo-skill"),
    ).resolves.toBeUndefined();
  });

  it("rethrows other failures", async () => {
    useBackend(localBackend);
    mockUninstallSkill.mockRejectedValue({ status: 500 });

    await expect(
      SkillsService.uninstallSkill("demo-skill"),
    ).rejects.toMatchObject({ code: "unknown" });
  });
});

describe("SkillsService.hasInstallSupport", () => {
  it("is true when the endpoint answers", async () => {
    useBackend(localBackend);
    mockListInstalledSkills.mockResolvedValue({ skills: [] });

    await expect(SkillsService.hasInstallSupport()).resolves.toBe(true);
  });

  it("is false on 404 and cached for subsequent calls", async () => {
    useBackend(localBackend);
    mockListInstalledSkills.mockRejectedValue({ status: 404 });

    await expect(SkillsService.hasInstallSupport()).resolves.toBe(false);
    await expect(SkillsService.hasInstallSupport()).resolves.toBe(false);

    expect(mockListInstalledSkills).toHaveBeenCalledTimes(1);
  });

  it("is false on 405", async () => {
    useBackend(localBackend);
    mockListInstalledSkills.mockRejectedValue({ status: 405 });

    await expect(SkillsService.hasInstallSupport()).resolves.toBe(false);
  });

  it("is false on a cloud backend without probing", async () => {
    useBackend(cloudBackend);

    await expect(SkillsService.hasInstallSupport()).resolves.toBe(false);
    expect(mockListInstalledSkills).not.toHaveBeenCalled();
  });
});
