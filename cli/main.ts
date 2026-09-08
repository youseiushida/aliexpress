/**
 * Command line interface.
 *
 * Built for two audiences at once, with the machine one taking priority:
 *
 * - Data goes to stdout, everything else to stderr, so `cmd | jq` is never
 *   polluted by a progress note.
 * - Output is a table on a terminal and JSON when piped, so an agent gets
 *   structured data without having to know to ask.
 * - `--fields` narrows the payload, because an agent pays per token for every
 *   field it did not need.
 * - Exit codes separate "bad input" from "AliExpress blocked us" from
 *   "AliExpress changed shape", so a caller can decide whether retrying,
 *   backing off, or giving up is the right move.
 * - Nothing ever prompts. There is no interactive path to hang on.
 *
 * @module
 */

import { parseArgs } from "@std/cli/parse-args";
import { AliExpress } from "../src/client.ts";
import { AliError, AliValidationError, EXIT_CODES } from "../src/errors.ts";
import type { Product, SortKey } from "../src/types.ts";
import {
  DEFAULT_PRODUCT_FIELDS,
  DEFAULT_SEARCH_FIELDS,
  type OutputFormat,
  render,
  selectFields,
} from "./format.ts";

/** Keep in step with the `version` field in deno.json. */
const VERSION = "0.1.0";

const SORT_KEYS: readonly SortKey[] = [
  "default",
  "orders",
  "price_asc",
  "price_desc",
];

const HELP = `aliexpress ${VERSION} — search AliExpress from the command line

USAGE
  aliexpress <command> [options]

COMMANDS
  search <query>       Search for products
  product <id...>      Fetch full detail for one or more product ids
  filters <query>      List the filters and sorts available for a query
  schema               Print the machine-readable interface description
  help                 Show this text

SEARCH OPTIONS
  --limit <n>          Maximum items to return (default 60, pages as needed)
  --page <n>           First page to read, 1-based (default 1)
  --sort <key>         ${SORT_KEYS.join(" | ")}
  --min-price <n>      Lowest price to include, in the active currency
  --max-price <n>      Highest price to include
  --free-shipping      Only items that ship free
  --four-stars         Only items rated 4 stars and above
  --choice             Only AliExpress Choice listings
  --switch <code>      Raw filter code, repeatable (see: aliexpress filters)

OUTPUT OPTIONS
  --json               Force JSON (the default when stdout is not a terminal)
  --ndjson             One JSON object per line, for streaming
  --table              Force the plain-text table
  --fields <a,b,c>     Dotted field paths to emit; fewer fields, fewer tokens
  --raw                Emit the untouched AliExpress payload instead
  --quiet              Suppress progress notes on stderr

LOCALE OPTIONS
  --locale <l>         Site locale, e.g. ja_JP, en_US (default en_US)
  --currency <c>       ISO 4217 code, e.g. JPY, USD (default USD)
  --country <c>        Shipping destination, e.g. JP, US (default US)

ENVIRONMENT
  ALIEXPRESS_COOKIE    Cookie header to seed the session with. Only needed to
                       recover the product command after AliExpress has flagged
                       this machine; search never needs it. Read from the
                       environment rather than a flag so it stays out of shell
                       history and process listings.

EXIT CODES
  0  success
  1  unexpected error
  2  bad arguments
  3  blocked by AliExpress — back off and retry later, nothing is broken
  4  AliExpress changed its response shape — this tool needs updating

EXAMPLES
  aliexpress search "usb capture card" --limit 20 --sort price_asc
  aliexpress search "usb hub" --locale ja_JP --currency JPY --country JP
  aliexpress search "led strip" --fields id,price.current.value --ndjson
  aliexpress product 1005008812285251 --fields title,skus
  aliexpress filters "usb cable"
`;

/**
 * Machine-readable description of this interface.
 *
 * Exists so an agent can learn the whole surface in one call instead of
 * probing `--help` per subcommand.
 */
