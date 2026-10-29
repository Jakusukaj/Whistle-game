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
  var app = createServer({ defaultPacks: ["bangers"], revealMs: 0, limitMs: 3000, countdownMs: 100, confirmMs: 600, cooldownMs: 300 });
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
  await C.waitFor(function (s) { return s.phase === "turn"; }, "game started for C");
  check("first turn belongs to the first player", A.state.turn.playerId === A.playerId);
  check("three turns scheduled", A.state.totalTurns === 3, A.state.totalTurns);
  check("no song before a difficulty is chosen", !A.state.turn.song && !B.state.turn.song);

  check("whistler is offered three songs, one per difficulty", !!A.state.turn.options && A.state.turn.options.length === 3 &&
    A.state.turn.options.map(function (o) { return o.difficulty; }).join() === "easy,medium,hard");
  check("guessers are not offered songs", !B.state.turn.options && !C.state.turn.options);
  check("the three offered songs are all different", new Set(A.state.turn.options.map(function (o) { return o.title; })).size === 3);
  var offeredEasy = A.state.turn.options[0].title;

  B.send({ t: "pickDifficulty", d: "easy" }); await sleep(80);
  check("a non-whistler cannot pick the song", A.state.turn.difficulty === null);

  A.send({ t: "pickDifficulty", d: "easy" });
  await A.waitFor(function (s) { return s.turn.difficulty === "easy"; }, "easy picked");
  await B.waitFor(function (s) { return s.turn.difficulty === "easy"; }, "easy seen by B");
  check("picking the song starts the countdown by itself", A.state.turn.stage === "countdown" || A.state.turn.stage === "whistling");
  check("whistler gets the song they were offered", A.state.turn.song.title === offeredEasy);
  check("guessers do NOT see the song", !B.state.turn.song && !C.state.turn.song);
  A.send({ t: "pickDifficulty", d: "hard" }); await sleep(80);
  check("the choice cannot be changed once made", A.state.turn.difficulty === "easy");
  A.send({ t: "shuffle" }); await sleep(30);
  check("no shuffling before the clock starts", A.state.turn.shuffles === 0);
  var song = A.state.turn.song.title;
  await A.waitFor(stageIs("whistling"), "whistling");
  await B.waitFor(stageIs("whistling"), "whistling seen by B");
  check("clock is running for everyone", B.state.turn.runningSince !== null);

  A.send({ t: "shuffle" });
  await A.waitFor(function (s) { return s.turn.shuffles === 1; }, "shuffle");
  check("shuffle does not lock the screen: a new song is there at once", !A.state.turn.lockUntil && !!A.state.turn.song);
  check("shuffle gives a different song", A.state.turn.song.title !== song);
  check("shuffle keeps the same difficulty", A.state.turn.difficulty === "easy");
  check("the clock keeps running through a shuffle", A.state.turn.runningSince !== null);
  song = A.state.turn.song.title;

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
  var expected = Math.max(0, Math.round(1000 * (1 - res.timeMs / 1000 / 3)) - 100);
  check("score is 1000 x (1 - time / limit), minus 100 for the shuffle", res.score === expected && res.score > 0 && res.score <= 1000, res.score + " vs " + expected);
  check("a shuffle costs 100 points off the multiplied score", res.shuffles === 1 && res.shufflePts === 100 && res.score === res.afterMult - 100, res.afterMult + " / " + res.score);
  var tot = function (c) { return A.state.players.filter(function (p) { return p.id === c.playerId; })[0].total; };
  check("the whistler's points are added to their total", tot(A) === res.score);
  check("the person who was heard guessing is pre-credited with half", tot(C) === Math.round(res.score / 2) && res.awards.length === 2, tot(C));
  check("people who were not named earn nothing", tot(B) === 0);
  check("guessers never saw the song before the reveal", B.songSeen.length === 0 && C.songSeen.length === 0, B.songSeen.join());

  A.send({ t: "next" });
  await B.waitFor(turnId(B.playerId), "turn 2 is Ben's");
  check("turn 2 stage resets to choose", B.stage() === "choose");
  await startTurnAs(cs, B, "hard");
  check("hard multiplier is 1.2", B.state.turn.multiplier === 1.2);
  await B.waitFor(stageIs("reveal"), "timeout reveal", 6000);
  await A.waitFor(stageIs("reveal"), "timeout reveal for A", 6000);
  check("an unguessed turn times out", B.state.turn.result.outcome === "timeout");
  check("a timeout scores nothing, whatever the difficulty", B.state.turn.result.score === 0 && B.state.turn.result.awards.length === 1, B.state.turn.result.score);
  check("timeout still reveals the song", !!B.state.turn.result.song.title && !!A.state.turn.result.song.title);

  A.send({ t: "next" });
  await C.waitFor(turnId(C.playerId), "turn 3 is Cat's");
  await startTurnAs(cs, C, "medium");
  B.send({ t: "hint" }); await sleep(80);
  check("only the whistler can take a hint", B.state.turn.hints === 0 && !B.state.turn.hintLines);
  C.send({ t: "hint" });
  await C.waitFor(function (st) { return !!st.turn.hintLines; }, "hint shown");
  check("hint 1 is a single written hint", C.state.turn.hintLines[0].length > 2 && C.state.turn.hintLines.length === 1, C.state.turn.hintLines.join(" | "));
  await B.waitFor(function (st) { return !!st.turn.hintLines; }, "guessers see the hint");
  check("guessers see the hint too, and never the song", B.state.turn.hintLines.length === 1 && !B.state.turn.song);
  C.send({ t: "hint" }); await C.waitFor(function (st) { return st.turn.hints === 2; }, "hint 2");
  check("hint 2 is a second written hint", C.state.turn.hintLines[1].length > 2 && C.state.turn.hintLines[1] !== C.state.turn.hintLines[0], C.state.turn.hintLines.join(" | "));
  C.send({ t: "hint" }); await C.waitFor(function (st) { return st.turn.hints === 3; }, "hint 3");
  check("hint 3 is the most obvious hint", C.state.turn.hintLines.length === 3 && C.state.turn.hintLines[2].length > 3, C.state.turn.hintLines.join(" | "));
  check("no hint gives away the title", C.state.turn.hintLines.join(" ").toLowerCase().indexOf(C.state.turn.song.title.toLowerCase()) === -1);
  C.send({ t: "hint" }); await sleep(80);
  check("only three hints per song", C.state.turn.hints === 3 && C.state.turn.nextHintCost === null);
  A.send({ t: "mic", state: "off" }); await sleep(80);
  check("a phone can report its mic is off", C.state.players.filter(function (p) { return p.id === A.playerId; })[0].mic === "off");
  C.send({ t: "gotIt" });
  await C.waitFor(stageIs("confirming"), "gotIt asks who");
  check("Someone got it pauses the clock and asks who", C.state.turn.runningSince === null && C.state.turn.pending.manual === true);
  var before = A.state.players.map(function (p) { return p.total; });
  C.send({ t: "confirm", ok: true, who: [A.playerId, B.playerId, C.playerId, "nobody"] });
  await C.waitFor(stageIs("reveal"), "naming reveal");
  var r3 = C.state.turn.result;
  check("whistler names who got it", r3.outcome === "correct" && r3.multiplier === 1.1);
  check("each named guesser is awarded separately, never the whistler twice or a stranger", r3.awards.length === 3 && r3.awards.filter(function (a) { return a.role === "guesser"; }).length === 2, JSON.stringify(r3.awards));
  check("each guesser earns half the whistler's points", r3.awards.filter(function (a) { return a.role === "guesser"; }).every(function (a) { return a.points === Math.round(r3.score / 2); }));
  check("medium is worth 10% more than the same speed on easy", r3.afterMult === Math.round(r3.base * 1.1));
  check("three hints cost 50 + 100 + 150 points", r3.hints === 3 && r3.hintPts === 300 && r3.score === Math.max(0, r3.afterMult - 300 - r3.shufflePts), r3.hintPts + " / " + r3.score);

  A.send({ t: "next" });
  await A.waitFor(function (s) { return s.phase === "gameover"; }, "game over");
  check("game ends with one winner", A.state.winners.length === 1 && A.state.winners[0] === C.playerId, A.state.winners);
  check("no tie-break needed", A.state.tieBreakWon === false);
  var mg = A.state.myGame;
  check("a player gets a game summary for their lifetime stats", !!mg && typeof mg.points === "number" && mg.players === 3 && mg.rank >= 1, JSON.stringify(mg));
  check("the summary agrees with the winners list", mg.won === (A.state.winners.indexOf(A.playerId) !== -1), JSON.stringify(mg));

  A.send({ t: "playAgain" });
  await A.waitFor(function (s) { return s.phase === "lobby"; }, "back to lobby");
  check("play again resets scores", A.state.players.every(function (p) { return p.total === 0; }));
  check("play again keeps the players", A.state.players.length === 3);

  cs.forEach(function (c) { c.close(); });
  app.server.close();
}

