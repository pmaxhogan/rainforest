<!-- stack-template: claude-md/project-stub@2 94bd64717081 -->

# rainforest

Remote MCP server that lets Claude work with Amazon.com (US retail) through the owner's own
logged-in Chrome: a thin Cloudflare Worker relay, a self-updating local daemon per computer,
and the quiet Playwright extension fork.

## Commands

- `npm ci` - install
- `npm run check` - everything CI runs: typecheck, eslint, prettier, ASCII check, fixture allowlist gate,
  tests with coverage, and the Worker suite (`npm run test:worker`, which runs inside workerd)
- `npm test` - vitest with coverage (excludes `packages/worker`)
- `npm run test:e2e` - end-to-end suite: the real browser session and flows against the mock
  storefront in a real Chromium with the quiet extension. Not part of `npm run check`; it skips
  itself unless the extension build and a free broker port exist (`RAINFOREST_E2E_REQUIRE=1` makes
  that an error, as CI does; see `.github/workflows/e2e.yml`)
- `npm run format` - prettier --write
- `node scripts/package-daemon.mjs [--version v] [--out dir]` - build the release tarball + manifest (CI signs and publishes via `.github/workflows/release.yml`; `scripts/verify-release.mjs <dir>` checks one)
- `node packages/daemon/src/main.ts --help` - the `rainforestd` commands, run from a checkout
- `node packages/mock-site/src/cli.ts [--port n] [--seed n]` - run the fake storefront by hand
- `node scripts/setup-hooks.mjs` - enable the git hooks in a fresh clone (required before committing)

## Layout

- `packages/core` - tool registry, wire protocol, error taxonomy, capture/parser/fixture contracts.
  Every other package keys on it. Change it deliberately.
- `packages/parsers` - pure `(capture) -> data` functions. No I/O, no clock, no randomness.
- `packages/browser` - broker clients, extension-mode attach, URL policy and network guard, pacing, session.
- `packages/daemon` - `rainforestd`: hub client, browser controller, flows (`src/flows/`; `FLOWS` is the
  list of implemented tools), updater, service install, CLI.
- `packages/worker` - Cloudflare Worker: OAuth, consent, pairing, Hub Durable Object, admin page.
- `packages/scrubber` - capture -> synthetic fixture, plus the privacy gates.
- `packages/mock-site` - test-only deterministic fake storefront (real cart and list state, trap
  pages) and the E2E suite in `e2e/`. Never shipped.
- Fixtures are synthetic only: parser cases live in `packages/parsers/test/fixtures/<kind>/<case>/`
  (a top-level `fixtures/` is also scanned if it exists). `docs/` - ARCHITECTURE, SECURITY, SETUP,
  PRIVACY, TOOLS.

Tests live in `packages/<name>/test/*.test.ts` (vitest); E2E tests in
`packages/mock-site/e2e/*.e2e.test.ts`. TypeScript ESM, Node 22+, npm workspaces,
imports use explicit `.ts` extensions, no build step for tests.

## Rules that are not negotiable

- This repository is PUBLIC and identity-free. Never commit an account id, hostname, domain,
  email, machine name, token, real name, address, ZIP, phone, real order id or real ASIN, in
  code, docs, tests, fixtures, workflow files or commit messages. Configuration that identifies
  the owner comes from the environment or from local files outside the repo.
- Fixtures are synthetic only: ASINs match `B0FAKE....`, order ids `000-0000000-NNNNNNN`,
  emails `@example.com`, phones `555-555-01NN`, ZIPs `00000`-`00003`, images are placeholders
  (see `FAKE` in `packages/core/src/capture.ts`). Product titles, review text and search
  queries are invented, never copied from a real page.
- Never `git add -A` after a browser session without reading `git status`; stage by path.
- Commit messages: Conventional Commits, ASCII only, no personal data, no AI attribution trailers.
- ASCII only everywhere (no em/en dashes, smart quotes or arrows). LF line endings.
- Security-relevant lists are tested against a HARDCODED expected list plus a membership
  assertion; never `it.each` over the live export. A missing input to a security predicate
  fails closed.
- The daemon never places an order, never opens checkout/payment/address/account-settings
  pages, never types credentials and never solves a captcha. A sign-in, captcha or checkpoint
  page stops the queue, starts a cool-down and returns `needs_human`.
- Every click a write flow makes goes through `guardedClick` (`packages/daemon/src/flows/click-guard.ts`).
  `add_to_cart` never subscribes (Subscribe & Save is refused).
- Pacing is per device; an account driven from two computers gets the sum, so keep the caps low.
- `docs/TOOLS.md` must stay in step with the registry (`packages/core/test/docs.test.ts` pins its
  tool headings); unimplemented tools stay marked "Planned" in the one Planned row of its Status
  table and in the README Status table.
- If your shell exports Cloudflare credentials for a different account, unset them and pick
  the right wrangler profile explicitly on every command, or you deploy to the wrong account.

<!-- stack:begin (managed by the stack plugin; edit via /stack:remember or by hand, keep the markers) -->

## Stack

- scope: pmaxhogan
- mode: auth.web-app-password=yes
- mode: deploy.target=cloudflare-workers
- mode: deps.dependabot-mechanism=workflow-run
- mode: release.target=github-releases
- mode: stack.type=node-ts
- mode: test.coverage-ratchet=compare-job
- exception: deps.dependabot-policy - version updates wait 5 days (minor and patch) instead of 3 and 0, because a merged update becomes a signed daemon release that installs itself. Owner's choice; security updates are not delayed. (2026-11-17)

<!-- stack:end -->
