import { pick } from "../src/normalize/common.ts";

/**
 * Output rendering for the CLI.
 *
 * The primary consumer is an AI agent reading stdout, so two things matter more
 * than looks: the caller can narrow the payload to the fields it needs, and the
 * text carries no escape codes or box drawing to parse around.
 */

export type OutputFormat = "json" | "ndjson" | "table";

/** Fields shown by `search` when the caller does not choose. */
export const DEFAULT_SEARCH_FIELDS = [
  "id",
  "price.current.value",
  "price.current.currency",
  "rating",
  "orders",
  "title",
];

/** Fields shown by `product` when the caller does not choose. */
export const DEFAULT_PRODUCT_FIELDS = [
  "id",
  "title",
  "price.current.value",
  "price.current.currency",
  "price.discountPct",
  "rating",
  "reviews",
  "orders",
  "stock",
  "store.name",
  "url",
];

/**
 * Project an object down to the requested dotted paths.
 *
 * Output is flat, with the dotted path as the key. Nesting would make an agent
 * walk the structure to reach a value it already named.
 */
export function selectFields(source: unknown, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) out[field] = pick(source, field) ?? null;
  return out;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join(",");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Render rows as an aligned plain-text table.
 *
 * No colour and no box characters: the same bytes are readable in a terminal
 * and cheap for a model to tokenize.
 */
export function renderTable(rows: readonly Record<string, unknown>[]): string {
  if (rows.length === 0) return "(no results)";
  const columns = Object.keys(rows[0]);
  const widths = columns.map((column) =>
    Math.max(column.length, ...rows.map((row) => cell(row[column]).length))
  );
  // Long free text (titles) would push every other column off screen.
  const capped = widths.map((width) => Math.min(width, 60));

  const line = (values: readonly string[]) =>
    values
      .map((value, index) =>
        (value.length > capped[index] ? `${value.slice(0, capped[index] - 1)}…` : value).padEnd(
          capped[index],
        )
      )
      .join("  ")
      .trimEnd();

  return [
    line(columns),
    line(capped.map((width) => "-".repeat(width))),
    ...rows.map((row) => line(columns.map((column) => cell(row[column])))),
  ].join("\n");
}

/** Serialize records in the chosen format. */
export function render(rows: readonly Record<string, unknown>[], format: OutputFormat): string {
  switch (format) {
    case "json":
      return JSON.stringify(rows, null, 2);
    case "ndjson":
      return rows.map((row) => JSON.stringify(row)).join("\n");
    case "table":
      return renderTable(rows);
  }
}
