import { isHttpError } from "@openhands/typescript-client";
import {
  AgentServerClient,
  SkillsClient,
} from "@openhands/typescript-client/clients";
import {
  SKILLS_CATALOG,
  type SkillCatalogEntry,
} from "@openhands/extensions/skills";
import { SkillInfo, SkillOrigin } from "#/types/settings";
import { getAgentServerWorkingDir } from "./agent-server-config";
import { getActiveBackend } from "./backend-registry/active-store";
import {
  fetchCloudConversationSkills,
  fetchCloudSkills,
} from "./cloud/skills-service.api";
import { getAgentServerClientOptions } from "./agent-server-client-options";

function catalogEntryToSkillInfo(entry: SkillCatalogEntry): SkillInfo {
  return {
    name: entry.name,
    type: "knowledge",
    source: "public",
    description: entry.description,
    triggers: entry.triggers,
    category: entry.category,
    content: entry.content,
    license: entry.license ?? null,
    compatibility: entry.compatibility ?? null,
  };
}

/**
 * Public skills loaded from the `@openhands/extensions` npm package.
 *
 * This is an **immutable build-time snapshot**: the catalog is baked into the
 * bundle at `npm run build` / `vite build` time and does not change at
 * runtime. Updating the catalog requires bumping the `@openhands/extensions`
 * dependency and rebuilding.
 */
const PUBLIC_SKILLS: SkillInfo[] = SKILLS_CATALOG.map(catalogEntryToSkillInfo);

const BUNDLED_BY_NAME = new Map(SKILLS_CATALOG.map((e) => [e.name, e]));

export const SKILL_CATALOG_PATH = "/api/skills/catalog";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOrigin(value: unknown): value is SkillOrigin {
  return value === "public" || value === "user";
}

/** A server entry, with the bundled catalog's display metadata for public skills. */
function toCatalogSkill(entry: unknown): SkillInfo {
  if (
    !isRecord(entry) ||
    typeof entry.name !== "string" ||
    !isOrigin(entry.origin)
  ) {
    throw new Error("The agent server returned a malformed skill catalog.");
  }
  const skill = entry as unknown as SkillInfo;
  if (skill.origin !== "public") return skill;
  // Shown as the catalog, as the bundled entries are, rather than a server path.
  const listed = { ...skill, source: "public" };
  const bundled = BUNDLED_BY_NAME.get(skill.name);
  if (!bundled) return listed;
  return {
    ...listed,
    category: bundled.category,
    license: skill.license ?? bundled.license ?? null,
    compatibility: skill.compatibility ?? bundled.compatibility ?? null,
  };
}

function hasStatus(error: unknown, status: number): boolean {
  return isRecord(error) && error.status === status;
}

export type SkillInstallErrorCode =
  | "conflict"
  | "invalid"
  | "unreadable"
  | "unsupported"
  | "unknown";

/**
 * A failed skill install/uninstall, with the raw HTTP status mapped to a
 * stable code the UI can branch on:
 *
 * - `conflict` (409): a skill with the same name is already installed; the
 *   UI offers a force-overwrite.
 * - `invalid` (422): the server rejected the package contents (bad SKILL.md
 *   or frontmatter); `detail` carries the server's message.
 * - `unreadable` (400): the server could not read the source directory.
 * - `unsupported`: a cloud backend, or the agent-server predates the
 *   installed-skills endpoints.
 * - `unknown`: anything else.
 */
export class SkillInstallError extends Error {
  readonly code: SkillInstallErrorCode;
  readonly detail?: string;
  readonly status?: number;

  constructor(
    code: SkillInstallErrorCode,
    message: string,
    options: { detail?: string; status?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "SkillInstallError";
    this.code = code;
    this.detail = options.detail;
    this.status = options.status;
  }
}

function getStatus(error: unknown): number | undefined {
  if (isHttpError(error)) return error.status;
  if (isRecord(error) && typeof error.status === "number") return error.status;
  return undefined;
}

function getDetail(error: unknown): string | undefined {
  if (isHttpError(error)) return error.detail;
  if (
    isRecord(error) &&
    typeof error.detail === "string" &&
    error.detail.trim()
  ) {
    return error.detail;
  }
  return undefined;
}

/** Minimal shape of a server-side installed skill, per the agent-server API. */
export interface InstalledSkillSummary {
  name: string;
  version?: string | null;
  enabled: boolean;
}

interface SkillsClientWithInstall {
  installSkill(request: {
    source: string;
    force?: boolean;
  }): Promise<Record<string, unknown>>;
  listInstalledSkills(): Promise<{ skills?: InstalledSkillSummary[] }>;
  uninstallSkill(skillName: string): Promise<{ message: string }>;
  getSkills(request: Record<string, unknown>): Promise<{ skills?: unknown[] }>;
}

function getInstallClient(): SkillsClientWithInstall {
  return new SkillsClient(
    getAgentServerClientOptions(),
  ) as unknown as SkillsClientWithInstall;
}

function isCloudBackend(): boolean {
  return getActiveBackend().backend.kind === "cloud";
}

class SkillsService {
  static async getSkills(projectDir?: string): Promise<SkillInfo[]> {
    if (getActiveBackend().backend.kind === "cloud") {
      return fetchCloudSkills();
    }

    // Public skills come from the bundled @openhands/extensions npm package —
    // no agent-server round-trip or GitHub fetch needed. Only ask the agent-
    // server for user and project skills so local .agents/skills/ content is
    // still picked up.
    let localSkills: SkillInfo[] = [];
    try {
      const response = await new SkillsClient(
        getAgentServerClientOptions(),
      ).getSkills({
        load_public: false,
        load_user: true,
        load_project: true,
        load_org: false,
        project_dir: projectDir ?? getAgentServerWorkingDir(),
      });
      localSkills = (response.skills ?? []) as SkillInfo[];
    } catch {
      // Agent-server may not support the skills endpoint or may be
      // unreachable; fall back to the bundled public catalog alone.
    }

    return [...localSkills, ...PUBLIC_SKILLS];
  }

