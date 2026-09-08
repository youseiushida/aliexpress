import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  epsswFrom,
  fieldsIn,
  normalizeCookieHeader,
  REQUIRED_FIELDS,
  spliceEpssw,
} from "../../src/baxia.ts";

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

Deno.test("a value that never resolves to JSON counts as nothing", () => {
  // Reporting the field names a broken value happens to contain would call it
  // complete and hand back a cookie that only fails at the request. Better to
  // treat unreadable as empty and let the mint keep waiting.
  const broken = "_baxia_sec_cookie_=%E0%A4%A" + JSON.stringify({ lwrid: 1 });
  assertEquals(fieldsIn(broken), []);
});

Deno.test("a double-encoded value is read, then emitted single-encoded", () => {
  // JSDOM's cookie store re-encodes on read, so the value comes back as
  // `%257B%2522lwrid…` where a browser sends `%7B%22lwrid…`. AliExpress decodes
  // exactly once, so the doubled form arrives as `%7B%22lwrid…` — not JSON.
  // Reading it is fine; emitting it is not.
  const once = header(REQUIRED_FIELDS);
  const twice = once.replace(
    /_baxia_sec_cookie_=([^;]*)/,
    (_, v) => `_baxia_sec_cookie_=${encodeURIComponent(v)}`,
  );

  assertEquals(fieldsIn(twice).length, 4);
  assertEquals(normalizeCookieHeader(twice), once);
  // Already-correct values must pass through unchanged.
  assertEquals(normalizeCookieHeader(once), once);
});

Deno.test("epsswFrom accepts a bare value or a whole cookie header", () => {
  const cookie = header(REQUIRED_FIELDS);
  const value = cookie.match(/_baxia_sec_cookie_=([^;]*)/)![1];
  assertEquals(epsswFrom(cookie), "value-for-epssw");
  assertEquals(epsswFrom(value), "value-for-epssw");
});

Deno.test("epsswFrom rejects input it cannot read", () => {
  assertThrows(() => epsswFrom("not a cookie"));
  // A cookie without the field must not silently yield undefined.
  assertThrows(() => epsswFrom(header(["lwrid", "tfstk", "lwrtk"])));
});

Deno.test("spliceEpssw swaps only that field", () => {
  // The one field AliExpress validates, established by swapping each in turn
  // between a working browser cookie and a refused minted one.
  const spliced = spliceEpssw(header(REQUIRED_FIELDS), "from-a-real-browser");
  const fields = JSON.parse(
    decodeURIComponent(spliced.match(/_baxia_sec_cookie_=([^;]*)/)![1]),
  );
  assertEquals(fields.epssw, "from-a-real-browser");
  assertEquals(fields.lwrid, "value-for-lwrid");
  assertEquals(fields.tfstk, "value-for-tfstk");
  assertEquals(fields.lwrtk, "value-for-lwrtk");
  // Neighbouring cookies must survive untouched.
  assert(spliced.startsWith("ali_apache_id=x;"));
  assert(spliced.endsWith("xman_f=y"));
});
