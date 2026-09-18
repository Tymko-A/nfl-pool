// Pulls the 2026 NFL season from ESPN's public endpoints and writes data/season.json
// in the exact shape index.html expects. No API key, no dependencies — plain Node 20+.
//
//   node scripts/fetch.mjs
//
// Run by .github/workflows/update.yml on a schedule.

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";

const SEASON = 2026;
const BASE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";

const TEAM_COLORS = {
  ARI:"#97233f", ATL:"#a71930", BAL:"#241773", BUF:"#00338d", CAR:"#0085ca", CHI:"#0b162a",
  CIN:"#fb4f14", CLE:"#311d00", DAL:"#041e42", DEN:"#fb4f14", DET:"#0076b6", GB:"#203731",
  HOU:"#03202f", IND:"#002c5f", JAX:"#006778", KC:"#e31837", LAC:"#0080c6", LAR:"#003594",
  LV:"#a5acaf",  MIA:"#008e97", MIN:"#4f2683", NE:"#002a5c",  NO:"#d3bc8d",  NYG:"#0b2265",
  NYJ:"#125740", PHI:"#004c54", PIT:"#ffb612", SEA:"#69be28", SF:"#aa0000",  TB:"#d50a0a",
  TEN:"#4b92db", WSH:"#5a1414"
};

// ESPN uses WSH; the pool file may use WAS. Normalise both ways.
const ALIAS = { WAS:"WSH", OAK:"LV", SD:"LAC", STL:"LAR" };
const norm = a => ALIAS[a] || a;

