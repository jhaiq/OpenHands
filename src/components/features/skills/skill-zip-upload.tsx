import React from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";

import { BrandButton } from "#/components/features/settings/brand-button";
import { SKILL_CATALOG_QUERY_KEYS } from "#/hooks/query/query-keys";
import { I18nKey } from "#/i18n/declaration";
import {
  DEFAULT_UNPACK_LIMITS,
  unpackSkillZip,
  type UnpackResult,
} from "#/utils/skill-zip/unpack";
import {
  validateSkillPackage,
  type SkillPackageValidation,
} from "#/utils/skill-zip/validator";
import {
  scanFilesForSecrets,
  type SecretScanResult,
} from "#/utils/skill-zip/secret-scanner";
import SkillsService, {
  SkillInstallError,
  type InstalledSkillSummary,
} from "#/api/skills-service";
import { installUploadedSkill, uploadSkillPackage } from "#/api/skill-upload";

interface SkillZipUploadProps {
  /** Closes the whole add-skill modal (the report's "cancel" action). */
  onClose: () => void;
}

type InstallPhase =
  | { state: "idle" }
  | { state: "unpacking" }
  | { state: "validating" }
  | {
      state: "report";
      zip: UnpackResult;
      validation: SkillPackageValidation;
      secrets: SecretScanResult;
    }
  | { state: "installing"; skillName: string; completed: number; total: number }
  | {
      state: "conflict";
      skillName: string;
      skillDir: string;
      existing: InstalledSkillSummary | null;
    }
  | { state: "done"; skillName: string }
  | { state: "error"; message: string };

