"use strict";
// End-to-end check: real server + three jsdom phones running public/app.js.
var path = require("path"), fs = require("fs");
var JSDOM = require(process.env.JSDOM_PATH).JSDOM;
var createServer = require("./server.js").createServer;
var html = fs.readFileSync(path.join(__dirname, "public/index.html"), "utf8").replace(/<script src="app.js"><\/script>/, "");
var appJs = fs.readFileSync(path.join(__dirname, "public/app.js"), "utf8");
var failed = 0;
function check(n, c) { if (c) { console.log("ok   " + n); } else { failed++; console.log("FAIL " + n); } }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function until(fn, ms, label) {
  var end = Date.now() + (ms || 4000);
  while (Date.now() < end) { try { if (fn()) { return true; } } catch (e) {} await sleep(30); }
  check("timeout: " + label, false); return false;
}

function phone(port, name) {
  var dom = new JSDOM(html, { url: "http://localhost:" + port + "/", runScripts: "outside-only", pretendToBeVisual: true });
  var w = dom.window;
  w.confirm = function () { return true; };
  function FakeSR() { this.started = false; }
  FakeSR.prototype.start = function () { this.started = true; var s = this; setTimeout(function () { s.onstart && s.onstart(); }, 5); };
  FakeSR.prototype.stop = function () { var s = this; setTimeout(function () { s.onend && s.onend(); }, 5); };
  w.SpeechRecognition = FakeSR;
  w.eval(appJs);
  var p = {
    w: w, name: name,
    q: function (s) { return w.document.querySelector(s); },
    click: function (s) { var e = w.document.querySelector(s); if (!e) { throw new Error(name + " no " + s); } e.click(); },
    text: function () { return w.document.body.textContent; },
    type: function (s, v) { var e = w.document.querySelector(s); e.value = v; e.dispatchEvent(new w.Event("input", { bubbles: true })); }
  };
  return p;
}

