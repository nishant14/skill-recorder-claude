import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_NARRATION_LANGUAGE,
  isNarrationLanguage,
  NARRATION_LANGUAGES,
  narrationLanguageLabel,
} from "./narration";

test("narration exposes all 99 supported languages alphabetically with English as the default", () => {
  const codes = NARRATION_LANGUAGES.map(({ code }) => code);
  const labels = NARRATION_LANGUAGES.map(({ label }) => label);

  assert.equal(NARRATION_LANGUAGES.length, 99);
  assert.equal(new Set(codes).size, NARRATION_LANGUAGES.length);
  assert.deepEqual(labels, [...labels].sort((left, right) => left.localeCompare(right, "en")));
  assert.equal(DEFAULT_NARRATION_LANGUAGE, "en");
  assert.equal(narrationLanguageLabel(DEFAULT_NARRATION_LANGUAGE), "English");
  assert.equal(isNarrationLanguage("haw"), true);
  assert.equal(isNarrationLanguage("xx"), false);
});
