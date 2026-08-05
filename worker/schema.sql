-- Channel Command — D1 schema for the launch-history samples.
--
-- Applied by the deploy workflow on every run. Every statement is IF NOT EXISTS, so
-- re-running is a no-op and the file is the single source of truth for the shape.
--
-- Why this exists at all: the minute samples used to live in a single KV blob rewritten
-- once a minute while any post was inside its hot window. Cloudflare's KV free tier
-- allows 1,000 writes a day, and two or three uploads across both platforms produce
-- overlapping hot windows that run ~17 hours a day — about 2,000 writes, so sampling
-- silently stopped once the cap was hit. D1's free tier allows 100,000 rows a day.

-- One row per (platform, video, minute). The composite primary key makes inserts
-- idempotent, so a double-fired cron can never create a duplicate sample.
CREATE TABLE IF NOT EXISTS samples (
  platform TEXT    NOT NULL,          -- 'yt' | 'tt'
  video_id TEXT    NOT NULL,
  ts       INTEGER NOT NULL,          -- epoch ms
  views    INTEGER NOT NULL DEFAULT 0,
  likes    INTEGER NOT NULL DEFAULT 0,
  comments INTEGER NOT NULL DEFAULT 0,
  shares   INTEGER NOT NULL DEFAULT 0, -- TikTok only; always 0 on YouTube
  PRIMARY KEY (platform, video_id, ts)
) WITHOUT ROWID;

-- The metadata a curve needs to be plotted: when the post went live, and what it is.
CREATE TABLE IF NOT EXISTS videos (
  platform     TEXT    NOT NULL,
  video_id     TEXT    NOT NULL,
  published_at INTEGER NOT NULL,      -- epoch ms
  title        TEXT    NOT NULL DEFAULT '',
  channel      TEXT    NOT NULL DEFAULT '',  -- YouTube channel id; empty on TikTok
  cover        TEXT    NOT NULL DEFAULT '',  -- TikTok cover url; empty on YouTube
  first_seen   INTEGER NOT NULL,
  PRIMARY KEY (platform, video_id)
) WITHOUT ROWID;

-- The primary key already covers per-video reads. This one is for the nightly prune,
-- which deletes by age across every platform at once.
CREATE INDEX IF NOT EXISTS idx_samples_prune ON samples (ts);
