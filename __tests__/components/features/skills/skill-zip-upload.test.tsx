import { QueryClient } from "@tanstack/react-query";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "test-utils";

import { buildTestZip } from "../../../utils/skill-zip/build-test-zip";
import { SkillZipUpload } from "#/components/features/skills/skill-zip-upload";
import { SkillInstallError } from "#/api/skills-service";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const translations: Record<string, string> = {
        SETTINGS$SKILLS_ZIP_TITLE: "Upload a ZIP package",
        SETTINGS$SKILLS_ZIP_INTRO: "Upload intro",
        SETTINGS$SKILLS_ZIP_LIMITS: "Limits: ZIP ≤ 20MB",
        SETTINGS$SKILLS_ZIP_CHOOSE: "Choose ZIP file",
        SETTINGS$SKILLS_ZIP_PARSING: "Analyzing archive…",
        SETTINGS$SKILLS_ZIP_VALIDATING: "Validating skill…",
        SETTINGS$SKILLS_ZIP_UPLOADING:
          "Uploading {{completed}}/{{total}} files…",
        SETTINGS$SKILLS_ZIP_INSTALLING: "Installing skill…",
        SETTINGS$SKILLS_ZIP_BLOCKED_TITLE: "Blocked ({{count}})",
        SETTINGS$SKILLS_ZIP_WARNING_TITLE: "Warnings ({{count}})",
        SETTINGS$SKILLS_ZIP_PASSED_TITLE: "Checks passed",
        SETTINGS$SKILLS_ZIP_SUMMARY_NAME: "Skill name: {{name}}",
        SETTINGS$SKILLS_ZIP_SUMMARY_FILES: "Files: {{count}}",
        SETTINGS$SKILLS_ZIP_SUMMARY_SIZE: "Uncompressed size: {{size}}",
        SETTINGS$SKILLS_ZIP_SUMMARY_SCRIPTS: "Contains executable scripts",
        SETTINGS$SKILLS_ZIP_SUMMARY_NO_SCRIPTS: "No executable scripts",
        SETTINGS$SKILLS_ZIP_ACK_RISK:
          "I understand the risks and want to continue",
        SETTINGS$SKILLS_ZIP_RESELECT: "Choose another file",
        SETTINGS$SKILLS_ZIP_INSTALL: "Install",
        SETTINGS$SKILLS_ZIP_CONFLICT_TITLE: "Skill already installed",
        SETTINGS$SKILLS_ZIP_CONFLICT_BODY:
          "A skill named “{{name}}” is already installed. Overwrite it?",
        SETTINGS$SKILLS_ZIP_OVERWRITE: "Overwrite",
        SETTINGS$SKILLS_ZIP_DONE_TITLE: "Skill installed",
        SETTINGS$SKILLS_ZIP_DONE_PATH: "Installed to {{path}}",
        SETTINGS$SKILLS_ZIP_DONE_RESTART: "Takes effect in new conversations.",
        SETTINGS$SKILLS_ZIP_ERROR_TITLE: "Installation failed",
        SETTINGS$SKILLS_ZIP_BLOCK_BAD_ZIP:
          "The archive is corrupt or unreadable",
        SETTINGS$SKILLS_ZIP_BLOCK_NO_SKILL_MD:
          "The package does not contain a SKILL.md",
        SETTINGS$SKILLS_ZIP_BLOCK_NAME: "The skill name is missing or invalid",
        SETTINGS$SKILLS_ZIP_BLOCK_SECRET:
          "Possible credential in {{file}} (line {{line}}, {{rule}})",
        SETTINGS$SKILLS_ZIP_WARN_SCRIPTS:
          "This skill can execute code (scripts found)",
        SETTINGS$SKILLS_ZIP_WARN_CASE_CONFLICT:
          "Two paths differ only in letter case",
        SETTINGS$SKILLS_ZIP_WARN_SCAN_PARTIAL:
          "Some files were skipped or only partially scanned",
        SETTINGS$SKILLS_ZIP_WARN_GENERIC: "This package has warnings",
        BUTTON$CLOSE: "Close",
      };
      let text = translations[key] ?? key;
      for (const [name, value] of Object.entries(params ?? {})) {
        text = text.replaceAll(`{{${name}}}`, String(value));
      }
      return text;
    },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children,
}));

const {
  mockHasInstallSupport,
  mockListInstalledSkills,
  mockUploadSkillPackage,
  mockInstallUploadedSkill,
} = vi.hoisted(() => ({
  mockHasInstallSupport: vi.fn(),
  mockListInstalledSkills: vi.fn(),
  mockUploadSkillPackage: vi.fn(),
  mockInstallUploadedSkill: vi.fn(),
}));

