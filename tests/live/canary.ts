/**
 * Live canary.
 *
 * Answers the only question the offline suite cannot: does this library still
 * work against the real AliExpress today? It runs the same code path a user
 * would, then checks that normalization still produces populated fields rather
 * than a page of well-formed nulls.
 *
 * The two ways this can fail need opposite responses, so they get distinct exit
 * codes:
 *
 * - `3` BLOCKED — AliExpress served an anti-bot challenge and nothing could be
 *   exercised. Says nothing about the library. CI should shrug this off.
 * - `4` SCHEMA_DRIFT — requests succeeded but fields we depend on stopped
 *   arriving. The normalizer needs updating, and someone should be told.
 *
 * Blocking is tracked per check rather than for the run as a whole. The MTOP
 * detail gateway is rate limited far more aggressively than search is, and an
 * early version of this file let one throttled detail request discard five
 * passing search results. A canary that throws away what it did learn is worse
 * than no canary.
 *
 * Run directly:
 * ```
 * deno run --allow-net --allow-env tests/live/canary.ts
 * ```
 *
 * @module
 */

import { AliExpress } from "../../mod.ts";
import { AliBlockedError, AliError, EXIT_CODES } from "../../src/errors.ts";
import { assertCoverage, type FieldCoverage, formatCoverage } from "../support/coverage.ts";

/** Queries kept broad on purpose, so a niche term going quiet is not a failure. */
const QUERY = Deno.env.get("AE_CANARY_QUERY") ?? "usb cable";

/**
 * Minimum share of results that must carry each field.
 *
 * Calibrated against live responses, then given headroom. Pricing sits far
 * below 1 on purpose: AliExpress omits the price block entirely on a fifth of
 * listings (observed 77-82% populated live, 67% in the frozen fixture), so the
 * threshold is set to catch "pricing stopped arriving", which reads as roughly
 * 0%, rather than "some listings have no price", which is normal.
 */
const SEARCH_COVERAGE = {
  id: 1,
  title: 1,
  url: 1,
  image: 0.95,
  // The gallery array is thinner than the primary image: some listings ship
  // only one photo. `image` above is the real "did imagery survive" signal.
  images: 0.7,
  "price.current.value": 0.6,
  "price.current.currency": 0.6,
  rating: 0.6,
  orders: 0.6,
} as const;

const DETAIL_COVERAGE = {
  title: 1,
  images: 1,
  "price.current.value": 1,
  rating: 1,
  "store.name": 1,
  attributes: 1,
  skus: 1,
} as const;

export type CheckStatus = "pass" | "fail" | "blocked";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  coverage?: FieldCoverage[];
}

