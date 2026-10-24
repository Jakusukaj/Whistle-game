"use strict";
var WebSocket = require("ws");
var createServer = require("./server.js").createServer;
var failed = 0;
function check(n, c) { if (c) { console.log("ok   " + n); } else { failed++; console.log("FAIL " + n); } }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function client(port) {
  var c = { state: null, errors: [], ws: new WebSocket("ws://localhost:" + port + "/ws") };
  c.ws.on("message", function (d) { var m = JSON.parse(d);
    if (m.t === "state") { c.state = m.state; }
    if (m.t === "joined") { c.code = m.code; c.id = m.playerId; }
    if (m.t === "error") { c.errors.push(m.code); } });
  c.send = function (o) { c.ws.send(JSON.stringify(o)); };
  c.ready = new Promise(function (r) { c.ws.on("open", r); });
  return c;
}
(async function () {
  var s = createServer({ defaultPacks: ["bangers"], revealMs: 0, countdownMs: 100 });
  await new Promise(function (r) { s.server.listen(0, r); });
  var port = s.server.address().port;
  var A = client(port), B = client(port), B2 = client(port), C = client(port);
  await Promise.all([A.ready, B.ready, B2.ready, C.ready]);
  A.send({ t: "create", name: "Ann" }); await sleep(100);
  B.send({ t: "join", code: A.code, name: "Bob" }); await sleep(100);
  B.ws.close(); await sleep(150);
  B2.send({ t: "join", code: A.code, name: "Bob" }); await sleep(150);
  check("away player can rejoin with the same name", !!B2.id && B2.errors.length === 0 && A.state.players.length === 2);
  B2.send({ t: "removePlayer", id: A.id }); await sleep(80);
  check("non-host cannot remove", A.state.players.length === 2);
  A.send({ t: "removePlayer", id: B2.id }); await sleep(120);
  check("host removes player in lobby", A.state.players.length === 1 && B2.errors.indexOf("removed") >= 0);
  B2.send({ t: "join", code: A.code, name: "Bob" }); await sleep(100);
  B2.send({ t: "join", code: A.code, name: "Bob" }); await sleep(100);
  C.send({ t: "join", code: A.code, name: "Cat" }); await sleep(100);
  C.ws.close(); await sleep(100);
  B2.send({ t: "join", code: A.code, name: "Bob2" }); await sleep(100);
  A.send({ t: "setRounds", rounds: 2 }); A.send({ t: "start" }); await sleep(200);
  var cat = A.state.players.filter(function (p) { return p.name === "Cat"; })[0];
  var before = A.state.totalTurns;
  A.send({ t: "removePlayer", id: cat.id }); await sleep(150);
  check("host removes away player mid-game", !A.state.players.some(function (p) { return p.name === "Cat"; }) && A.state.totalTurns < before);
  s.server.close(); process.exit(failed ? 1 : 0);
})();
