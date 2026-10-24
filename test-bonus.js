// Run with: node test-bonus.js
var G = require("./game.js");
var rm = new G.RoomManager({});
var failed = 0;
function check(name, ok) { console.log((ok ? "ok   " : "FAIL ") + name); if (!ok) { failed++; } }

function room(totals, stats, rounds) {
  var r = { rounds: rounds || 5, players: [], stats: {}, endAwards: null };
  Object.keys(totals).forEach(function (n) { r.players.push({ id: n, name: n, total: totals[n], bonus: 0, sitOut: false }); });
  Object.keys(stats).forEach(function (n) {
    r.stats[n] = Object.assign({ whistles: 5, solved: 3, streak: 0, bestStreak: 0, bestTimeMs: 20000, hardSolved: 0, guessed: 0, whistlePts: 1500 }, stats[n]);
  });
  r.players.forEach(function (p) { if (!r.stats[p.id]) { r.stats[p.id] = { whistles: 5, solved: 0, streak: 0, bestStreak: 0, bestTimeMs: Infinity, hardSolved: 0, guessed: 0, whistlePts: 0 }; } });
  return r;
}
function byTitle(r, key) { return (r.endAwards || []).filter(function (d) { return d.key === key; })[0]; }
function get(r, id) { return r.players.filter(function (p) { return p.id === id; })[0]; }

// 1. Clear leader keeps the win even though a trailing player sweeps the awards.
var r = room({ Ann: 4200, Ben: 2600, Cat: 2400 }, {
  Ben: { whistlePts: 2600, guessed: 5, bestStreak: 4, bestTimeMs: 6000, hardSolved: 3 },
  Ann: { whistlePts: 1000, guessed: 1 }
});
rm.applyEndBonuses(r);
check("awards were created", r.endAwards && r.endAwards.length >= 4);
check("Ben swept the awards", byTitle(r, "whistler").winners[0].id === "Ben" && byTitle(r, "guesser").winners[0].id === "Ben");
check("Ben got a bonus but is capped at the maximum", get(r, "Ben").bonus > 0 && get(r, "Ben").bonus <= 400);
check("clear leader is still ahead after bonuses", get(r, "Ann").total > get(r, "Ben").total);
check("totals include the bonus", get(r, "Ben").total === 2600 + get(r, "Ben").bonus);

// 2. A close game can be turned by the bonuses.
r = room({ Ann: 3000, Ben: 2900 }, { Ben: { whistlePts: 3000, guessed: 4, bestStreak: 3, bestTimeMs: 5000 }, Ann: { whistlePts: 900, guessed: 0 } });
rm.applyEndBonuses(r);
check("close game: the trailing player can overtake", get(r, "Ben").total > get(r, "Ann").total);

// 3. A far-behind player cannot jump the whole table.
r = room({ Ann: 4000, Ben: 3500, Cat: 1500 }, { Cat: { whistlePts: 3000, guessed: 6, bestStreak: 5, bestTimeMs: 4000, hardSolved: 4 } });
rm.applyEndBonuses(r);
check("a distant player cannot pass the leader", get(r, "Cat").total < get(r, "Ann").total);
check("a distant player cannot pass second place", get(r, "Cat").total < get(r, "Ben").total);

// 4. Runs once, and shorter games get smaller bonuses.
var before = get(r, "Cat").total; rm.applyEndBonuses(r);
check("bonuses are only applied once", get(r, "Cat").total === before);
var short = room({ Ann: 600, Ben: 500 }, { Ben: { whistlePts: 900, guessed: 2 } }, 1);
var long = room({ Ann: 600, Ben: 500 }, { Ben: { whistlePts: 900, guessed: 2 } }, 10);
rm.applyEndBonuses(short); rm.applyEndBonuses(long);
check("longer games have bigger bonuses", byTitle(long, "guesser").bonus > byTitle(short, "guesser").bonus);

// 5. Ties share an award.
r = room({ Ann: 1000, Ben: 1000 }, { Ann: { guessed: 3 }, Ben: { guessed: 3 } });
rm.applyEndBonuses(r);
check("tied players share an award", byTitle(r, "guesser").winners.length === 2);
console.log(failed ? "\nFAILED " + failed : "\nALL PASSED");
process.exit(failed ? 1 : 0);
