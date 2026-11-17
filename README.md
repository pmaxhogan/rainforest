# rainforest

An open-source remote MCP server that lets Claude (claude.ai through a custom connector, and Claude
Code) work with Amazon.com (US retail) through your own logged-in Chrome, on macOS and Windows.

You host it yourself. A small Cloudflare Worker relays tool calls to a daemon on your computer; the
daemon drives your real Chrome profile, where you are already signed in to Amazon. There is no
shared service, no Amazon credentials stored anywhere, and no scraping from a datacenter.

## What it can and cannot do

It can read the pages of your own account and the public catalog, and it is designed to make small,
reversible edits to your cart and lists:

- Search, product pages, variants, buying options, media, reviews and price history.
- Your cart, orders, invoices, Subscribe & Save, lists and browsing history.
- Cart and list edits, with cart adds always done in two steps.

It deliberately cannot:

- **Place an order.** There is no tool for it, and checkout, payment, address and account-settings
  pages are hard-blocked by a URL policy that the daemon enforces on every request of the
  automation tab, including redirects.
- Type credentials, solve a captcha, or open a page the typed flows do not need. There is no
  generic "navigate" or "click" tool.
- Go fast. Pacing is conservative on purpose: one page at a time per computer, jittered gaps,
  hourly and daily caps per page type, and a 30 minute cool-down after any captcha or sign-in
  prompt.

Cart adds are two-step: `get_buying_options` returns short-lived offer ids and flags, and
`add_to_cart` takes exactly one offer id and refuses flagged offers unless every flag is
acknowledged. The only route to checkout is `show_on_screen`, which opens a normal tab for you to
finish by hand.

## Status

Early and incomplete (version 0.1). The hub is the most complete part; the daemon implements only
part of the tool registry. This section is the one place in the repository documentation that
tracks it; it describes the commit that introduced these docs.

| Area                                              | State                                           |
| ------------------------------------------------- | ----------------------------------------------- |
| Worker: OAuth, consent, MCP endpoint, pairing     | Implemented                                     |
| Worker: Hub Durable Object, admin page, audit log | Implemented                                     |
| Daemon: hub client, supervisor, presence, audit   | Implemented                                     |
| Daemon: autostart (LaunchAgent / Scheduled Task)  | Implemented                                     |
| Daemon: signed self-update with rollback          | Implemented                                     |
| Daemon: browser attach, URL policy, network guard | Implemented                                     |
| Tools `get_cart`, `list_subscriptions`            | Implemented                                     |
| Tool `get_browsing_history`                       | Implemented                                     |
| Every other daemon tool, including all writes     | Planned (the daemon answers `unsupported`)      |
| `rainforestd doctor`, `rainforestd capture`       | Planned (the commands exist but exit 1)         |
| First install from a release tarball              | Not implemented as a command; see docs/SETUP.md |
| Windows autostart                                 | Written; the hidden launch is unverified        |

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
  `delete_saved_item` - cart edits.
- `create_list`, `update_list`, `delete_list`, `add_to_list`, `remove_from_list`,
  `update_list_item`, `move_list_item` - list edits.

**Diagnostics**

- `get_status` - hub and per-device state.
- `get_audit_log` - recent tool calls (arguments for write tools only, never page content).

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - components, the life of one tool call, the wire
  protocol, browser resolution, capture and parsing, pacing, results and budgets.
- [docs/SECURITY.md](docs/SECURITY.md) - threat model, the two consent gates, the URL policy,
  updates, known limitations, and how to report a vulnerability.
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
npm test               vitest with coverage
npm run format         prettier --write
node scripts/setup-hooks.mjs   enable the git hooks (do this before committing)
```

The repository is public and identity-free: no account ids, hostnames, emails or real data, in code,
docs, tests, fixtures or commit messages. See docs/PRIVACY.md for the fixture rules.

## License

MIT. See [LICENSE](LICENSE).
