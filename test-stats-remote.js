"use strict";
// The remote copy, against a pretend Upstash. Run on its own because the module reads its settings once.
process.env.STATS_OFF = "1";
var store = [], calls = 0, failNext = false, failLoad = false;
global.fetch = function (url, opts) {
  calls++;
  var cmds = JSON.parse(opts.body);
  if (failLoad && cmds[0][0] === "LRANGE") { return Promise.resolve({ ok: false, status: 500, json: function () { return {}; } }); }
  if (failNext && cmds[0][0] === "RPUSH") { failNext = false; return Promise.resolve({ ok: false, status: 503, json: function () { return {}; } }); }
  var out = cmds.map(function (c) {
    if (c[0] === "RPUSH") { c.slice(2).forEach(function (l) { store.push(l); }); return { result: store.length }; }
    if (c[0] === "LRANGE") { return { result: store.slice(c[2], c[3] + 1) }; }
  });
  return Promise.resolve({ ok: true, status: 200, json: function () { return out; } });
};
store.push(JSON.stringify({ type: "game", at: 1, finished: true, durationMs: 600000, players: 4, rounds: 5, limitMs: 60000, turns: 20 }));
var A = require("./analytics.js"), failed = 0;
function check(n, c) { if (c) { console.log("ok   " + n); } else { failed++; console.log("FAIL " + n); } }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
(async function () {
  A.configureRemote("https://fake.example", "tok");
  A.record("turn", { outcome: "correct", limitMs: 60000, performMs: 9000, players: 4, sd: false });
  await sleep(100);
  check("earlier events are loaded back from the remote list", A.remoteStatus().status === "connected" && A.remoteStatus().loaded === 1);
  check("the history and this run's events are both counted", A.summary().gamesFinished === 1 && A.summary().turnsRecorded === 1);
  check("events recorded before loading finished were saved too", store.length === 2);
  A.record("turn", { outcome: "correct", limitMs: 60000, performMs: 12000, players: 4, sd: false });
  check("new events wait to be sent in a batch", A.remoteStatus().waiting === 1 && store.length === 2);
  await A.flush();
  check("flush saves them", store.length === 3 && A.remoteStatus().waiting === 0);
  A.record("turn", { outcome: "timeout", limitMs: 60000, performMs: 60000, players: 4, sd: false });
  failNext = true; await A.flush();
  check("a failed save keeps the events to try again", A.remoteStatus().waiting === 1 && !!A.remoteStatus().lastError);
  await A.flush();
  check("and sends them next time without losing any", store.length === 4 && A.remoteStatus().waiting === 0);
  check("raw export has every event", A.rawLines().split("\n").length === 4);
  console.log(failed ? failed + " FAILED" : "ALL PASSED"); process.exit(failed ? 1 : 0);
})();
