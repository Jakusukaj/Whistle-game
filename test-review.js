"use strict";
// The rules changed after the November 2026 review: scoring floor, split guesser share, buzzing in,
// claiming, one refresh, auto-pick, rotating turn order, the games list and the whistler's grace period.
// Run with: node test-review.js
var G = require("./game.js");
var RoomManager = G.RoomManager;
var SONGS = require("./songs.js");
var failed = 0;
function check(n, c, extra) { if (c) { console.log("ok   " + n); } else { failed++; console.log("FAIL " + n + (extra !== undefined ? "  " + extra : "")); } }

function fakeConn(ip) {
  var c = { roomCode: null, playerId: null, state: null, errors: [], rooms: null, ip: ip };
  c.send = function (m) {
    if (m.t === "state") { c.state = m.state; }
    if (m.t === "joined") { c.playerId = m.playerId; c.code = m.code; }
    if (m.t === "error") { c.errors.push(m.code); }
    if (m.t === "rooms") { c.rooms = m.rooms; }
  };
  return c;
}
var clock = 1000000;
function newGame(n, opts) {
  var m = new RoomManager(Object.assign({ defaultPacks: ["bangers"], revealMs: 0, chooseMs: 0, now: function () { return clock; } }, opts || {}));
  var cs = [];
  for (var i = 0; i < n; i++) { cs.push(fakeConn("81.2.69.142")); }
  m.handle(cs[0], { t: "create", name: "P0" });
  for (i = 1; i < n; i++) { m.handle(cs[i], { t: "join", code: cs[0].code, name: "P" + i }); }
  return { m: m, cs: cs, room: m.rooms[cs[0].code] };
}
// Start the game and get the current whistler to the point where the clock is running.
function whistling(g, difficulty) {
  if (g.room.phase === "lobby") { g.m.handle(g.cs[0], { t: "start" }); }
  var w = g.cs.filter(function (c) { return c.playerId === g.room.turn.playerId; })[0];
  g.m.handle(w, { t: "pickDifficulty", d: difficulty || "easy" });
  g.m.startWhistling(g.room, g.room.turn.id);
  return w;
}
function others(g, w) { return g.cs.filter(function (c) { return c !== w; }); }
function total(g, c) { return g.room.players.filter(function (p) { return p.id === c.playerId; })[0].total; }