export async function runCanary(): Promise<CheckResult[]> {
  // Paced well below the library default. This runs once a day with no latency
  // pressure, and a spurious block teaches everyone to ignore the one workflow
  // whose whole job is to be believed.
  const ae = new AliExpress({
    locale: "ja_JP",
    currency: "JPY",
    country: "JP",
    minRequestInterval: 2500,
    // Lets a maintainer exercise the detail check from a machine AliExpress has
    // already flagged, instead of waiting for the flag to lapse.
    cookie: Deno.env.get("ALIEXPRESS_COOKIE"),
  });

  const results: CheckResult[] = [];

  /** Record an assertion. Anything it throws is drift, not a transport problem. */
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

  /**
   * Fetch the input for a group of checks.
   *
   * Returns `null` when AliExpress refuses, which lets the caller skip the
   * checks that needed it while every other check still runs and reports.
   */
  const fetchFor = async <T>(name: string, run: () => Promise<T>): Promise<T | null> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof AliBlockedError) {
        results.push({ name, status: "blocked", detail: error.message });
        return null;
      }
      throw error;
    }
  };

  // 1. Search still returns a full page of normalizable products.
  const page1 = await fetchFor("search", () => ae.search(QUERY));
  if (page1) {
    check("search returns a full page", () => {
      if (page1.items.length < 20) {
        throw new Error(`expected a full page, got ${page1.items.length} items`);
      }
      return { detail: `${page1.items.length} items, total=${page1.total ?? "unknown"}` };
    });

    check("search fields survive normalization", () => ({
      detail: `${page1.items.length} items checked`,
      coverage: assertCoverage("search", page1.items, SEARCH_COVERAGE),
    }));

    // 2. Filters and sorts stay discoverable, since the CLI advertises them.
    check("refinements are discoverable", () => {
      const params = new Set(page1.filters.map((group) => group.param));
      const sorts = page1.sorts.map((sort) => sort.value);
      if (!params.has("selectedSwitches")) {
        throw new Error(`no selectedSwitches filter group; found ${[...params].join(", ")}`);
      }
      if (!sorts.includes("price_asc")) {
        throw new Error(`no price_asc sort; found ${sorts.join(", ")}`);
      }
      return { detail: `filters=${[...params].join(",")} sorts=${sorts.join(",")}` };
    });
  }

  // 3. Paging still moves. If `page` were silently ignored we would quietly
  //    return the first page forever, which no assertion on page 1 would catch.
  const page2 = page1 ? await fetchFor("paging", () => ae.search(QUERY, { page: 2 })) : null;
  if (page1 && page2) {
    check("paging advances", () => {
      if (page2.page !== 2) {
        throw new Error(`requested page 2 but the response reports page ${page2.page}`);
      }
      const ids = new Set(page1.items.map((item) => item.id));
      const fresh = page2.items.filter((item) => !ids.has(item.id)).length;
      if (fresh === 0) {
        throw new Error("page 2 repeated page 1 exactly — the page parameter is being ignored");
      }
      return { detail: `${fresh}/${page2.items.length} items on page 2 are new` };
    });
  }

  // 4. Sorting still applies. Same reasoning: an ignored parameter is invisible
  //    unless the resulting order is actually checked.
  const byPrice = await fetchFor("price sort", () => ae.search(QUERY, { sort: "price_asc" }));
  if (byPrice) {
    check("price sort applies", () => {
      const prices = byPrice.items
        .map((item) => item.price?.current.value)
        .filter((value): value is number => value !== undefined);
      if (prices.length < 5) throw new Error(`only ${prices.length} priced items to compare`);
      const ascending = prices.every((value, index) => index === 0 || prices[index - 1] <= value);
      if (!ascending) {
        throw new Error(`prices are not ascending: ${prices.slice(0, 8).join(", ")}`);
      }
      return { detail: `cheapest ${prices.slice(0, 3).join(", ")}` };
    });
  }

  const byOrders = await fetchFor("orders sort", () => ae.search(QUERY, { sort: "orders" }));
  if (byOrders) {
    check("orders sort applies", () => {
      const counts = byOrders.items
        .map((item) => item.orders)
        .filter((count): count is number => count !== null);
      if (counts.length < 5) throw new Error(`only ${counts.length} items report order counts`);
      const descending = counts.every((count, index) => index === 0 || counts[index - 1] >= count);
      if (!descending) {
        throw new Error(`order counts are not descending: ${counts.slice(0, 8).join(", ")}`);
      }
      return { detail: `best sellers ${counts.slice(0, 3).join(", ")}` };
    });
  }

  // 5. Product detail, including the MTOP signature handshake.
  //
  //    MTOP is gated far harder than search: it answers RGV587_ERROR after a
  //    modest number of calls even when search is entirely healthy. Losing this
  //    check must not cost us the search results above.
  if (page1) {
    const target = page1.items.find((item) => item.price !== null) ?? page1.items[0];
    const detail = await fetchFor("product detail", () => ae.product(target.id));
    if (detail) {
      check("product detail resolves", () => ({
        detail: `${detail.id} "${detail.title.slice(0, 40)}" skus=${detail.skus.length}`,
        coverage: assertCoverage("detail", [detail], DETAIL_COVERAGE),
      }));
    }
  }

  return results;
}

/** Render a run as GitHub-flavoured Markdown for the workflow summary. */
export function formatReport(results: readonly CheckResult[]): string {
  const label = { pass: "PASS", fail: "FAIL", blocked: "BLOCKED" };
  const lines = ["| | check | detail |", "|---|---|---|"];
  for (const result of results) {
    lines.push(`| ${label[result.status]} | ${result.name} | ${result.detail} |`);
  }
  const coverage = results
    .filter((result) => result.coverage)
    .map((result) => `\n**${result.name}**\n\n\`\`\`\n${formatCoverage(result.coverage!)}\n\`\`\``);
  return [...lines, ...coverage].join("\n");
}

/**
 * Turn a run into an exit code.
 *
 * Drift outranks blocking: if anything actually broke, that is the headline
 * even when other checks could not run. A run that learned nothing at all is
 * blocked; a run where some checks passed is a pass, with the blocked ones
 * named in the report.
 */
export function exitCodeFor(results: readonly CheckResult[]): number {
  if (results.some((result) => result.status === "fail")) return EXIT_CODES.SCHEMA_DRIFT;
  if (!results.some((result) => result.status === "pass")) return EXIT_CODES.BLOCKED;
  return EXIT_CODES.OK;
}

if (import.meta.main) {
  let results: CheckResult[] = [];
  let exitCode: number;

  try {
    results = await runCanary();
    exitCode = exitCodeFor(results);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ name: "canary run", status: "fail", detail: message });
    exitCode = error instanceof AliError ? error.exitCode : EXIT_CODES.GENERAL;
  }

  const report = formatReport(results);
  console.log(report);

  const blocked = results.filter((result) => result.status === "blocked");
  if (blocked.length > 0) {
    console.error(
      `\n${blocked.length} check(s) could not run — AliExpress refused them: ` +
        `${blocked.map((result) => result.name).join(", ")}`,
    );
  }

  const summaryPath = Deno.env.get("GITHUB_STEP_SUMMARY");
  if (summaryPath) {
    await Deno.writeTextFile(summaryPath, `## AliExpress canary\n\n${report}\n`, { append: true });
  }

  Deno.exit(exitCode);
}
