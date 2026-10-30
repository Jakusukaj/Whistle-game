"use strict";
process.env.STATS_OFF = "1";
var A = require("./analytics.js"), failed = 0;
function check(n, c) { if (c) { console.log("ok   " + n); } else { failed++; console.log("FAIL " + n); } }
[600000, 660000, 720000].forEach(function (d) { A.record("game", { finished: true, durationMs: d, players: 4, rounds: 5, limitMs: 60000, turns: 20 }); });
A.record("game", { finished: false, durationMs: 100000, players: 4, rounds: 5, limitMs: 60000, turns: 3 });
[10000, 14000, 20000].forEach(function (p) { A.record("turn", { outcome: "correct", limitMs: 60000, performMs: p, hints: 0, shuffles: 0, players: 4, sd: false }); });
A.record("turn", { outcome: "timeout", limitMs: 60000, performMs: 60000, hints: 1, shuffles: 0, players: 4, sd: false });
var s = A.summary();
check("counts finished and abandoned games", s.gamesFinished === 3 && s.gamesAbandoned === 1);
check("average game length in minutes", s.avgGameMin === 11, s.avgGameMin);
check("seconds per turn", s.avgSecPerTurn === 33, s.avgSecPerTurn);
check("guess rate and average guess time", s.guessRate === 0.75 && s.avgGuessSec === 14.7, s.guessRate + " " + s.avgGuessSec);
check("grouped by player count", s.byPlayers["4-6"] && s.byPlayers["4-6"].games === 3);
check("compares real length with the lobby estimate", typeof s.estimateAccuracy.avgActualOverEstimate === "number");
console.log(failed ? failed + " FAILED" : "ALL PASSED"); process.exit(failed ? 1 : 0);
