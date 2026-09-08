# @youseiushida/aliexpress

A lightweight AliExpress client for Deno, usable as a library or a CLI.

It calls the same JSON endpoints the AliExpress website calls. There is no headless browser, no
JSDOM, and no HTML parsing — one small dependency for MD5 and one for argument parsing, and that is
the whole tree.

Built for product research: search with filters and sorting, page through results, and pull full
detail including SKUs, stock, store and specs.

## Install

```sh
deno add jsr:@youseiushida/aliexpress
```

As a CLI:

```sh
deno install -gA -n aliexpress jsr:@youseiushida/aliexpress/cli
```

## Library

```ts
import { AliExpress } from "@youseiushida/aliexpress";

const ae = new AliExpress({ locale: "ja_JP", currency: "JPY", country: "JP" });

const result = await ae.search("usb capture card", { sort: "price_asc" });
console.log(result.total); // approximate total matches
for (const item of result.items) {
  console.log(item.id, item.price?.current.formatted, item.rating, item.title);
}
```

Paging is an async iterator, so the page arithmetic stays out of your code:

```ts
for await (const item of ae.searchAll("usb hub", { limit: 300 })) {
  console.log(item.id, item.title);
}
```

Full detail:

```ts
const detail = await ae.product("1005008812285251");
console.log(detail.attributes); // { "Type": "Video capture card", ... }
console.log(detail.skus); // [{ id, attributes, price, stock, available }]
console.log(detail.stock, detail.store?.positiveRate);
```

### Normalized, with an escape hatch

Every result is normalized into stable types, and every object keeps the untouched upstream payload
on `raw`:

```ts
const item = result.items[0];
item.price?.current.value; // 410
item.raw; // the original AliExpress object, whole
```

AliExpress payloads are large, undocumented, and A/B-tested. When normalization misses a field you
need, `raw` means you are inconvenienced rather than blocked.

Fields that AliExpress may omit are typed as nullable rather than optional, so there is one shape to
branch on. Notably, **about a fifth of search results carry no price at all** — that is the
platform's behaviour, not a parsing failure.

### Errors

Failures are typed so you can tell them apart:

| Error                | Meaning                                                                     |
| -------------------- | --------------------------------------------------------------------------- |
| `AliValidationError` | Bad arguments. Thrown before any network call.                              |
| `AliBlockedError`    | Anti-bot challenge or rate limit. Back off; nothing is broken.              |
| `AliSchemaError`     | The response no longer has the fields we read. This library needs updating. |
| `AliNotFoundError`   | No such listing.                                                            |
| `AliUpstreamError`   | AliExpress reported an error of its own.                                    |

### Options

```ts
new AliExpress({
  locale: "ja_JP", // site locale; also picks the host (ja.aliexpress.com)
  currency: "JPY",
  country: "JP", // shipping destination
  minRequestInterval: 1000, // floor between requests, in ms
  fetch: myFetch, // inject a proxy, cache, or retry policy
});
```

Requests are serialized and paced. AliExpress fronts these endpoints with bot detection, and bursts
earn a captcha that costs more time than pacing does.

### Search is cheap; detail is not

The two halves of this library sit behind very different gates, and it is worth planning around.

**Search** tolerates steady use. Paging through several hundred results is routine.

**Product detail** goes through Alibaba's MTOP gateway, which is policed much harder. After a modest
number of lookups it starts answering `RGV587_ERROR` — while search from the same address stays
perfectly healthy — and once that happens the refusal lasts a long time.

What is actually going on, established by experiment rather than guesswork: the detail path requires
a `_baxia_sec_cookie_` once a caller has been flagged. In one browser, on one connection, the
identical request reached signature validation with cookies attached and was refused at the edge
with `credentials: "omit"`. Dropping only `_baxia_sec_cookie_` reproduced the refusal; dropping
`cna`, `xman_us_f` or `acs_usuc_t` changed nothing.

That cookie cannot be forged. It is a ~1 KB opaque blob written by Alibaba's anti-bot script, no
HTTP response ever sets it, and a plausible-looking substitute is rejected. Neither is there a way
around the API: the product page is client-rendered, so its HTML carries no data, and
`mtop.aliexpress.pdp.pc.query` is the only detail API that exists.

The flag is what turns the cookie into a requirement — an unflagged client fetches detail happily
without one. So pacing is the whole game. Detail gets its own budget (`minDetailRequestInterval`, 3s
by default) on top of the shared throttle, and for product research the shape that works is: search
broadly, narrow using the search fields you already have, and spend detail lookups only on the
shortlist.

If you are already flagged and need detail now, there are two ways back.

