/**
 * Live test for the CLI.
 *
 * The CLI is a published entry point with its own contract — exit codes, stream
 * separation, field selection, a machine-readable schema — and none of that is
 * exercised by testing the library it wraps. This runs the real binary as a
 * subprocess and checks the promises the README makes to an agent driving it.
 *
 * ```
 * deno run -A tests/live/cli.ts
 * ```
 *
 * @module
 */

import { EXIT_CODES } from "../../src/errors.ts";
import { type CheckResult, exitCodeFor, formatReport } from "./canary.ts";

const ENTRY = new URL("../../cli/main.ts", import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  "$1",
);
const LOCALE = ["--locale", "ja_JP", "--currency", "JPY", "--country", "JP"];
const PRODUCT = "1005008812285251";

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Invoke the CLI exactly as a caller would, with stdout piped (so: not a TTY). */
async function run(args: string[]): Promise<Run> {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-net", "--allow-env", ENTRY, ...args],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

const results: CheckResult[] = [];

/** Raised when AliExpress refused the request — not a CLI defect. */
class Blocked extends Error {}

async function check(
  name: string,
  body: () => Promise<Omit<CheckResult, "name" | "status">>,
): Promise<void> {
  try {
    results.push({ name, status: "pass", ...await body() });
  } catch (error) {
    results.push({
      name,
      status: error instanceof Blocked ? "blocked" : "fail",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Exit 3 from the CLI means the upstream refused us, so stop this check there. */
function assertNotBlocked(result: Run): void {
  if (result.code === EXIT_CODES.BLOCKED) {
    throw new Blocked("AliExpress refused the request (CLI exited 3)");
  }
}

await check("schema is valid, complete JSON", async () => {
  const r = await run(["schema"]);
  if (r.code !== 0) throw new Error(`exit ${r.code}, stderr: ${r.stderr.slice(0, 120)}`);
  const schema = JSON.parse(r.stdout);
  for (const key of ["name", "commands", "globalOptions", "exitCodes", "errorFormat"]) {
    if (!(key in schema)) throw new Error(`schema is missing "${key}"`);
  }
  for (const command of ["search", "product", "filters"]) {
    if (!(command in schema.commands)) throw new Error(`schema does not describe "${command}"`);
  }
  return { detail: `${Object.keys(schema.commands).length} commands documented` };
});

await check("bad arguments exit 2 with a JSON error on stderr", async () => {
  const r = await run(["search", "x", "--sort", "not-a-sort"]);
  if (r.code !== EXIT_CODES.VALIDATION) throw new Error(`expected exit 2, got ${r.code}`);
  if (r.stdout.trim() !== "") {
    throw new Error(`stdout should be empty, got: ${r.stdout.slice(0, 80)}`);
  }
  const error = JSON.parse(r.stderr.trim());
  if (!error.error?.code) throw new Error("stderr was not the documented error envelope");
  return { detail: `code=${error.error.code}` };
});

await check("an unknown command is refused, not guessed", async () => {
  const r = await run(["serch", "usb"]);
  if (r.code !== EXIT_CODES.VALIDATION) throw new Error(`expected exit 2, got ${r.code}`);
  const error = JSON.parse(r.stderr.trim());
  if (!/Unknown command/i.test(error.error?.message ?? "")) {
    throw new Error(`unexpected message: ${error.error?.message}`);
  }
  return { detail: error.error.message };
});

await check("piped search emits JSON by default", async () => {
  const r = await run(["search", "usb cable", "--limit", "5", "--quiet", ...LOCALE]);
  assertNotBlocked(r);
  if (r.code !== 0) throw new Error(`exit ${r.code}, stderr: ${r.stderr.slice(0, 120)}`);
  const items = JSON.parse(r.stdout);
  if (!Array.isArray(items) || items.length === 0) throw new Error("no items returned");
  if (items.length > 5) throw new Error(`--limit 5 returned ${items.length}`);
  return { detail: `${items.length} items as JSON` };
});

await check("--fields narrows the payload to exactly what was asked", async () => {
  const wanted = ["id", "price.current.value", "title"];
  const r = await run([
    "search",
    "usb cable",
    "--limit",
    "3",
    "--fields",
    wanted.join(","),
    "--ndjson",
    "--quiet",
    ...LOCALE,
  ]);
  assertNotBlocked(r);
  if (r.code !== 0) throw new Error(`exit ${r.code}, stderr: ${r.stderr.slice(0, 120)}`);

  const lines = r.stdout.trim().split("\n").filter(Boolean);
  if (lines.length === 0) throw new Error("no NDJSON lines");
  for (const line of lines) {
    const keys = Object.keys(JSON.parse(line));
    if (keys.join() !== wanted.join()) {
      throw new Error(`expected exactly [${wanted}], got [${keys}]`);
    }
  }
  // --quiet is meant to leave stderr silent, so a pipe carries data only.
  if (r.stderr.trim() !== "") throw new Error(`--quiet still wrote: ${r.stderr.slice(0, 80)}`);
  return { detail: `${lines.length} NDJSON lines, ${wanted.length} fields each` };
});

await check("diagnostics go to stderr, never stdout", async () => {
  const r = await run(["search", "usb cable", "--limit", "3", ...LOCALE]);
  assertNotBlocked(r);
  if (r.code !== 0) throw new Error(`exit ${r.code}`);
  JSON.parse(r.stdout); // throws if a progress note leaked into the data stream
  if (!/searching/i.test(r.stderr)) {
    throw new Error("expected progress notes on stderr without --quiet");
  }
  return { detail: `stdout parsed clean; ${r.stderr.trim().split("\n").length} stderr lines` };
});

await check("filters lists usable switch codes", async () => {
  const r = await run(["filters", "usb cable", "--json", "--quiet", ...LOCALE]);
  assertNotBlocked(r);
  if (r.code !== 0) throw new Error(`exit ${r.code}, stderr: ${r.stderr.slice(0, 120)}`);
  const rows = JSON.parse(r.stdout);
  const sorts = rows.filter((row: { kind: string }) => row.kind === "sort");
  const switches = rows.filter((row: { param: string }) => row.param === "--switch");
  if (sorts.length === 0) throw new Error("no sort rows");
  if (switches.length === 0) throw new Error("no --switch rows");
  return { detail: `${sorts.length} sorts, ${switches.length} filter codes` };
});

await check("product returns detail, or exits 3 when refused", async () => {
  const r = await run(["product", PRODUCT, "--quiet", ...LOCALE]);
  assertNotBlocked(r);
  if (r.code !== 0) throw new Error(`exit ${r.code}, stderr: ${r.stderr.slice(0, 160)}`);
  const [item] = JSON.parse(r.stdout);
  if (item.id !== PRODUCT) throw new Error(`asked for ${PRODUCT}, got ${item.id}`);
  if (!item.title) throw new Error("no title in the detail payload");
  return { detail: `${String(item.title).slice(0, 40)}` };
});

const report = formatReport(results);
console.log(report);

const summaryPath = Deno.env.get("GITHUB_STEP_SUMMARY");
if (summaryPath) {
  await Deno.writeTextFile(summaryPath, `## CLI\n\n${report}\n`, { append: true });
}

Deno.exit(exitCodeFor(results));
