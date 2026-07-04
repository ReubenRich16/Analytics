# Analytics

Live YouTube channel dashboard ("Channel Command") hosted on GitHub Pages.

## Dashboard

- **Dashboard URL:** https://reubenrich16.github.io/Analytics/
- **OAuth origin (for Google Cloud Console):** `https://reubenrich16.github.io`

The page in [`yt-dashboard/index.html`](yt-dashboard/index.html) is deployed
automatically by the [`deploy-dashboard.yml`](.github/workflows/deploy-dashboard.yml)
workflow whenever it changes. No build step — it's a single static HTML file
that talks directly to the YouTube Data + Analytics APIs from your browser.

## One-time Google Cloud Console setup (~3 minutes)

Done in the same Google Cloud project you already use (e.g. "Shinny YT"):

1. **Enable APIs** — API Library → enable **YouTube Analytics API** and
   **YouTube Data API v3**.
2. **OAuth consent screen** — External → app name `yt-dashboard`, your email
   in both email fields → Save through the screens → under **Test users**,
   add your own Gmail.
3. **Credentials** → + Create Credentials → **OAuth client ID** → type
   **Web application** → under **Authorized JavaScript origins** add:
   `https://reubenrich16.github.io` → Create → copy the **Client ID**.

## Daily use

Open (and bookmark on every device):

```
https://reubenrich16.github.io/Analytics/?client_id=YOUR_CLIENT_ID_HERE
```

The `?client_id=` parameter prefills the Client ID forever — just tap
**Sign in with Google**.

## Alternative: standalone repo via CLI

`yt-dashboard/publish.sh` is the original one-shot publisher. If you'd rather
host the dashboard in its own `yt-dashboard` repo, run it locally from a
machine with the authenticated `gh` CLI:

```bash
cd yt-dashboard && bash publish.sh
```