/** Blocker codes grouped onto one localized message each. */
const BLOCKER_CODE_KEYS: Record<string, I18nKey> = {
  "bad-zip": I18nKey.SETTINGS$SKILLS_ZIP_BLOCK_BAD_ZIP,
  "no-entries": I18nKey.SETTINGS$SKILLS_ZIP_BLOCK_BAD_ZIP,
  "corrupt-entry": I18nKey.SETTINGS$SKILLS_ZIP_BLOCK_BAD_ZIP,
  "inflated-size-mismatch": I18nKey.SETTINGS$SKILLS_ZIP_BLOCK_BAD_ZIP,
  "zip-too-large": I18nKey.SETTINGS$SKILLS_ZIP_BLOCK_TOO_LARGE,
  "file-too-large": I18nKey.SETTINGS$SKILLS_ZIP_BLOCK_TOO_LARGE,
  "total-too-large": I18nKey.SETTINGS$SKILLS_ZIP_BLOCK_TOO_LARGE,
  "too-many-entries": I18nKey.SETTINGS$SKILLS_ZIP_BLOCK_TOO_MANY,
  "compression-ratio": I18nKey.SETTINGS$SKILLS_ZIP_BLOCK_RATIO,
  "depth-too-deep": I18nKey.SETTINGS$SKILLS_ZIP_BLOCK_DEPTH,
  "encrypted-entry": I18nKey.SETTINGS$SKILLS_ZIP_BLOCK_ENCRYPTED,
  "symlink-entry": I18nKey.SETTINGS$SKILLS_ZIP_BLOCK_SYMLINK,
  "forbidden-path": I18nKey.SETTINGS$SKILLS_ZIP_BLOCK_PATH,
  "duplicate-entry": I18nKey.SETTINGS$SKILLS_ZIP_BLOCK_DUPLICATE,
  "missing-skill-md": I18nKey.SETTINGS$SKILLS_ZIP_BLOCK_NO_SKILL_MD,
  "missing-frontmatter": I18nKey.SETTINGS$SKILLS_ZIP_BLOCK_FRONTMATTER,
  "unterminated-frontmatter": I18nKey.SETTINGS$SKILLS_ZIP_BLOCK_FRONTMATTER,
  "invalid-frontmatter": I18nKey.SETTINGS$SKILLS_ZIP_BLOCK_FRONTMATTER,
  "missing-name": I18nKey.SETTINGS$SKILLS_ZIP_BLOCK_NAME,
  "missing-description": I18nKey.SETTINGS$SKILLS_ZIP_BLOCK_NAME,
  "invalid-name": I18nKey.SETTINGS$SKILLS_ZIP_BLOCK_NAME,
  "reserved-name": I18nKey.SETTINGS$SKILLS_ZIP_BLOCK_NAME,
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function maskedInstallPath(skillName: string): string {
  return `~/.openhands/skills/installed/${skillName}/`;
}

/**
 * The "upload ZIP" section of the add-skill modal: pick a file, run the
 * local pre-checks (structure → correctness → secrets), review the report,
 * then stage and install. Rendered only when the agent-server supports
 * installed skills on a local backend — the parent gates on that.
 */
export function SkillZipUpload({ onClose }: SkillZipUploadProps) {
  const { t } = useTranslation("openhands");
  const queryClient = useQueryClient();

  const [phase, setPhase] = React.useState<InstallPhase>({ state: "idle" });
  const [warningsAcknowledged, setWarningsAcknowledged] = React.useState(false);
  const abortRef = React.useRef<AbortController | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // Closing the modal unmounts this section; abort any in-flight upload so
  // staged writes stop immediately (design task 3.6).
  React.useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const handleFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    // Reset so re-selecting the same file fires `change` again.
    const { target } = event;
    const file = target.files?.[0];
    target.value = "";
    if (!file) return;

    setWarningsAcknowledged(false);
    setPhase({ state: "unpacking" });
    try {
      const buffer = await file.arrayBuffer();
      const zip = unpackSkillZip(new Uint8Array(buffer), DEFAULT_UNPACK_LIMITS);
      setPhase({ state: "validating" });

      const validation = validateSkillPackage(zip.files);
      const secrets = scanFilesForSecrets(zip.files);

      setPhase({ state: "report", zip, validation, secrets });
    } catch {
      setPhase({
        state: "error",
        message: t(I18nKey.SETTINGS$SKILLS_ZIP_BLOCK_BAD_ZIP),
      });
    }
  };

  const resetToIdle = () => {
    setWarningsAcknowledged(false);
    setPhase({ state: "idle" });
  };

  const reportBlockers = (
    phase: Extract<InstallPhase, { state: "report" }>,
  ) => {
    const { zip, validation, secrets } = phase;
    const blockers: ZipIssue[] = [
      ...zip.blockers.map((blocker) => ({
        code: blocker.code,
        entry: blocker.entry,
      })),
      ...validation.blockers.map((blocker) => ({
        code: blocker.code,
        entry: "SKILL.md",
      })),
      ...secrets.findings.map((finding) => ({
        code: `secret:${finding.rule}`,
        entry: `${finding.file}:${finding.line}`,
        params: { file: finding.file, line: finding.line, rule: finding.rule },
      })),
    ];
    return blockers;
  };

  const reportWarnings = (
    phase: Extract<InstallPhase, { state: "report" }>,
  ) => {
    const { zip, validation, secrets } = phase;
    const warnings: ZipIssue[] = [
      ...zip.warnings.map((warning) => ({
        code: warning.code,
        entry: warning.entry,
      })),
    ];
    if (validation.info.hasScripts) {
      warnings.push({ code: "has-scripts" });
    }
    if (secrets.partial.length > 0 || secrets.skipped.length > 0) {
      warnings.push({ code: "scan-partial" });
    }
    return warnings;
  };

  const install = async (force: boolean) => {
    const current = phase;
    if (current.state !== "report" && current.state !== "conflict") return;

    const skillName =
      current.state === "conflict"
        ? current.skillName
        : current.validation.info.name;
    if (!skillName) return;

    // The report phase no longer holds the staged file list after re-renders
    // (it is derived state), so restart from the stored report data.
    if (current.state === "conflict") {
      await installStaged(current.skillDir, skillName, force);
      return;
    }

    setPhase({
      state: "installing",
      skillName,
      completed: 0,
      total: current.zip.files.length,
    });
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const staged = await uploadSkillPackage(current.zip.files, skillName, {
        signal: controller.signal,
        onProgress: ({ completed, total }) =>
          setPhase((prev) =>
            prev.state === "installing" && prev.skillName === skillName
              ? { ...prev, completed, total }
              : prev,
          ),
      });
      await installStaged(staged.skillDir, skillName, force);
    } catch (error) {
      setPhase({
        state: "error",
        message:
          error instanceof Error && error.message
            ? error.message
            : t(I18nKey.SETTINGS$SKILLS_ZIP_ERROR_TITLE),
      });
    } finally {
      abortRef.current = null;
    }
  };

  const installStaged = async (
    skillDir: string,
    skillName: string,
    force: boolean,
  ) => {
    setPhase({ state: "installing", skillName, completed: 0, total: 0 });
    try {
      await installUploadedSkill(skillDir, { force });
      await queryClient.invalidateQueries({
        queryKey: SKILL_CATALOG_QUERY_KEYS.all,
      });
      setPhase({ state: "done", skillName });
    } catch (error) {
      if (error instanceof SkillInstallError && error.code === "conflict") {
        const existing =
          (await SkillsService.listInstalledSkills()).find(
            (skill) => skill.name === skillName,
          ) ?? null;
        setPhase({ state: "conflict", skillName, skillDir, existing });
        return;
      }
      setPhase({
        state: "error",
        message:
          error instanceof Error && error.message
            ? error.message
            : t(I18nKey.SETTINGS$SKILLS_ZIP_ERROR_TITLE),
      });
    }
  };

  return (
    <section className="flex flex-col gap-2" data-testid="skill-zip-upload">
      <h3 className="text-sm font-semibold text-foreground">
        {t(I18nKey.SETTINGS$SKILLS_ZIP_TITLE)}
      </h3>
      <p className="text-xs leading-relaxed text-tertiary-light">
        {t(I18nKey.SETTINGS$SKILLS_ZIP_INTRO)}
      </p>

      {phase.state === "idle" && (
        <div className="flex flex-col gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            data-testid="skill-zip-input"
            onChange={handleFileChange}
          />
          <BrandButton
            type="button"
            variant="secondary"
            testId="skill-zip-choose"
            onClick={() => fileInputRef.current?.click()}
          >
            {t(I18nKey.SETTINGS$SKILLS_ZIP_CHOOSE)}
          </BrandButton>
          <p className="text-xs text-tertiary-light">
            {t(I18nKey.SETTINGS$SKILLS_ZIP_LIMITS)}
          </p>
        </div>
      )}

      {(phase.state === "unpacking" || phase.state === "validating") && (
        <p className="text-xs text-tertiary-light" data-testid="skill-zip-busy">
          {t(
            phase.state === "unpacking"
              ? I18nKey.SETTINGS$SKILLS_ZIP_PARSING
              : I18nKey.SETTINGS$SKILLS_ZIP_VALIDATING,
          )}
        </p>
      )}

      {phase.state === "report" && (
        <SkillZipReport
          phase={phase}
          blockers={reportBlockers(phase)}
          warnings={reportWarnings(phase)}
          warningsAcknowledged={warningsAcknowledged}
          onAcknowledgeChange={setWarningsAcknowledged}
          onReselect={resetToIdle}
          onClose={onClose}
          onInstall={() => install(false)}
        />
      )}

      {phase.state === "installing" && (
        <p
          className="text-xs text-tertiary-light"
          data-testid="skill-zip-installing"
        >
          {phase.total > 0
            ? t(I18nKey.SETTINGS$SKILLS_ZIP_UPLOADING, {
                completed: phase.completed,
                total: phase.total,
              })
            : t(I18nKey.SETTINGS$SKILLS_ZIP_INSTALLING)}
        </p>
      )}

      {phase.state === "conflict" && (
        <div className="flex flex-col gap-2" data-testid="skill-zip-conflict">
          <p className="text-sm font-semibold text-foreground">
            {t(I18nKey.SETTINGS$SKILLS_ZIP_CONFLICT_TITLE)}
          </p>
          <p className="text-xs text-tertiary-light">
            {t(I18nKey.SETTINGS$SKILLS_ZIP_CONFLICT_BODY, {
              name: phase.skillName,
            })}
          </p>
          {phase.existing && (
            <p
              className="text-xs text-tertiary-light"
              data-testid="skill-zip-conflict-existing"
            >
              {phase.existing.enabled
                ? t(I18nKey.SETTINGS$SKILLS_ZIP_SUMMARY_NAME, {
                    name: phase.existing.name,
                  })
                : t(I18nKey.SETTINGS$SKILLS_ZIP_SUMMARY_NAME, {
                    name: `${phase.existing.name} (disabled)`,
                  })}
            </p>
          )}
          <div className="flex gap-2">
            <BrandButton
              type="button"
              variant="primary"
              testId="skill-zip-overwrite"
              onClick={() => install(true)}
            >
              {t(I18nKey.SETTINGS$SKILLS_ZIP_OVERWRITE)}
            </BrandButton>
            <BrandButton
              type="button"
              variant="secondary"
              testId="skill-zip-conflict-cancel"
              onClick={resetToIdle}
            >
              {t(I18nKey.SETTINGS$SKILLS_ZIP_RESELECT)}
            </BrandButton>
          </div>
        </div>
      )}

      {phase.state === "done" && (
        <div className="flex flex-col gap-2" data-testid="skill-zip-done">
          <p className="text-sm font-semibold text-foreground">
            {t(I18nKey.SETTINGS$SKILLS_ZIP_DONE_TITLE)}
          </p>
          <p className="text-xs text-tertiary-light">
            {t(I18nKey.SETTINGS$SKILLS_ZIP_DONE_PATH, {
              path: maskedInstallPath(phase.skillName),
            })}
          </p>
          <p className="text-xs text-tertiary-light">
            {t(I18nKey.SETTINGS$SKILLS_ZIP_DONE_RESTART)}
          </p>
          <BrandButton
            type="button"
            variant="secondary"
            testId="skill-zip-done-close"
            onClick={onClose}
          >
            {t(I18nKey.BUTTON$CLOSE)}
          </BrandButton>
        </div>
      )}

      {phase.state === "error" && (
        <div className="flex flex-col gap-2" data-testid="skill-zip-error">
          <p className="text-sm font-semibold text-danger">
            {t(I18nKey.SETTINGS$SKILLS_ZIP_ERROR_TITLE)}
          </p>
          <p className="text-xs text-tertiary-light">{phase.message}</p>
          <BrandButton
            type="button"
            variant="secondary"
            testId="skill-zip-error-reselect"
            onClick={resetToIdle}
          >
            {t(I18nKey.SETTINGS$SKILLS_ZIP_RESELECT)}
          </BrandButton>
        </div>
      )}
    </section>
  );
}