  /**
   * Skills an agent profile can select on this server. Repo skills load only
   * when a conversation opens its workspace, so they are not listed.
   */
  static async getSkillCatalog(): Promise<SkillInfo[]> {
    const { host, apiKey } = getAgentServerClientOptions();
    try {
      const data = await new AgentServerClient({ host, apiKey }).get<unknown>(
        SKILL_CATALOG_PATH,
        { acceptableStatusCodes: new Set([200]), responseType: "json" },
      );
      const skills = isRecord(data) ? data.skills : undefined;
      if (!Array.isArray(skills)) {
        throw new Error("The agent server returned a malformed skill catalog.");
      }
      return skills.map(toCatalogSkill);
    } catch (error) {
      if (!hasStatus(error, 404)) throw error;
    }
    // Servers before the catalog endpoint: the bundled catalog plus user skills.
    const response = await new SkillsClient(
      getAgentServerClientOptions(),
    ).getSkills({
      load_public: false,
      load_user: true,
      load_project: false,
      load_org: false,
    });
    const userSkills = ((response.skills ?? []) as SkillInfo[]).map(
      (skill) => ({ ...skill, origin: "user" as const }),
    );
    const userNames = new Set(userSkills.map((skill) => skill.name));
    return [
      ...PUBLIC_SKILLS.filter((skill) => !userNames.has(skill.name)).map(
        (skill) => ({ ...skill, origin: "public" as const }),
      ),
      ...userSkills,
    ];
  }

  /**
   * Skills loaded into a running cloud conversation (see
   * `fetchCloudConversationSkills`). Cloud-only: local conversations keep
   * using `getSkills(projectDir)`, whose agent-server call already scopes to
   * the conversation's workspace.
   */
  static getConversationSkills(conversationId: string): Promise<SkillInfo[]> {
    return fetchCloudConversationSkills(conversationId);
  }

  /**
   * Installs a skill from a directory that already exists on the agent-server
   * host (e.g. the ZIP-upload staging directory). The server enforces
   * `SKILL.md` validity and `name == directory name`; 409/422/400 responses
   * are mapped to {@link SkillInstallError} codes.
   */
  static async installSkillFromDirectory(
    directory: string,
    { force = false }: { force?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    if (isCloudBackend()) {
      throw new SkillInstallError(
        "unsupported",
        "Installing skills is only available on a local backend.",
      );
    }

    try {
      return await getInstallClient().installSkill({
        source: directory,
        force,
      });
    } catch (error) {
      throw mapInstallError(error, "install");
    }
  }

  /**
   * Skills installed on the agent-server host
   * (`~/.openhands/skills/installed/`). Returns an empty list on cloud
   * backends, on servers without the installed-skills endpoints, or when the
   * server is unreachable — callers that need the distinction should use
   * {@link hasInstallSupport} instead.
   */
  static async listInstalledSkills(): Promise<InstalledSkillSummary[]> {
    if (isCloudBackend()) return [];

    try {
      const response = await getInstallClient().listInstalledSkills();
      return response.skills ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Removes an installed skill. A 404 is treated as "already uninstalled"
   * and resolves normally so retries and races are harmless.
   */
  static async uninstallSkill(name: string): Promise<void> {
    if (isCloudBackend()) {
      throw new SkillInstallError(
        "unsupported",
        "Uninstalling skills is only available on a local backend.",
      );
    }

    try {
      await getInstallClient().uninstallSkill(name);
    } catch (error) {
      if (getStatus(error) === 404) return;
      throw mapInstallError(error, "uninstall");
    }
  }

  /**
   * Whether this agent-server supports installing skills (the
   * `/api/skills/installed` endpoints). Never runs on Cloud. Probed once per
   * backend and cached; only an explicit 404/405 (old servers) reports `false`
   * so the upload UI hides instead of failing mid-flow, while transport errors
   * keep the UI available and let the real install attempt surface the problem.
   */
  static async hasInstallSupport(): Promise<boolean> {
    if (isCloudBackend()) return false;

    const { host } = getAgentServerClientOptions();
    const cached = installSupportCache.get(host);
    if (cached) return cached;

    const probe = (async () => {
      try {
        await getInstallClient().listInstalledSkills();
        return true;
      } catch (error) {
        const status = getStatus(error);
        return status !== 404 && status !== 405;
      }
    })();

    installSupportCache.set(host, probe);
    return probe;
  }
}

const installSupportCache = new Map<string, Promise<boolean>>();

/** Test-only helper. */
export function __resetInstallSupportCacheForTests(): void {
  installSupportCache.clear();
}

function mapInstallError(error: unknown, action: string): SkillInstallError {
  const status = getStatus(error);
  const detail = getDetail(error);
  const code: SkillInstallErrorCode =
    status === 409
      ? "conflict"
      : status === 422
        ? "invalid"
        : status === 400
          ? "unreadable"
          : "unknown";
  const message =
    detail ??
    (status !== undefined
      ? `Skill ${action} failed with status ${status}`
      : `Skill ${action} failed`);
  return new SkillInstallError(code, message, { detail, status, cause: error });
}

export default SkillsService;
