"use strict";
// Protocol tests: several real WebSocket clients play through the game against
// a real server, with short timers. Run with: node test-game.js
var WebSocket = require("ws");
var createServer = require("./server.js").createServer;

var failures = 0, passes = 0;
function check(name, cond, extra) {
  if (cond) { passes++; } else { failures++; }
  console.log((cond ? "PASS " : "FAIL ") + name + (!cond && extra !== undefined ? "  [" + extra + "]" : ""));
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function Client(port, label) {
  var self = this;
  this.label = label;
  this.state = null; this.errors = []; this.feedback = []; this.songSeen = [];
  this.playerId = null; this.code = null; this.waiters = [];
  this.open = new Promise(function (resolve) {
    self.ws = new WebSocket("ws://localhost:" + port + "/ws");
    self.ws.on("open", resolve);
  });
  this.ws.on("message", function (data) {
    var m = JSON.parse(data.toString());
    if (m.t === "state") {
      self.state = m.state;
      if (m.state.turn && m.state.turn.song) { self.songSeen.push(m.state.turn.song.title); }
      self.waiters = self.waiters.filter(function (w) {
        if (w.pred(self.state)) { clearTimeout(w.timer); w.resolve(self.state); return false; }
        return true;
      });
    } else if (m.t === "joined") { self.playerId = m.playerId; self.code = m.code; }
    else if (m.t === "error") { self.errors.push(m.code); }
    else if (m.t === "guessFeedback") { self.feedback.push(m); }
  });
}
Client.prototype.send = function (o) { this.ws.send(JSON.stringify(o)); };
Client.prototype.waitFor = function (pred, label, ms) {
  var self = this;
  if (this.state && pred(this.state)) { return Promise.resolve(this.state); }
  return new Promise(function (resolve, reject) {
    var w = { pred: pred, resolve: resolve };
    w.timer = setTimeout(function () { reject(new Error("Timed out waiting for: " + label + " (" + self.label + ")")); }, ms || 4000);
    self.waiters.push(w);
  });
};
Client.prototype.close = function () { this.ws.close(); };
Client.prototype.stage = function () { return this.state && this.state.turn ? this.state.turn.stage : null; };

function stageIs(s) { return function (st) { return st.turn && st.turn.stage === s; }; }
function turnId(id) { return function (st) { return st.turn && st.turn.playerId === id; }; }

async function newRoom(port, names) {
  var clients = [];
  var host = new Client(port, names[0]); await host.open;
  host.send({ t: "create", name: names[0] });
  await host.waitFor(function (s) { return s.phase === "lobby"; }, "lobby");
  clients.push(host);
  for (var i = 1; i < names.length; i++) {
    var c = new Client(port, names[i]); await c.open;
    c.send({ t: "join", code: host.code, name: names[i] });
    await c.waitFor(function (s) { return s.phase === "lobby"; }, "joined lobby");
    clients.push(c);
  }
  await host.waitFor(function (s) { return s.players.length === names.length; }, "all joined");
  return clients;
}

async function startTurnAs(clients, whistler, difficulty) {
  var w = whistler;
  w.send({ t: "pickDifficulty", d: difficulty });
  await w.waitFor(function (s) { return s.turn && s.turn.difficulty === difficulty; }, "difficulty picked");
  w.send({ t: "ready" });
  await w.waitFor(stageIs("whistling"), "whistling");
}

async function mainScenario() {
  console.log("\n--- Scenario 1: full game, three players ---");
  // Short timers so the test runs fast. In the real game the limit is 60s and
  // a shuffle costs 5s; the maths is the same.
  var app = createServer({ limitMs: 3000, countdownMs: 100, confirmMs: 600, cooldownMs: 300, shufflePenaltyS: 0.5 });
  await new Promise(function (r) { app.server.listen(0, r); });
  var port = app.server.address().port;

  var cs = await newRoom(port, ["Ann", "Ben", "Cat"]);
  var A = cs[0], B = cs[1], C = cs[2];
  check("room code is four letters", /^[A-Z]{4}$/.test(A.code), A.code);

  var dup = new Client(port, "Dup"); await dup.open;
  dup.send({ t: "join", code: A.code, name: "ben" }); await sleep(80);
  check("duplicate name is refused", dup.errors.indexOf("name_taken") !== -1, dup.errors);
  dup.send({ t: "join", code: "ZZZZ", name: "Zed" }); await sleep(80);
  check("unknown room code is refused", dup.errors.indexOf("room_not_found") !== -1, dup.errors);
  dup.close();

  B.send({ t: "start" }); await sleep(80);
  check("only the host can start", B.errors.indexOf("not_host") !== -1 && A.state.phase === "lobby");
  A.send({ t: "setRounds", rounds: 99 }); await sleep(60);
  check("rounds are clamped to 10", A.state.rounds === 10, A.state.rounds);
  A.send({ t: "setRounds", rounds: 1 }); await sleep(60);
  check("host can set rounds", A.state.rounds === 1);

  A.send({ t: "start" });
  await A.waitFor(function (s) { return s.phase === "turn"; }, "game started");
  await B.waitFor(function (s) { return s.phase === "turn"; }, "game started for B");
  check("first turn belongs to the first player", A.state.turn.playerId === A.playerId);
  check("three turns scheduled", A.state.totalTurns === 3, A.state.totalTurns);
  check("no song before a difficulty is chosen", !A.state.turn.song && !B.state.turn.song);

  B.send({ t: "pickDifficulty", d: "easy" }); await sleep(80);
  check("a non-whistler cannot pick the difficulty", A.state.turn.difficulty === null);

  A.send({ t: "pickDifficulty", d: "easy" });
  await A.waitFor(function (s) { return s.turn.difficulty === "easy"; }, "easy picked");
  await B.waitFor(function (s) { return s.turn.difficulty === "easy"; }, "easy seen by B");
  check("whistler sees the song", !!(A.state.turn.song && A.state.turn.song.title));
  check("guessers do NOT see the song", !B.state.turn.song && !C.state.turn.song);
  A.send({ t: "pickDifficulty", d: "hard" }); await sleep(80);
  check("difficulty cannot be changed once chosen", A.state.turn.difficulty === "easy");

  var firstSong = A.state.turn.song.title;
  A.send({ t: "shuffle" });
  await A.waitFor(function (s) { return s.turn.shuffles === 1; }, "shuffle");
  check("shuffle gives a different song", A.state.turn.song.title !== firstSong);
  check("shuffle keeps the same difficulty", A.state.turn.difficulty === "easy");
  var song = A.state.turn.song.title;

  A.send({ t: "ready" });
  await B.waitFor(stageIs("countdown"), "countdown seen by B");
  await A.waitFor(stageIs("whistling"), "whistling");
  await B.waitFor(stageIs("whistling"), "whistling seen by B");
  check("clock is running for everyone", B.state.turn.runningSince !== null);

  B.send({ t: "guess", alts: ["definitely not the song"], typed: true });
  await sleep(100);
  check("a wrong typed guess gets feedback and changes nothing", B.feedback.length === 1 && A.stage() === "whistling");
  B.send({ t: "guess", alts: ["we want pizza tonight"], typed: false });
  await sleep(100);
  check("wrong speech is ignored silently", B.feedback.length === 1 && A.stage() === "whistling");
  A.send({ t: "guess", alts: [song], typed: true }); await sleep(100);
  check("the whistler cannot guess their own song", A.stage() === "whistling");

  B.send({ t: "guess", alts: ["mumble", song.toLowerCase()], typed: false });
  await A.waitFor(stageIs("confirming"), "confirming");
  check("clock pauses on a likely match", A.state.turn.runningSince === null);
  check("whistler is asked to confirm what was heard", !!(A.state.turn.pending && A.state.turn.pending.heard));
  await C.waitFor(stageIs("confirming"), "C sees checking");
  check("other guessers see only that it is being checked", !C.state.turn.pending && !C.state.turn.song);

  var pausedAt = A.state.turn.accumulatedMs;
  A.send({ t: "confirm", ok: false });
  await A.waitFor(stageIs("whistling"), "resumed after no");
  check("a rejected guess resumes the clock", A.state.turn.runningSince !== null && A.state.turn.accumulatedMs === pausedAt);
  B.send({ t: "guess", alts: [song], typed: true }); await sleep(80);
  check("guesses are ignored during the cooldown", A.stage() === "whistling");

  await sleep(350);
  C.send({ t: "guess", alts: [song], typed: true });
  await A.waitFor(stageIs("confirming"), "confirming again");
  B.send({ t: "confirm", ok: true }); await sleep(80);
  check("only the whistler can confirm", A.stage() === "confirming");
  A.send({ t: "confirm", ok: true });
  await B.waitFor(stageIs("reveal"), "reveal");
  await C.waitFor(stageIs("reveal"), "reveal for C");
  await A.waitFor(stageIs("reveal"), "reveal for A");
  var res = B.state.turn.result;
  check("result is a correct guess", res.outcome === "correct");
  check("everyone sees the song at the reveal", res.song.title === song && C.state.turn.result.song.title === song);
  var expected = Math.round(((res.timeMs / 1000) * 1 + 0.5) * 10) / 10;
  check("score is time x multiplier plus the shuffle penalty", res.score === expected && res.score >= 0.5, res.score + " vs " + expected);
  check("score is added to the total", A.state.players.filter(function (p) { return p.id === A.playerId; })[0].total === res.score);
  check("guessers never saw the song before the reveal", B.songSeen.length === 0 && C.songSeen.length === 0, B.songSeen.join());

  A.send({ t: "next" });
  await B.waitFor(turnId(B.playerId), "turn 2 is Ben's");
  check("turn 2 stage resets to choose", B.stage() === "choose");
  await startTurnAs(cs, B, "hard");
  check("hard multiplier is 0.6", B.state.turn.multiplier === 0.6);
  await B.waitFor(stageIs("reveal"), "timeout reveal", 6000);
  await A.waitFor(stageIs("reveal"), "timeout reveal for A", 6000);
  check("an unguessed turn times out", B.state.turn.result.outcome === "timeout");
  check("a timeout scores the full limit, whatever the difficulty", B.state.turn.result.score === 3, B.state.turn.result.score);
  check("timeout still reveals the song", !!B.state.turn.result.song.title && !!A.state.turn.result.song.title);

  A.send({ t: "next" });
  await C.waitFor(turnId(C.playerId), "turn 3 is Cat's");
  await startTurnAs(cs, C, "medium");
  C.send({ t: "gotIt" });
  await C.waitFor(stageIs("reveal"), "gotIt reveal");
  check("whistler can end the turn manually", C.state.turn.result.outcome === "correct" && C.state.turn.result.multiplier === 0.8);

  A.send({ t: "next" });
  await A.waitFor(function (s) { return s.phase === "gameover"; }, "game over");
  check("game ends with one winner", A.state.winners.length === 1 && A.state.winners[0] === C.playerId, A.state.winners);
  check("no tie-break needed", A.state.tieBreakWon === false);

  A.send({ t: "playAgain" });
  await A.waitFor(function (s) { return s.phase === "lobby"; }, "back to lobby");
  check("play again resets scores", A.state.players.every(function (p) { return p.total === 0; }));
  check("play again keeps the players", A.state.players.length === 3);

  cs.forEach(function (c) { c.close(); });
  app.server.close();
}

async function skipAndLeaveScenario() {
  console.log("\n--- Scenario 2: skip, leave, late joiner ---");
  var app = createServer({ limitMs: 1500, countdownMs: 100, confirmMs: 600, cooldownMs: 300 });
  await new Promise(function (r) { app.server.listen(0, r); });
  var port = app.server.address().port;
  var cs = await newRoom(port, ["Ann", "Ben", "Cat"]);
  var A = cs[0], B = cs[1], C = cs[2];
  A.send({ t: "setRounds", rounds: 1 }); await sleep(60);
  A.send({ t: "start" });
  await A.waitFor(function (s) { return s.phase === "turn"; }, "started");

  var late = new Client(port, "Late"); await late.open;
  late.send({ t: "join", code: A.code, name: "Late" }); await sleep(80);
  check("cannot join a game that has started", late.errors.indexOf("game_started") !== -1, late.errors);
  late.close();

  B.send({ t: "skip" }); await sleep(80);
  check("only the host can skip", B.errors.indexOf("not_host") !== -1 && A.stage() === "choose");
  A.send({ t: "skip" });
  await A.waitFor(stageIs("reveal"), "skipped");
  check("a skipped turn scores the full limit", A.state.turn.result.outcome === "skipped" && A.state.turn.result.score === 1.5, A.state.turn.result.score);

  A.send({ t: "next" });
  await B.waitFor(turnId(B.playerId), "Ben's turn");
  B.send({ t: "leave" });
  await A.waitFor(stageIs("reveal"), "leave auto-skips");
  check("leaving mid-turn skips that turn", A.state.turn.result.outcome === "skipped" && A.state.turn.playerId === B.playerId);

  cs.forEach(function (c) { c.close(); });
  app.server.close();
}

async function reconnectScenario() {
  console.log("\n--- Scenario 3: reconnect and host hand-over ---");
  var app = createServer({ limitMs: 1500, countdownMs: 100, confirmMs: 600, cooldownMs: 300 });
  await new Promise(function (r) { app.server.listen(0, r); });
  var port = app.server.address().port;
  var cs = await newRoom(port, ["Ann", "Ben"]);
  var A = cs[0], B = cs[1];
  var code = A.code, aId = A.playerId;
  A.close();
  await B.waitFor(function (s) { return s.hostId === B.playerId; }, "host handed over");
  check("host passes to a connected player", B.state.hostId === B.playerId);
  check("dropped player shows as offline", B.state.players.filter(function (p) { return p.id === aId; })[0].connected === false);

  var A2 = new Client(port, "Ann again"); await A2.open;
  A2.send({ t: "join", code: code, playerId: aId });
  await A2.waitFor(function (s) { return s.phase === "lobby"; }, "rejoined");
  check("rejoin keeps the same player", A2.playerId === aId && A2.state.me === aId);
  await B.waitFor(function (s) { return s.players.every(function (p) { return p.connected; }); }, "back online");
  check("rejoined player shows as online", true);

  A2.close(); B.close();
  app.server.close();
}

async function tieScenario() {
  console.log("\n--- Scenario 4: tie goes to sudden death ---");
  var app = createServer({ limitMs: 600, countdownMs: 50, confirmMs: 400, cooldownMs: 200 });
  await new Promise(function (r) { app.server.listen(0, r); });
  var port = app.server.address().port;
  var cs = await newRoom(port, ["Xia", "Yan"]);
  var X = cs[0], Y = cs[1];
  X.send({ t: "setRounds", rounds: 1 }); await sleep(60);
  X.send({ t: "start" });
  await X.waitFor(function (s) { return s.phase === "turn"; }, "started");
  X.send({ t: "skip" }); await X.waitFor(stageIs("reveal"), "x skipped");
  X.send({ t: "next" }); await Y.waitFor(turnId(Y.playerId), "y turn");
  X.send({ t: "skip" }); await X.waitFor(stageIs("reveal"), "y skipped");
  X.send({ t: "next" });
  await X.waitFor(function (s) { return s.suddenDeath && s.turn; }, "sudden death", 3000);
  check("equal totals trigger sudden death", X.state.suddenDeath === true);
  check("sudden death uses a fixed difficulty with a song ready", X.state.turn.difficulty === "medium" && !!X.state.turn.song);
  check("sudden death turns are flagged", X.state.turn.sd === true);
  check("the other contender cannot see the song", !Y.state.turn.song);

  X.send({ t: "ready" }); await X.waitFor(stageIs("whistling"), "x whistling");
  X.send({ t: "gotIt" }); await X.waitFor(stageIs("reveal"), "x sd reveal");
  X.send({ t: "next" }); await Y.waitFor(turnId(Y.playerId), "y sd turn");
  Y.send({ t: "ready" }); await Y.waitFor(stageIs("whistling"), "y whistling");
  await Y.waitFor(stageIs("reveal"), "y sd timeout", 2000);
  X.send({ t: "next" });
  await X.waitFor(function (s) { return s.phase === "gameover"; }, "gameover");
  check("faster player wins the tie-break", X.state.winners.length === 1 && X.state.winners[0] === X.playerId, X.state.winners);
  check("game over says it was settled by tie-break", X.state.tieBreakWon === true);
  var xs = X.state.players.filter(function (p) { return p.id === X.playerId; })[0];
  var ys = X.state.players.filter(function (p) { return p.id === Y.playerId; })[0];
  check("tie-break scores do not change the totals", xs.total === 0.6 && ys.total === 0.6, xs.total + "/" + ys.total);

  cs.forEach(function (c) { c.close(); });
  app.server.close();
}

async function endlessTieScenario() {
  console.log("\n--- Scenario 5: tie that cannot be broken ---");
  var app = createServer({ limitMs: 300, countdownMs: 30, confirmMs: 300, cooldownMs: 100 });
  await new Promise(function (r) { app.server.listen(0, r); });
  var port = app.server.address().port;
  var cs = await newRoom(port, ["Xia", "Yan"]);
  var X = cs[0], Y = cs[1];
  X.send({ t: "setRounds", rounds: 1 }); await sleep(60);
  X.send({ t: "start" });
  await X.waitFor(function (s) { return s.phase === "turn"; }, "started");
  X.send({ t: "skip" }); await X.waitFor(stageIs("reveal"), "skip 1");
  X.send({ t: "next" }); await X.waitFor(turnId(Y.playerId), "turn 2");
  X.send({ t: "skip" }); await X.waitFor(stageIs("reveal"), "skip 2");
  X.send({ t: "next" });
  for (var round = 1; round <= 3; round++) {
    for (var k = 0; k < 2; k++) {
      await X.waitFor(function (s) { return s.suddenDeath && s.turn && s.turn.stage === "choose"; }, "sd choose r" + round, 3000);
      var who = X.state.turn.playerId === X.playerId ? X : Y;
      who.send({ t: "ready" });
      await X.waitFor(stageIs("reveal"), "sd timeout r" + round, 3000);
      X.send({ t: "next" });
    }
  }
  await X.waitFor(function (s) { return s.phase === "gameover"; }, "gameover after three tie-breaks", 3000);
  check("after three tied tie-breaks both players share the win", X.state.winners.length === 2, X.state.winners);
  cs.forEach(function (c) { c.close(); });
  app.server.close();
}

(async function () {
  try {
    await mainScenario();
    await skipAndLeaveScenario();
    await reconnectScenario();
    await tieScenario();
    await endlessTieScenario();
  } catch (e) {
    failures++;
    console.log("FAIL unexpected error: " + e.message);
  }
  console.log("\nPassed: " + passes + ", failed: " + failures);
  process.exit(failures ? 1 : 0);
})();
