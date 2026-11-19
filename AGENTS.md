# AGENTS.md

Shared rules for any AI coding agent working in this repo. It is the only agent rules file here.

## What this is
Channel Command: a private YouTube and TikTok analytics dashboard, free-hosted on GitHub Pages.
The pages are plain HTML/CSS/vanilla JS with no build step. They call the YouTube APIs from the
browser and a Cloudflare Worker (D1 + KV + one-minute cron) that holds the secrets, TikTok sign-in,
the Gemini AI proxy and the minute-by-minute recording. The GitHub repo is public.

## Layout
- `yt-dashboard/` the websites, published as-is to GitHub Pages
  - `index.html` (YouTube), `tiktok.html`, `compare.html`: very large single-file pages
    (about 350 KB, 420 KB, 63 KB) with inline JS and hand-rolled SVG charts
  - `style.css` shared styles; `motion.js`, `stickers.js` shared scripts
  - `privacy.html`, `terms.html` published policies
  - `publish.sh` legacy and stale (names a `channel-command.html` that does not exist). Do not use.
- `worker/` Cloudflare Worker
  - `worker.js` (about 114 KB): HTTP routes plus the `scheduled` cron handler
  - `wrangler.toml`: name `yt`, cron every minute, KV binding `MINUTE`, D1 binding `DB`, var `TIKTOK_CLIENT_KEY`
  - `schema.sql` D1 schema, idempotent, applied on every deploy; `*.test.mjs` Worker suites
- `scripts/` `snapshot.mjs` and `rank.mjs` (robots run by Actions), `test-all.mjs`, `*.test.mjs` dashboard suites
- `data/` `history.json`, `alerts.json`, `ranks.json` are written by the robots.
  `keywords.json` is hand-edited input for `rank.mjs`. The dashboards read `data/` from `main`
  through raw.githubusercontent.com, so a change to `data/` is live without a deploy.
- `.github/workflows/` CI/CD (see below). `docs/` TikTok setup and YouTube ideas. `brand/` icons and design notes.
- `CHANNEL-COMMAND-TASKS.md` is a finished historical brief; its own header says not to implement against it.

## Commands
No package.json, no install step, no build. Node 22 is what CI uses.
- All tests: `node scripts/test-all.mjs`. It runs every `*.test.mjs` in `worker/` and `scripts/`,
  one process each, and exits 0 only if all pass. No network, no secrets.
- One suite: `node scripts/plateau.test.mjs` (any `*.test.mjs` runs on its own).
- Syntax check as CI does it: `node --check worker/worker.js`, and `node --check` on each `scripts/*.mjs`.
- Preview the dashboard: the repo has no dev server or script. The pages are static, so any static
  file server pointed at `yt-dashboard/` works. Google sign-in is registered only for the GitHub Pages
  origin (README, Setup step 1), so signed-in features cannot be tried from a local origin.
- Deploy: CI only. The README says to trigger the deploy workflow from the Actions tab.
- `scripts/snapshot.mjs` and `scripts/rank.mjs` are run by CI with `YT_API_KEY` and `CHANNEL_ID`.
  They overwrite files in `data/`, so do not run them locally and commit the output.

## How it deploys
Pushing to `main` ships. Nothing waits for the tests.
- `deploy-dashboard.yml`: push to `main` touching `yt-dashboard/**`, or manual. Copies that folder
  (minus `publish.sh`) into a fresh repo and force-pushes it to the `gh-pages` branch. Never edit `gh-pages`.
- `deploy-worker.yml`: push to `main` touching `worker/**`, or manual. Applies `schema.sql` to D1
  (non-blocking), runs `wrangler deploy`, then re-uploads the Worker secrets from GitHub secrets.
- `test.yml`: every pull request, and pushes to `main` touching `worker/`, `yt-dashboard/` or `scripts/`.
  Syntax check, then `node scripts/test-all.mjs`. It does not gate the two deploys, which run in parallel.
- `snapshot.yml`: cron every 5 minutes. Runs `snapshot.mjs` and commits `data/` straight to the branch
  ("Stats snapshot", only when something changed). May open a GitHub issue on a milestone.