interface SkillZipReportProps {
  phase: Extract<InstallPhase, { state: "report" }>;
  blockers: ZipIssue[];
  warnings: ZipIssue[];
  warningsAcknowledged: boolean;
  onAcknowledgeChange: (acknowledged: boolean) => void;
  onReselect: () => void;
  onClose: () => void;
  onInstall: () => void;
}

interface ZipIssue {
  code: string;
  entry?: string;
  /** i18n interpolation values (e.g. file/line/rule for secret findings). */
  params?: Record<string, string | number>;
}

function blockerMessageKey(code: string): I18nKey {
  // Secret codes carry the rule name ("secret:<rule>"); the entry prefix
  // ("notes/config.txt:1") is rendered separately, never the secret itself.
  if (code.startsWith("secret:")) {
    return I18nKey.SETTINGS$SKILLS_ZIP_BLOCK_SECRET;
  }
  return BLOCKER_CODE_KEYS[code] ?? I18nKey.SETTINGS$SKILLS_ZIP_BLOCK_GENERIC;
}

function SkillZipReport({
  phase,
  blockers,
  warnings,
  warningsAcknowledged,
  onAcknowledgeChange,
  onReselect,
  onClose,
  onInstall,
}: SkillZipReportProps) {
  const { t } = useTranslation("openhands");
  const info = phase.validation.info;
  const hasBlockers = blockers.length > 0;
  const hasWarnings = warnings.length > 0;
  const installDisabled = hasBlockers || (hasWarnings && !warningsAcknowledged);

  return (
    <div className="flex flex-col gap-3" data-testid="skill-zip-report">
      {hasBlockers && (
        <div className="flex flex-col gap-1" data-testid="skill-zip-blockers">
          <p className="text-xs font-semibold text-danger">
            {t(I18nKey.SETTINGS$SKILLS_ZIP_BLOCKED_TITLE, {
              count: blockers.length,
            })}
          </p>
          <ul className="list-disc space-y-1 pl-4 text-xs text-tertiary-light">
            {blockers.map((blocker, index) => (
              <li
                key={`${blocker.code}-${blocker.entry ?? index}`}
                data-testid="skill-zip-blocker-item"
              >
                {blocker.entry && (
                  <span className="font-mono">{blocker.entry}: </span>
                )}
                {t(
                  blockerMessageKey(blocker.code),
                  "params" in blocker ? blocker.params : undefined,
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {hasWarnings && (
        <div className="flex flex-col gap-1" data-testid="skill-zip-warnings">
          <p className="text-xs font-semibold text-warning">
            {t(I18nKey.SETTINGS$SKILLS_ZIP_WARNING_TITLE, {
              count: warnings.length,
            })}
          </p>
          <ul className="list-disc space-y-1 pl-4 text-xs text-tertiary-light">
            {warnings.map((warning, index) => (
              <li key={`${warning.code}-${warning.entry ?? index}`}>
                {t(
                  warning.code === "case-conflict"
                    ? I18nKey.SETTINGS$SKILLS_ZIP_WARN_CASE_CONFLICT
                    : warning.code === "has-scripts"
                      ? I18nKey.SETTINGS$SKILLS_ZIP_WARN_SCRIPTS
                      : warning.code === "scan-partial"
                        ? I18nKey.SETTINGS$SKILLS_ZIP_WARN_SCAN_PARTIAL
                        : I18nKey.SETTINGS$SKILLS_ZIP_WARN_GENERIC,
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!hasBlockers && (
        <div className="flex flex-col gap-1" data-testid="skill-zip-passed">
          <p className="text-xs font-semibold text-success">
            {t(I18nKey.SETTINGS$SKILLS_ZIP_PASSED_TITLE)}
          </p>
          <ul className="list-disc space-y-1 pl-4 text-xs text-tertiary-light">
            <li>
              {t(I18nKey.SETTINGS$SKILLS_ZIP_SUMMARY_NAME, { name: info.name })}
            </li>
            <li>
              {t(I18nKey.SETTINGS$SKILLS_ZIP_SUMMARY_FILES, {
                count: info.fileCount,
              })}
            </li>
            <li>
              {t(I18nKey.SETTINGS$SKILLS_ZIP_SUMMARY_SIZE, {
                size: formatBytes(info.totalSize),
              })}
            </li>
            <li>
              {t(
                info.hasScripts
                  ? I18nKey.SETTINGS$SKILLS_ZIP_SUMMARY_SCRIPTS
                  : I18nKey.SETTINGS$SKILLS_ZIP_SUMMARY_NO_SCRIPTS,
              )}
            </li>
          </ul>
        </div>
      )}

      {hasWarnings && !hasBlockers && (
        <label
          className="flex items-center gap-2"
          data-testid="skill-zip-ack-risk-label"
        >
          <input
            type="checkbox"
            data-testid="skill-zip-ack-risk"
            checked={warningsAcknowledged}
            onChange={(event) => onAcknowledgeChange(event.target.checked)}
            className="h-3.5 w-3.5 cursor-pointer accent-accent"
          />
          <span className="text-xs text-tertiary-light">
            {t(I18nKey.SETTINGS$SKILLS_ZIP_ACK_RISK)}
          </span>
        </label>
      )}

      <div className="flex gap-2">
        <BrandButton
          type="button"
          variant="primary"
          testId="skill-zip-install"
          isDisabled={installDisabled}
          onClick={onInstall}
        >
          {t(I18nKey.SETTINGS$SKILLS_ZIP_INSTALL)}
        </BrandButton>
        <BrandButton
          type="button"
          variant="secondary"
          testId="skill-zip-reselect"
          onClick={onReselect}
        >
          {t(I18nKey.SETTINGS$SKILLS_ZIP_RESELECT)}
        </BrandButton>
        <BrandButton
          type="button"
          variant="secondary"
          testId="skill-zip-cancel"
          onClick={onClose}
        >
          {t(I18nKey.BUTTON$CLOSE)}
        </BrandButton>
      </div>
    </div>
  );
}
