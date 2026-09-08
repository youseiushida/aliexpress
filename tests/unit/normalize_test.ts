import { assert, assertEquals, assertGreater, assertThrows } from "@std/assert";
import { normalizeProduct, normalizeSearch } from "../../src/normalize/search.ts";
import { normalizeProductDetail } from "../../src/normalize/product.ts";
import { parseFuzzyCount, price } from "../../src/normalize/common.ts";
import { AliSchemaError } from "../../src/errors.ts";
import { mtopSign } from "../../src/mtop.ts";
import { assertCoverage, formatCoverage } from "../support/coverage.ts";

/**
 * Offline tests against frozen captures of real responses.
 *
 * These pin the raw-to-normalized mapping and run everywhere, with no network
 * and no flakiness. The live canary in `tests/live/` covers the other half of
 * the problem: whether AliExpress still sends what these fixtures show.
 */

const HOST = "ja.aliexpress.com";

const searchFixture = JSON.parse(
  await Deno.readTextFile(new URL("../fixtures/search.ja.json", import.meta.url)),
);
const productFixture = JSON.parse(
  await Deno.readTextFile(new URL("../fixtures/product.ja.json", import.meta.url)),
);

Deno.test("normalizeSearch reads page metadata", () => {
  const result = normalizeSearch(searchFixture, "usb capture card", HOST);
  assertEquals(result.query, "usb capture card");
  assertEquals(result.page, 1);
  assertEquals(result.pageSize, 60);
  assertGreater(result.total ?? 0, 0);
});

Deno.test("normalizeSearch maps every item field", () => {
  const result = normalizeSearch(searchFixture, "usb capture card", HOST);
  assertGreater(result.items.length, 0);

  // Identity and imagery are always present. Pricing is not: AliExpress omits
  // the `prices` object entirely on some listings (2 of the 6 captured here),
  // so the threshold is set from what the platform actually sends.
  const report = assertCoverage("search fixture", result.items, {
    id: 1,
    title: 1,
    url: 1,
    image: 1,
    images: 1,
    "price.current.value": 0.6,
    "price.current.currency": 0.6,
    "price.current.formatted": 0.6,
    rating: 0.8,
    orders: 0.8,
  });
  console.log(formatCoverage(report));
});

Deno.test("normalizeSearch derives prices and discounts", () => {
  const { items } = normalizeSearch(searchFixture, "q", HOST);
  const discounted = items.find((item) => item.price?.original);
  assert(discounted, "fixture should contain at least one discounted item");
  const { current, original, discountPct } = discounted.price!;
  assertEquals(current.currency, "JPY");
  assertGreater(original!.value, current.value);
  assertGreater(discountPct ?? 0, 0);
});

Deno.test("normalizeSearch exposes filters and sorts", () => {
  const result = normalizeSearch(searchFixture, "q", HOST);
  assert(result.filters.some((group) => group.param === "selectedSwitches"));
  assert(result.filters.some((group) => group.param === "pr"));
  // The price sort is nested under one entry and must be flattened per direction.
  const sorts = result.sorts.map((sort) => sort.value);
  assert(sorts.includes("price_asc"), `expected price_asc in ${sorts.join(",")}`);
  assert(sorts.includes("price_desc"), `expected price_desc in ${sorts.join(",")}`);
});

Deno.test("normalizeProduct skips non-product cards", () => {
  assertEquals(normalizeProduct({ itemType: "ad" }, HOST), null);
  assertEquals(normalizeProduct(null, HOST), null);
});

Deno.test("normalizeSearch rejects a payload with no item array", () => {
  assertThrows(
    () => normalizeSearch({ data: { result: {} } }, "q", HOST),
    AliSchemaError,
  );
});

Deno.test("normalizeProductDetail maps the detail modules", () => {
  const detail = normalizeProductDetail(productFixture.data, "1005008812285251", HOST, "JPY");

  assertEquals(detail.id, "1005008812285251");
  assertGreater(detail.title.length, 0);
  assertEquals(detail.url, "https://ja.aliexpress.com/item/1005008812285251.html");

  const report = assertCoverage("product fixture", [detail], {
    title: 1,
    images: 1,
    "price.current.value": 1,
    "price.original.value": 1,
    rating: 1,
    reviews: 1,
    orders: 1,
    "store.id": 1,
    "store.name": 1,
    "store.positiveRate": 1,
    attributes: 1,
    skus: 1,
    stock: 1,
  });
  console.log(formatCoverage(report));
});

Deno.test("normalizeProductDetail resolves SKU attributes to readable labels", () => {
  const detail = normalizeProductDetail(productFixture.data, "1005008812285251", HOST, "JPY");
  const sku = detail.skus[0];
  assert(sku, "fixture should expose at least one SKU");
  assert(/^\d+$/.test(sku.id));
  // The fixture's SKU path is "14:691", which must resolve through
  // skuProperties into a named attribute rather than staying as raw ids.
  assertGreater(Object.keys(sku.attributes).length, 0);
  for (const [name, value] of Object.entries(sku.attributes)) {
    assert(!/^\d+$/.test(name), `attribute name "${name}" was left as a property id`);
    assertGreater(value.length, 0);
  }
  assertGreater(sku.price?.current.value ?? 0, 0);
  assertEquals(sku.available, true);
});

Deno.test("normalizeProductDetail rejects a payload with no title module", () => {
  assertThrows(() => normalizeProductDetail({ result: {} }, "1", HOST, "JPY"), AliSchemaError);
  assertThrows(() => normalizeProductDetail({}, "1", HOST, "JPY"), AliSchemaError);
});

Deno.test("parseFuzzyCount reads blurred sales figures", () => {
  assertEquals(parseFuzzyCount("1,000+ sold"), 1000);
  assertEquals(parseFuzzyCount("1,000+ 点販売"), 1000);
  assertEquals(parseFuzzyCount("10K+ sold"), 10_000);
  assertEquals(parseFuzzyCount("49"), 49);
  assertEquals(parseFuzzyCount("no digits"), null);
  assertEquals(parseFuzzyCount(null), null);
});

Deno.test("price hides a fake original and computes the discount", () => {
  const yen = (value: number) => ({ value, currency: "JPY", formatted: `${value}` });
  assertEquals(price(yen(100), yen(100), null)?.original, null);
  assertEquals(price(yen(50), yen(200), null)?.discountPct, 75);
  // An explicitly stated discount wins over the derived one.
  assertEquals(price(yen(50), yen(200), 80)?.discountPct, 80);
  assertEquals(price(null, yen(200), null), null);
});

Deno.test("mtopSign matches the gateway's documented scheme", () => {
  // md5("token&1788877164928&12574478&{}")
  assertEquals(
    mtopSign("token", "1788877164928", "12574478", "{}"),
    "a4fb82551b4e20864d74824dd483505f",
  );
});