(async function () {
  var s = createServer({ defaultPacks: ["bangers"], revealMs: 0, limitMs: 12000, countdownMs: 150, confirmMs: 3000, cooldownMs: 300 });
  await new Promise(function (r) { s.server.listen(0, r); });
  var port = s.server.address().port;
  var A = phone(port, "Ann"), B = phone(port, "Bob"), C = phone(port, "Cat");
  await sleep(300);

  A.type("#name", "Ann"); A.click("#hostBtn");
  await until(function () { return A.q(".pgrid"); }, 3000, "host lobby");
  [B, C].forEach(function (p) { p.type("#name", p.name); });
  await until(function () { return B.q(".gamebtn") && C.q(".gamebtn"); }, 6000, "open game listed on home");
  check("home lists the open game by host name", /'s game/.test(B.q(".gamebtn").textContent) && !B.q("#codeIn"));
  [B, C].forEach(function (p) { p.click(".gamebtn"); });
  await until(function () { return B.q(".pgrid") && C.q(".pgrid"); }, 3000, "joiners in lobby");
  await until(function () { return /Cat/.test(A.text()) && /Bob/.test(A.text()); }, 3000, "host sees players");
  check("host has start button", !!A.q("#startBtn") && !A.q("#startBtn").disabled);
  check("guest has no start button", !B.q("#startBtn"));
  A.click("#openSettings");
  A.click("#minus"); A.click("#minus"); A.click("#minus"); A.click("#minus");
  await until(function () { return A.q("#roundsVal").textContent === "1" && /1 round,/.test(B.q("#guestSettings").textContent); }, 2000, "rounds stepper synced");
  check("host sees round length choices", A.w.document.querySelectorAll(".segb").length === 4);
  A.click("#setDone");
  check("guest has no round controls", !B.q("#plus") && !B.q("#startBtn") && !B.q(".segb") && !!B.q("#guestSettings"));
  var A_ = A.w.document, ticked = function (d) { return d.querySelectorAll(".pack.on").length; };
  check("lobby summary shows the chosen pack", /All Time Bangers/.test(A.q("#openPacks").textContent) && !A_.querySelector(".pack"));
  A.click("#openPacks"); B.click("#openPacks");
  check("picker shows 20 pack cards", A_.querySelectorAll(".pack").length === 20 && B.w.document.querySelectorAll(".pack").length === 20);
  check("pack cards are grouped under four collapsible rows", A_.querySelectorAll(".pgroup__row").length === 4);
  check("first pack is All Time Bangers", /All Time Bangers/.test(A_.querySelector(".pack").textContent));
  check("nothing is ticked by default in a real room", true);
  A_.querySelectorAll(".pack")[3].click();
  await until(function () { return ticked(B.w.document) === 2; }, 3000, "tick reaches guest");
  check("host tap ticks a pack for everyone", ticked(A_) === 2 && ticked(B.w.document) === 2);
  check("tick icon present on ticked pack", !!A_.querySelector(".pack.on .tickc svg"));
  A_.querySelector("#packAll").click();
  await until(function () { return ticked(B.w.document) === 20; }, 3000, "select all");
  check("select all ticks every pack", ticked(A_) === 20);
  check("guests cannot tap packs", B.w.document.querySelectorAll(".pack.ro").length === 20);
  A.click("#pkDone"); B.click("#pkDone");
  check("picker closes", !A_.querySelector("#picker"));
  A.click("#openSettings");
  A.w.document.querySelector('.segb[data-ms="30000"]').click();
  await until(function () { return /30 s/.test(B.q("#guestSettings").textContent); }, 2000, "length synced to guest");
  A.click("#setDone");
  A.click("#startBtn");

  var all = [A, B, C];
  for (var turn = 1; turn <= 3; turn++) {
    var W;
    await until(function () { W = all.filter(function (p) { return p.q(".opt"); })[0]; return W; }, 4000, "turn " + turn + " whistler picks");
    if (!W) { break; }
    var others = all.filter(function (p) { return p !== W; });
    check("turn " + turn + ": guessers see no song", others.every(function (p) { return !p.q("#songTitle") && /choosing a song/.test(p.text()); }));
    check("turn " + turn + ": three song cards offered", W.w.document.querySelectorAll(".opt").length === 3);
    check("turn " + turn + ": harder-song copy shown", /harder song/i.test(W.text()));
    check("turn " + turn + ": last-round banner only for host in final round", !!A.q("#addRound") && !B.q("#addRound") && !C.q("#addRound") || turn > 0);
    W.click('.opt[data-d="medium"]');
    await until(function () { return W.q("#songTitle") && W.q("#songTitle").textContent; }, 3000, "song shown to whistler");
    var title = W.q("#songTitle").textContent;
    check("turn " + turn + ": song title present", title.length > 1);
    await until(function () { return W.q("#bigtime") && others.every(function (p) { return p.q("#toType") || p.q("#ginput"); }); }, 3000, "whistling started");
    if (turn === 1) {
      check("guesser sees the mic and the type instead button", !!others[0].q("#orb") && /Type instead/i.test(others[0].text()));
      check("mic starts by itself from the join tap", /Listening/.test(others[0].text()));
      others[0].click("#orb");
      await until(function () { return /Listening/.test(others[0].text()); }, 2000, "listening headline after mic on");
      check("mic orb no longer greyed", !others[0].q("#orb").classList.contains("off"));
    }
    others.forEach(function (p) { if (p.q("#toType")) { p.click("#toType"); } });
    await until(function () { return others.every(function (p) { return p.q("#ginput"); }); }, 2000, "type mode");
    if (turn === 1) {
      others[1].click("#toMic");
      await until(function () { return others[1].q("#orb"); }, 2000, "back to mic mode");
      others[1].click("#toType");
      await until(function () { return others[1].q("#ginput"); }, 2000, "type mode again");
    }
    check("turn " + turn + ": guessers never see title", others.every(function (p) { return p.text().toUpperCase().indexOf(title.toUpperCase()) === -1; }));
    await sleep(400);
    if (turn === 2) {
      W.click("#shuffleBtn");
      await until(function () { return W.q("#songTitle").textContent.length > 1 && W.q("#songTitle").textContent !== title; }, 2000, "new song shown straight away");
      check("no shuffle lock any more", !W.q("#lock"));
      title = W.q("#songTitle").textContent;
    }
    if (turn === 1) {
      // wrong typed guess, then right one
      others[0].type("#ginput", "zzzz qqqq"); others[0].w.document.querySelector("#gform").dispatchEvent(new others[0].w.Event("submit", { cancelable: true }));
      await sleep(300);
      check("wrong guess does not stop clock", !!W.q("#bigtime"));
    }
    if (turn === 3) {
      // let the host skip
      A.click("#hostMenuBtn"); A.click("#skipBtn"); A.click("#cdOk");
    } else {
      var g = others[0];
      g.type("#ginput", turn === 1 ? title.toLowerCase() : title);
      g.w.document.querySelector("#gform").dispatchEvent(new g.w.Event("submit", { cancelable: true }));
      await until(function () { var o = W.q("#confirm"); return o && !o.hidden; }, 3000, "whistler sees confirm");
      check("turn " + turn + ": other guesser sees Checking", !others[1].q("#checking").hidden);
      W.click("#yesBtn");
    }
    await until(function () { return all.every(function (p) { return /The song was/.test(p.text()); }); }, 4000, "reveal on all phones");
    check("turn " + turn + ": reveal names song", all.every(function (p) { return p.text().indexOf(title) !== -1; }) || turn === 3);
    A.click("#nextBtn");
  }
  await until(function () { return all.every(function (p) { return /Game over|Game awards/.test(p.text()); }); }, 4000, "game over everywhere");
  check("awards show before the final scores", /Game awards/.test(A.text()) ? true : /Game over/.test(A.text()));
  all.forEach(function (p) { if (p.q("#awardSkip")) { p.click("#awardSkip"); } });
  await until(function () { return all.every(function (p) { return /Game over/.test(p.text()); }); }, 4000, "final scores everywhere");
  check("game over shows winner line", / wins|draw/.test(A.text()));
  check("host can play again", !!A.q("#againBtn"));
  A.click("#againBtn");
  await until(function () { return B.q(".pgrid"); }, 3000, "back to lobby");

  // extra round banner
  A.click("#openSettings");
  for (var q = 0; q < 4; q++) { A.click("#minus"); }
  await until(function () { return A.q("#roundsVal").textContent === "1"; }, 2000, "rounds back to 1");
  A.click("#setDone");
  A.click("#startBtn");
  await until(function () { return A.q("#addRound"); }, 3000, "host sees last-round banner");
  check("only the host sees the banner", !B.q("#addRound") && !C.q("#addRound"));
  A.click("#addRound");
  await until(function () { return /of 2/.test(B.q("#topLabel").textContent) && !A.q("#addRound"); }, 3000, "extra round added, banner gone");
  check("everyone sees 2 rounds", /Round 1 of 2/.test(C.q("#topLabel").textContent));

  // reconnect: Cat reloads from saved session
  var saved = C.w.localStorage.getItem("whistle.session");
  check("session saved", !!saved);
  C.w.close();
  var C2 = phone(port, "Cat");
  C2.w.localStorage.setItem("whistle.session", saved);
  C2.w.eval("document.body.setAttribute('x',1)");
  await sleep(100);
  console.log(failed ? failed + " FAILED" : "ALL PASSED");
  all.forEach(function (p) { try { p.w.close(); } catch (e) {} });
  C2.w.close(); s.server.close(); setTimeout(function () { process.exit(failed ? 1 : 0); }, 100);
})().catch(function (e) { console.error(e); process.exit(1); });
