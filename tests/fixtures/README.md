# Fixtures

Frozen captures of real AliExpress responses. The offline tests run against these, so they can
check the raw-to-normalized mapping without a network and without flakiness.

- `search.ja.json` — one page of `POST /fn/search-pc/index`, trimmed to 6 items.
- `product.ja.json` — one `mtop.aliexpress.pdp.pc.query` response, whole.

## Re-capturing

Refresh these when the live canary reports drift and the normalizer has been updated to match.
Capture with `locale: "ja_JP"`, `currency: "JPY"`, `country: "JP"` so the expectations in
`tests/unit/` still hold, and trim the search item list to keep the file reviewable.

**Scrub the capture before committing it.** These payloads are not purely about the product: they
carry fields describing whoever made the request. The original capture of `search.ja.json` embedded
the machine's public IP in `clientIp`, plus a tracking `sessionId`. Both are now redacted to
`0.0.0.0` and zeroes. Check any new capture for the same, and for anything else that identifies a
person or a machine, before it goes into git.

The browser HAR files these were originally derived from are **not** committed — see `.gitignore`.
They hold live session cookies and run to tens of megabytes.
