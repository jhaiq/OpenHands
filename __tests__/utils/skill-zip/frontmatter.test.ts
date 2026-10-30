import { describe, expect, it } from "vitest";

import { parseSkillFrontmatter } from "#/utils/skill-zip/frontmatter";

const VALID = `---
name: my-skill
description: Does useful things.
---

# My Skill

Body content here.
`;

describe("parseSkillFrontmatter", () => {
  it("parses plain scalar name and description", () => {
    const result = parseSkillFrontmatter(VALID);

    expect(result).toEqual({
      ok: true,
      frontmatter: {
        name: "my-skill",
        description: "Does useful things.",
      },
    });
  });

  it("strips a leading BOM and accepts CRLF line endings", () => {
    const result = parseSkillFrontmatter(
      `\uFEFF---\r\nname: crlf-skill\r\ndescription: Handles windows line endings.\r\n---\r\nbody`,
    );

    expect(result).toMatchObject({
      ok: true,
      frontmatter: {
        name: "crlf-skill",
        description: "Handles windows line endings.",
      },
    });
  });

  it("supports quoted scalars and ignores unknown keys", () => {
    const result = parseSkillFrontmatter(`---
name: "quoted-name"
description: 'single quoted'
license: MIT
version: 2
---

body
`);

    expect(result).toMatchObject({
      ok: true,
      frontmatter: { name: "quoted-name", description: "single quoted" },
    });
  });

  it("joins folded block scalars with spaces", () => {
    const result = parseSkillFrontmatter(`---
name: block-skill
description: >
  First line of the description
  second line continues here.
---

body
`);

    expect(result).toMatchObject({
      ok: true,
      frontmatter: {
        description:
          "First line of the description second line continues here.",
      },
    });
  });

  it("joins literal block scalars with newlines", () => {
    const result = parseSkillFrontmatter(`---
name: literal-skill
description: |
  Line one.
  Line two.
---
`);

    expect(result).toMatchObject({
      ok: true,
      frontmatter: { description: "Line one.\nLine two." },
    });
  });

  it("supports chomping indicators and block scalars for other keys", () => {
    const result = parseSkillFrontmatter(`---
description: plain
name: mixed-skill
instructions: >-
  Long instructions
  folded together.
---

body
`);

    expect(result).toMatchObject({
      ok: true,
      frontmatter: { name: "mixed-skill", description: "plain" },
    });
  });

  it.each([
    ["no frontmatter at all", "missing-frontmatter"],
    ["body without fences", "missing-frontmatter"],
    ["unterminated block", "unterminated-frontmatter"],
    ["missing name", "missing-name"],
    ["missing description", "missing-description"],
  ])("fails on %s", (label, code) => {
    const samples: Record<string, string> = {
      "no frontmatter at all": "just some text",
      "body without fences": "text\n---\nstill body",
      "unterminated block": "---\nname: x\ndescription: y\n",
      "missing name": "---\ndescription: only description\n---\n",
      "missing description": "---\nname: only-name\n---\n",
    };
    const result = parseSkillFrontmatter(samples[label]);

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.code).toBe(code);
  });

  it("rejects empty-string values", () => {
    const result = parseSkillFrontmatter(
      '---\nname: ""\ndescription: ""\n---\n',
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.code).toBe("missing-name");
  });

  it("rejects a structured name instead of silently mis-parsing it", () => {
    const result = parseSkillFrontmatter(
      "---\nname: [a, b]\ndescription: {x: 1}\n---\n",
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.code).toBe("missing-name");
  });

  it("accepts inline sequences and inline mappings", () => {
    const inlineList = parseSkillFrontmatter(
      '---\nname: x\ndescription: d\ntriggers: [develop, "trouble shoot"]\n---\n',
    );
    expect(inlineList.ok).toBe(true);

    const inlineMap = parseSkillFrontmatter(
      "---\nname: x\ndescription: d\nmetadata: {author: me, tier: 2}\n---\n",
    );
    expect(inlineMap.ok).toBe(true);
  });

  it("rejects an inline mapping or scalar for triggers", () => {
    const mapping = parseSkillFrontmatter(
      "---\nname: x\ndescription: d\ntriggers: {a: b}\n---\n",
    );
    expect(mapping.ok).toBe(false);
    expect(mapping.ok ? null : mapping.code).toBe("triggers-not-list");
  });

  it("rejects stray indented lines", () => {
    const result = parseSkillFrontmatter(
      "---\nname: x\n  oops: indented\ndescription: y\n---\n",
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.code).toBe("invalid-line");
  });

  it("accepts a YAML sequence value such as triggers", () => {
    const result = parseSkillFrontmatter(`---
name: list-skill
description: Has keyword triggers.
triggers:
  - develop
  - troubleshoot
---
`);

    expect(result).toMatchObject({
      ok: true,
      frontmatter: { name: "list-skill", description: "Has keyword triggers." },
    });
  });

  it("rejects an unquoted colon inside a plain scalar", () => {
    const result = parseSkillFrontmatter(`---
name: colon-skill
description: Probes first (DRY/BUILD): then acts.
---
`);

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.code).toBe("unquoted-colon");
    expect(result.ok ? null : result.line).toBe(3);
  });

  it("allows colons inside quoted and block scalars", () => {
    const quoted = parseSkillFrontmatter(
      '---\nname: q\ndescription: "Probes first: then acts."\n---\n',
    );
    expect(quoted.ok).toBe(true);

    const block = parseSkillFrontmatter(
      "---\nname: b\ndescription: >\n  Probes first: then acts.\n---\n",
    );
    expect(block.ok).toBe(true);
  });

  it("rejects a scalar triggers value", () => {
    const result = parseSkillFrontmatter(`---
name: scalar-triggers
description: d
triggers: develop / troubleshoot
---
`);

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.code).toBe("triggers-not-list");
    expect(result.ok ? null : result.line).toBe(4);
  });
});
