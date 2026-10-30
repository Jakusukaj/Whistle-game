"use strict";
// Anonymous game timing, so the lobby's length estimate can be checked against real games.
// No names, codes or songs are recorded. Events are kept in memory, printed as "[stats] {...}" log lines
// and appended to a JSONL file. On a host with a throwaway disk (Render's free tier) the file is cleared on
// each deploy or restart, but the log lines stay in the host's log viewer.
var fs = require("fs"), path = require("path");

var FILE = process.env.STATS_FILE || path.join(__dirname, "data", "stats.jsonl");
var MAX = 20000;
var events = [];
var persist = process.env.STATS_OFF !== "1" && process.env.npm_lifecycle_event !== "test";

function load() {
  try {
    fs.readFileSync(FILE, "utf8").split("\n").forEach(function (l) {
      if (l) { try { events.push(JSON.parse(l)); } catch (e) {} }
    });
  } catch (e) {}
}
if (persist) { load(); }

function record(type, data) {
  var ev = Object.assign({ type: type, at: Date.now() }, data);
  events.push(ev);
  if (events.length > MAX) { events.shift(); }
  if (!persist) { return ev; }
  var line = JSON.stringify(ev);
  console.log("[stats] " + line);
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.appendFileSync(FILE, line + "\n"); } catch (e) {}
  return ev;
}

