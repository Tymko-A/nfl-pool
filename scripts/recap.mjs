// Writes the recap of the COMPLETED week by sending its real numbers to Claude,
// in the house style defined by style/examples.md.
//
//   ANTHROPIC_API_KEY=sk-... node scripts/recap.mjs
//
// Run by .github/workflows/recap.yml on Tuesday mornings, after MNF.
// Every number in the prompt comes from ESPN or data/season.json — the model
// writes the sentences, never the stats.
//
// IMPORTANT: data/season.json tracks the week ESPN calls current, which flips to
// the NEXT week as soon as the previous one finishes. Recapping season.week
// therefore produced a preview of unplayed games. This script instead picks the
// most recent week that actually has finished pool games and fetches THAT week's
// scores itself.

import { readFile, writeFile } from "node:fs/promises";

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) { console.error("ANTHROPIC_API_KEY is not set"); process.exit(1); }

const season = JSON.parse(await readFile("data/season.json", "utf8"));
const examples = await readFile("style/examples.md", "utf8");

const owner = {};
season.entries.forEach(e => { owner[e.afc] = e.name; owner[e.nfc] = e.name; });

const poolTeams = new Set(season.entries.flatMap(e => [e.afc, e.nfc]));
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";
const ALIAS = { WAS:"WSH", OAK:"LV", SD:"LAC", STL:"LAR" };
const norm = a => ALIAS[a] || a;