const SCHEMA = {
  name: "aliexpress",
  version: VERSION,
  description: "Search AliExpress and read product detail as structured data.",
  commands: {
    search: {
      arguments: [{ name: "query", required: true, type: "string" }],
      options: {
        limit: { type: "number", default: 60 },
        page: { type: "number", default: 1 },
        sort: { type: "string", values: SORT_KEYS },
        "min-price": { type: "number" },
        "max-price": { type: "number" },
        "free-shipping": { type: "boolean" },
        "four-stars": { type: "boolean" },
        choice: { type: "boolean" },
        switch: { type: "string", repeatable: true },
      },
      outputFields: {
        id: "string",
        title: "string",
        url: "string",
        image: "string | null",
        images: "string[]",
        "price.current.value": "number | null",
        "price.current.currency": "string | null",
        "price.current.formatted": "string | null",
        "price.original.value": "number | null",
        "price.discountPct": "number | null",
        rating: "number | null — 0 to 5",
        orders: "number | null — units sold",
        "store.name": "string | null",
        badges: "string[]",
      },
      defaultFields: DEFAULT_SEARCH_FIELDS,
    },
    product: {
      arguments: [{ name: "id", required: true, type: "string", variadic: true }],
      outputFields: {
        id: "string",
        title: "string",
        url: "string",
        images: "string[]",
        "price.current.value": "number | null",
        "price.discountPct": "number | null",
        rating: "number | null",
        reviews: "number | null",
        orders: "number | null",
        stock: "number | null",
        "store.name": "string | null",
        "store.positiveRate": "number | null",
        attributes: "Record<string, string>",
        skus: "{ id, attributes, price, stock, available }[]",
      },
      defaultFields: DEFAULT_PRODUCT_FIELDS,
    },
    filters: {
      arguments: [{ name: "query", required: true, type: "string" }],
      description: "Discover the filter codes accepted by --switch, and the sort keys.",
    },
    schema: { arguments: [], description: "Print this document." },
  },
  globalOptions: {
    json: { type: "boolean", description: "Force JSON output" },
    ndjson: { type: "boolean", description: "One JSON object per line" },
    table: { type: "boolean", description: "Force plain-text table" },
    fields: { type: "string", description: "Comma-separated dotted field paths" },
    raw: { type: "boolean", description: "Emit the untouched upstream payload" },
    quiet: { type: "boolean", description: "Suppress stderr progress notes" },
    locale: { type: "string", default: "en_US" },
    currency: { type: "string", default: "USD" },
    country: { type: "string", default: "US" },
  },
  environment: {
    ALIEXPRESS_COOKIE:
      "Cookie header to seed the session with. Only needed to recover the product command " +
      "after AliExpress has flagged this machine; search never needs it.",
  },
  outputDefault: "JSON when stdout is not a TTY, otherwise a plain-text table",
  exitCodes: {
    "0": "success",
    "1": "unexpected error",
    "2": "bad arguments",
    "3": "blocked by AliExpress; retry later, the tool is not broken",
    "4": "AliExpress changed its response shape; the tool needs updating",
  },
  errorFormat: 'JSON on stderr: { "error": { "code", "message", "hint"? } }',
} as const;

/** Parsed argv. `_` holds the command and its positional arguments. */
type Args = Record<string, unknown> & { _: (string | number)[] };

interface Flags {
  format: OutputFormat;
  fields: string[] | null;
  raw: boolean;
  quiet: boolean;
}

function outputFormat(args: Args): OutputFormat {
  if (args.ndjson) return "ndjson";
  if (args.json) return "json";
  if (args.table) return "table";
  // Piped output is being read by a program; a table would only be in the way.
  return Deno.stdout.isTerminal() ? "table" : "json";
}

function note(flags: Flags, message: string): void {
  if (!flags.quiet) console.error(message);
}

/** Emit records to stdout in the selected shape. */
function emit(
  records: readonly unknown[],
  defaults: readonly string[],
  flags: Flags,
): void {
  if (flags.raw) {
    const raws = records.map((record) => (record as { raw?: unknown }).raw ?? record);
    console.log(JSON.stringify(flags.format === "ndjson" ? raws : raws, null, 2));
    return;
  }
  const fields = flags.fields ?? defaults;
  const rows = records.map((record) => selectFields(record, fields));
  console.log(render(rows, flags.format));
}

function requireNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new AliValidationError(`--${name} must be a number, got "${value}"`);
  }
  return parsed;
}

function asList(value: unknown): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

async function runSearch(
  client: AliExpress,
  args: Args,
  flags: Flags,
): Promise<void> {
  const query = String(args._[1] ?? "").trim();
  if (!query) {
    throw new AliValidationError(
      "search needs a query",
      'Example: aliexpress search "usb capture card"',
    );
  }

  const sort = args.sort === undefined ? undefined : String(args.sort);
  if (sort !== undefined && !SORT_KEYS.includes(sort as SortKey)) {
    throw new AliValidationError(
      `--sort must be one of ${SORT_KEYS.join(", ")}, got "${sort}"`,
    );
  }

  const limit = requireNumber(args.limit, "limit") ?? 60;
  if (limit < 1) throw new AliValidationError(`--limit must be at least 1, got ${limit}`);

  const options = {
    page: requireNumber(args.page, "page") ?? 1,
    sort: sort as SortKey | undefined,
    minPrice: requireNumber(args["min-price"], "min-price"),
    maxPrice: requireNumber(args["max-price"], "max-price"),
    freeShipping: args["free-shipping"] === true,
    fourStarsUp: args["four-stars"] === true,
    choice: args.choice === true,
    switches: asList(args.switch),
  };

  note(flags, `searching "${query}" (limit ${limit})...`);

  // One page covers the common case without paying for a second request.
  if (limit <= 60) {
    const result = await client.search(query, options);
    note(
      flags,
      `${result.total ?? "?"} total matches; showing ${Math.min(limit, result.items.length)}`,
    );
    emit(result.items.slice(0, limit), DEFAULT_SEARCH_FIELDS, flags);
    return;
  }

  const items: Product[] = [];
  for await (const item of client.searchAll(query, { ...options, limit })) {
    items.push(item);
  }
  note(flags, `collected ${items.length} items`);
  emit(items, DEFAULT_SEARCH_FIELDS, flags);
}

