// Content parity tests: the English and Arabic files must say the same things.
// Rules are policy, so a rule that exists in one language and not the other, or a
// placeholder that got lost in translation, is a real defect, not a cosmetic one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { flatten, placeholders } from "../logic.js";

const load = (lang) => JSON.parse(readFileSync(fileURLToPath(new URL(`../content/${lang}.json`, import.meta.url)), "utf8"));
const en = load("en");
const ar = load("ar");
const flatEn = flatten(en);
const flatAr = flatten(ar);

// Values that are identifiers or config, not translatable text.
const NON_TEXT = /^(meta\.|rules\.\d+\.(id|kind)$|practice_questions\.\d+\.(id|correct)$)/;

test("both languages have exactly the same keys (including array lengths)", () => {
  const onlyEn = Object.keys(flatEn).filter((k) => !(k in flatAr));
  const onlyAr = Object.keys(flatAr).filter((k) => !(k in flatEn));
  assert.deepEqual(onlyEn, [], `missing in ar.json: ${onlyEn.join(", ")}`);
  assert.deepEqual(onlyAr, [], `missing in en.json: ${onlyAr.join(", ")}`);
});

test("no empty strings", () => {
  for (const [lang, flat] of [["en", flatEn], ["ar", flatAr]]) {
    for (const [k, v] of Object.entries(flat)) {
      if (typeof v === "string") assert.ok(v.trim().length > 0, `${lang}: ${k} is empty`);
    }
  }
});

test("same placeholders in every string", () => {
  for (const [k, v] of Object.entries(flatEn)) {
    if (typeof v !== "string" || NON_TEXT.test(k)) continue;
    assert.deepEqual([...placeholders(flatAr[k])].sort(), [...placeholders(v)].sort(), `placeholder mismatch at ${k}`);
  }
});

test("rules: same ids, kinds and order in both languages; ids are unique", () => {
  const sig = (c) => c.rules.map((r) => `${r.id}:${r.kind}:${"if_detected" in r}`);
  assert.deepEqual(sig(ar), sig(en));
  const ids = en.rules.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const r of en.rules) assert.ok(["allowed", "prohibited", "behaviour"].includes(r.kind), r.id);
});

test("practice questions: same ids and correct answers; answer index is valid", () => {
  en.practice_questions.forEach((q, i) => {
    const a = ar.practice_questions[i];
    assert.equal(a.id, q.id);
    assert.equal(a.correct, q.correct, `correct answer differs for ${q.id}`);
    assert.equal(a.options.length, q.options.length);
    assert.ok(q.correct >= 0 && q.correct < q.options.length);
  });
});

test("identifiers and config are NOT translated", () => {
  for (const k of Object.keys(flatEn)) {
    if (/^rules\.\d+\.(id|kind)$|^practice_questions\.\d+\.id$/.test(k)) assert.equal(flatAr[k], flatEn[k], k);
  }
  assert.equal(ar.meta.content_version, en.meta.content_version, "content versions must move together");
  assert.equal(ar.meta.policy_status, en.meta.policy_status);
});

test("meta: direction, language and pinned number locale", () => {
  assert.equal(en.meta.dir, "ltr");
  assert.equal(ar.meta.dir, "rtl");
  assert.equal(ar.meta.lang, "ar");
  assert.match(ar.meta.number_locale, /-u-nu-(latn|arab)$/, "Arabic digits must be pinned explicitly (R&D.md D9)");
  assert.notEqual(ar.meta.translation_status, "source", "Arabic must stay flagged until a human reviewer approves it");
});

test("every nudge and proctor alert exists for each practice condition", () => {
  const conditions = ["FACE_MISSING", "OUT_OF_FRAME", "TOO_FAR", "MULTIPLE_FACES", "LOOKING_AWAY", "SPEECH_DETECTED", "PHONE_DETECTED"];
  for (const c of conditions) {
    assert.ok(en.nudges[c], `nudge ${c}`);
    assert.ok(en.proctor_alerts[c], `proctor alert ${c}`);
  }
  for (const c of Object.keys(en.steps.practice.try_items)) assert.ok(conditions.includes(c), c);
});

test("Arabic text contains no leftover English sentences", () => {
  // Brand/product names and bracketed English UI labels are expected; whole
  // English sentences are not. Heuristic: flag strings with 4+ consecutive Latin words.
  for (const [k, v] of Object.entries(flatAr)) {
    if (typeof v !== "string" || NON_TEXT.test(k)) continue;
    const stripped = v.replace(/\([^)]*\)/g, "");
    assert.ok(!/([A-Za-z]+[\s,]+){4,}[A-Za-z]+/.test(stripped), `looks untranslated: ${k}: ${v}`);
  }
});
