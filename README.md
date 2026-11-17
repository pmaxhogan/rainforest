# rainforest

An open-source remote MCP server that lets Claude (claude.ai through a custom connector, and Claude
Code) work with Amazon.com (US retail) through your own logged-in Chrome, on macOS and Windows.

You host it yourself. A small Cloudflare Worker relays tool calls to a daemon on your computer; the
daemon drives your real Chrome profile, where you are already signed in to Amazon. There is no
shared service, no Amazon credentials stored anywhere, and no scraping from a datacenter.

## What it can and cannot do

It can read the pages of your own account and the public catalog, and it makes small, reversible
edits to your cart and lists:

- Search, product pages, variants, buying options, media, reviews and price history.
- Your cart, orders, invoices, Subscribe & Save, lists, browsing history and recent searches.
- Cart edits (add, change a line's quantity, remove, save for later, move back, delete a saved
  item) and removing an item from a list, with cart adds always done in two steps. Other list
  edits are planned.

It deliberately cannot:

- **Place an order.** There is no tool for it, and checkout, payment, address and account-settings
  pages are hard-blocked by a URL policy that the daemon enforces on every request of the
  automation tab, including redirects.
- Type credentials, solve a captcha, or open a page the typed flows do not need. There is no
  generic "navigate" or "click" tool. A sign-in, captcha or checkpoint page stops the queue,
  starts a cool-down and comes back as `needs_human`; a person has to deal with it.
- Start a Subscribe & Save subscription. That is a recurring order, so `add_to_cart` refuses it and
  points to `show_on_screen`.
- Go fast. Pacing is conservative on purpose and is per computer: one page at a time, jittered
  gaps of 5 to 11 seconds, hourly and daily caps per page type and across all of them, a burst cap,
  and a 60 minute cool-down after any captcha, sign-in or checkpoint page. An account driven from
  two computers gets the sum of both, which is why the per-computer caps are low.

Cart adds are two-step: `get_buying_options` returns short-lived offer ids and flags, and
`add_to_cart` takes exactly one offer id, re-reads the offer, refuses flagged or changed offers
unless every flag is acknowledged, and proves the result by reading the cart again. The only route
to checkout is `show_on_screen`, which opens a normal tab for you to finish by hand.

## Status

Early (version 0.1), but most of the registry is built. This section is the one place in the
repository documentation that tracks it, together with the Status table in docs/TOOLS.md; check
`FLOWS` in `packages/daemon/src/flows/index.ts` for the tools the daemon implements today.

| Area                                                                                                                                                 | State                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker: OAuth, consent, MCP endpoint, pairing                                                                                                        | Implemented                                                                                                                                                   |
| Worker: Hub Durable Object, admin page (pairings, devices, clients), audit                                                                           | Implemented                                                                                                                                                   |
| Daemon: hub client, supervisor, presence, audit                                                                                                      | Implemented                                                                                                                                                   |
| Daemon: autostart (LaunchAgent / Scheduled Task)                                                                                                     | Implemented; the Windows hidden launch is unverified                                                                                                          |
| Daemon: signed self-update with rollback, install from an unpacked release                                                                           | Implemented                                                                                                                                                   |
| Rails: URL policy, network guard, navigation guard, click guard, pacing                                                                              | Implemented                                                                                                                                                   |
| Read tools (17), including search, orders, lists, reviews and price history                                                                          | Implemented                                                                                                                                                   |
| Write tools: `add_to_cart`, `remove_from_cart`, `save_for_later`, `move_to_cart`, `delete_saved_item`, `remove_from_list`; hand-off `show_on_screen` | Implemented                                                                                                                                                   |
| Planned tools and options                                                                                                                            | Planned: `create_list`, `update_list`, `delete_list`, `add_to_list`, `update_list_item`, `move_list_item`, coupon clipping (the daemon answers `unsupported`) |
| `rainforestd doctor`                                                                                                                                 | Implemented                                                                                                                                                   |
| `rainforestd capture`                                                                                                                                | Placeholder: the command exists but exits 1                                                                                                                   |
| Mock storefront and end-to-end suite                                                                                                                 | Implemented (`npm run test:e2e`); informational in CI                                                                                                         |

Nothing here has been security audited. Read docs/SECURITY.md before connecting an account you
care about.

## Architecture