async function get(url) {
  const res = await fetch(url, { headers: { "user-agent": "trash-talk-pool/1.0" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return res.json();
}

const ET = d => new Date(d).toLocaleString("en-US", {
  timeZone: "America/New_York", weekday: "short", month: "numeric", day: "numeric",
  hour: "numeric", minute: "2-digit"
});

function slot(iso, state, detail) {
  const d = new Date(iso);
  const day = d.toLocaleString("en-US", { timeZone:"America/New_York", weekday:"short" });
  const date = d.toLocaleString("en-US", { timeZone:"America/New_York", month:"numeric", day:"numeric" });
  if (state === "post") return `${day} ${date} · Final`;
  if (state === "in") return `${day} ${date} · ${detail || "In progress"}`;
  const time = d.toLocaleString("en-US", { timeZone:"America/New_York", hour:"numeric", minute:"2-digit" });
  return `${day} ${date} · ${time} ET`;
}

// ── current week ────────────────────────────────────────────────────────────
async function currentWeek() {
  const sb = await get(`${BASE}/scoreboard`);
  const wk = sb?.week?.number ?? 1;
  const type = sb?.season?.type ?? 2;
  return type === 2 ? wk : 1; // preseason/postseason → clamp to regular-season week 1
}

// ── team records ────────────────────────────────────────────────────────────
async function teamRecords() {
  const data = await get(`${BASE}/teams`);
  const list = data.sports[0].leagues[0].teams.map(t => t.team);
  const out = {};
  for (const t of list) {
    const abbr = norm(t.abbreviation);
    const detail = await get(`${BASE}/teams/${t.id}`);
    const rec = detail?.team?.record?.items?.find(i => i.type === "total");
    const stat = k => Number(rec?.stats?.find(s => s.name === k)?.value ?? 0);
    out[abbr] = {
      name: t.displayName,
      conf: detail?.team?.groups?.parent?.id === "8" ? "NFC" : "AFC",
      w: stat("wins"), l: stat("losses"), t: stat("ties"),
      pf: stat("pointsFor"), pa: stat("pointsAgainst"),
      color: TEAM_COLORS[abbr] || "#6f6860"
    };
  }
  return out;
}

// ── per-week results, for the week-by-week grid ─────────────────────────────
async function weeklyResults(upto) {
  const results = {};
  for (let week = 1; week <= upto; week++) {
    const sb = await get(`${BASE}/scoreboard?seasontype=2&week=${week}&dates=${SEASON}`);
    for (const ev of sb.events ?? []) {
      const comp = ev.competitions[0];
      if (comp.status?.type?.state !== "post") continue;
      const [a, b] = comp.competitors;
      for (const side of [a, b]) {
        const abbr = norm(side.team.abbreviation);
        const own = Number(side.score), opp = Number(side === a ? b.score : a.score);
        (results[abbr] ||= [])[week - 1] = own > opp ? "W" : own < opp ? "L" : "T";
      }
    }
    // mark byes: any team with no entry for this week and a played week later
    for (const abbr of Object.keys(results)) {
      if (results[abbr][week - 1] === undefined) results[abbr][week - 1] = "";
    }
  }
  return results;
}

// ── this week's games involving pool teams, with player leaders ─────────────
async function weekGames(week, poolTeams) {
  const sb = await get(`${BASE}/scoreboard?seasontype=2&week=${week}&dates=${SEASON}`);
  const games = [];
  for (const ev of sb.events ?? []) {
    const comp = ev.competitions[0];
    const away = comp.competitors.find(c => c.homeAway === "away");
    const home = comp.competitors.find(c => c.homeAway === "home");
    const aA = norm(away.team.abbreviation), hA = norm(home.team.abbreviation);
    if (!poolTeams.has(aA) && !poolTeams.has(hA)) continue;

    const state = comp.status?.type?.state;   // "pre" | "in" | "post"
    const done = state === "post";
    const live = state === "in";
    const g = {
      when: slot(ev.date, state, comp.status?.type?.shortDetail),
      away: aA, home: hA, done, live, leaders: []
    };
    if (done || live) {
      g.as = Number(away.score);
      g.hs = Number(home.score);
    }
    if (live) {
      // e.g. "3rd 4:21" — shown in place of the kickoff time
      g.clock = comp.status?.type?.shortDetail ?? "In progress";
    }
    if (done) {
      try {
        const sum = await get(`${BASE}/summary?event=${ev.id}`);
        const cats = { passingYards:"PASS", rushingYards:"RUSH", receivingYards:"REC" };
        for (const team of sum.leaders ?? []) {
          const abbr = norm(team.team?.abbreviation ?? "");
          for (const cat of team.leaders ?? []) {
            const tag = cats[cat.name];
            if (!tag) continue;
            const l = cat.leaders?.[0];
            if (!l) continue;
            g.leaders.push([tag, `${l.athlete?.shortName ?? l.athlete?.displayName} (${abbr})`, l.displayValue]);
          }
        }
      } catch { /* summary unavailable — the card still shows the score */ }
    }
    games.push(g);
  }
  games.sort((x, y) => Number(y.done) - Number(x.done) || Number(y.live) - Number(x.live));
  return games;
}

// ── main ───────────────────────────────────────────────────────────────────
const pool = JSON.parse(await readFile("pool.json", "utf8"));
const poolTeams = new Set(pool.entries.flatMap(e => [norm(e.afc), norm(e.nfc)]));

const week = await currentWeek();
console.log(`Season ${SEASON}, week ${week}`);

const allTeams = await teamRecords();
const teams = {};
for (const abbr of poolTeams) {
  if (!allTeams[abbr]) throw new Error(`pool.json references unknown team "${abbr}"`);
  teams[abbr] = allTeams[abbr];
}

// The recap lives inside season.json but is written by scripts/recap.mjs on its own
// schedule. This script rebuilds season.json from scratch, so it must carry the
// existing recap forward — otherwise every data refresh erases it and the page
// falls back to the stale built-in recap.
let priorRecap = null;
try {
  const prev = JSON.parse(await readFile("data/season.json", "utf8"));
  if (prev?.recap?.headline) priorRecap = prev.recap;
} catch { /* first run, or no data yet */ }

// Belt and braces: recap.mjs also archives data/recap-week-N.json. If one of those
// is newer than whatever season.json carried, prefer it.
try {
  const weeks = (await readdir("data"))
    .map(f => f.match(/^recap-week-(\d+)\.json$/))
    .filter(Boolean).map(m => Number(m[1]));
  if (weeks.length) {
    const latest = Math.max(...weeks);
    if (!priorRecap || Number(priorRecap.weekNumber || 0) < latest) {
      priorRecap = JSON.parse(await readFile(`data/recap-week-${latest}.json`, "utf8"));
    }
  }
} catch { /* no archive yet */ }

const out = {
  season: SEASON,
  week,
  updated: ET(Date.now()) + " ET",
  entries: pool.entries.map(e => ({ ...e, afc: norm(e.afc), nfc: norm(e.nfc) })),
  teams,
  results: await weeklyResults(week),
  games: await weekGames(week, poolTeams)
};

if (priorRecap) {
  out.recap = priorRecap;
  console.log(`Carried forward the ${priorRecap.week || "existing"} recap`);
} else {
  console.log("No existing recap to carry forward");
}

await mkdir("data", { recursive: true });
await writeFile("data/season.json", JSON.stringify(out, null, 2));
console.log(`Wrote data/season.json — ${Object.keys(teams).length} teams, ${out.games.length} games`);
