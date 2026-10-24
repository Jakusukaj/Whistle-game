"use strict";
// Leaderboard once per round, and the join link lookup.
var RoomManager = require("./game.js").RoomManager;
var failed = 0;
function check(n, c, extra) { if (c) { console.log("ok   " + n); } else { failed++; console.log("FAIL " + n + (extra ? "  " + extra : "")); } }
function fakeConn() { var c = { roomCode: null, playerId: null, state: null, info: null, errors: [] };
  c.send = function (m) { if (m.t === "state") { c.state = m.state; } if (m.t === "joined") { c.playerId = m.playerId; c.code = m.code; } if (m.t === "roomInfo") { c.info = m; } if (m.t === "error") { c.errors.push(m.code); } };
  return c; }
var m = new RoomManager({ defaultPacks: ["bangers"], revealMs: 0 });
var cs = [fakeConn(), fakeConn(), fakeConn()];
m.handle(cs[0], { t: "create", name: "Ann" });

// --- join link lookup
var q = fakeConn();
m.handle(q, { t: "peek", code: cs[0].code });
check("peek finds an open lobby and names the host", q.info && q.info.found && q.info.host === "Ann" && q.info.state === "open" && q.info.players === 1);
m.handle(q, { t: "peek", code: "ZZZZ" });
check("peek says so when the game does not exist", q.info && q.info.found === false);
m.handle(cs[1], { t: "join", code: cs[0].code, name: "Bob" });
m.handle(cs[2], { t: "join", code: cs[0].code, name: "Cat" });
check("each player gets a colour of their own", [0, 1, 2].map(function (i) { return cs[i].state.players.filter(function (p) { return p.id === cs[i].playerId; })[0].ci; }).join() === "0,1,2");

// --- leaderboard only at the end of a round
m.handle(cs[0], { t: "setRounds", rounds: 2 });
m.handle(cs[0], { t: "start" });
m.handle(q, { t: "peek", code: cs[0].code });
check("peek reports a started game", q.info.state === "started");
var seen = [], nexts = [];
for (var i = 0; i < 6; i++) {
  m.handle(cs[0], { t: "skip" });
  var T = cs[0].state.turn;
  seen.push(T.stage === "reveal" ? T.roundEnd : "?");
  nexts.push(T.nextId);
  if (i < 5) { m.handle(cs[0], { t: "next" }); }
}
check("leaderboard shows after turns 3 and 6 only (3 players, 2 rounds)", seen.join() === "false,false,true,false,false,true", seen.join());
check("the reveal names who is up next, except after the last turn", nexts[0] && nexts[1] && nexts[5] === null);
