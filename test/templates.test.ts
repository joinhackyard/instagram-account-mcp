import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { IgError } from "../src/errors.js";
import {
  applyCaptionTemplate,
  checkCaption,
  countHashtags,
  countMentions,
  TemplateStore,
  type Template,
} from "../src/templates.js";

const hackyard: Template = {
  name: "hackyard",
  description: "",
  caption_footer: "Find your people. hackyard.org",
  hashtags: ["Hackyard", "#builders"],
  mentions: ["the.hackyard"],
  guidance: "calm",
};

test("checkCaption: Instagram's hard limits", () => {
  assert.deepEqual(checkCaption("Fine caption #one @two"), []);
  assert.match(checkCaption("x".repeat(2201)).join(), /2201 characters/);
  const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" ");
  assert.match(checkCaption(tags).join(), /31 hashtags/);
  const mentions = Array.from({ length: 21 }, (_, i) => `@u${i}`).join(" ");
  assert.match(checkCaption(mentions).join(), /21 @mentions/);
  assert.equal(countHashtags("a#b #c #d_e"), 2, "a#b is not a hashtag");
  assert.equal(countMentions("mail me@x.com @real"), 1, "emails are not mentions");
  assert.equal(checkCaption("é".repeat(2200)).length, 0, "counts characters, not bytes");
});

test("applyCaptionTemplate: footer, mentions and hashtags, without duplicates", () => {
  const r = applyCaptionTemplate("We shipped it.\n\n#builders", hackyard);
  assert.equal(
    r.caption,
    "We shipped it.\n\n#builders\n\nFind your people. hackyard.org\n@the.hackyard\n\n#Hackyard",
  );
  assert.equal(r.first_comment, undefined);
  const again = applyCaptionTemplate(r.caption, hackyard);
  assert.equal(again.caption, r.caption, "applying twice changes nothing");
  assert.deepEqual(applyCaptionTemplate("  plain  ").caption, "plain");
});

test("applyCaptionTemplate: hashtags in the first comment", () => {
  const r = applyCaptionTemplate("Hook line", {
    ...hackyard,
    hashtags_in: "first_comment",
    first_comment: "Credits: Utpal",
  });
  assert.ok(!r.caption.includes("#Hackyard"));
  assert.equal(r.first_comment, "Credits: Utpal\n\n#Hackyard #builders");
});

test("applyCaptionTemplate: trims template hashtags to stay under 30, rejects real violations", () => {
  const own = Array.from({ length: 29 }, (_, i) => `#own${i}`).join(" ");
  const r = applyCaptionTemplate(`Hook\n\n${own}`, hackyard);
  assert.equal(countHashtags(r.caption), 30);
  assert.match(r.warnings.join(), /Dropped 1 template hashtag/);
  assert.throws(
    () => applyCaptionTemplate("x".repeat(2200), hackyard),
    (e: unknown) => e instanceof IgError && e.code === "invalid_request",
  );
  const long = applyCaptionTemplate(`${"word ".repeat(40)}\nrest`);
  assert.equal(long.warnings.length, 0, "no template, no craft warnings");
  const warned = applyCaptionTemplate(`${"word ".repeat(40)}\nrest`, hackyard);
  assert.match(warned.warnings.join(), /first line/);
});

test("TemplateStore: files, extends merge, save, delete", () => {
  const dir = mkdtempSync(join(tmpdir(), "igm-tpl-"));
  writeFileSync(
    join(dir, "brand.json"),
    JSON.stringify([
      hackyard,
      {
        name: "build2026",
        extends: "hackyard",
        hashtags: ["Build2026"],
        caption_footer: "Hackyard Build 2026",
        guidance: "event",
      },
      { name: "bad name!", hashtags: [] },
    ]),
  );
  const store = new TemplateStore(dir);
  const names = store.list().map((t) => t.name);
  assert.ok(names.includes("reel") && names.includes("hackyard") && names.includes("build2026"));
  assert.ok(!names.includes("bad name!"), "invalid templates are skipped");
  const b = store.get("build2026");
  assert.deepEqual(b.hashtags, ["Hackyard", "#builders", "Build2026"]);
  assert.equal(b.caption_footer, "Hackyard Build 2026");
  assert.deepEqual(b.mentions, ["the.hackyard"]);
  assert.equal(b.guidance, "calm\nevent");
  assert.equal(b.extends, undefined);
  assert.throws(() => store.get("nope"), /No template named "nope"/);

  store.save({ name: "solo", description: "x", first_comment: "hi" });
  assert.equal(store.get("solo").first_comment, "hi");
  store.delete("solo");
  assert.throws(() => store.get("solo"));
  assert.throws(() => store.delete("hackyard"), /No saved template file/);
  assert.throws(() => store.save({ name: "loop", description: "", extends: "loop" } as Template));
});
