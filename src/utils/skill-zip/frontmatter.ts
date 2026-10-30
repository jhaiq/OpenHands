/**
 * A deliberately narrow frontmatter parser for SKILL.md files.
 *
 * Skill frontmatter only needs two scalar fields — `name` and `description`.
 * Pulling in a full YAML parser would add an attack surface and bundle weight
 * for zero benefit, so this parser accepts exactly what well-formed skill
 * frontmatter uses and fails loudly on anything else:
 *
 *   ---
 *   name: my-skill
 *   description: >
 *     Folded description lines are joined with spaces.
 *   triggers:
 *     - develop
 *   ---
 *
 * Supported value forms: plain scalars, single/double quoted scalars, `>` / `|`
 * block scalars (with an optional chomping indicator), and `- item` sequences.
 * Unknown keys are ignored but their block scalars and sequences are consumed
 * correctly.
 *
 * The rules below mirror what the Agent Server's YAML loader accepts, so a
 * package that passes here does not get rejected later at install time:
 *
 * - A plain (unquoted) scalar may not contain `": "` or end with `:` — YAML
 *   reads that as a nested mapping and fails with "mapping values are not
 *   allowed in this context".
 * - `triggers` must be a sequence; the server rejects a plain string.
 */

export interface SkillFrontmatter {
  name: string;
  description: string;
}

export type FrontmatterErrorCode =
  | "missing-frontmatter"
  | "unterminated-frontmatter"
  | "invalid-line"
  | "unquoted-colon"
  | "triggers-not-list"
  | "missing-name"
  | "missing-description";

export type FrontmatterResult =
  | { ok: true; frontmatter: SkillFrontmatter }
  | {
      ok: false;
      code: FrontmatterErrorCode;
      message: string;
      /** 1-based line number in SKILL.md, when the problem is line-specific. */
      line?: number;
    };

const FENCE = "---";

/** `key:` at column 0 — the only shape a frontmatter key may take here. */
const KEY_LINE = /^([A-Za-z][A-Za-z0-9_-]*):\s?(.*)$/;

/** A sequence item belonging to the preceding `key:` line. */
const LIST_ITEM = /^\s*-\s+(.*)$/;

/** Block scalar indicators this parser understands: `>`, `|` and chomping. */
const BLOCK_INDICATORS = new Set([">", "|", ">-", "|-", ">+", "|+"]);

export function parseSkillFrontmatter(markdown: string): FrontmatterResult {
  const withoutBom = markdown.replace(/^\uFEFF/, "");
  const lines = withoutBom.split(/\r?\n/);

  if ((lines[0] ?? "").trim() !== FENCE) {
    return fail(
      "missing-frontmatter",
      "SKILL.md must start with a --- frontmatter block",
    );
  }

  let closingIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === FENCE) {
      closingIndex = i;
      break;
    }
  }
  if (closingIndex < 0) {
    return fail(
      "unterminated-frontmatter",
      "Frontmatter block is never closed with ---",
    );
  }

  const fields = parseFields(lines.slice(1, closingIndex));
  if (!fields.ok) {
    return fields;
  }

  const name = fields.scalars.get("name") ?? fields.blocks.get("name")?.text;
  const description =
    fields.scalars.get("description") ?? fields.blocks.get("description")?.text;

  if (!name || name.trim().length === 0) {
    return fail("missing-name", "Frontmatter must define a non-empty name");
  }
  if (!description || description.trim().length === 0) {
    return fail(
      "missing-description",
      "Frontmatter must define a non-empty description",
    );
  }

  // The server reads `triggers` as a keyword list; a plain string makes the
  // skill unloadable, so reject it here where the message can be specific.
  if (fields.scalars.has("triggers") && !fields.lists.has("triggers")) {
    return fail(
      "triggers-not-list",
      'The "triggers" field must be a list of keywords, not a single string',
      fields.lines.get("triggers"),
    );
  }

  return {
    ok: true,
    frontmatter: {
      name: name.trim(),
      description: description.trim(),
    },
  };
}

