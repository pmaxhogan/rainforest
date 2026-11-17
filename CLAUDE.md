<!-- stack-template: claude-md/project-stub@2 94bd64717081 -->

# rainforest

Remote MCP server that lets Claude work with Amazon.com (US retail) through the owner's own
logged-in Chrome: a thin Cloudflare Worker relay, a self-updating local daemon per computer,
and the quiet Playwright extension fork.

## Commands

- `npm ci` - install
- `npm run check` - everything CI runs: typecheck, eslint, prettier, ASCII check, tests with coverage
- `npm test` - vitest with coverage
- `npm run format` - prettier --write
- `node scripts/package-daemon.mjs [--version v] [--out dir]` - build the release tarball + manifest (CI signs and publishes via `.github/workflows/release.yml`; `scripts/verify-release.mjs <dir>` checks one)
- `node scripts/setup-hooks.mjs` - enable the git hooks in a fresh clone (required before committing)

## Layout

- `packages/core` - tool registry, wire protocol, error taxonomy, capture/parser/fixture contracts.
  Every other package keys on it. Change it deliberately.
- `packages/parsers` - pure `(capture) -> data` functions. No I/O, no clock, no randomness.
- `packages/daemon` - `rainforestd`: hub client, browser controller, policy rails, flows, updater, CLI.
- `packages/worker` - Cloudflare Worker: OAuth, consent, pairing, Hub Durable Object, admin page.
- `packages/mock-site` - deterministic fake storefront serving fixtures, with real cart/list state.
- `packages/scrubber` - capture -> synthetic fixture, plus the privacy gates.
- `fixtures/` - synthetic only. `docs/` - ARCHITECTURE, SECURITY, SETUP, PRIVACY, TOOLS.

Tests live in `packages/<name>/test/*.test.ts` (vitest). TypeScript ESM, Node 22+, npm workspaces,
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
  pages, never types credentials and never solves a captcha.
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

<!-- stack:end -->