- `rank.yml`: Mondays 06:23 UTC. Runs `rank.mjs`, commits `data/` ("Search rank check").
- `create-d1.yml` (one-off) and `d1-peek.yml` (read-only diagnostics) are manual only.
- Use a branch and pull request to get the tests before anything ships.

## Rules
- This repo is public, and so are its Actions logs. Never commit or print secrets, tokens, API keys,
  session ids, TikTok `open_id`s or any account-private data. Secrets live only in GitHub Actions
  secrets and Cloudflare Worker secrets. The ids in `wrangler.toml` and `TIKTOK_CLIENT_KEY` are
  intentionally committed because they are not sensitive; do not move that key into a secret.
- Never put a secret in a page. Secrets stay on the Worker; the browser holds only an opaque session id
  (plus a personal Gemini key if the user pastes one, which stays on that device).
- Do not add a server-side or repo export of recorded account data. The README rules this out on purpose.
- No build step, no framework, no bundler, no npm dependencies. The only external script is Google
  Identity Services. Keep code dependency-free unless asked.
- Keep the app read-only toward YouTube and TikTok. Never request a Google Drive scope. The README
  explains why: it makes Google refuse sign-in for supervised accounts.
- Run `node scripts/test-all.mjs` before calling work done. Add or update a `*.test.mjs` next to
  the code you change. Suites are discovered by filename.
- Many suites lift code out of `index.html`, `tiktok.html` and `worker.js` by marker strings
  (function names, comments, `export default {`). If a suite says "not found", you moved a marker.
- Some logic is deliberately duplicated in `index.html` and `tiktok.html` (the plateau model, the
  tooltip engine, `sparkHtml`). Tests compare the copies, ignoring comments and whitespace, so make the
  same edit in both.
- Do not hand-edit `data/history.json`, `data/alerts.json` or `data/ranks.json`; the robots own them.
  Edit `data/keywords.json` for search phrases.
- The HTML files are huge. Make targeted edits. Never reformat, re-indent, minify or rewrite a whole
  file, and locate code with search rather than reading it all.
- Keep the Worker owner-locked (`CHANNEL_ID`) and keep unauthenticated routes cheap. `/run` is rate limited.
- Keep both KV and D1 in the Worker. The README says dual-write is the settled design, not a half-done migration.

## Gotchas
- Bots push to `main` constantly (`data/history.json` is about 1.4 MB). Run `git pull --rebase` before
  you push, and do not touch `data/` in feature commits.
- Free-tier quotas are a design constraint. YouTube Data API: 10,000 units a day, and `search.list`
  costs 100 per page (`rank.mjs` caps itself at a 40-page budget). Cloudflare KV: 1,000 writes a day.
  D1: 100,000 row-writes a day (each index adds one per insert) and 5,000,000 row-reads a day.
  The README holds the arithmetic. Changes that add writes, indexes or reads need that sum redone.
- `deploy-worker.yml` runs the D1 schema step with `continue-on-error`, so a green run may not have
  applied `schema.sql`. Keep every statement idempotent. Adding a repo secret does not re-run a deploy.
- Auth is restrictive on purpose. Google OAuth is in Test-users mode and TikTok is in Sandbox, so only
  listed accounts can sign in. The Worker's post-login redirect uses an exact host allowlist
  (`RETURN_HOSTS`); do not loosen it to suffix matching, because anyone can claim a `*.github.io` name.
- The suites build paths from `import.meta.url` `.pathname`, which gives `/C:/...` and `%20` on Windows or
  in a folder with spaces. If suites fail locally with file-not-found, that is a likely cause, and CI
  (Linux) is the reference run. Worker suites also write a temporary `.worker-*.mjs` beside `worker.js`
  and delete it on exit. There is no `.gitignore`, so never commit a leftover one.

## Where to look for more
- `README.md`: "The four moving parts", "What the dashboards show" (behaviour reference), "Setup" (steps 1 to 5:
  YouTube sign-in, robots and secret names, Worker routes and D1/KV design, TikTok, extras), "Security",
  "Troubleshooting", "Repo layout".
- `docs/tiktok-setup.md` for the TikTok developer app. `worker/wrangler.toml` and `worker/schema.sql`
  comments for bindings, secrets and quota reasoning. Workflow header comments for CI history.
- Test file headers say what each suite guards and how it extracts the code it checks.
