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
 *   ---
 *
 * Supported value forms: plain scalars, single/double quoted scalars, and
 * `>` / `|` block scalars (with an optional chomping indicator). Unknown keys
 * are ignored but their block scalars are consumed correctly.
 */

export interface SkillFrontmatter {
  name: string;
  description: string;
}

export type FrontmatterErrorCode =
  | "missing-frontmatter"
  | "unterminated-frontmatter"
  | "invalid-line"
  | "missing-name"
  | "missing-description";

export type FrontmatterResult =
  | { ok: true; frontmatter: SkillFrontmatter }
  | { ok: false; code: FrontmatterErrorCode; message: string };

const FENCE = "---";

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
    }
  | { ok: false; code: FrontmatterErrorCode; message: string };

function parseFields(blockLines: string[]): ParsedFields {
  const scalars = new Map<string, string>();
  const blocks = new Map<string, { style: ">" | "|"; text: string }>();

  for (let i = 0; i < blockLines.length; i += 1) {
    const line = blockLines[i];
    if (line.trim().length === 0) {
      continue;
    }
    if (/^\s/.test(line)) {
      return fail(
        "invalid-line",
        `Unexpected indented line in frontmatter: "${line}"`,
      );
    }

    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s?(.*)$/.exec(line);
    if (!match) {
      return fail("invalid-line", `Cannot parse frontmatter line: "${line}"`);
    }
    const key = match[1];
    let value = match[2].trim();

    if (
      value === ">" ||
      value === "|" ||
      value === ">-" ||
      value === "|-" ||
      value === ">+" ||
      value === "|+"
    ) {
      const style = value.startsWith(">") ? ">" : "|";
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

    if (value.length >= 2) {
      const quote = value[0];
      if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
        value = value.slice(1, -1);
      }
    }

    if (
      value.startsWith("[") ||
      value.startsWith("{") ||
      value.startsWith("&") ||
      value.startsWith("*")
    ) {
      return fail(
        "invalid-line",
        `Frontmatter value for "${key}" uses unsupported YAML syntax; use a plain scalar`,
      );
    }

    scalars.set(key, value);
  }

  return { ok: true, scalars, blocks };
}

function fail(
  code: FrontmatterErrorCode,
  message: string,
): { ok: false; code: FrontmatterErrorCode; message: string } {
  return { ok: false, code, message };
}