async function skipAndLeaveScenario() {
  console.log("\n--- Scenario 2: skip, leave, late joiner ---");
  var app = createServer({ defaultPacks: ["bangers"], revealMs: 0, limitMs: 1500, countdownMs: 100, confirmMs: 600, cooldownMs: 300 });
  await new Promise(function (r) { app.server.listen(0, r); });
  var port = app.server.address().port;
  var cs = await newRoom(port, ["Ann", "Ben", "Cat"]);
  var A = cs[0], B = cs[1], C = cs[2];
  A.send({ t: "setRounds", rounds: 1 }); await sleep(60);
  A.send({ t: "start" });
  await A.waitFor(function (s) { return s.phase === "turn"; }, "started");

  var late = new Client(port, "Late"); await late.open;
  late.send({ t: "join", code: A.code, name: "Late" }); await sleep(80);
  check("a game in progress can be joined", late.errors.length === 0);
  late.close();

  B.send({ t: "skip" }); await sleep(80);
  check("only the host can skip", B.errors.indexOf("not_host") !== -1 && A.stage() === "choose");
  A.send({ t: "skip" });
  await A.waitFor(stageIs("reveal"), "skipped");
  check("a skipped turn scores nothing", A.state.turn.result.outcome === "skipped" && A.state.turn.result.score === 0, A.state.turn.result.score);

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
  var app = createServer({ defaultPacks: ["bangers"], revealMs: 0, limitMs: 1500, countdownMs: 100, confirmMs: 600, cooldownMs: 300 });
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
  var app = createServer({ defaultPacks: ["bangers"], revealMs: 0, limitMs: 600, countdownMs: 50, confirmMs: 400, cooldownMs: 200 });
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
  X.send({ t: "gotIt" }); await X.waitFor(stageIs("confirming"), "x asks who");
  X.send({ t: "confirm", ok: true, who: [Y.playerId] }); await X.waitFor(stageIs("reveal"), "x sd reveal");
  check("tie-break guessers earn no points", X.state.turn.result.awards.length === 1);
  X.send({ t: "next" }); await Y.waitFor(turnId(Y.playerId), "y sd turn");
  Y.send({ t: "ready" }); await Y.waitFor(stageIs("whistling"), "y whistling");
  await Y.waitFor(stageIs("reveal"), "y sd timeout", 2000);
  X.send({ t: "next" });
  await X.waitFor(function (s) { return s.phase === "gameover"; }, "gameover");
  check("higher scorer wins the tie-break", X.state.winners.length === 1 && X.state.winners[0] === X.playerId, X.state.winners);
  check("game over says it was settled by tie-break", X.state.tieBreakWon === true);
  var xs = X.state.players.filter(function (p) { return p.id === X.playerId; })[0];
  var ys = X.state.players.filter(function (p) { return p.id === Y.playerId; })[0];
  check("tie-break scores do not change the totals", xs.total === 0 && ys.total === 0, xs.total + "/" + ys.total);

  cs.forEach(function (c) { c.close(); });
  app.server.close();
}

async function endlessTieScenario() {
  console.log("\n--- Scenario 5: tie that cannot be broken ---");
  var app = createServer({ defaultPacks: ["bangers"], revealMs: 0, limitMs: 300, countdownMs: 30, confirmMs: 300, cooldownMs: 100 });
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
