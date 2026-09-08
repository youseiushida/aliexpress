import type { Money, Price } from "../types.ts";

/**
 * Shared helpers for turning AliExpress payloads into typed data.
 *
 * Everything here is total: given garbage it returns `null` rather than
 * throwing. Search returns 60 items at a time and a single odd listing must not
 * fail the whole page. Callers decide what a missing field means; the
 * normalizer's job is only to report it honestly.
 */

/** Read a dotted path without trusting any level to exist. */
export function pick(source: unknown, path: string): unknown {
  let current = source;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function str(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value === "number") return String(value);
  return null;
}

export function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[,\s]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** AliExpress serves protocol-relative image URLs. */
export function absUrl(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  if (raw.startsWith("//")) return `https:${raw}`;
  if (raw.startsWith("http://")) return `https://${raw.slice(7)}`;
  return raw.startsWith("https://") ? raw : null;
}

/**
 * Parse counts that AliExpress deliberately blurs, such as `"1,000+ sold"` or
 * `"10K+"`. Returns the lower bound, which is the only honest reading.
 */
export function parseFuzzyCount(value: unknown): number | null {
  const raw = str(value);
  if (!raw) return null;
  const match = raw.match(/([\d,.]+)\s*([KMk万千])?/);
  if (!match) return null;
  const base = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(base)) return null;
  const multiplier = { K: 1_000, k: 1_000, M: 1_000_000, "万": 10_000, "千": 1_000 }[
    match[2] ?? ""
  ] ?? 1;
  return Math.round(base * multiplier);
}

/**
 * Build a {@link Money} from an AliExpress price object.
 *
 * These carry several overlapping amount fields. `minPrice` and `value` are in
 * major units; `cent` is named misleadingly and matches `minPrice` for
 * zero-decimal currencies, so it is only a last resort.
 */
export function money(source: unknown, fallbackCurrency: string): Money | null {
  if (source === null || typeof source !== "object") return null;
  const value = num(pick(source, "minPrice")) ?? num(pick(source, "value")) ??
    num(pick(source, "cent"));
  if (value === null) return null;
  const currency = str(pick(source, "currencyCode")) ?? str(pick(source, "currency")) ??
    fallbackCurrency;
  const formatted = str(pick(source, "formattedPrice")) ?? str(pick(source, "formatedAmount")) ??
    `${value} ${currency}`;
  return { value, currency, formatted };
}

/** Assemble a {@link Price}, deriving the discount when it is not given. */
export function price(
  current: Money | null,
  original: Money | null,
  statedDiscount: number | null,
): Price | null {
  if (!current) return null;
  let discountPct = statedDiscount;
  if (discountPct === null && original && original.value > current.value && original.value > 0) {
    discountPct = Math.round(((original.value - current.value) / original.value) * 100);
  }
  return {
    current,
    original: original && original.value !== current.value ? original : null,
    discountPct,
  };
}

/** Canonical product URL on the given site host. */
export function productUrl(host: string, id: string): string {
  return `https://${host}/item/${id}.html`;
}