async function runProduct(
  client: AliExpress,
  args: Args,
  flags: Flags,
): Promise<void> {
  const ids = args._.slice(1).map(String);
  if (ids.length === 0) {
    throw new AliValidationError(
      "product needs at least one id",
      "Example: aliexpress product 1005008812285251",
    );
  }
  // Check every id up front. Rejecting the tenth id after nine network round
  // trips wastes the caller's time and leaves them with partial output.
  const malformed = ids.filter((id) => !/^\d+$/.test(id));
  if (malformed.length > 0) {
    throw new AliValidationError(
      `Product ids must be numeric; rejected ${malformed.join(", ")}`,
      "Ids look like 1005008812285251 and appear in search results and item URLs.",
    );
  }
  note(flags, `fetching ${ids.length} product(s)...`);
  const details = await client.products(ids);
  emit(details, DEFAULT_PRODUCT_FIELDS, flags);
}

async function runFilters(
  client: AliExpress,
  args: Args,
  flags: Flags,
): Promise<void> {
  const query = String(args._[1] ?? "").trim();
  if (!query) {
    throw new AliValidationError(
      "filters needs a query",
      'Example: aliexpress filters "usb cable"',
    );
  }
  const result = await client.search(query, {});
  const rows = [
    ...result.sorts.map((sort) => ({
      kind: "sort",
      param: "--sort",
      code: sort.value,
      label: sort.label,
    })),
    ...result.filters.flatMap((group) =>
      group.options.map((option) => ({
        kind: "filter",
        param: group.param === "selectedSwitches" ? "--switch" : group.param,
        code: option.value,
        label: `${group.label}: ${option.label}`,
      }))
    ),
  ];
  console.log(render(rows, flags.format));
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv, {
    boolean: [
      "json",
      "ndjson",
      "table",
      "raw",
      "quiet",
      "help",
      "version",
      "free-shipping",
      "four-stars",
      "choice",
    ],
    string: [
      "fields",
      "sort",
      "locale",
      "currency",
      "country",
      "limit",
      "page",
      "min-price",
      "max-price",
      "switch",
    ],
    collect: ["switch"],
    alias: { h: "help", v: "version" },
  });

  const command = String(args._[0] ?? "");

  if (args.version) {
    console.log(VERSION);
    return EXIT_CODES.OK;
  }
  if (args.help || command === "" || command === "help") {
    // Help is a successful answer when asked for, and a usage error otherwise.
    console.log(HELP);
    return command === "" && !args.help ? EXIT_CODES.VALIDATION : EXIT_CODES.OK;
  }
  if (command === "schema") {
    console.log(JSON.stringify(SCHEMA, null, 2));
    return EXIT_CODES.OK;
  }

  const flags: Flags = {
    format: outputFormat(args),
    fields: args.fields ? String(args.fields).split(",").map((f) => f.trim()) : null,
    raw: args.raw === true,
    quiet: args.quiet === true,
  };

  const client = new AliExpress({
    locale: args.locale ? String(args.locale) : "en_US",
    currency: args.currency ? String(args.currency) : "USD",
    country: args.country ? String(args.country) : "US",
    cookie: Deno.env.get("ALIEXPRESS_COOKIE"),
  });

  switch (command) {
    case "search":
      await runSearch(client, args, flags);
      return EXIT_CODES.OK;
    case "product":
      await runProduct(client, args, flags);
      return EXIT_CODES.OK;
    case "filters":
      await runFilters(client, args, flags);
      return EXIT_CODES.OK;
    default:
      // Deliberately no "did you mean": a guess an agent cannot see is worse
      // than a refusal it can read.
      throw new AliValidationError(
        `Unknown command "${command}"`,
        "Run `aliexpress help`, or `aliexpress schema` for the machine-readable interface.",
      );
  }
}

if (import.meta.main) {
  try {
    Deno.exit(await main(Deno.args));
  } catch (error) {
    if (error instanceof AliError) {
      console.error(JSON.stringify(error.toJSON()));
      Deno.exit(error.exitCode);
    }
    console.error(JSON.stringify({
      error: {
        code: "UNEXPECTED",
        message: error instanceof Error ? error.message : String(error),
      },
    }));
    Deno.exit(EXIT_CODES.GENERAL);
  }
}