```
  claude.ai  /  Claude Code
        |
        |  Streamable HTTP (POST /mcp) + OAuth 2.1
        v
  +--------------------------------------------------+
  |  Cloudflare Worker  (the hub)                    |
  |  - OAuth server; consent page behind Cloudflare  |
  |    Access AND an app password                    |
  |  - stateless MCP endpoint                        |
  |  - one Durable Object: device registry, pairing, |
  |    per-connection browser selection, audit log,  |
  |    the daemons' WebSockets                       |
  |  - keeps page content only in transit            |
  +--------------------------------------------------+
        ^
        |  outbound WebSocket, per-device Ed25519 key
        |  (the computer dials out; no inbound network port)
        |
  +--------------------------------------------------+
  |  rainforestd  (Node daemon, one per computer)    |
  |  - policy rails, pacing, typed Amazon flows      |
  |  - pure parsers: page capture -> JSON            |
  |  - self-update from signed GitHub releases       |
  +--------------------------------------------------+
        |
        |  loopback broker + Playwright extension-mode relay
        v
  +--------------------------------------------------+
  |  your Chrome profile, signed in to Amazon        |
  |  with "Playwright Extension (quiet)"             |
  |  (automation tabs open in an unfocused window)   |
  +--------------------------------------------------+
        |
        v
    www.amazon.com
```

The browser extension is a fork of Playwright's extension that opens automation tabs without
stealing focus:
[pmaxhogan/playwright-extension-quiet](https://github.com/pmaxhogan/playwright-extension-quiet),
Chrome Web Store id `djphaomahfdjobipmjingddpnnihknnk`. The stock Playwright extension steals focus
on attach, and this code does not implement a path for it.

See docs/ARCHITECTURE.md for the full picture.

## Tools

The registry in `packages/core/src/tools.ts` defines 35 tools. One line each, from the registry;
arguments, results and errors are in docs/TOOLS.md.

**Browsers**

- `list_browsers` - list your computers that can drive Amazon, with presence and selection.
- `select_browser` - set the default browser for this connection only.
- `show_on_screen` - open a product, cart, list or order page in a normal tab for you to use by
  hand (the only route to checkout).

**Catalog reads**

- `search` - search amazon.com; every result labeled organic or sponsored.
- `get_product` - read a product page, losslessly.
- `get_variants` - variant dimensions, the combination to child ASIN map, per-variant offers.
- `get_buying_options` - the featured offer plus all offers, with offer ids and flags.
- `get_media` - hi-res image URLs per variant and videos.
- `get_reviews` - paged full review text with sort and filters.
- `get_review_summary` - rating, histogram, AI summary, top positive and critical review.
- `get_price_history` - price history per source (Amazon, CamelCamelCamel, Keepa).

**Account reads**

- `get_cart` - active cart items, subtotal and Saved for later.
- `list_orders` - order history by year or range, paged.
- `get_order` - full order details, shipments and tracking.
- `get_invoice` - invoice charge breakdown and payment transactions.
- `list_subscriptions` - Subscribe & Save subscriptions and upcoming deliveries (read only).
- `list_lists` - your lists with privacy and item counts.
- `get_list` - items on a list.
- `get_browsing_history` - recently viewed products.
- `get_search_history` - recent searches, best effort.

**Writes**

- `add_to_cart`, `set_cart_quantity`, `remove_from_cart`, `save_for_later`, `move_to_cart`,
  `delete_saved_item` - cart edits (implemented).
- `remove_from_list` - list edits (implemented). `create_list`, `update_list`, `delete_list`,
  `add_to_list`, `update_list_item`, `move_list_item` are planned.

**Diagnostics**

- `get_status` - hub and per-device state.
- `get_audit_log` - recent tool calls (arguments for write tools only, never page content).

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - components, the life of one tool call, the wire
  protocol, browser resolution, the rails, write flows, capture and parsing, pacing, results and
  budgets, testing.
- [docs/SECURITY.md](docs/SECURITY.md) - threat model, the two consent gates, the URL policy, the
  network, navigation and click guards, friction handling, updates, known limitations, and how to
  report a vulnerability.
- [docs/SETUP.md](docs/SETUP.md) - self-hosting step by step on macOS and Windows.
- [docs/PRIVACY.md](docs/PRIVACY.md) - what each side stores, and the fixture policy for
  contributors.
- [docs/TOOLS.md](docs/TOOLS.md) - every tool: arguments, results, errors, pacing.

## Development

Node 22 or newer and npm.

```
npm ci                 install
npm run check          everything CI runs: typecheck, eslint, prettier, ASCII check,
                       fixture gate, tests with coverage, worker tests
npm test               vitest with coverage (everything but the Worker)
npm run test:worker    the Worker suite, which runs inside workerd
npm run test:e2e       end-to-end suite against the mock storefront (needs Chromium and the
                       extension build; it skips itself when they are missing)
npm run format         prettier --write
node scripts/setup-hooks.mjs   enable the git hooks (do this before committing)
```

`packages/mock-site` is a deterministic fake storefront with real cart and list state and trap
pages (checkout, sign-in, captcha, checkpoint). The end-to-end suite drives the real browser
session and the real flows against it in a real Chromium with the extension; the test browser maps
the storefront hostname to loopback and fails every other name, so the real site is never
contacted. See docs/ARCHITECTURE.md (Testing).

The repository is public and identity-free: no account ids, hostnames, emails or real data, in code,
docs, tests, fixtures or commit messages. See docs/PRIVACY.md for the fixture rules.

## License

MIT. See [LICENSE](LICENSE).
