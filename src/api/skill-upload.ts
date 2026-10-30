/**
 * ZIP-skill upload pipeline: stage the unpacked files on the agent-server
 * host, then install from the staged directory.
 *
 * Staging layout — `<stagingRoot>/<uploadId>/<skillName>/<entry paths>`:
 * the extra `<uploadId>/` level keeps concurrent uploads from colliding, and
 * the `<skillName>/` level is required by the server, which insists the
 * install source directory name equals the skill's frontmatter name.
 *
 * There is no delete-file endpoint, so staged directories are intentionally
 * left behind on failure (`~/.openhands/tmp/` is ephemeral on most setups;
 * the fallback root lives under `~/.cache/`). Cleanup is accepted follow-up
 * work, per the design's risk register.
 */

import { FileClient } from "@openhands/typescript-client/clients";

import { getAgentServerClientOptions } from "./agent-server-client-options";
import { getAgentServerHomeDir } from "./agent-server-home";
import SkillsService from "./skills-service";
import type { UnpackedFile } from "#/utils/skill-zip/unpack";

export interface UploadedSkillPackage {
  /** Absolute server path of the staged `<skillName>/` directory to install from. */
  skillDir: string;
  /** Absolute server path of the staging root that was used. */
  stagingRoot: string;
  fileCount: number;
}

export interface SkillUploadProgress {
  completed: number;
  total: number;
  /** Path (relative to the skill root) of the file just finished. */
  currentPath: string;
}

export interface UploadSkillPackageOptions {
  onProgress?: (progress: SkillUploadProgress) => void;
  /** Maximum parallel uploads; defaults to 5. */
  concurrency?: number;
  /** Abort signal — checked before dispatching each file. */
  signal?: AbortSignal;
}

export class SkillUploadError extends Error {
  /** Entry path (relative to the skill root) that failed to upload. */
  readonly failedPath: string;
  readonly status?: number;

  constructor(failedPath: string, message: string, status?: number) {
    super(message);
    this.name = "SkillUploadError";
    this.failedPath = failedPath;
    this.status = status;
  }
}

const PRIMARY_STAGING_RELATIVE = ".openhands/tmp/skill-upload";
const FALLBACK_STAGING_RELATIVE = ".cache/agent-canvas-skill-upload";
const DEFAULT_CONCURRENCY = 5;

function joinStagingPath(home: string, relative: string): string {
  return `${home.replace(/[/\\]+$/, "")}/${relative}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getStatus(error: unknown): number | undefined {
  if (isRecord(error) && typeof error.status === "number") return error.status;
  return undefined;
}

/**
 * The primary staging root sits under `~/.openhands`, which some server
 * setups make read-only or sandbox; those surface as 403/500. Everything
 * else (disk full, network) is a hard failure.
 */
function isStagingRootRejection(error: unknown): boolean {
  const status = getStatus(error);
  return status === 403 || status === 500;
}

/**
 * Guards against path traversal reaching the staging layout even though the
 * unpacker already rejects such entries — this module is the last line
 * before the server's filesystem.
 */
function assertSafeEntryPath(path: string): void {
  if (path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error(`Entry path "${path}" escapes the skill directory`);
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Skill upload aborted");
  }
}

function makeUploadId(): string {
  return crypto.randomUUID();
}

export async function uploadSkillPackage(
  entries: UnpackedFile[],
  skillName: string,
  options: UploadSkillPackageOptions = {},
): Promise<UploadedSkillPackage> {
  for (const entry of entries) {
    assertSafeEntryPath(entry.path);
  }
  assertNotAborted(options.signal);

  const home = await getAgentServerHomeDir();
  const uploadId = makeUploadId();

  try {
    const stagingRoot = joinStagingPath(home, PRIMARY_STAGING_RELATIVE);
    const skillDir = await stageEntries(
      entries,
      skillName,
      stagingRoot,
      uploadId,
      options,
    );
    return { skillDir, stagingRoot, fileCount: entries.length };
  } catch (error) {
    if (!isStagingRootRejection(error)) throw error;
  }

  const fallbackRoot = joinStagingPath(home, FALLBACK_STAGING_RELATIVE);
  const skillDir = await stageEntries(
    entries,
    skillName,
    fallbackRoot,
    uploadId,
    options,
  );
  return { skillDir, stagingRoot: fallbackRoot, fileCount: entries.length };
}

async function stageEntries(
  entries: UnpackedFile[],
  skillName: string,
  stagingRoot: string,
  uploadId: string,
  options: UploadSkillPackageOptions,
): Promise<string> {
  assertNotAborted(options.signal);

  const skillDir = `${stagingRoot}/${uploadId}/${skillName}`;
  const client = new FileClient(getAgentServerClientOptions());
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const total = entries.length;
  let nextIndex = 0;
  let completed = 0;
  let failure: unknown;

  const uploadOne = async (entry: UnpackedFile): Promise<void> => {
    const segments = entry.path.split("/");
    const fileName = segments[segments.length - 1];
    const destinationPath =
      segments.length > 1
        ? `${skillDir}/${segments.slice(0, -1).join("/")}`
        : skillDir;
    try {
      // `new Uint8Array(view)` copies into a plain ArrayBuffer, which is a
      // valid BlobPart regardless of the source buffer's type.
      await client.uploadFile(
        new Blob([new Uint8Array(entry.bytes)]),
        destinationPath,
        fileName,
      );
    } catch (error) {
      const status = getStatus(error);
      throw new SkillUploadError(
        entry.path,
        `Failed to upload "${entry.path}"${status !== undefined ? ` (status ${status})` : ""}`,
        status,
      );
    }
  };

  const worker = async (): Promise<void> => {
    while (failure === undefined) {
      assertNotAborted(options.signal);
      const index = nextIndex;
      nextIndex += 1;
      if (index >= total) return;

      const entry = entries[index];
      try {
        await uploadOne(entry);
      } catch (error) {
        // Record the first failure and stop dispatching; in-flight uploads
        // are allowed to finish so we do not leave the server mid-request.
        failure ??= error;
        return;
      }
      completed += 1;
      options.onProgress?.({
        completed,
        total,
        currentPath: entry.path,
      });
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, total) }, () => worker()),
  );

  if (failure !== undefined) throw failure;
  return skillDir;
}

/**
 * Installs the previously staged package. The staged directory must be the
 * inner `<uploadId>/<skillName>` path — passing the bare `<uploadId>` makes
 * the server reject the install because the directory name no longer equals
 * the skill's frontmatter name.
 */
export async function installUploadedSkill(
  skillDir: string,
  { force = false }: { force?: boolean } = {},
): Promise<Record<string, unknown>> {
  return SkillsService.installSkillFromDirectory(skillDir, { force });
}