async function get(url) {
  const res = await fetch(url, { headers: { "user-agent": "trash-talk-pool/1.0" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return res.json();
}

function slotLabel(iso, state, detail) {
  const d = new Date(iso);
  const opts = { timeZone:"America/New_York" };
  const day = d.toLocaleString("en-US", { ...opts, weekday:"short" });
  const date = d.toLocaleString("en-US", { ...opts, month:"numeric", day:"numeric" });
  if (state === "post") return `${day} ${date} · Final`;
  if (state === "in") return `${day} ${date} · ${detail || "In progress"}`;
  const time = d.toLocaleString("en-US", { ...opts, hour:"numeric", minute:"2-digit" });
  return `${day} ${date} · ${time} ET`;
}

// Pool games for one week, with player leaders on the finished ones.
async function weekGames(week, withLeaders) {
  const sb = await get(`${ESPN}/scoreboard?seasontype=2&week=${week}&dates=${season.season}`);
  const games = [];
  for (const ev of sb.events ?? []) {
    const comp = ev.competitions[0];
    const away = comp.competitors.find(c => c.homeAway === "away");
    const home = comp.competitors.find(c => c.homeAway === "home");
    const aA = norm(away.team.abbreviation), hA = norm(home.team.abbreviation);
    if (!poolTeams.has(aA) && !poolTeams.has(hA)) continue;

    const state = comp.status?.type?.state;      // "pre" | "in" | "post"
    const done = state === "post";
    const g = {
      when: slotLabel(ev.date, state, comp.status?.type?.shortDetail),
      kickoffISO: ev.date,
      away: aA, home: hA, done, live: state === "in", leaders: []
    };
    if (state !== "pre") { g.as = Number(away.score); g.hs = Number(home.score); }
    if (done && withLeaders) {
      try {
        const sum = await get(`${ESPN}/summary?event=${ev.id}`);
        const cats = { passingYards:"PASS", rushingYards:"RUSH", receivingYards:"REC" };
        for (const team of sum.leaders ?? []) {
          const abbr = norm(team.team?.abbreviation ?? "");
          for (const cat of team.leaders ?? []) {
            const tag = cats[cat.name];
            const l = cat.leaders?.[0];
            if (tag && l) g.leaders.push([tag, `${l.athlete?.shortName ?? l.athlete?.displayName} (${abbr})`, l.displayValue]);
          }
        }
      } catch { /* summary unavailable — the score still stands */ }
    }
    games.push(g);
  }
  return games;
}

// The week to recap: the latest week whose pool games are all finished. Walk
// back from ESPN's current week so a Tuesday run recaps the weekend just gone.
let recapWeek = null, recapGames = null;
for (let w = season.week; w >= 1; w--) {
  const games = await weekGames(w, false);
  if (games.length && games.every(g => g.done)) { recapWeek = w; break; }
}
if (recapWeek === null) {
  console.error(`No completed week found at or before week ${season.week} — nothing to recap yet.`);
  process.exit(0);
}
recapGames = await weekGames(recapWeek, true);
console.log(`Recapping week ${recapWeek} (season.week is ${season.week}) — ${recapGames.length} pool games`);

// The week ahead, for the forward-looking lines only.
const nextWeek = recapWeek + 1;
const nextGames = nextWeek <= 18 ? await weekGames(nextWeek, false) : [];

const teamName = a => season.teams[a]?.name ?? a;

// Today, stated explicitly: without it the model guesses and writes "tonight"
// about a game that is days away.
const nowET = new Date().toLocaleString("en-US", {
  timeZone:"America/New_York", weekday:"long", month:"long", day:"numeric", year:"numeric"
});

// ── build the standings the same way the site does ─────────────────────────
const rows = season.entries.map(e => {
  const a = season.teams[e.afc], n = season.teams[e.nfc];
  const w = a.w + n.w, l = a.l + n.l, t = a.t + n.t;
  const pf = a.pf + n.pf, pa = a.pa + n.pa;
  return { name: e.name, afc: a, nfc: n, w, l, t, pts: w + t * 0.5, net: pf - pa };
});
rows.sort((x, y) => y.pts - x.pts || y.net - x.net);

// ── the recapped week, per entrant ─────────────────────────────────────────
const weekly = {};
season.entries.forEach(e => { weekly[e.name] = { wins: 0, losses: 0, ties: 0, net: 0, games: [], next: [] }; });
for (const g of nextGames) {
  for (const abbr of [g.away, g.home]) {
    const o = owner[abbr];
    if (o) weekly[o].next.push(`${teamName(abbr)} — ${g.when}`);
  }
}
for (const g of recapGames.filter(g => g.done)) {
  for (const [abbr, own, opp] of [[g.away, g.as, g.hs], [g.home, g.hs, g.as]]) {
    const o = owner[abbr];
    if (!o) continue;
    const t = weekly[o];
    t.net += own - opp;
    if (own > opp) t.wins++; else if (own < opp) t.losses++; else t.ties++;
    t.games.push(`${teamName(abbr)} ${own}-${opp}`);
  }
}

const finished = recapGames.filter(g => g.done).length;

const brief = {
  season: season.season,
  seasonLabel: `${season.season} NFL season`,
  weekBeingRecapped: recapWeek,
  weekStatus: `COMPLETE — all ${finished} pool games in Week ${recapWeek} are final. This is a look BACK at that week.`,
  todayIs: nowET + " (Eastern)",
  nextWeekNumber: nextWeek,
  gamesFinished: finished,
  standings: rows.map((r, i) => ({
    rank: i + 1, entrant: r.name, points: r.pts, record: `${r.w}-${r.l}-${r.t}`,
    net: r.net, afc: `${r.afc.name} ${r.afc.w}-${r.afc.l}`, nfc: `${r.nfc.name} ${r.nfc.w}-${r.nfc.l}`
  })),
  weekResults: Object.entries(weekly).map(([name, v]) => ({
    entrant: name,
    weekRecord: `${v.wins}-${v.losses}${v.ties ? "-" + v.ties : ""}`,
    weekPoints: v.wins + v.ties * 0.5,
    weekNet: v.net,
    gamesPlayed: v.games,
    nextWeekGames: v.next
  })),
  finalGames: recapGames.filter(g => g.done).map(g => ({
    matchup: `${teamName(g.away)} at ${teamName(g.home)}`,
    score: `${g.as}-${g.hs}`,
    winner: g.as === g.hs ? "tie" : teamName(g.as > g.hs ? g.away : g.home),
    awayOwner: owner[g.away] ?? null, homeOwner: owner[g.home] ?? null,
    headToHead: Boolean(owner[g.away] && owner[g.home]),
    leaders: g.leaders
  })),
  nextWeekSchedule: nextGames.map(g => ({
    matchup: `${teamName(g.away)} at ${teamName(g.home)}`,
    when: g.when, awayOwner: owner[g.away] ?? null, homeOwner: owner[g.home] ?? null,
    headToHead: Boolean(owner[g.away] && owner[g.home])
  }))
};

const SYSTEM = `You write the weekly recap for a nine-person NFL pool called the Trash Talk Pool.
This is the ${season.season} NFL season. Never state any other year — if you mention the season at
all, it is ${season.season}. Do not refer to it as ${season.season - 1}.

THE POOL
Each entrant holds two teams, one AFC and one NFC. A win is 1 point, a tie 0.5, a loss or bye 0.
Most combined points at the end of the regular season wins. Ties break on combined net points
(points for minus points against), then head-to-head, then points for. Playoffs do not count.
When two entrants' teams play each other it is a "head-to-head" — one gains a point, the other cannot.

HOUSE STYLE — study the examples below and match them
- Always name the entrant alongside the team: "Ben's 49ers", "Adrian's Patriots", "Jordy's Broncos".
- Be funny at the entrants' expense, never mean. Rib the losers, deflate the winners a little.
- Lead with what the result means for the pool, not just what happened in the game.
- Use the real player lines you are given. Never invent a statistic, a player, or a quarter-by-quarter.
- Call out head-to-heads explicitly — they are the most interesting thing that happens in any week.
- Use the phrase "head-to-head", never "collision".
- Point forward: who plays whom next week, who is about to be in trouble.
- Running gags are welcome. Emoji sparingly or not at all.

WHAT THIS PIECE IS
This is a RECAP of Week ${recapWeek}, which is OVER. It is not a preview. Write about what
happened: the games that were played, the scores, who gained ground and who lost it. The bulk of
the piece is the week just finished. Only the "ahead" lines and the last clause of each entrant
note look forward.

FACTUAL DISCIPLINE
- Every game in finalGames has been PLAYED. Recap it in the past tense with the score you are given.
- Write one "games" entry for every game in finalGames, and no entries for anything else.
- nextWeekSchedule has NOT been played. Never score it, never describe how it went, and never
  call any of it a result. Use it only to say who plays whom next.
- Each entrant's weekRecord is what they did in Week ${recapWeek}. Do not describe an entrant as
  "not having played yet" — the week is complete.
- Never invent a statistic, a player or a quarter-by-quarter. Use only the leaders provided.
- A team with no game in finalGames was on a bye that week; say so only if that is the case.

DATES — todayIs in the brief is the real current date
- Never write "tonight", "today", "tomorrow" or "this afternoon" about a scheduled game. Work out
  the relationship between todayIs and the game's day, and name the DAY instead: "Thursday night",
  "Sunday afternoon". If in doubt, name the day and the time and nothing more.
- Do not claim next week begins tonight unless todayIs is genuinely the day of that kickoff.

OUTPUT
Return ONLY valid JSON, no prose around it, matching exactly this shape:

{
  "week": "Week ${recapWeek}",
  "headline": "short, punchy, under 70 characters — about what HAPPENED in Week ${recapWeek}",
  "dek": "one or two sentences summing up the week that was",
  "takeaways": ["3 or 4 short observations about the completed week"],
  "games": [
    { "winKey": "SEA", "winScore": 13, "loseKey": "NE", "loseScore": 10,
      "text": "two or three paragraphs separated by \\n\\n — football detail first, pool consequence second" }
  ],
  "entrants": [
    { "name": "Ben", "result": "2-0", "tone": "good|bad|flat", "text": "one or two sentences on their Week ${recapWeek}, ending with what they face next week" }
  ],
  "ahead": ["2 or 3 lines on Week ${nextWeek}, naming the day of each game"],
  "notes": [
    { "label": "Biggest swing", "value": "short", "sub": "short" },
    { "label": "...", "value": "...", "sub": "..." },
    { "label": "...", "value": "...", "sub": "..." }
  ]
}

Use the exact team abbreviations from the brief for winKey/loseKey, and set "result" from each
entrant's weekRecord. One "games" entry per game in finalGames. One "entrants" entry per entrant,
ordered best week first; you may group entrants who all had identical uneventful weeks into a
single entry with their names joined.

STYLE EXAMPLES FROM PREVIOUS SEASONS
${examples}`;

const MODEL = process.env.RECAP_MODEL || "claude-sonnet-4-5";

// A full week of finals needs far more room than 4k: the prompt asks for two or
// three paragraphs per completed game plus an entry per entrant. If the answer
// is cut off at the cap the JSON is truncated and unparseable, which is how this
// job failed in Week 2 with 4000.
const MAX_TOKENS = Number(process.env.RECAP_MAX_TOKENS || 16000);

async function ask(extraSystem) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: extraSystem ? SYSTEM + "\n\n" + extraSystem : SYSTEM,
      messages: [
        { role: "user", content: `Write the Week ${recapWeek} recap — a look back at the completed week — from this brief.\n\n${JSON.stringify(brief, null, 2)}` },
        // Prefill the opening brace so the reply can only be the JSON object.
        { role: "assistant", content: "{" }
      ]
    })
  });

  if (!res.ok) {
    console.error(`Anthropic API returned ${res.status} ${res.statusText} for model "${MODEL}"`);
    console.error((await res.text()).slice(0, 1200));
    process.exit(1);
  }

  const body = await res.json();
  const stop = body.stop_reason;
  let text = "{" + body.content.map(c => c.text ?? "").join("");
  text = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

  console.log(`model=${MODEL} stop_reason=${stop} in=${body.usage?.input_tokens} out=${body.usage?.output_tokens}/${MAX_TOKENS}`);
  return { text, stop };
}

