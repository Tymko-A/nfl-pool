// Writes this week's recap by sending the week's real numbers to Claude,
// in the house style defined by style/examples.md.
//
//   ANTHROPIC_API_KEY=sk-... node scripts/recap.mjs
//
// Run by .github/workflows/recap.yml on Tuesday mornings, after MNF.
// Every number in the prompt comes from data/season.json — the model writes
// the sentences, never the stats.

import { readFile, writeFile } from "node:fs/promises";

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) { console.error("ANTHROPIC_API_KEY is not set"); process.exit(1); }

const season = JSON.parse(await readFile("data/season.json", "utf8"));
const examples = await readFile("style/examples.md", "utf8");

const owner = {};
season.entries.forEach(e => { owner[e.afc] = e.name; owner[e.nfc] = e.name; });

// ── build the standings the same way the site does ─────────────────────────
const rows = season.entries.map(e => {
  const a = season.teams[e.afc], n = season.teams[e.nfc];
  const w = a.w + n.w, l = a.l + n.l, t = a.t + n.t;
  const pf = a.pf + n.pf, pa = a.pa + n.pa;
  return { name: e.name, afc: a, nfc: n, w, l, t, pts: w + t * 0.5, net: pf - pa };
});
rows.sort((x, y) => y.pts - x.pts || y.net - x.net);

// ── this week, per entrant ─────────────────────────────────────────────────
const weekly = {};
season.entries.forEach(e => { weekly[e.name] = { wins: 0, losses: 0, ties: 0, net: 0, games: [], pending: [] }; });
for (const g of season.games.filter(g => !g.done)) {
  for (const abbr of [g.away, g.home]) {
    const o = owner[abbr];
    if (o) weekly[o].pending.push(`${season.teams[abbr].name} — ${g.when}`);
  }
}
for (const g of season.games.filter(g => g.done)) {
  for (const [abbr, own, opp] of [[g.away, g.as, g.hs], [g.home, g.hs, g.as]]) {
    const o = owner[abbr];
    if (!o) continue;
    const t = weekly[o];
    t.net += own - opp;
    if (own > opp) t.wins++; else if (own < opp) t.losses++; else t.ties++;
    t.games.push(`${season.teams[abbr].name} ${own}-${opp}`);
  }
}

const finished = season.games.filter(g => g.done).length;
const pending = season.games.filter(g => !g.done).length;

const brief = {
  season: season.season,
  seasonLabel: `${season.season} NFL season`,
  week: season.week,
  weekStatus: pending === 0
    ? "COMPLETE — every pool team has finished playing this week."
    : `IN PROGRESS — ${finished} of ${finished + pending} pool games have finished; ${pending} have NOT been played yet.`,
  gamesFinished: finished,
  gamesNotYetPlayed: pending,
  standings: rows.map((r, i) => ({
    rank: i + 1, entrant: r.name, points: r.pts, record: `${r.w}-${r.l}-${r.t}`,
    net: r.net, afc: `${r.afc.name} ${r.afc.w}-${r.afc.l}`, nfc: `${r.nfc.name} ${r.nfc.w}-${r.nfc.l}`
  })),
  thisWeek: Object.entries(weekly).map(([name, v]) => ({
    entrant: name,
    resultSoFar: `${v.wins}-${v.losses}${v.ties ? "-" + v.ties : ""}`,
    weekNet: v.net,
    finishedGames: v.games,
    stillToPlay: v.pending,
    status: v.pending.length === 0
      ? "both teams have played"
      : v.games.length === 0
        ? `has NOT played yet this week — ${v.pending.length} game(s) still to come`
        : `${v.games.length} played, ${v.pending.length} still to come`
  })),
  finalGames: season.games.filter(g => g.done).map(g => ({
    matchup: `${season.teams[g.away]?.name ?? g.away} at ${season.teams[g.home]?.name ?? g.home}`,
    score: `${g.as}-${g.hs}`,
    awayOwner: owner[g.away] ?? null, homeOwner: owner[g.home] ?? null,
    headToHead: Boolean(owner[g.away] && owner[g.home]),
    leaders: g.leaders
  })),
  upcoming: season.games.filter(g => !g.done).map(g => ({
    matchup: `${season.teams[g.away]?.name ?? g.away} at ${season.teams[g.home]?.name ?? g.home}`,
    when: g.when, awayOwner: owner[g.away] ?? null, homeOwner: owner[g.home] ?? null,
    collision: Boolean(owner[g.away] && owner[g.home])
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

FACTUAL DISCIPLINE — read weekStatus before you write a word
- If weekStatus says IN PROGRESS, the week is NOT over. Write it as a week underway: some results
  in, most still to come. Never summarise it as finished and never crown a weekly winner outright —
  say who leads so far and who can still catch them.
- A team with no result yet this week has NOT PLAYED YET. That is not a bye, not a loss and not a
  draw. Never use the word "bye" unless a team is explicitly described as being on one.
- An entrant showing 0-0 has simply not kicked off yet. Do not write them as having had a bad week
  or a quiet week — they have had no week at all so far.
- Use each entrant's "status" and "stillToPlay" fields to say what is coming, by day and time.
- The only completed games are those in finalGames. Everything in "upcoming" has not happened;
  never describe, score or characterise those games as though they have.

OUTPUT
Return ONLY valid JSON, no prose around it, matching exactly this shape:

{
  "week": "Week N",
  "headline": "short, punchy, under 70 characters",
  "dek": "one or two sentences setting up the week",
  "takeaways": ["3 or 4 short observations"],
  "games": [
    { "winKey": "SEA", "winScore": 13, "loseKey": "NE", "loseScore": 10,
      "text": "two or three paragraphs separated by \\n\\n — football detail first, pool consequence second" }
  ],
  "entrants": [
    { "name": "Ben", "result": "2-0", "tone": "good|bad|flat", "text": "one or two sentences, including what's next for them" }
  ],
  "ahead": ["2 or 3 forward-looking lines"],
  "notes": [
    { "label": "Biggest swing", "value": "short", "sub": "short" },
    { "label": "...", "value": "...", "sub": "..." },
    { "label": "...", "value": "...", "sub": "..." }
  ]
}

Use the exact team abbreviations from the brief for winKey/loseKey. One "games" entry per
completed game. One "entrants" entry per entrant, ordered best week first; you may group
entrants who all had identical uneventful weeks into a single entry with their names joined.

STYLE EXAMPLES FROM PREVIOUS SEASONS
${examples}`;

const res = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-api-key": KEY,
    "anthropic-version": "2023-06-01"
  },
  body: JSON.stringify({
    model: "claude-sonnet-4-5",
    max_tokens: 4000,
    system: SYSTEM,
    messages: [{
      role: "user",
      content: `Write the Week ${season.week} recap from this brief.\n\n${JSON.stringify(brief, null, 2)}`
    }]
  })
});

if (!res.ok) { console.error(await res.text()); process.exit(1); }
const body = await res.json();
let text = body.content.map(c => c.text ?? "").join("").trim();
text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

let recap;
try {
  recap = JSON.parse(text);
} catch (e) {
  console.error("Model did not return valid JSON:\n", text.slice(0, 800));
  process.exit(1);
}
recap.generated = `Written ${season.updated} from the nightly feed`;

season.recap = recap;
await writeFile("data/season.json", JSON.stringify(season, null, 2));
await writeFile(`data/recap-week-${season.week}.json`, JSON.stringify(recap, null, 2));
console.log(`Wrote Week ${season.week} recap — "${recap.headline}"`);