(async function () {
  // ---------------------------------------------------------------- players and turn order
  var g = newGame(8);
  check("eight players fit", g.room.players.length === 8);
  var ninth = fakeConn("81.2.69.142");
  g.m.handle(ninth, { t: "join", code: g.cs[0].code, name: "Nine" });
  check("a ninth player is told the room is full", ninth.errors.indexOf("full") !== -1 && g.room.players.length === 8);
  check("eight players get eight different colours", g.cs[0].state.players.map(function (p) { return p.ci; }).sort().join("") === "01234567");

  g = newGame(4); g.m.handle(g.cs[0], { t: "setRounds", rounds: 3 }); g.m.handle(g.cs[0], { t: "start" });
  var ids = g.room.players.map(function (p) { return p.id; });
  var order = function (r) { return g.room.turns.filter(function (t) { return t.round === r; }).map(function (t) { return ids.indexOf(t.playerId); }).join(""); };
  check("round 1 runs in join order", order(1) === "0123", order(1));
  check("round 2 starts one place on, so nobody always goes last", order(2) === "1230", order(2));
  check("round 3 starts one place further on", order(3) === "2301", order(3));
  check("nobody whistles twice running across a round", g.room.turns.every(function (t, i) { return i === 0 || t.playerId !== g.room.turns[i - 1].playerId; }));
  g = newGame(2); g.m.handle(g.cs[0], { t: "setRounds", rounds: 2 }); g.m.handle(g.cs[0], { t: "start" });
  check("with two players the order stays put", g.room.turns.map(function (t) { return t.playerId === g.room.players[0].id ? "a" : "b"; }).join("") === "abab");

  // ---------------------------------------------------------------- scoring
  g = newGame(4);
  var w = whistling(g, "medium"), gs = others(g, w);
  check("medium is worth 1.5 and hard is worth 2", g.room.turn.multiplier === 1.5 && g.m.opts.multipliers.hard === 2 && g.m.opts.multipliers.easy === 1);
  g.m.handle(w, { t: "hint" }); g.m.handle(w, { t: "hint" }); g.m.handle(w, { t: "hint" });
  clock += 50000;
  g.m.handle(gs[0], { t: "guess", alts: [g.room.turn.song.title], typed: true });
  check("a guess with 10 seconds left is still heard", g.room.turn.stage === "confirming");
  g.m.handle(w, { t: "confirm", ok: true, who: gs.map(function (c) { return c.playerId; }) });
  var res = g.room.turn.result;
  check("three hints late in the turn cannot wipe out a correct guess", res.outcome === "correct" && res.afterMult - res.hintPts < 100 && res.score === 100, JSON.stringify([res.afterMult, res.hintPts, res.score]));
  check("three named guessers split one half share", gs.every(function (c) { return total(g, c) === Math.round(100 * 0.5 / 3); }), gs.map(function (c) { return total(g, c); }).join());
  check("naming more people puts no more points on the table", gs.reduce(function (n, c) { return n + total(g, c); }, 0) <= 51);
  check("the reveal says whose phone heard it", res.heardFrom === gs[0].playerId && res.source === "typed");

  g = newGame(3);
  w = whistling(g, "hard"); gs = others(g, w);
  clock += 12400;
  g.m.handle(gs[0], { t: "guess", alts: [g.room.turn.song.title], typed: true });
  g.m.handle(w, { t: "confirm", ok: true, who: [gs[0].playerId] });
  res = g.room.turn.result;
  check("hard at 12.4 seconds: 793 x 2 = 1,586", res.base === 793 && res.afterMult === 1586 && res.score === 1586, JSON.stringify([res.base, res.afterMult, res.score]));
  check("one named guesser earns the whole half share", total(g, gs[0]) === 793);

  // A skipped turn is left out of the whistler's averages.
  g = newGame(3); g.m.handle(g.cs[0], { t: "start" });
  var skippedId = g.room.turn.playerId;
  g.m.handle(g.cs[0], { t: "skip" });
  check("a skipped turn does not count against the whistler's average", !g.room.stats[skippedId] || g.room.stats[skippedId].whistles === 0);

  // ---------------------------------------------------------------- buzzing in
  g = newGame(4);
  w = whistling(g); gs = others(g, w);
  var before = g.room.turn.accumulatedMs;
  clock += 5000;
  g.m.handle(w, { t: "buzz" });
  check("the whistler cannot buzz", g.room.turn.stage === "whistling");
  g.m.handle(gs[0], { t: "buzz" });
  check("a buzz freezes the clock", g.room.turn.stage === "confirming" && g.room.turn.runningSince === null && g.room.turn.accumulatedMs === before + 5000);
  check("every phone is told who buzzed", g.cs.every(function (c) { return c.state.turn.buzzer === gs[0].playerId; }));
  check("the whistler is asked to judge the buzz", w.state.turn.pending && w.state.turn.pending.buzz === true && w.state.turn.pending.from === gs[0].playerId);
  check("guessers never see the song", gs.every(function (c) { return !c.state.turn.song; }));
  g.m.handle(gs[1], { t: "buzz" });
  check("a second buzz whilst one is being judged does nothing", g.room.turn.pending.from === gs[0].playerId);
  g.m.handle(w, { t: "confirm", ok: false });
  check("Wrong restarts the clock", g.room.turn.stage === "whistling" && g.room.turn.runningSince === clock);
  check("the player who buzzed wrongly is told they are locked out", gs[0].state.turn.buzzLockUntil === clock + 5000 && !gs[1].state.turn.buzzLockUntil);
  g.m.handle(gs[0], { t: "buzz" });
  check("a locked-out player cannot buzz again yet", g.room.turn.stage === "whistling");
  g.m.handle(gs[1], { t: "guess", alts: [g.room.turn.song.title], typed: true });
  check("a wrong buzz does not silence everyone else", g.room.turn.stage === "confirming" && g.room.turn.pending.from === gs[1].playerId);
  g.m.handle(w, { t: "confirm", ok: false });
  clock += 5001;
  g.m.handle(gs[0], { t: "buzz" });
  check("the lock-out ends after five seconds", g.room.turn.stage === "confirming" && g.room.turn.pending.from === gs[0].playerId);
  g.m.handle(w, { t: "confirm", ok: true, who: gs.map(function (c) { return c.playerId; }) });
  res = g.room.turn.result;
  check("Right ends the turn for the player who buzzed, whoever else is named", res.outcome === "correct" && res.awards.length === 2 && res.awards[1].id === gs[0].playerId, JSON.stringify(res.awards));
  check("a buzz win is recorded as a buzz", res.source === "buzz" && res.heardFrom === gs[0].playerId);

  // ---------------------------------------------------------------- Someone got it needs a claim
  g = newGame(3);
  w = whistling(g); gs = others(g, w);
  clock += 1200;
  g.m.handle(w, { t: "gotIt" });
  g.m.handle(w, { t: "confirm", ok: true, who: [] });
  check("Someone got it with nobody named carries on", g.room.turn.stage === "whistling");
  g.m.handle(w, { t: "gotIt" });
  var paused = g.room.turn.accumulatedMs;
  g.m.handle(w, { t: "confirm", ok: true, who: [gs[0].playerId] });
  check("naming someone after Someone got it asks them to claim", g.room.turn.stage === "claiming" && gs[0].state.turn.claim.ids[0] === gs[0].playerId);
  g.m.handle(gs[1], { t: "claim" });
  check("a player who was not named cannot claim", g.room.turn.stage === "claiming" && g.room.turn.claim.claimed.length === 0);
  g.m.endClaim(g.room, g.room.turn.id);
  check("nobody claiming means nobody got it: the turn carries on", g.room.turn.stage === "whistling" && g.room.turn.accumulatedMs === paused && !g.room.turn.result);
  check("the whistler cannot end a turn alone", total(g, w) === 0);
  g.m.handle(w, { t: "gotIt" });
  g.m.handle(w, { t: "confirm", ok: true, who: [gs[0].playerId, gs[1].playerId] });
  g.m.handle(gs[0], { t: "claim" });
  check("the turn waits for everyone named", g.room.turn.stage === "claiming");
  g.m.endClaim(g.room, g.room.turn.id);
  res = g.room.turn.result;
  check("when time is up, only those who claimed are paid", res.outcome === "correct" && res.awards.length === 2 && res.awards[1].id === gs[0].playerId, JSON.stringify(res.awards));
  var off = newGame(3, { claimMs: 0 });
  w = whistling(off); gs = others(off, w);
  off.m.handle(w, { t: "gotIt" }); off.m.handle(w, { t: "confirm", ok: true, who: [gs[0].playerId] });
  check("claimMs: 0 switches the claim step off", off.room.turn.stage === "reveal");

  // ---------------------------------------------------------------- choosing
  var a = newGame(3, { chooseMs: 40 });
  a.m.handle(a.cs[0], { t: "start" });
  var aw = a.cs.filter(function (c) { return c.playerId === a.room.turn.playerId; })[0];
  check("the whistler is told when the pick will be made for them", aw.state.turn.chooseEndsAt === clock + 40);
  var middle = a.room.turn.options[1].song.title;
  await new Promise(function (r) { setTimeout(r, 120); });
  check("after the time is up the middle card is picked", a.room.turn.song && a.room.turn.song.title === middle && a.room.turn.stage === "countdown" && a.room.turn.autoPicked === true);
  a.m.clearTimers(a.room.turn);
  var b = newGame(3, { chooseMs: 40 });
  b.m.handle(b.cs[0], { t: "start" });
  var bw = b.cs.filter(function (c) { return c.playerId === b.room.turn.playerId; })[0];
  b.m.disconnect(bw);
  await new Promise(function (r) { setTimeout(r, 120); });
  check("an absent whistler is not picked for", b.room.turn.stage === "choose" && !b.room.turn.song);
  check("everyone is told how long the whistler has to come back", b.cs.filter(function (c) { return c !== bw; })[0].state.turn.awayUntil === clock + 30000);
  b.m.clearTimers(b.room.turn);

  // ---------------------------------------------------------------- reveal timing
  var rv = newGame(3, { revealMs: 8000, roundRevealMs: 11000 });
  rv.m.handle(rv.cs[0], { t: "setRounds", rounds: 1 }); rv.m.handle(rv.cs[0], { t: "start" });
  rv.m.handle(rv.cs[0], { t: "skip" });
  check("the reveal lasts 8 seconds", rv.room.turn.nextAt === clock + 8000);
  rv.m.advance(rv.room); rv.m.handle(rv.cs[0], { t: "skip" }); rv.m.advance(rv.room); rv.m.handle(rv.cs[0], { t: "skip" });
  check("the last turn of a round gets 11 seconds, for the leaderboard", rv.room.turn.nextAt === clock + 11000);
  rv.m.clearTimers(rv.room.turn);

  // ---------------------------------------------------------------- the games list
  g = newGame(2);
  var same = fakeConn("81.2.69.142"), other = fakeConn("203.0.113.9"), unknown = fakeConn(undefined);
  g.m.handle(same, { t: "listRooms" }); g.m.handle(other, { t: "listRooms" }); g.m.handle(unknown, { t: "listRooms" });
  check("a phone on the same network sees the game", same.rooms.length === 1 && same.rooms[0].max === 8);
  check("a phone on another network does not", other.rooms.length === 0);
  check("a visitor with no known address is not shut out", unknown.rooms.length === 1);
  check("the link still works from anywhere", (function () { var c = fakeConn("203.0.113.9"); g.m.handle(c, { t: "join", code: g.cs[0].code, name: "Far" }); return c.errors.length === 0 && g.room.players.length === 3; })());
  var open = newGame(2, { openGamesList: true }), o2 = fakeConn("203.0.113.9");
  open.m.handle(o2, { t: "listRooms" });
  check("openGamesList shows every game to everyone", o2.rooms.length === 1);
  check("IPv4 is compared whole", G.netKey("81.2.69.142") === "81.2.69.142" && G.netKey("::ffff:81.2.69.142") === "81.2.69.142");
  check("IPv6 is compared by its first four groups", G.netKey("2a00:23c7:8d0b:5c01:1cb:8f3:22:1") === G.netKey("2a00:23c7:8d0b:5c01::9") && G.netKey("2a00:23c7:8d0b:5c01::9") !== G.netKey("2a00:23c7:8d0b:5c02::9"));

  // ---------------------------------------------------------------- the host
  g = newGame(3, { hostGraceMs: 0 });
  var hostId = g.room.hostId;
  g.m.disconnect(g.cs[0]);
  check("with no grace period the role passes at once", g.room.hostId === g.cs[1].playerId);
  var back = fakeConn("81.2.69.142");
  g.m.handle(back, { t: "join", code: g.room.code, playerId: hostId, token: g.room.players[0].token });
  check("and still comes back to the original host", g.room.hostId === hostId);
  g.m.handle(back, { t: "leave" });
  check("a host who leaves on purpose gives the role up", g.room.hostId === g.cs[1].playerId && !g.room.origHostId);

  // ---------------------------------------------------------------- titles inside longer titles
  var yellow = SONGS.filter(function (s) { return s.title === "Yellow"; })[0];
  var sub = SONGS.filter(function (s) { return s.title === "Yellow Submarine"; })[0];
  if (yellow && sub) {
    g = newGame(3);
    w = whistling(g); gs = others(g, w);
    g.room.turn.song = yellow;
    g.m.handle(gs[0], { t: "guess", alts: ["yellow submarine"], typed: false });
    check("saying Yellow Submarine is not a guess at Yellow", g.room.turn.stage === "whistling");
    g.m.handle(gs[0], { t: "guess", alts: ["is it yellow"], typed: false });
    check("saying Yellow still is", g.room.turn.stage === "confirming");
    g.m.handle(w, { t: "confirm", ok: false }); clock += 5000;
    g.room.turn.song = sub;
    g.m.handle(gs[0], { t: "guess", alts: ["yellow submarine"], typed: false });
    check("and Yellow Submarine still counts for Yellow Submarine", g.room.turn.stage === "confirming");
  } else { check("Yellow and Yellow Submarine are both in the library", false); }

  console.log(failed ? "\n" + failed + " FAILED" : "\nALL PASSED");
  process.exit(failed ? 1 : 0);
})();