type ParsedFields =
  | {
      ok: true;
      scalars: Map<string, string>;
      blocks: Map<string, { style: ">" | "|"; text: string }>;
      lists: Map<string, string[]>;
      /** Key -> 1-based SKILL.md line number, for precise error messages. */
      lines: Map<string, number>;
    }
  | { ok: false; code: FrontmatterErrorCode; message: string; line?: number };

function parseFields(blockLines: string[]): ParsedFields {
  const scalars = new Map<string, string>();
  const blocks = new Map<string, { style: ">" | "|"; text: string }>();
  const lists = new Map<string, string[]>();
  const lines = new Map<string, number>();

  /** Key of the `key:` line a following `- item` block belongs to. */
  let listKey: string | null = null;

  for (let i = 0; i < blockLines.length; i += 1) {
    const line = blockLines[i];
    // blockLines[0] is the second line of the file (line 1 is the opening ---).
    const fileLine = i + 2;

    if (line.trim().length === 0) {
      continue;
    }

    if (/^\s/.test(line)) {
      const item = LIST_ITEM.exec(line);
      if (item !== null && listKey !== null) {
        lists.get(listKey)?.push(unquote(item[1].trim()));
        continue;
      }
      return fail(
        "invalid-line",
        `Unexpected indented line in frontmatter: "${line}"`,
        fileLine,
      );
    }

    listKey = null;

    const match = KEY_LINE.exec(line);
    if (!match) {
      return fail(
        "invalid-line",
        `Cannot parse frontmatter line: "${line}"`,
        fileLine,
      );
    }
    const key = match[1];
    const raw = match[2].trim();
    lines.set(key, fileLine);

    if (raw.length === 0) {
      // `key:` with nothing after it — either a sequence follows or the value
      // is genuinely empty (caught later for name/description).
      lists.set(key, []);
      listKey = key;
      continue;
    }

    if (BLOCK_INDICATORS.has(raw)) {
      const style = raw.startsWith(">") ? ">" : "|";
      const collected: string[] = [];
      i += 1;
      while (
        i < blockLines.length &&
        (blockLines[i].startsWith(" ") ||
          blockLines[i].startsWith("\t") ||
          blockLines[i].trim().length === 0)
      ) {
        if (blockLines[i].trim().length > 0) {
          collected.push(blockLines[i].trim());
        }
        i += 1;
      }
      i -= 1; // the outer loop increments again
      const joiner = style === ">" ? " " : "\n";
      blocks.set(key, { style, text: collected.join(joiner) });
      continue;
    }

    const quoted =
      raw.length >= 2 &&
      (raw[0] === '"' || raw[0] === "'") &&
      raw.endsWith(raw[0]);
    const value = quoted ? unquote(raw) : raw;

    if (!quoted && /:(\s|$)/.test(raw)) {
      return fail(
        "unquoted-colon",
        `Frontmatter value for "${key}" contains an unquoted ": "; ` +
          "YAML would parse it as a nested mapping — wrap the value in quotes " +
          "or use a > block scalar",
        fileLine,
      );
    }

    if (
      !quoted &&
      (value.startsWith("[") ||
        value.startsWith("{") ||
        value.startsWith("&") ||
        value.startsWith("*"))
    ) {
      return fail(
        "invalid-line",
        `Frontmatter value for "${key}" uses unsupported YAML syntax; use a plain scalar`,
        fileLine,
      );
    }

    scalars.set(key, value);
  }

  return { ok: true, scalars, blocks, lists, lines };
}

function unquote(value: string): string {
  if (value.length < 2) {
    return value;
  }
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
    return value.slice(1, -1);
  }
  return value;
}

function fail(
  code: FrontmatterErrorCode,
  message: string,
  line?: number,
): { ok: false; code: FrontmatterErrorCode; message: string; line?: number } {
  return { ok: false, code, message, line };
}
