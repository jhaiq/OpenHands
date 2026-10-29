import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "#/services/settings";
import { AvailableLanguages } from "#/i18n";

describe("DEFAULT_SETTINGS", () => {
  it("defaults the language to Simplified Chinese and to a selectable option", () => {
    expect(DEFAULT_SETTINGS.language).toBe("zh-CN");
    expect(
      AvailableLanguages.some(
        (lang) => lang.value === DEFAULT_SETTINGS.language,
      ),
    ).toBe(true);
  });
});
