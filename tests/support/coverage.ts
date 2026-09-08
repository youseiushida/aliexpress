import { pick } from "../../src/normalize/common.ts";

/**
 * Field-coverage assertions.
 *
 * Live data cannot be checked against expected values — prices, ratings and
 * listings all change by the hour. What should not change is how often a field
 * comes out populated. If `price.current.value` is filled for 60 of 60 items
 * today and 0 of 60 tomorrow, AliExpress changed its payload and the normalizer
 * is silently dropping data.
 *
 * Coverage thresholds turn that into a test that fails loudly, and names the
 * exact field that broke.
 */

export interface FieldCoverage {
  field: string;
  present: number;
  total: number;
  ratio: number;
  required: number;
  ok: boolean;
}

/** A value counts as present when it is not null, undefined, empty or NaN. */
function isPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/** Measure how often each dotted field path is populated across `items`. */
export function measureCoverage(
  items: readonly unknown[],
  requirements: Record<string, number>,
): FieldCoverage[] {
  return Object.entries(requirements).map(([field, required]) => {
    const present = items.filter((item) => isPresent(pick(item, field))).length;
    const ratio = items.length === 0 ? 0 : present / items.length;
    return {
      field,
      present,
      total: items.length,
      ratio,
      required,
      // Round to avoid a 0.9499999 style failure on exact thresholds.
      ok: Math.round(ratio * 1000) >= Math.round(required * 1000),
    };
  });
}

/** Render a coverage table, for test output and CI logs. */
export function formatCoverage(report: readonly FieldCoverage[]): string {
  const width = Math.max(...report.map((row) => row.field.length), 5);
  return report
    .map((row) =>
      `${row.ok ? "ok  " : "FAIL"} ${row.field.padEnd(width)} ` +
      `${row.present}/${row.total} (${(row.ratio * 100).toFixed(0)}%, need ${
        (row.required * 100).toFixed(0)
      }%)`
    )
    .join("\n");
}

/**
 * Assert that every field meets its threshold.
 *
 * @param label Name of the payload under test, used in the failure message.
 * @param items Normalized objects to inspect.
 * @param requirements Dotted field path to the minimum ratio it must reach.
 * @throws {Error} listing every field that fell short.
 */
export function assertCoverage(
  label: string,
  items: readonly unknown[],
  requirements: Record<string, number>,
): FieldCoverage[] {
  if (items.length === 0) {
    throw new Error(`${label}: nothing to check — the response contained no items`);
  }
  const report = measureCoverage(items, requirements);
  const failures = report.filter((row) => !row.ok);
  if (failures.length > 0) {
    throw new Error(
      `${label}: ${failures.length} field(s) below threshold — ` +
        `AliExpress likely changed its response shape.\n${formatCoverage(report)}`,
    );
  }
  return report;
}