**Hand it a real browser session:**

```ts
const ae = new AliExpress({ cookie: Deno.env.get("ALIEXPRESS_COOKIE") });
```

The CLI reads the same `ALIEXPRESS_COOKIE` variable. It is taken from the environment rather than a
flag so it stays out of shell history and process listings.

**Or let it mint one for itself**, via the optional `./baxia` entry point:

```ts
import { AliExpress } from "@youseiushida/aliexpress";
import { mintSessionCookie } from "@youseiushida/aliexpress/baxia";

const ae = new AliExpress({ cookieProvider: mintSessionCookie });
await ae.product("1005008812285251"); // refused, mints, retries, succeeds
```

This runs AliExpress' own anti-bot scripts under JSDOM against a blank document — no storefront, no
browser — and takes two to six seconds. Measured: three mints out of three produced a complete
cookie, and a flagged client recovered end to end in about seven seconds.

It is deliberately a separate entry point. JSDOM is around thirty transitive packages and the core
of this library needs none of them, so you only pay for it if you import it. Two caveats worth
knowing before you rely on it: a minted cookie is **not reusable** — each detail lookup pays the
mint again — and the whole thing is best-effort, since it executes third-party scripts under an
incomplete DOM. Give it a fallback.

Lighter routes were measured and rejected: running only the cookie-writing script under a hand-built
zero-dependency shim yields one of the four required fields and is refused, and happy-dom produced
no cookie at all in 31 seconds.

## CLI

```sh
aliexpress search "usb capture card" --limit 20 --sort price_asc
aliexpress product 1005008812285251
aliexpress filters "usb cable"   # discover filter codes and sort keys
```

Output is a plain-text table on a terminal and JSON when piped, so both a human and a program get a
usable answer without passing a flag.

### For AI agents

The CLI is designed to be driven by an agent:

- **`aliexpress schema`** prints the whole interface — commands, options, output fields, exit codes
  — as JSON, so an agent can learn it in one call instead of probing `--help` per subcommand.
- **`--fields`** narrows the payload to the dotted paths you actually need. Everything else costs
  tokens for nothing:
  ```sh
  aliexpress search "led strip" --fields id,price.current.value --ndjson
  ```
- **Data goes to stdout, diagnostics to stderr.** Piping never mixes the two. `--quiet` silences the
  progress notes entirely.
- **Exit codes carry meaning**, so a caller knows whether to retry, back off, or give up:

  | Code | Meaning                                                         |
  | ---- | --------------------------------------------------------------- |
  | 0    | success                                                         |
  | 1    | unexpected error                                                |
  | 2    | bad arguments                                                   |
  | 3    | blocked by AliExpress — retry later, the tool is not broken     |
  | 4    | AliExpress changed its response shape — the tool needs updating |

- **Errors are JSON on stderr**: `{"error":{"code","message","hint"}}`.
- **Nothing ever prompts.** There is no interactive path to hang on.
- **Unknown commands fail** rather than guessing. A silent "did you mean" is worse than a refusal
  the agent can read.
- **Output field names are a contract.** They are added, never renamed or removed, within a major
  version.

## Is it still working?

Anything built on a site's own endpoints breaks when that site changes. Two layers of tests separate
"we broke it" from "they changed it":

```sh
deno task test     # offline, against frozen captures of real responses
deno task canary   # live, against AliExpress right now
```

The canary cannot assert on values — prices and listings change hourly. It asserts on **field
coverage**: how often each normalized field comes out populated across a live page of 60 results. If
`price.current.value` is filled for 78% of results today and 0% tomorrow, AliExpress changed its
payload and the normalizer is silently dropping data. The failure names the exact field.

It also checks that request parameters still take effect — that page 2 differs from page 1, and that
`--sort price_asc` really returns ascending prices. A parameter that starts being ignored is
invisible unless you look for it.

Blocking is tracked per check. AliExpress rate limits the MTOP detail gateway far harder than search
— it starts refusing product lookups while search is still perfectly healthy — so one throttled
detail request must not discard the search results the run did establish. A run reports exit 3 only
when nothing at all could be exercised; if some checks passed, it exits 0 and names the blocked
ones.

`.github/workflows/canary.yml` runs this daily and treats the outcomes differently: exit 3 (nothing
ran) logs a warning and passes, exit 4 (drift) opens an issue.

## Scope

Search and product detail. No cart, orders, or authentication.

This library reads the public site's own endpoints, and is subject to whatever rate limits and terms
AliExpress applies. Pace your requests, and expect the official Open Platform API to be the better
answer if you need guarantees.

## License

MIT