function avg(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : null; }
function median(a) {
  if (!a.length) { return null; }
  var s = a.slice().sort(function (x, y) { return x - y; }), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function r1(n) { return n === null ? null : Math.round(n * 10) / 10; }

// The estimate the lobby shows, repeated here so it can be compared with what really happened.
function estimateMin(players, rounds, limitMs) {
  return (30 + 0.3 * limitMs / 1000) * players * rounds / 60 + (rounds >= 4 ? 8 / 60 : 0);
}

function recentGames(n) {
  return events.filter(function (e) { return e.type === "game"; }).slice(-n).reverse().map(function (g) {
    return { at: g.at, finished: g.finished, players: g.players, rounds: g.rounds, limitMs: g.limitMs, turns: g.turns, minutes: r1(g.durationMs / 60000) };
  });
}

// How well voice guessing is working: of the guesses the game heard, how many did the performer accept.
function voiceStats(turns) {
  var det = 0, rej = 0, bySrc = { voice: 0, typed: 0, manual: 0 };
  turns.forEach(function (t) { det += t.detected || 0; rej += t.rejected || 0; if (bySrc[t.source] !== undefined) { bySrc[t.source]++; } });
  return { heardGuesses: det, rejectedByPerformer: rej, rejectRate: det ? Math.round(100 * rej / det) / 100 : null, correctBySource: bySrc };
}
function packStats(turns) {
  var c = {}; turns.forEach(function (t) { (t.packs || []).forEach(function (p) { c[p] = (c[p] || 0) + 1; }); });
  return Object.keys(c).sort(function (x, y) { return c[y] - c[x]; }).slice(0, 8).map(function (p) { return { pack: p, turns: c[p] }; });
}
// Songs played at least twice: the ones nobody gets, and the quickest.
function songStats(turns) {
  var m = {};
  turns.forEach(function (t) { if (!t.song) { return; } var x = m[t.song] = m[t.song] || { song: t.song, plays: 0, guessed: 0, secs: [] }; x.plays++; if (t.outcome === "correct") { x.guessed++; x.secs.push(t.performMs / 1000); } });
  var list = Object.keys(m).map(function (k) { return m[k]; }).filter(function (x) { return x.plays >= 2; });
  return {
    hardest: list.slice().sort(function (a, b) { return a.guessed / a.plays - b.guessed / b.plays || b.plays - a.plays; }).slice(0, 5).map(function (x) { return { song: x.song, plays: x.plays, guessed: x.guessed }; }),
    quickest: list.filter(function (x) { return x.guessed; }).sort(function (a, b) { return avg(a.secs) - avg(b.secs); }).slice(0, 5).map(function (x) { return { song: x.song, plays: x.plays, avgGuessSec: r1(avg(x.secs)) }; })
  };
}
function micTotals(done) {
  var t = {}; done.forEach(function (g) { Object.keys(g.mics || {}).forEach(function (k) { t[k] = (t[k] || 0) + g.mics[k]; }); }); return t;
}

function pct(n, d) { return d ? Math.round(100 * n / d) : null; }
function tally(list, f) { var c = {}; list.forEach(function (e) { var k = f(e); c[k] = (c[k] || 0) + 1; }); return c; }
function helpStats() {
  var u = events.filter(function (e) { return e.type === "usage"; });
  var taps = u.filter(function (e) { return e.ev === "help"; });
  var by = tally(taps, function (e) { return e.screen + " (" + e.role + ")"; });
  var list = Object.keys(by).sort(function (x, y) { return by[y] - by[x]; }).map(function (k) { return { screen: k, taps: by[k], share: pct(by[k], taps.length) }; });
  var scr = tally(taps, function (e) { return e.screen; });
  var screens = Object.keys(scr).sort(function (x, y) { return scr[y] - scr[x]; }).map(function (k) { return { screen: k, taps: scr[k], share: pct(scr[k], taps.length) }; });
  var fp = tally(u.filter(function (e) { return e.ev === "first_yes" || e.ev === "first_no"; }), function (e) { return e.ev; });
  return { helpTaps: taps.length, byScreen: screens, byScreenAndRole: list.slice(0, 12), howToOpened: tally(u.filter(function (e) { return e.ev === "howto"; }), function (e) { return e.from; }),
    playedBefore: { yes: fp.first_yes || 0, no: fp.first_no || 0 }, mute: { muted: u.filter(function (e) { return e.ev === "mute"; }).length, unmuted: u.filter(function (e) { return e.ev === "unmute"; }).length } };
}
function deviceStats() {
  var d = events.filter(function (e) { return e.type === "device"; });
  return { visits: d.length, browsers: tally(d, function (e) { return e.browser; }), os: tally(d, function (e) { return e.os; }),
    speechSupportPct: pct(d.filter(function (e) { return e.speech; }).length, d.length), vibrationSupportPct: pct(d.filter(function (e) { return e.vibrate; }).length, d.length), installedPct: pct(d.filter(function (e) { return e.installed; }).length, d.length) };
}
function funnelStats(games, done) {
  var ab = games.filter(function (g) { return !g.finished && g.plannedTurns; });
  return {
    playAgainRate: done.length ? Math.round(100 * events.filter(function (e) { return e.type === "again"; }).length / done.length) / 100 : null,
    avgLobbyMin: r1(avg(games.filter(function (g) { return g.lobbyMs; }).map(function (g) { return g.lobbyMs / 60000; }))),
    abandonedAtPct: r1(avg(ab.map(function (g) { return 100 * g.turns / g.plannedTurns; })))
  };
}

function summary() {
  var games = events.filter(function (e) { return e.type === "game"; });
  var done = games.filter(function (g) { return g.finished && g.turns > 0; });
  var turns = events.filter(function (e) { return e.type === "turn" && !e.sd && e.outcome !== "skipped"; });
  var guessed = turns.filter(function (t) { return t.outcome === "correct"; });
  var mins = done.map(function (g) { return g.durationMs / 60000; });
  var perTurn = done.map(function (g) { return g.durationMs / 1000 / g.turns; });
  var ratio = done.map(function (g) { return (g.durationMs / 60000) / Math.max(0.1, estimateMin(g.players, g.rounds, g.limitMs)); });
  var by = {};
  done.forEach(function (g) {
    var k = g.players <= 3 ? "2-3" : g.players <= 6 ? "4-6" : g.players <= 10 ? "7-10" : "11+";
    (by[k] = by[k] || []).push(g);
  });
  var byPlayers = {};
  Object.keys(by).forEach(function (k) {
    byPlayers[k] = { games: by[k].length, avgGameMin: r1(avg(by[k].map(function (g) { return g.durationMs / 60000; }))), avgSecPerTurn: r1(avg(by[k].map(function (g) { return g.durationMs / 1000 / g.turns; }))) };
  });
  var byLimit = {};
  guessed.forEach(function (t) { var k = String(t.limitMs / 1000) + "s"; (byLimit[k] = byLimit[k] || []).push(t.performMs / 1000); });
  Object.keys(byLimit).forEach(function (k) { byLimit[k] = { guessedTurns: byLimit[k].length, avgGuessSec: r1(avg(byLimit[k])), medianGuessSec: r1(median(byLimit[k])) }; });
  return {
    gamesStarted: games.length, gamesFinished: done.length, gamesAbandoned: games.length - done.length,
    avgGameMin: r1(avg(mins)), medianGameMin: r1(median(mins)),
    avgSecPerTurn: r1(avg(perTurn)), medianSecPerTurn: r1(median(perTurn)),
    turnsRecorded: turns.length, guessRate: turns.length ? Math.round(100 * guessed.length / turns.length) / 100 : null,
    avgGuessSec: r1(avg(guessed.map(function (t) { return t.performMs / 1000; }))),
    medianGuessSec: r1(median(guessed.map(function (t) { return t.performMs / 1000; }))),
    avgHintsPerTurn: r1(avg(turns.map(function (t) { return t.hints || 0; }))),
    avgShufflesPerTurn: r1(avg(turns.map(function (t) { return t.shuffles || 0; }))),
    estimateAccuracy: { avgActualOverEstimate: r1(avg(ratio)), note: "1 means the lobby estimate was right, above 1 means games ran longer than shown" },
    help: helpStats(), devices: deviceStats(), funnel: funnelStats(games, done),
    voice: voiceStats(turns), packsPlayed: packStats(turns), songs: songStats(turns),
    games: { avgLateJoiners: r1(avg(done.map(function (g) { return g.lateJoiners || 0; }))), mics: micTotals(done) },
    byPlayers: byPlayers, byLimit: byLimit
  };
}

function persistentNow() { return persist; }
module.exports = { recentGames: recentGames, persistent: persistentNow, record: record, summary: summary, estimateMin: estimateMin, _events: events };
