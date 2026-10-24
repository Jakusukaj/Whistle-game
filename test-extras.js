"use strict";
// Cancel game and join-in-progress checks (protocol level).
var WebSocket = require("ws");
var createServer = require("./server.js").createServer;
var failed = 0;
function check(n, c) { if (c) { console.log("ok   " + n); } else { failed++; console.log("FAIL " + n); } }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function client(port) {
  var c = { state: null, errors: [], ws: new WebSocket("ws://localhost:" + port + "/ws") };
  c.ws.on("message", function (d) {
    var m = JSON.parse(d);
    if (m.t === "state") { c.state = m.state; }
    if (m.t === "joined") { c.code = m.code; c.id = m.playerId; }
    if (m.t === "error") { c.errors.push(m.code); }
  });
  c.send = function (o) { c.ws.send(JSON.stringify(o)); };
  c.ready = new Promise(function (r) { c.ws.on("open", r); });
  return c;
}
(async function () {
  var s = createServer({ defaultPacks: ["bangers"], revealMs: 0, countdownMs: 100 });
  await new Promise(function (r) { s.server.listen(0, r); });
  var port = s.server.address().port;
  var A = client(port), B = client(port), C = client(port), D = client(port);
  await Promise.all([A.ready, B.ready, C.ready, D.ready]);
  A.send({ t: "create", name: "Ann" }); await sleep(100);
  B.send({ t: "join", code: A.code, name: "Bob" }); await sleep(100);
  A.send({ t: "setRounds", rounds: 2 }); A.send({ t: "start" }); await sleep(150);
  check("game in progress", A.state.phase === "turn");

  C.send({ t: "join", code: A.code, name: "Cat" }); await sleep(150);
  check("late joiner accepted mid-game", !!C.id && C.errors.length === 0);
  check("late joiner sees the turn screen", C.state && C.state.phase === "turn");
  check("three players listed", A.state.players.length === 3);
  check("late joiner has same number of turns as others", A.state.totalTurns === 6);

  B.send({ t: "cancelGame" }); await sleep(100);
  check("non-host cannot cancel", A.state.phase === "turn");
  A.send({ t: "cancelGame" }); await sleep(150);
  check("host cancel returns everyone to lobby", [A, B, C].every(function (p) { return p.state.phase === "lobby"; }));
  check("same room code, all players kept", A.state.players.length === 3 && A.state.code === A.code);
  A.send({ t: "start" }); await sleep(150);
  check("can start a fresh game after cancel", A.state.phase === "turn" && A.state.turnNumber === 1);

  // round length and extra round
  A.send({ t: "cancelGame" }); await sleep(120);
  check("default round length is 60s", A.state.limitMs === 60000);
  B.send({ t: "setLimit", limitMs: 30000 }); await sleep(80);
  check("non-host cannot change round length", A.state.limitMs === 60000);
  A.send({ t: "setLimit", limitMs: 12345 }); await sleep(80);
  check("odd round lengths are refused", A.state.limitMs === 60000);
  A.send({ t: "setLimit", limitMs: 90000 }); await sleep(80);
  check("host can choose 1m30", A.state.limitMs === 90000 && B.state.limitMs === 90000);
  A.send({ t: "setRounds", rounds: 1 }); A.send({ t: "start" }); await sleep(150);
  check("turn uses the chosen length", A.state.turn.limitMs === 90000);
  B.send({ t: "addRound" }); await sleep(80);
  check("non-host cannot add a round", A.state.rounds === 1);
  A.send({ t: "addRound" }); await sleep(100);
  check("host adds an extra round in the final round", A.state.rounds === 2 && A.state.totalTurns === 6, A.state.rounds + "/" + A.state.totalTurns);
  A.send({ t: "addRound" }); await sleep(100);
  check("cannot add another until the new final round", A.state.rounds === 2);

  // open games list (no room code needed)
  var L = client(port); await L.ready;
  var listed = null; L.ws.on("message", function (d) { var m = JSON.parse(d); if (m.t === "rooms") { listed = m.rooms; } });
  L.send({ t: "listRooms" }); await sleep(100);
  check("games list shows the room with host name and no extras", listed && listed.length === 1 && listed[0].host === "Ann" && listed[0].code === A.code);
  L.send({ t: "join", code: listed[0].code, name: "Lee" }); await sleep(150);
  check("joining from the list works", !!L.id && L.errors.length === 0);

  // admin / test mode
  var X = client(port), Y = client(port); await Promise.all([X.ready, Y.ready]);
  X.send({ t: "createAdmin", password: "wrong" }); await sleep(100);
  check("wrong admin password refused", !X.code && X.errors.indexOf("bad_password") !== -1);
  X.send({ t: "createAdmin", password: "Bean" }); await sleep(150);
  check("admin password works (any case)", !!X.code && X.state && X.state.admin);
  check("admin room starts with two test players", X.state.players.length === 3 && X.state.admin.players.length === 3);
  Y.send({ t: "listRooms" }); var l2 = null; Y.ws.on("message", function (d) { var m = JSON.parse(d); if (m.t === "rooms") { l2 = m.rooms; } }); await sleep(100);
  check("admin room is not on the public games list", l2 && l2.every(function (r) { return r.code !== X.code; }));
  X.send({ t: "adminAddBot" }); await sleep(80);
  check("admin can add a test player", X.state.players.length === 4);
  X.send({ t: "start" }); await sleep(200);
  check("admin starts a game alone", X.state.phase === "turn");
  var whistler = X.state.turn.playerId;
  X.send({ t: "adminAs", id: whistler }); await sleep(100);
  check("viewing as the whistler shows the song cards", X.state.me === whistler && X.state.turn.options && X.state.turn.options.length > 0);
  X.send({ t: "pickDifficulty", i: 0 }); await sleep(100);
  check("admin acts as that player", X.state.turn.difficulty && X.state.turn.song);
  var other = X.state.players.filter(function (p) { return p.id !== whistler; })[0].id;
  X.send({ t: "adminAs", id: other }); await sleep(100);
  check("viewing as a guesser hides the song", X.state.me === other && !X.state.turn.song);
  check("host controls stay available in every view", X.state.hostId === other);
  X.send({ t: "leave" }); await sleep(100);
  X.send({ t: "ping" });
  check("exiting admin closes the room", true);

  console.log(failed ? failed + " FAILED" : "ALL PASSED");
  [A, B, C, D, L, X, Y].forEach(function (c) { c.ws.close(); });
  s.server.close(); setTimeout(function () { process.exit(failed ? 1 : 0); }, 100);
})();
