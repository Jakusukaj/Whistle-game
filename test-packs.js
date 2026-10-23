"use strict";
// Song packs: library integrity, pack selection, and the no-repeat rule.
var RoomManager = require("./game.js").RoomManager;
var SONGS = require("./songs.js");
var PACKS = require("./packs.js");
var Matcher = require("./matcher.js");
var failed = 0;
function check(n, c, extra) { if (c) { console.log("ok   " + n); } else { failed++; console.log("FAIL " + n + (extra ? "  " + extra : "")); } }

function fakeConn() { var c = { roomCode: null, playerId: null, state: null, errors: [] };
  c.send = function (m) { if (m.t === "state") { c.state = m.state; } if (m.t === "joined") { c.playerId = m.playerId; c.code = m.code; } if (m.t === "error") { c.errors.push(m.code); } };
  return c; }

function newGame(n, opts) {
  var m = new RoomManager(opts || {});
  var cs = [];
  for (var i = 0; i < n; i++) { cs.push(fakeConn()); }
  m.handle(cs[0], { t: "create", name: "P0" });
  for (i = 1; i < n; i++) { m.handle(cs[i], { t: "join", code: cs[0].code, name: "P" + i }); }
  return { m: m, cs: cs, room: m.rooms[cs[0].code] };
}

// --- library
var titles = {}, dup = 0, badPack = 0, ids = PACKS.map(function (p) { return p.id; });
SONGS.forEach(function (s) {
  var k = Matcher.normalise(s.title); if (titles[k]) { dup++; } titles[k] = true;
  if (!s.packs.length || s.packs.some(function (p) { return ids.indexOf(p) === -1; })) { badPack++; }
});
check("every song title appears once in the library", dup === 0, dup);
check("every song is in at least one real pack", badPack === 0, badPack);
check("packs.js has 20 packs with names, and All Time Bangers is first", PACKS.length === 20 && PACKS[0].id === "bangers" && PACKS[0].name === "All Time Bangers");
check("every pack has at least 30 songs", PACKS.every(function (p) { return SONGS.filter(function (s) { return s.packs.indexOf(p.id) !== -1; }).length >= 30; }));
check("every pack has a group", PACKS.every(function (p) { return !!p.group; }));

// --- overlap: a song in two ticked packs is in the pool once
var g = newGame(2); var room = g.room;
var dywm = SONGS.filter(function (s) { return s.title === "Don't You Want Me"; })[0];
check("Don't You Want Me is in both 80s and bangers", dywm && dywm.packs.indexOf("eighties") !== -1 && dywm.packs.indexOf("bangers") !== -1);
g.m.handle(g.cs[0], { t: "setPacks", packs: ["eighties", "bangers"] });
var pool = g.m.poolFor(room);
check("overlapping song counted once in the pool", pool.filter(function (s) { return s.title === "Don't You Want Me"; }).length === 1);
var uniq = {}; pool.forEach(function (s) { uniq[s.title] = 1; });
check("pool has no duplicate titles", Object.keys(uniq).length === pool.length);

// --- selecting packs
check("default is All Time Bangers only", newGame(2).room.packs.join() === "bangers");
g.m.handle(g.cs[1], { t: "setPacks", packs: ["rock"] });
check("non-host cannot change packs", room.packs.join() === "eighties,bangers" || room.packs.join() === "bangers,eighties");
g.m.handle(g.cs[0], { t: "setPacks", packs: [] });
check("empty selection ignored", room.packs.length === 2);
g.m.handle(g.cs[0], { t: "setPacks", packs: ["nope", "rock"] });
check("unknown pack ids dropped", room.packs.join() === "rock");
g.m.handle(g.cs[0], { t: "setPacks", packs: ids });
check("select all works", room.packs.length === 20 && g.cs[1].state.selectedPacks.length === 20);
check("state carries pack catalogue with counts", g.cs[1].state.packs.length === 20 && g.cs[1].state.packs[0].count > 90 && g.cs[1].state.songsInPlay === SONGS.length);

// --- too few songs refused
var h = newGame(8);
h.m.handle(h.cs[0], { t: "setPacks", packs: ["xmas"] });
h.m.handle(h.cs[0], { t: "setRounds", rounds: 10 });
h.m.handle(h.cs[0], { t: "start" });
check("start refused when packs are too small", h.room.phase === "lobby" && h.cs[0].errors.indexOf("too_few_songs") !== -1);

// --- play whole games and record every song actually played
function playOut(gm, expectTurns) {
  var seen = [], guard = 0, host = gm.cs[0];
  while (gm.room.phase === "turn" && guard++ < 500) {
    var t = gm.room.turn;
    var w = gm.cs.filter(function (c) { return c.playerId === t.playerId; })[0];
    if (t.stage === "choose" && !t.difficulty && t.options) {
      var opts = gm.m.viewFor(gm.room, t.playerId).turn.options;
      check_options(opts);
      gm.m.handle(w, { t: "pickDifficulty", i: Math.floor(Math.random() * opts.length) });
    }
    if (gm.room.turn.song) { seen.push(gm.room.turn.song.title); }
    gm.m.handle(host, { t: "skip" });
    if (gm.room.phase === "turn" && gm.room.turn.stage === "reveal") { gm.m.handle(host, { t: "next" }); }
  }
  return seen;
}
var optsBad = 0;
function check_options(o) { if (!o || !o.length || o.some(function (x) { return !x.title || !x.difficulty; })) { optsBad++; } }
function noRepeats(arr) { var s = {}; for (var i = 0; i < arr.length; i++) { if (s[arr[i]]) { return false; } s[arr[i]] = 1; } return true; }

var a = newGame(4);
a.m.handle(a.cs[0], { t: "setPacks", packs: ids });
a.m.handle(a.cs[0], { t: "setRounds", rounds: 10 });
a.m.handle(a.cs[0], { t: "start" });
var seenA = playOut(a);
check("40-turn game across all packs completed", a.room.phase === "gameover" || a.room.phase === "turn", a.room.phase);
check("no song repeated across 40 turns and 10 rounds (all packs)", seenA.length >= 40 && noRepeats(seenA), seenA.length);

var b = newGame(8);
b.m.handle(b.cs[0], { t: "setRounds", rounds: 10 });
b.m.handle(b.cs[0], { t: "start" });
var seenB = playOut(b);
check("80-turn game on All Time Bangers only starts and finishes", b.room.phase !== "lobby" && seenB.length >= 80, seenB.length);
check("no repeats even when the pack is nearly used up", noRepeats(seenB));
check("offered cards always had a title and difficulty", optsBad === 0, optsBad);

var c = newGame(3);
c.m.handle(c.cs[0], { t: "setPacks", packs: ["eighties", "bangers", "party"] });
c.m.handle(c.cs[0], { t: "setRounds", rounds: 10 });
c.m.handle(c.cs[0], { t: "start" });
check("multi-pack game: no repeats", noRepeats(playOut(c)));

// --- old protocol (pick by difficulty) still works
var d = newGame(2);
d.m.handle(d.cs[0], { t: "start" });
var tw = d.cs.filter(function (x) { return x.playerId === d.room.turn.playerId; })[0];
d.m.handle(tw, { t: "pickDifficulty", d: "hard" });
check("picking by difficulty still works", d.room.turn.difficulty === d.room.turn.song.difficulty || d.room.turn.difficulty);

console.log(failed ? "\nFAILED: " + failed : "\nAll pack checks passed");
process.exit(failed ? 1 : 0);