vi.mock("#/api/skills-service", () => ({
  default: {
    hasInstallSupport: mockHasInstallSupport,
    listInstalledSkills: mockListInstalledSkills,
  },
  SkillInstallError: class SkillInstallError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

vi.mock("#/api/skill-upload", () => ({
  uploadSkillPackage: mockUploadSkillPackage,
  installUploadedSkill: mockInstallUploadedSkill,
}));

function makeZip(specs: Parameters<typeof buildTestZip>[0]): File {
  const bytes = buildTestZip(specs);
  return new File([new Uint8Array(bytes)], "skill.zip", {
    type: "application/zip",
  });
}

function chooseFile(file: File): void {
  const input = screen.getByTestId("skill-zip-input");
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockHasInstallSupport.mockResolvedValue(true);
  mockListInstalledSkills.mockResolvedValue([]);
  mockUploadSkillPackage.mockResolvedValue({
    skillDir: "/home/u/.openhands/tmp/skill-upload/id/demo-skill",
    stagingRoot: "/home/u/.openhands/tmp/skill-upload",
    fileCount: 1,
  });
  mockInstallUploadedSkill.mockResolvedValue({ name: "demo-skill" });
});

const VALID_ZIP = makeZip([
  {
    name: "SKILL.md",
    data: "---\nname: demo-skill\ndescription: A demo\n---\nbody",
  },
]);

describe("SkillZipUpload", () => {
  it("shows the report with the pass summary for a valid package", async () => {
    renderUpload();
    chooseFile(VALID_ZIP);

    expect(await screen.findByTestId("skill-zip-report")).toBeInTheDocument();
    expect(screen.getByTestId("skill-zip-passed")).toHaveTextContent(
      "demo-skill",
    );
    expect(screen.queryByTestId("skill-zip-blockers")).not.toBeInTheDocument();
    expect(screen.queryByTestId("skill-zip-warnings")).not.toBeInTheDocument();

    const install = screen.getByTestId("skill-zip-install");
    expect(install).not.toBeDisabled();
  });

  it("lists blockers and disables install for a corrupt archive", async () => {
    renderUpload();
    chooseFile(makeZip([])); // no entries -> bad-zip blocker

    expect(await screen.findByTestId("skill-zip-blockers")).toBeInTheDocument();
    expect(screen.getByTestId("skill-zip-install")).toBeDisabled();
  });

  it("requires acknowledging warnings before install", async () => {
    const { user } = renderUpload();
    chooseFile(
      makeZip([
        {
          name: "SKILL.md",
          data: "---\nname: demo-skill\ndescription: A demo\n---\nbody",
        },
        { name: "scripts/run.sh", data: "#!/bin/sh\necho hi" },
      ]),
    );

    await screen.findByTestId("skill-zip-report");
    expect(screen.getByTestId("skill-zip-warnings")).toBeInTheDocument();
    expect(screen.getByTestId("skill-zip-install")).toBeDisabled();

    await user.click(screen.getByTestId("skill-zip-ack-risk"));
    expect(screen.getByTestId("skill-zip-install")).not.toBeDisabled();
  });

  it("uploads and installs, then shows the receipt with a masked path", async () => {
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    const { user } = renderUpload();
    chooseFile(VALID_ZIP);

    await user.click(await screen.findByTestId("skill-zip-install"));

    await waitFor(() => {
      expect(screen.getByTestId("skill-zip-done")).toBeInTheDocument();
    });
    expect(mockUploadSkillPackage).toHaveBeenCalledTimes(1);
    expect(mockInstallUploadedSkill).toHaveBeenCalledWith(
      "/home/u/.openhands/tmp/skill-upload/id/demo-skill",
      { force: false },
    );
    expect(screen.getByTestId("skill-zip-done")).toHaveTextContent(
      "~/.openhands/skills/installed/demo-skill/",
    );
    expect(invalidateSpy).toHaveBeenCalled();
    invalidateSpy.mockRestore();
  });

  it("shows the conflict view on 409 and overwrites with force on request", async () => {
    const conflict = new SkillInstallError("conflict", "already installed");
    mockInstallUploadedSkill.mockRejectedValueOnce(conflict);
    mockListInstalledSkills.mockResolvedValue([
      { name: "demo-skill", enabled: true },
    ]);

    const { user } = renderUpload();
    chooseFile(VALID_ZIP);
    await user.click(await screen.findByTestId("skill-zip-install"));

    expect(await screen.findByTestId("skill-zip-conflict")).toBeInTheDocument();
    expect(screen.getByTestId("skill-zip-conflict-existing")).toHaveTextContent(
      "demo-skill",
    );

    mockInstallUploadedSkill.mockResolvedValue({ name: "demo-skill" });
    await user.click(screen.getByTestId("skill-zip-overwrite"));

    await waitFor(() => {
      expect(screen.getByTestId("skill-zip-done")).toBeInTheDocument();
    });
    expect(mockInstallUploadedSkill).toHaveBeenLastCalledWith(
      "/home/u/.openhands/tmp/skill-upload/id/demo-skill",
      { force: true },
    );
  });

  it("aborts the in-flight upload when unmounted", async () => {
    let capturedSignal: AbortSignal | undefined;
    mockUploadSkillPackage.mockImplementation(
      (_entries, _name, options) =>
        new Promise((resolve) => {
          capturedSignal = options.signal;
          // never resolves on its own; unmount should abort it
          options.signal?.addEventListener("abort", () =>
            resolve({
              skillDir: "/tmp/x",
              stagingRoot: "/tmp",
              fileCount: 1,
            }),
          );
        }),
    );

    const { user, unmount } = renderUpload();
    chooseFile(VALID_ZIP);
    await user.click(await screen.findByTestId("skill-zip-install"));

    unmount();
    expect(capturedSignal?.aborted).toBe(true);
  });
});

function renderUpload() {
  const user = userEvent.setup();
  const utils = renderWithProviders(<SkillZipUpload onClose={vi.fn()} />);
  return { user, ...utils };
}
