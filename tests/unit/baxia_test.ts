import { assert, assertEquals } from "@std/assert";
import { fieldsIn, REQUIRED_FIELDS } from "../../src/baxia.ts";

/**
 * Offline tests for the cookie-completeness rule.
 *
 * This rule is the whole reason the mint does not simply return as soon as a
 * cookie exists. AliExpress builds the value field by field: a one-field value
 * appears within a second, and a three-field one missing `epssw` was minted and
 * rejected by the gateway. Returning early therefore produces a cookie that
 * looks fine and fails later, at the request — the worst kind of bug to debug.
 *
 * Importing this module does not load JSDOM: the dependency is imported lazily
 * inside `mintSessionCookie`, which these tests never call.
 */

/** Shape a real cookie header the way AliExpress writes it. */
function header(fields: readonly string[]): string {
  const payload = JSON.stringify(
    Object.fromEntries(fields.map((field) => [field, "value-for-" + field])),
  );
  return `ali_apache_id=x; _baxia_sec_cookie_=${encodeURIComponent(payload)}; xman_f=y`;
}

Deno.test("REQUIRED_FIELDS lists every field the gateway needs", () => {
  assertEquals([...REQUIRED_FIELDS], ["lwrid", "tfstk", "lwrtk", "epssw"]);
});

Deno.test("fieldsIn reports a complete cookie as complete", () => {
  assertEquals(fieldsIn(header(REQUIRED_FIELDS)).length, REQUIRED_FIELDS.length);
});

Deno.test("fieldsIn sees through the URL encoding AliExpress uses", () => {
  // The real value is percent-encoded JSON; reading it raw would miss fields.
  const encoded = header(REQUIRED_FIELDS);
  assert(encoded.includes("%22"), "the fixture should be percent-encoded like the real thing");
  assertEquals(fieldsIn(encoded).length, 4);
});

Deno.test("fieldsIn detects the partial values the gateway rejects", () => {
  // Observed live: this is what a mint that returns too early looks like.
  assertEquals(fieldsIn(header(["lwrid"])), ["lwrid"]);
  assertEquals(fieldsIn(header(["lwrid", "tfstk", "lwrtk"])), ["lwrid", "tfstk", "lwrtk"]);
  // The three-field value above was minted for real and refused, so anything
  // short of the full set must not count as done.
  assert(fieldsIn(header(["lwrid", "tfstk", "lwrtk"])).length < REQUIRED_FIELDS.length);
});

Deno.test("fieldsIn returns nothing when the cookie is absent or malformed", () => {
  assertEquals(fieldsIn(""), []);
  assertEquals(fieldsIn("ali_apache_id=x; xman_f=y"), []);
  assertEquals(fieldsIn("_baxia_sec_cookie_="), []);
});

Deno.test("fieldsIn survives a value that is not valid percent-encoding", () => {
  // A truncated value must degrade to "incomplete", never throw mid-mint.
  const broken = "_baxia_sec_cookie_=%E0%A4%A" + JSON.stringify({ lwrid: 1 });
  assertEquals(fieldsIn(broken), ["lwrid"]);
});
