// End-of-game awards are titles only: nobody's score changes. Run with: node test-awards.js
var G = require("./game.js");
var rm = new G.RoomManager({});
var failed = 0;
function check(name, ok, extra) { console.log((ok ? "ok   " : "FAIL ") + name + (!ok && extra !== undefined ? "  " + extra : "")); if (!ok) { failed++; } }

var BLANK = { whistles: 5, solved: 0, streak: 0, bestStreak: 0, bestTimeMs: Infinity, slowestMs: 0, hardSolved: 0, guessed: 0, whistlePts: 0, guessBestMs: Infinity, hintAsks: 0, shuffles: 0, packs: {} };
function room(totals, stats, rounds) {
  var r = { rounds: rounds || 5, players: [], stats: {}, endAwards: null };
  Object.keys(totals).forEach(function (n) { r.players.push({ id: n, name: n, total: totals[n], bonus: 0, sitOut: false }); });
  r.players.forEach(function (p) { r.stats[p.id] = Object.assign({}, BLANK, stats[p.id] ? Object.assign({ solved: 3, bestTimeMs: 20000, slowestMs: 20000, whistlePts: 1500 }, stats[p.id]) : {}); });
  return r;
}
function byKey(r, key) { return (r.endAwards || []).filter(function (d) { return d.key === key; })[0]; }
function get(r, id) { return r.players.filter(function (p) { return p.id === id; })[0]; }

// 1. A trailing player sweeps the awards and the scores do not move.
var r = room({ Ann: 4200, Ben: 2600, Cat: 2400 }, {
  Ben: { whistlePts: 2600, guessed: 5, bestStreak: 4, bestTimeMs: 6000, hardSolved: 3 },
  Ann: { whistlePts: 1000, guessed: 1 }
});
rm.settleAwards(r);
check("awards were created", r.endAwards && r.endAwards.length >= 4, r.endAwards && r.endAwards.length);
check("Ben swept the awards", byKey(r, "whistler").winners[0].id === "Ben" && byKey(r, "guesser").winners[0].id === "Ben");
check("no award carries points", r.endAwards.every(function (d) { return d.bonus === undefined && d.winners.every(function (w) { return w.bonus === undefined; }); }));
check("totals are exactly what they were", get(r, "Ann").total === 4200 && get(r, "Ben").total === 2600 && get(r, "Cat").total === 2400);
check("nobody is credited a bonus", r.players.every(function (p) { return p.bonus === 0; }) && r.bonusCapped === false);

// 2. A close game stays as the scoreboard had it.
r = room({ Ann: 3000, Ben: 2900 }, { Ben: { whistlePts: 3000, guessed: 4, bestStreak: 3, bestTimeMs: 5000 }, Ann: { whistlePts: 900, guessed: 0 } });
rm.settleAwards(r);
check("close game: awards cannot change who is ahead", get(r, "Ann").total > get(r, "Ben").total);

// 3. Runs once.
var first = r.endAwards; rm.settleAwards(r);
check("awards are only worked out once", r.endAwards === first);

// 4. Ties share an award.
r = room({ Ann: 1000, Ben: 1000 }, { Ann: { guessed: 3 }, Ben: { guessed: 3 } });
rm.settleAwards(r);
check("tied players share an award", byKey(r, "guesser").winners.length === 2);

// 5. The new awards.
r = room({ Ann: 1000, Ben: 900, Cat: 800 }, {
  Ann: { slowestMs: 47500, solved: 2 }, Ben: { hintAsks: 5 }, Cat: { shuffles: 3, hintAsks: 1 }
});
rm.settleAwards(r);
check("Slow burner goes to the longest solved whistle", byKey(r, "slowest") && byKey(r, "slowest").winners[0].id === "Ann" && /47\.5 seconds/.test(byKey(r, "slowest").winners[0].detail), JSON.stringify(byKey(r, "slowest")));
check("Hint beggar goes to whoever asked most", byKey(r, "beggar") && byKey(r, "beggar").winners[0].id === "Ben" && byKey(r, "beggar").winners.length === 1);
check("Shuffle merchant goes to whoever shuffled most", byKey(r, "shuffler") && byKey(r, "shuffler").winners[0].id === "Cat");
check("one hint ask is not enough for an award", byKey(r, "beggar").winners.every(function (w) { return w.id !== "Cat"; }));

// 6. Never more than fit on one screen.
r = room({ Ann: 1000, Ben: 900 }, {
  Ann: { whistlePts: 3000, guessed: 4, bestStreak: 3, bestTimeMs: 5000, slowestMs: 40000, hardSolved: 3, hintAsks: 4, shuffles: 3 }, Ben: { guessed: 1 }
});
rm.settleAwards(r);
check("at most six awards are shown", r.endAwards.length <= 6, r.endAwards.length);
check("the old name still works", typeof rm.applyEndBonuses === "function");

console.log(failed ? "\nFAILED " + failed : "\nALL PASSED");
process.exit(failed ? 1 : 0);
