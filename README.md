# Trash Talk Pool — 2026

A nine-person NFL pool tracker. Each entrant holds two teams (one AFC, one NFC); most combined
wins at the end of the regular season takes it. The site is static, the data refreshes itself,
and the weekly recap writes itself. Nothing to maintain in-season.

---

## What's in here

| File | What it does |
| --- | --- |
| `index.html` | The whole site. Self-contained — no build step, no dependencies. |
| `pool.json` | **The only file you edit by hand.** Entrants, their two teams, password hashes. |
| `scripts/fetch.mjs` | Pulls scores, records and player leaders from ESPN → `data/season.json`. |
| `scripts/recap.mjs` | Sends the week's numbers to Claude → writes the recap into `data/season.json`. |
| `style/examples.md` | Your previous commentaries. The recap writer matches this voice. |
| `setup-password.html` | Open locally; each person generates their own password hash. |
| `.github/workflows/update.yml` | Data refresh: 5am ET daily, plus every 30 min during games. |
| `.github/workflows/recap.yml` | Recap: Tuesday 6am ET, after Monday Night Football. |
| `data/season.json` | Generated. Don't edit — it gets overwritten every run. |

---

## Setup, once

### 1. Repository settings

**Settings → Actions → General → Workflow permissions** → select **Read and write permissions**.
Without this the scheduled jobs can't save the data they fetch. This is the step people miss.

### 2. First data pull

**Actions → Update NFL data → Run workflow.** Takes about a minute (it walks every played week to
build the week-by-week grid). When it goes green, check that `data/season.json` exists and has real
records in it.

### 3. Deploy

In Netlify: **Add new site → Import an existing project → GitHub → this repo.** Leave build
command and publish directory empty — it's a static site. You'll have a live URL in a minute.

Every time a workflow commits new data, Netlify redeploys automatically. That's the whole loop.

### 4. Custom domain

Netlify **Domain management → Add a domain** → enter your domain. Netlify gives you two
nameservers; paste them into Cloudflare under your domain's DNS. HTTPS is automatic and free.

### 5. Passwords

Download `setup-password.html` and open it in a browser — it works offline. Each person picks
their name, types a password, and clicks Generate. They send you the line it produces (which
contains a hash, never the password). Paste all nine lines into `pool.json` and commit.

Until you do this, the site accepts any password. After it, each person has their own, and the
browser remembers them so they only ever click **Enter**.

### 6. Weekly recaps

1. Create an API key at [console.anthropic.com](https://console.anthropic.com) and put $5 of
   credit on it. A season of recaps costs well under a dollar.
2. In this repo: **Settings → Secrets and variables → Actions → New repository secret.**
   Name it `ANTHROPIC_API_KEY`, paste the key.
3. Test it: **Actions → Write weekly recap → Run workflow.**

Add more of your old commentaries to `style/examples.md` any time — the voice gets closer to yours
with each one.

---

## Every year

1. Run the draft however you like.
2. Update the nine lines in `pool.json` with the new picks.
3. Change `SEASON` at the top of `scripts/fetch.mjs` to the new year.
4. Commit. The site catches up within a minute.

Optionally fill in `draftOrder` in `pool.json` — the order comes from the previous season's final
standings, champion picking first in one conference and last in the other.

---

## Scoring, as implemented

- Win = 1 point, tie = 0.5, loss or bye = 0.
- Seventeen games per team across eighteen weeks. Regular season only.
- Playoff results are excluded from wins and from net points.
- Tiebreakers in order: combined net points (PF − PA), then head-to-head between the tied
  entrants' teams, then combined points for. Entrants still level share the rank, shown with a `T`.
- Forfeit: 0 to the forfeiting team, 1 to the team awarded the win.
- Cancellation with no result: scored as a tie, 0.5 each, 0 net points.
- Playoff side pool is separate and scores nothing — furthest round reached wins it, ties split.

If a number on the site disagrees with this list, this list is right and the script needs fixing.

---

## Things to know

**The ESPN endpoint is unofficial.** It's free, it carries full box scores, and hobby projects
have used it for years — but there's no contract. If it changes shape the site shows stale data
until `scripts/fetch.mjs` is adjusted. Nothing breaks silently: the "updated" timestamp in the
header is the last successful run.

**The recap is written, not calculated.** Every number handed to the model comes from
`data/season.json`. The model writes sentences only. Standings, records and net points on the site
never pass through it.

**Free tiers are fine at this size.** Nine users will not approach any limit on GitHub Actions or
Netlify. The only recurring cost is the domain.
