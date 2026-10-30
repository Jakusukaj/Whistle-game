"use strict";
// Regression checks for the code audit: crash on bad URLs, private reconnect tokens, one room per socket,
// offline performers, removed players cannot win, award breakdowns add up.
var http = require("http");
var WebSocket = require("ws");
var createServer = require("./server.js").createServer;
var RoomManager = require("./game.js").RoomManager;
var failed = 0;
function check(n, c, d) { if (c) { console.log("ok   " + n); } else { failed++; console.log("FAIL " + n + (d ? "  [" + d + "]" : "")); } }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function client(port) {
  var c = { state: null, errors: [], ws: new WebSocket("ws://localhost:" + port + "/ws") };
  c.ws.on("message", function (d) {
    var m = JSON.parse(d);
    if (m.t === "state") { c.state = m.state; }
    if (m.t === "joined") { c.code = m.code; c.id = m.playerId; c.token = m.token; }
    if (m.t === "error") { c.errors.push(m.code); }
  });
  c.send = function (o) { c.ws.send(JSON.stringify(o)); };
  c.ready = new Promise(function (r) { c.ws.on("open", r); });
  return c;
}
function rawGet(port, p) {
  return new Promise(function (resolve) {
    var req = http.request({ host: "localhost", port: port, path: p, method: "GET" }, function (res) { res.resume(); resolve(res.statusCode); });
    req.on("error", function () { resolve(0); });
    req.end();
  });
}

(async function () {
  var s = createServer({ defaultPacks: ["bangers"], revealMs: 0, countdownMs: 100, awayMs: 400 });
  await new Promise(function (r) { s.server.listen(0, r); });
  var port = s.server.address().port;

  // Bad URL encodings answer 400 and the server carries on.
  check("bad URL gets 400", await rawGet(port, "/%") === 400);
  check("bad stats key gets 401 or 400", [400, 401].indexOf(await rawGet(port, "/stats?key=%")) !== -1);
  check("server still answers after bad URLs", await rawGet(port, "/healthz") === 200);

  // Private reconnect tokens.
  var A = client(port), B = client(port), C = client(port);
  await Promise.all([A.ready, B.ready, C.ready]);
  A.send({ t: "create", name: "Ann" }); await sleep(100);
  B.send({ t: "join", code: A.code, name: "Bob" }); await sleep(100);
  check("joined message carries a private token", !!A.token && !!B.token && A.token !== B.token);
  check("tokens are never in the shared state", JSON.stringify(A.state).indexOf(B.token) === -1 && JSON.stringify(B.state).indexOf(A.token) === -1);
  C.send({ t: "join", code: A.code, playerId: B.id, name: "Cat" }); await sleep(100);
  check("someone else's id without the token does not take them over", C.id !== B.id && A.state.players.length === 3);
  var B2 = client(port); await B2.ready;
  B2.send({ t: "join", code: A.code, playerId: B.id, token: B.token, name: "Bob" }); await sleep(100);
  check("the right token takes the seat back", B2.id === B.id);

  // Start: a performer cannot be impersonated by name while their seat is empty.
  A.send({ t: "setRounds", rounds: 1 }); A.send({ t: "start" }); await sleep(250);
  var perfId = A.state.turn.playerId;
  var holder = [A, B2, C].filter(function (x) { return x.id === perfId; })[0];
  holder.ws.close(); await sleep(100);
  var thief = client(port); await thief.ready;
  var pname = A.state.players.filter(function (p) { return p.id === perfId; })[0].name;
  thief.send({ t: "join", code: A.code, name: pname }); await sleep(100);
  check("a performer's seat cannot be taken by name", thief.errors.indexOf("name_taken") !== -1 && thief.id !== perfId);
  var back = client(port); await back.ready;
  back.send({ t: "join", code: A.code, playerId: perfId, token: holder.token, name: pname }); await sleep(100);
  check("the real performer can come back with the token", back.id === perfId);

  // One room per socket: moving rooms leaves the first properly.
  var X = client(port), Y = client(port); await Promise.all([X.ready, Y.ready]);
  X.send({ t: "create", name: "Xan" }); await sleep(100);
  var codeX = X.code;
  Y.send({ t: "join", code: codeX, name: "Yas" }); await sleep(100);
  X.send({ t: "create", name: "Xan" }); await sleep(100);
  var xRoom = s.manager.rooms[codeX];
  var oldX = xRoom.players.filter(function (p) { return p.name === "Xan"; })[0];
  check("moving rooms leaves the old seat disconnected", X.code !== codeX && oldX && !oldX.connected);

  // Offline performer: a player who is gone when their turn comes is skipped after the grace period.
  var P = client(port), Q = client(port), R = client(port); await Promise.all([P.ready, Q.ready, R.ready]);
  P.send({ t: "create", name: "Pat" }); await sleep(100);
  Q.send({ t: "join", code: P.code, name: "Quin" }); R.send({ t: "join", code: P.code, name: "Rae" }); await sleep(150);
  R.ws.close(); await sleep(100);
  P.send({ t: "setRounds", rounds: 1 }); P.send({ t: "start" }); await sleep(250);
  var sawR = false, deadline = Date.now() + 6000, finished = false;
  while (Date.now() < deadline) {
    var st = P.state;
    if (st.phase === "gameover") { finished = true; break; }
    if (st.phase === "turn" && st.turn) {
      var rid = st.players.filter(function (p) { return p.name === "Rae"; })[0].id;
      if (st.turn.playerId === rid) { sawR = true; }
      if (st.turn.stage === "reveal") { P.send({ t: "next" }); }
      else if (st.turn.playerId !== rid) { P.send({ t: "skip" }); }
    }
    await sleep(150);
  }
  check("game gets past a performer who is offline", sawR && finished);

  s.server.close();
  s.wss.close();

  // Removed players cannot win, and award breakdowns add up.
  var m = new RoomManager({});
  var room = { code: "TEST", players: [{ id: "a", name: "A", total: 900, sitOut: true }, { id: "b", name: "B", total: 500 }, { id: "c", name: "C", total: 400 }],
    rounds: 5, stats: {}, hostId: "b", phase: "turn", turns: [], used: {}, createdAt: 0 };
  m.broadcast = function () {}; m.gameOver = function (r, ids) { room.out = ids; };
  m.afterTurns(room);
  check("a removed leader does not win", room.out && room.out.length === 1 && room.out[0] === "b", JSON.stringify(room.out));

  var r2 = { code: "TST2", players: [{ id: "a", name: "A", total: 1000 }, { id: "b", name: "B", total: 900 }], rounds: 5, hostId: "a", stats: {} };
  r2.stats.a = { whistles: 3, solved: 3, streak: 3, bestStreak: 3, bestTimeMs: 4000, hardSolved: 3, guessed: 3, whistlePts: 3000, guessBestMs: 2000, packs: {} };
  r2.stats.b = { whistles: 3, solved: 1, streak: 0, bestStreak: 1, bestTimeMs: 9000, hardSolved: 0, guessed: 1, whistlePts: 900, guessBestMs: 5000, packs: {} };
  var beforeA = r2.players[0].total;
  m.applyEndBonuses(r2);
  var credited = r2.players[0].total - beforeA;
  var shown = 0; r2.endAwards.forEach(function (d) { d.winners.forEach(function (w) { if (w.id === "a") { shown += w.bonus; } }); });
  check("award breakdown matches the bonus credited", shown === credited && credited > 0, "shown " + shown + ", credited " + credited);

  if (failed) { console.log("\n" + failed + " FAILED"); process.exit(1); }
  console.log("\nALL PASSED"); process.exit(0);
})();
