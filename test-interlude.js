"use strict";
var G = require("./game.js");
var m = new G.RoomManager({}), failed = 0;
function check(n, c) { if (c) { console.log("ok   " + n); } else { failed++; console.log("FAIL " + n); } }
function mk(rounds, stats, turnPos) {
  var room = { rounds: rounds, players: [{ id: "a" }, { id: "b" }, { id: "c" }], stats: stats, turnCounter: 5, turns: [], turnPos: 0 };
  for (var r = 1; r <= rounds; r++) { ["a", "b", "c"].forEach(function (id) { room.turns.push({ playerId: id, round: r, sd: false }); }); }
  room.turnPos = turnPos === undefined ? Math.ceil(rounds / 2) * 3 : turnPos;
  return room;
}
var S = function (p, w, g) { return { whistles: w, whistlePts: p * w, guessed: g, guessBestMs: 3000 }; };
var r = mk(6, { a: S(900, 3, 4), b: S(300, 3, 1), c: S(600, 3, 2) }); m.maybeInterlude(r);
check("six rounds: interlude after round 3", !!r.interlude && r.interlude.performer.id === "a" && r.interlude.worst.id === "b" && r.interlude.guesser.id === "a");
var r2 = mk(3, { a: S(900, 1, 4), b: S(300, 1, 1), c: S(600, 1, 2) }, 3); m.maybeInterlude(r2);
check("three rounds or fewer: no interlude", !r2.interlude);
var r3 = mk(6, { a: S(500, 3, 0), b: S(500, 3, 0), c: S(500, 3, 0) }); m.maybeInterlude(r3);
check("nothing to say when everyone is level", !r3.interlude);
var r4 = mk(4, { a: S(900, 2, 4), b: S(300, 2, 1), c: S(300, 2, 2) }); m.maybeInterlude(r4);
check("four rounds: shows, and does not single out a tied worst", !!r4.interlude && r4.interlude.worst === null);
var r5 = mk(6, { a: S(900, 3, 4), b: S(300, 3, 1), c: S(600, 3, 2) }, 4); m.maybeInterlude(r5);
check("only at the halfway point", !r5.interlude);
console.log(failed ? failed + " FAILED" : "ALL PASSED"); process.exit(failed ? 1 : 0);
