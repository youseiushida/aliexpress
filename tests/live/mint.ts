/**
 * Live test for the optional `./baxia` recovery path.
 *
 * Kept out of the main canary because it needs JSDOM from npm, which the core
 * library does not. Run it when that entry point matters:
 *
 * ```
 * deno run -A --node-modules-dir=auto tests/live/mint.ts
 * ```
 *
 * Exit codes match the canary's: 0 pass, 3 nothing could be exercised, 4 the
 * behaviour we depend on changed.
 *
 * What it pins down is the part that is easy to get subtly wrong: the cookie is
 * assembled field by field, a partial value appears within a second, and the
 * gateway rejects partial values. A mint that returns too early looks like a
 * success and fails at the point of use.
 *
 * @module
 */

import { AliExpress } from "../../mod.ts";
import { mintSessionCookie } from "../../src/baxia.ts";
import { AliBlockedError, EXIT_CODES } from "../../src/errors.ts";
import { type CheckResult, exitCodeFor, formatReport } from "./canary.ts";

const REQUIRED_FIELDS = ["lwrid", "tfstk", "lwrtk", "epssw"];
const PRODUCT = "1005008812285251";
const SECOND_PRODUCT = "1005010439254805";

/** How many times to mint, since a one-off success proves little. */
const MINT_ROUNDS = 3;

function fieldsIn(cookie: string): string[] {
  const value = cookie.match(/_baxia_sec_cookie_=([^;]*)/)?.[1] ?? "";
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch { /* keep raw */ }
  return REQUIRED_FIELDS.filter((field) => decoded.includes(field));
}

const results: CheckResult[] = [];

const check = (name: string, body: () => Omit<CheckResult, "name" | "status">): void => {
  try {
    results.push({ name, status: "pass", ...body() });
  } catch (error) {
    results.push({
      name,
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
};

async function fetchFor<T>(name: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AliBlockedError) {
      results.push({ name, status: "blocked", detail: error.message });
      return null;
    }
    results.push({
      name,
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// 1. Minting works, repeatably, and returns a COMPLETE cookie every time.
const mints: { cookie: string; fields: string[]; seconds: number }[] = [];
for (let round = 1; round <= MINT_ROUNDS; round++) {
  const started = performance.now();
  const cookie = await fetchFor(`mint ${round}`, () => mintSessionCookie());
  if (!cookie) continue;
  mints.push({
    cookie,
    fields: fieldsIn(cookie),
    seconds: (performance.now() - started) / 1000,
  });
}

if (mints.length > 0) {
  check("every mint yields a complete cookie", () => {
    const short = mints.filter((m) => m.fields.length !== REQUIRED_FIELDS.length);
    if (short.length > 0) {
      throw new Error(
        `${short.length}/${mints.length} mints were incomplete — ` +
          `best had [${short[0].fields.join(",")}], need [${REQUIRED_FIELDS.join(",")}]`,
      );
    }
    const times = mints.map((m) => m.seconds.toFixed(1)).join("s, ");
    return { detail: `${mints.length}/${MINT_ROUNDS} complete in ${times}s` };
  });

  check("mints are not suspiciously identical", () => {
    // Two mints producing byte-identical values would mean we are replaying a
    // cached token rather than generating one, which would expire silently.
    const values = new Set(mints.map((m) => m.cookie.match(/_baxia_sec_cookie_=([^;]*)/)?.[1]));
    if (mints.length > 1 && values.size === 1) {
      throw new Error("every mint returned the same value — nothing is actually being generated");
    }
    return { detail: `${values.size} distinct values from ${mints.length} mints` };
  });

  // 2. A minted cookie is accepted where an absent one is refused.
  const detail = await fetchFor("detail with minted cookie", () => {
    const ae = new AliExpress({
      locale: "ja_JP",
      currency: "JPY",
      country: "JP",
      cookie: mints[0].cookie,
    });
    return ae.product(PRODUCT);
  });
  if (detail) {
    check("minted cookie is accepted by the gateway", () => {
      if (detail.id !== PRODUCT) throw new Error(`asked for ${PRODUCT}, got ${detail.id}`);
      if (!detail.title) throw new Error("detail came back without a title");
      return { detail: `${detail.title.slice(0, 40)} — ${detail.price?.current.formatted}` };
    });
  }
}

// 3. The integration that actually matters: a client with no cookie recovers by
//    itself. This is what `cookieProvider` promises.
const recovered = await fetchFor("automatic recovery", () => {
  const ae = new AliExpress({
    locale: "ja_JP",
    currency: "JPY",
    country: "JP",
    cookieProvider: mintSessionCookie,
  });
  return ae.products([PRODUCT, SECOND_PRODUCT]);
});
if (recovered) {
  check("cookieProvider recovers a flagged client", () => {
    if (recovered.length !== 2) throw new Error(`expected 2 products, got ${recovered.length}`);
    for (const product of recovered) {
      if (!product.title) throw new Error(`${product.id} came back without a title`);
      if (!product.price) throw new Error(`${product.id} came back without a price`);
    }
    return {
      detail: recovered.map((p) => `${p.id} ${p.price?.current.formatted}`).join("; "),
    };
  });
}

// The completeness rule itself is pinned offline in tests/unit — forcing a
// partial mint here would mean tearing the DOM down mid-load, which tests
// JSDOM's resilience rather than ours.

const report = formatReport(results);
console.log(report);

const blocked = results.filter((r) => r.status === "blocked");
if (blocked.length > 0) {
  console.error(
    `\n${blocked.length} check(s) could not run: ${blocked.map((r) => r.name).join(", ")}`,
  );
}

const summaryPath = Deno.env.get("GITHUB_STEP_SUMMARY");
if (summaryPath) {
  await Deno.writeTextFile(summaryPath, `## Baxia mint\n\n${report}\n`, { append: true });
}

Deno.exit(results.length === 0 ? EXIT_CODES.BLOCKED : exitCodeFor(results));
