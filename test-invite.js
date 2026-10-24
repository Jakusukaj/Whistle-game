"use strict";
// Host first, then a shared link that goes straight to a name field and a Join lobby button.
var path = require("path"), fs = require("fs");
var JSDOM = require(process.env.JSDOM_PATH).JSDOM;
var createServer = require("./server.js").createServer;
var html = fs.readFileSync(path.join(__dirname, "public/index.html"), "utf8").replace(/<script src="app.js"><\/script>/, "");
var appJs = fs.readFileSync(path.join(__dirname, "public/app.js"), "utf8");
var failed = 0;
function check(n, c) { if (c) { console.log("ok   " + n); } else { failed++; console.log("FAIL " + n); } }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function until(fn, ms, label) { var end = Date.now() + (ms || 4000); while (Date.now() < end) { try { if (fn()) { return true; } } catch (e) {} await sleep(30); } check("timeout: " + label, false); return false; }
function phone(port, search) {
  var dom = new JSDOM(html, { url: "http://localhost:" + port + "/" + (search || ""), runScripts: "outside-only", pretendToBeVisual: true });
  var w = dom.window;
  w.eval(appJs);
  return { w: w, q: function (s) { return w.document.querySelector(s); }, text: function () { return w.document.body.textContent; },
    type: function (s, v) { var e = w.document.querySelector(s); e.value = v; } };
}
(async function () {
  var s = createServer({ defaultPacks: ["bangers"], revealMs: 0 });
  await new Promise(function (r) { s.server.listen(0, r); });
  var port = s.server.address().port;
  var H = phone(port); await sleep(300);
  check("home has a name field and Start lobby", !!H.q("#name") && /Start lobby/.test(H.q("#hostBtn").textContent));
  H.q("#hostBtn").click();
  check("host needs a name first", !!H.q("#name.flag") && /Enter your name first/.test(H.text()));
  H.type("#name", "Ann"); H.q("#hostBtn").click();
  await until(function () { return H.q(".pgrid"); }, 3000, "host lobby");
  var code = Object.keys(s.manager.rooms)[0];
  check("host lobby has a Copy link button and does not show the link", /Copy link/.test(H.q("#copyLink").textContent) && !/join=/.test(H.q("#copyLink").textContent));
  var G = phone(port, "?join=" + code); await sleep(400);
  await until(function () { return G.q("#joinBtn"); }, 3000, "join screen");
  check("the link shows the host's game, a name field and Join lobby", /Ann's game/.test(G.text()) && !!G.q("#name") && /Join lobby/.test(G.q("#joinBtn").textContent) && !G.q("#hostBtn") && !G.q("#games"));
  G.q("#joinBtn").click();
  check("joining needs a name", !!G.q("#name.flag"));
  G.type("#name", "Bob"); G.q("#joinBtn").click();
  await until(function () { return G.q(".pgrid") && /Bob/.test(H.text()); }, 3000, "guest in lobby");
  check("guest lands in the lobby and the host sees them", /Bob/.test(H.text()) && !G.q("#startBtn"));
  check("the join parameter is removed from the address after joining", G.w.location.search === "");
  var X = phone(port, "?join=ZZZZ"); await sleep(400);
  await until(function () { return /Game not found/.test(X.text()); }, 3000, "bad link");
  check("a dead link says so and offers a way home", /Game not found/.test(X.text()) && !!X.q("#inviteHome"));
  X.q("#inviteHome").click();
  check("Back to home shows the normal home screen", !!X.q("#hostBtn"));
  console.log(failed ? failed + " FAILED" : "ALL PASSED");
  s.server.close(); setTimeout(function () { process.exit(failed ? 1 : 0); }, 100);
})().catch(function (e) { console.error(e); process.exit(1); });