function parseRecap(text) {
  try { return JSON.parse(text); } catch (e) {}
  // Trailing prose or a stray fence: take the outermost object and retry.
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try { return JSON.parse(text.slice(a, b + 1)); } catch (e) {}
  }
  return null;
}

let { text, stop } = await ask();
let recap = stop === "max_tokens" ? null : parseRecap(text);

if (!recap) {
  // One shorter retry: same facts, less prose, so it fits comfortably.
  console.error(stop === "max_tokens"
    ? `Reply hit the ${MAX_TOKENS}-token cap and was truncated — retrying with a tighter brief.`
    : "First reply did not parse as JSON — retrying with a tighter brief.");
  const r2 = await ask(
    "LENGTH LIMIT: keep every \"games\" text to ONE short paragraph and every " +
    "\"entrants\" text to ONE sentence. Group entrants with identical uneventful " +
    "weeks into a single entry. The complete JSON object must be finished."
  );
  recap = r2.stop === "max_tokens" ? null : parseRecap(r2.text);
  if (!recap) {
    console.error("Still no valid JSON. stop_reason=" + r2.stop + "\nFirst 1200 chars:\n" + r2.text.slice(0, 1200));
    process.exit(1);
  }
}

// Don't overwrite a good recap with a structurally broken one.
if (!recap.headline || !Array.isArray(recap.games) || !Array.isArray(recap.entrants)) {
  console.error("Recap JSON is missing headline/games/entrants — refusing to write it.");
  console.error(JSON.stringify(recap).slice(0, 800));
  process.exit(1);
}
recap.generated = `Written ${season.updated} from the nightly feed`;

recap.week = `Week ${recapWeek}`;
recap.weekNumber = recapWeek;

season.recap = recap;
// Keep the season archive in step: replace this week's entry (or add it).
const archive = (Array.isArray(season.recaps) ? season.recaps : []).filter(r => Number(r.weekNumber) !== recapWeek);
archive.push(recap);
archive.sort((a, b) => Number(a.weekNumber || 0) - Number(b.weekNumber || 0));
season.recaps = archive;
await writeFile("data/season.json", JSON.stringify(season, null, 2));
await writeFile(`data/recap-week-${recapWeek}.json`, JSON.stringify(recap, null, 2));
console.log(`Wrote Week ${recapWeek} recap — "${recap.headline}"`);
