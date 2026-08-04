# TikTok dashboard — setup guide

Everything **you** need to do to create the TikTok app. Once these steps are done,
the code side (OAuth exchange in the Cloudflare Worker + the dashboard page) can
be built and connected.

Budget about **20–30 minutes**. It's free — no card, no app review needed
(we use Sandbox mode).

---

## Before you start — two things worth knowing

**Your partner's Apple ID login is not a problem.** TikTok handles the login
itself, exactly like the Google sign-in on the YouTube dashboard. She taps
"Continue with TikTok" and logs in however she normally does (Apple ID, phone,
whatever). The app never sees an email or password — TikTok just returns an
`open_id`, its own internal user reference. Even adding her as a test user is
done by *logging into her account*, not by typing an email.

**What the data can and can't do.** TikTok's free Display API gives per-video
**views, likes, comments, shares** (sometimes saves), plus caption, cover image,
duration and post time — and profile-level **followers, following, total likes,
video count**. It does **not** provide retention, average watch time, traffic
sources, search terms, audience demographics, or impressions/CTR. Those live only
in TikTok's Research API (academics) or Business API (business account +
approval). So the TikTok dashboard will be strong on live counters, trends,
grading and coaching, but will have no retention/audience/traffic sections.

---

## Step 1 — Create a TikTok developer account

1. Go to <https://developers.tiktok.com/> and click **Log in** (top right).
2. Log in with **your own** TikTok account (this becomes the developer account —
   it doesn't have to be either channel account, but using yours is simplest).
3. Accept the **TikTok for Developers Terms of Service**.
4. If prompted, complete the developer profile (name, email, country).

## Step 2 — Create the app

1. Go to **Manage apps** → **Connect an app** (or **Create an app**).
2. Give it a name, e.g. `Channel Command TikTok`, and a short description such as
   *"Private analytics dashboard for my own TikTok accounts."*
3. Choose the **Web** platform.
4. Save. You'll land on the app's configuration page.

## Step 3 — Fill in the app details

The form requires a Terms of Service URL and a Privacy Policy URL. Both are
published from this repo, so paste these:

| Field | Value |
|---|---|
| App name | `AnalyticsTikTok` (anything) |
| Category | Anything sensible, e.g. *Productivity* / *Tools* |
| Description | `A private dashboard showing my own TikTok video stats (views, likes, comments) to help me improve my content.` |
| Terms of Service URL | `https://reubenrich16.github.io/Analytics/terms.html` |
| Privacy Policy URL | `https://reubenrich16.github.io/Analytics/privacy.html` |
| Platforms | **Web** only |
| Web/Desktop URL | `https://reubenrich16.github.io/Analytics/` |

## Step 4 — Products and scopes

> **There is no separate "Display API" product.** The Display API is reached purely
> through scopes. The only product you need is **Login Kit**. (Share Kit, Content
> Posting API, Webhooks, Data Portability and Local Service API are all irrelevant
> here — don't add them, and remove Webhooks if it got added.)

Under **Scopes**, add these (`user.info.basic` comes with Login Kit automatically):

| Scope | What it gives us |
|---|---|
| `user.info.basic` | display name + avatar + open id |
| `user.info.profile` | username, bio, profile link |
| `user.info.stats` | **followers, following, total likes, video count** |
| `video.list` | **the videos + views / likes / comments / shares** |

In Sandbox mode these are available without a review.

## Step 5 — Set the redirect URI ⚠️ the easiest thing to get wrong

This goes in **Login Kit → Redirect URI → Web tab** — *not* in the Webhooks
"Callback URL" box, which is a completely different feature.

TikTok requires the redirect URI to be **HTTPS, absolute, and completely static —
query parameters are rejected**. That means it *cannot* be the dashboard link
(which carries `?worker=…`). Instead we point TikTok at the Worker, which then
hands you back to the dashboard.

Click **+ Add a URI** under the **Web** tab and enter exactly:

```
https://yt.reubenrichardson37.workers.dev/tiktok/callback
```

(No trailing slash, no parameters. If the Worker is ever renamed, update this.)

## Step 6 — Create a Sandbox and add both accounts

Sandbox mode lets the app work for specific accounts **without submitting it for
review**. Up to 10 accounts.

1. On the app page, find **Sandbox** → **Create sandbox** (name it e.g. `family`).
2. Open the sandbox → **Target users** → **Add account**.
3. You'll be redirected to a TikTok login. **Log in as the account you want to
   add** and accept the Developer Terms.
4. Repeat for the second account — this is where your partner logs in with her
   Apple ID as normal. *(Easiest done on her device, or in a private/incognito
   window so it doesn't clash with your session.)*
5. Make sure both accounts appear in the Target users list, and are **authorized**
   for Login Kit.

> Only accounts listed here can use the app while it's in Sandbox mode. That's
> exactly what we want — it stays private to the two of you.

## Step 7 — Copy the credentials

On the app page, find:

- **Client key** — not secret, this can live in the page (like the Google Client ID).
- **Client secret** — **must stay private.** Never paste it into chat, the repo,
  or the dashboard.

**Recorded so far:**

| | |
|---|---|
| Sandbox client key | `sbawwsui0uvmik0odt` |
| Client secret | *(set as a Worker secret — never stored here)* |

The `sb` prefix marks it as a **Sandbox** credential. When the app is eventually
moved to production it gets a different key, and this must be updated.

## App icon

A ready-made icon lives in [`brand/`](../brand): upload **`icon-1024.png`**
(or `icon-512.png` if there's a size limit). The source is `brand/icon.svg`, so it
can be re-rendered at any size, and `brand/PHILOSOPHY.md` records the design
rationale.

## Step 8 — Store the secret (same pattern as the Gemini key)

Add both as **GitHub repository secrets** (Settings → Secrets and variables →
Actions → New repository secret), and the deploy workflow will push them into the
Worker automatically:

- `TIKTOK_CLIENT_KEY`
- `TIKTOK_CLIENT_SECRET`

The Worker performs the OAuth code exchange server-side, so the secret is never
exposed in the public page — the same approach used for the Gemini key.

## Step 9 — Tell me it's done

Send me:
- the **client key** (safe to share), and
- confirmation that both accounts are added as target users.

Then the Worker OAuth endpoints and the TikTok dashboard page can be built and
connected.

---

## What gets built afterwards

- **Worker**: `/tiktok/login` (starts auth with a CSRF `state`), `/tiktok/callback`
  (exchanges the code for tokens), and refresh-token storage in KV.
  TikTok access tokens last ~24h but refresh tokens last ~1 year, so the Worker
  can keep polling in the background — meaning **true offline minute-by-minute
  tracking**, even better than the YouTube setup which needs a browser session.
- **Dashboard**: live counters, per-video table, the minute-by-minute race,
  Report Card grading, Coaching (best day/time to post), and the Idea Studio
  working from captions + hashtags.

## Reference

- [Login Kit for Web](https://developers.tiktok.com/doc/login-kit-web)
- [Display API overview](https://developers.tiktok.com/doc/display-api-overview)
- [Sandbox mode](https://developers.tiktok.com/doc/add-a-sandbox/)
