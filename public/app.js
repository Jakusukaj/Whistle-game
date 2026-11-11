(function () {
  "use strict";

  var app = document.getElementById("app");
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  var ws = null, connected = false, session = null, rejoining = false, pendingName = "", reconnectTimer = null, lastMsgAt = 0;
  var UA = navigator.userAgent || "";
  var IOS = /iPhone|iPad|iPod/i.test(UA) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  // In-app browsers (Instagram, Facebook, TikTok and friends) show the speech API and never start it.
  var IN_APP = /FBAN|FBAV|FB_IAB|Instagram|Snapchat|TikTok|musical_ly|Line\/|GSA\/|MicroMessenger/i.test(UA) || (IOS && /AppleWebKit/i.test(UA) && !/Safari\//i.test(UA) && !navigator.standalone);
  var gameList = [], gamesLoaded = false, adminLogin = false, adminAuthed = false, adminPw = "", adminData = null, pickerOpen = false, packDraft = null, settingsOpen = false, pickerTab = "All", keepPickerScroll = true;
  var lastMicSent = "";
  var invite = null, copyOnJoin = false, linkResolve = null;
  var st = null, offset = 0, lastKey = null, wakeLock = null, prevStage = null, prevTurnId = null;

  try { session = JSON.parse(localStorage.getItem("whistle.session") || "null"); } catch (e) { session = null; }
  (function () {
    var m = /[?&]join=([A-Za-z]{4})/.exec(location.search);
    if (m) {
      var code = m[1].toUpperCase();
      if (session && session.code !== code) { session = null; saveSession(); }
      if (!session) { invite = { code: code, info: null, loading: true }; }
    }
  })();

  function $(sel, root) { return (root || document).querySelector(sel); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function fmt(n) { return (Math.round(n * 10) / 10).toFixed(1); }
  function nowS() { return Date.now() + offset; }
  function saveSession() {
    try {
      if (session) { localStorage.setItem("whistle.session", JSON.stringify(session)); }
      else { localStorage.removeItem("whistle.session"); }
    } catch (e) {}
  }
  function player(s, id) {
    for (var i = 0; i < s.players.length; i++) { if (s.players[i].id === id) { return s.players[i]; } }
    return null;
  }
  function pname(s, id) { var p = player(s, id); return p ? p.name : "Someone"; }

  // ----------------------------------------------------------------- toast
  var toastTimer = null;
  function toast(text) {
    var el = $("#toast");
    el.textContent = text; el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2400);
  }

  // ------------------------------------------------------------ connection
  function send(o) { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(o)); } }

  function setBanner(text) {
    var b = $("#banner");
    if (text) { b.textContent = text; b.hidden = false; } else { b.hidden = true; }
  }

  function connect() {
    if (ws && ws.readyState < 2) { return; }
    clearTimeout(reconnectTimer);
    var proto = location.protocol === "https:" ? "wss" : "ws";
    var sock = ws = new WebSocket(proto + "://" + location.host + "/ws");
    sock.onopen = function () {
      if (ws !== sock) { return; }
      connected = true; setBanner(""); lastMicSent = ""; lastMsgAt = Date.now();
      sendHello();
      send({ t: "listRooms" });
      if (invite && !session) { invite.loading = true; send({ t: "peek", code: invite.code }); }
      if (session) {
        rejoining = true;
        send({ t: "join", code: session.code, playerId: session.playerId, token: session.token, name: session.name });
      }
    };
    sock.onmessage = function (e) {
      if (ws !== sock) { return; }
      lastMsgAt = Date.now();
      var m; try { m = JSON.parse(e.data); } catch (err) { return; }
      onMessage(m);
    };
    sock.onclose = function () {
      if (ws !== sock) { return; }
      connected = false;
      setBanner("Hang on, reconnecting...");
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 1500);
    };
    sock.onerror = function () { try { sock.close(); } catch (e) {} };
  }

  // Back from the lock screen, a notification or another app. Phones freeze a hidden page, so the socket
  // may be dead without knowing it and the mic session is stale. Reconnect or resync, then listen afresh.
  function comeBack() {
    keepAwake();
    if (!ws || ws.readyState > 1) { clearTimeout(reconnectTimer); connect(); return; }
    if (ws.readyState !== 1) { return; }
    var sock = ws, asked = Date.now();
    if (session) { rejoining = true; send({ t: "join", code: session.code, playerId: session.playerId, token: session.token, name: session.name }); }
    else { send({ t: "ping" }); }
    setTimeout(function () {
      if (ws !== sock || lastMsgAt >= asked) { return; }
      // No answer: the socket only looks open. Drop it and start again.
      sock.onclose = null; try { sock.close(); } catch (e) {}
      ws = null; connected = false; setBanner("Hang on, reconnecting...");
      connect();
    }, 3000);
    mic.key = null; micSync();
  }

  // Anonymous browser and device facts, so we know what people play on.
  function sendHello() {
    try {
      var ua = navigator.userAgent || "", p = navigator.platform || "";
      var browser = /SamsungBrowser/i.test(ua) ? "Samsung" : /Edg\//.test(ua) ? "Edge" : /Firefox|FxiOS/i.test(ua) ? "Firefox" : /Chrome|CriOS/i.test(ua) ? "Chrome" : /Safari/i.test(ua) ? "Safari" : "Other";
      var os = /iPhone|iPad|iPod/i.test(ua) || (p === "MacIntel" && navigator.maxTouchPoints > 1) ? "iOS" : /Android/i.test(ua) ? "Android" : /Win/i.test(p) ? "Windows" : /Mac/i.test(p) ? "Mac" : /Linux/i.test(p) ? "Linux" : "Other";
      send({ t: "hello", browser: browser, os: os, speech: !!(window.SpeechRecognition || window.webkitSpeechRecognition), vibrate: !!navigator.vibrate,
        installed: !!(window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || !!navigator.standalone });
    } catch (e) {}
  }
  var SCREEN_OF = { lobby: "lobby", choose: "choose song", ready: "ready", wait: "waiting", cd: "countdown", w: "performing", g: "guessing", reveal: "reveal", awards: "awards", over: "game over" };
  function usage(ev, from) {
    try {
      var k = String(lastKey || "").split("-")[0], role = "guest";
      if (st) { role = st.hostId === st.me ? "host" : "guest"; if (st.turn) { role = st.turn.playerId === st.me ? "performer" : "guesser"; } }
      send({ t: "usage", ev: ev, from: from, screen: !st ? "home" : (SCREEN_OF[k] || "other"), role: role });
    } catch (e) {}
  }

  function onMessage(m) {
    if (m.t === "state") {
      var prevSt = st;
      st = m.state;
      audioEvents(prevSt, st);
      offset = st.serverNow - Date.now();
      var T = st.turn;
      if (T && T.stage === "whistling" && (prevStage !== "whistling" || prevTurnId !== T.id)) { mic.lastSent = ""; }
      prevStage = T ? T.stage : null; prevTurnId = T ? T.id : null;
      render();
    } else if (m.t === "rooms") {
      gameList = m.rooms || []; gamesLoaded = true;
      if (!st && !adminLogin && lastKey === "home") { var v = viewHome(); if (v.update) { v.update(); } }
    } else if (m.t === "roomInfo") {
      if (invite && invite.code === m.code) { invite.info = m; invite.loading = false; if (!st) { lastKey = null; render(); } }
    } else if (m.t === "joined") {
      session = { code: m.code, playerId: m.playerId, token: m.token, name: pendingName || (session && session.name) || "" };
      saveSession(); rejoining = false; keepAwake(); adminLogin = false; lastMicSent = "";
      if (invite) { invite = null; try { history.replaceState(null, "", location.pathname); } catch (e) {} }
      if (copyOnJoin) { copyOnJoin = false; deliverLink(m.code); }
    } else if (m.t === "error") {
      if (m.code === "removed") {
        session = null; saveSession(); st = null; rejoining = false; lastKey = null; toast("The host removed you from the game."); render();
      } else if (rejoining && (m.code === "room_not_found" || m.code === "game_started")) {
        session = null; saveSession(); st = null; rejoining = false; lastKey = null;
        toast("That game's all over."); render();
      } else {
        toast(m.message || "Oops, something went wrong.");
      }
    } else if (m.t === "adminStats") {
      adminData = m.data; adminAuthed = true; lastKey = null; render();
    }
  }

  var wakeFail = !navigator.wakeLock;
  function keepAwake() {
    try {
      if (navigator.wakeLock && !wakeLock) {
        navigator.wakeLock.request("screen").then(function (l) {
          wakeLock = l; wakeFail = false;
          l.addEventListener("release", function () { wakeLock = null; });
        }).catch(function () { if (!wakeFail) { wakeFail = true; refreshMic(); } });
      }
    } catch (e) { wakeFail = true; }
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") { comeBack(); }
    else { micPark(); }
  });
  // Safari restores a frozen page without a visibility change now and then.
  window.addEventListener("pageshow", function (e) { if (e.persisted) { comeBack(); } });

  function linkFor(code) { return location.origin + "/?join=" + code; }
  // Copy the join link. The host's tap on Start lobby starts the copy; the link is filled in once the room exists.
  function primeCopy() {
    linkResolve = null;
    try {
      if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
        var pr = new Promise(function (res) { linkResolve = res; });
        navigator.clipboard.write([new ClipboardItem({ "text/plain": pr.then(function (t) { return new Blob([t], { type: "text/plain" }); }) })])
          .then(function () { toast("Link copied! Pop it in the group chat."); })
          .catch(function () { linkResolve = null; });
      }
    } catch (e) { linkResolve = null; }
  }
  function deliverLink(code) {
    var url = linkFor(code);
    if (linkResolve) { var r = linkResolve; linkResolve = null; r(url); return; }
    copyText(url, true);
  }
  function copyText(text, quiet) {
    var done = function () { toast("Link copied! Pop it in the group chat."); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(function () { if (!quiet) { toast(text); } });
        return;
      }
    } catch (e) {}
    if (!quiet) { toast(text); }
  }

  function leaveRoom() {
    send({ t: "leave" });
    session = null; saveSession(); st = null; lastKey = null;
    render();
  }

  // ------------------------------------------------------------------- mic
  // The phone listens only whilst there is something to hear: in the lobby, so players can see it works, and
  // from each countdown to the end of that turn. Every turn gets a fresh recognition session, because a
  // long-lived one can stop returning results without saying so. A phone that cannot listen buzzes in instead.
  var mic = { state: !SR || IN_APP ? "unsupported" : "off", why: IN_APP ? "inapp" : "", rec: null, want: false, enabled: false, pre: false, key: null, ok: false, fails: 0,
    lastSent: "", heard: "", level: 0, buzzMode: !SR || IN_APP };

  function isGuessing() {
    return !!(st && st.phase === "turn" && st.turn && st.turn.stage === "whistling" && st.turn.playerId !== st.me);
  }
  function liveStage(T) { return !!T && (T.stage === "countdown" || T.stage === "whistling" || T.stage === "confirming" || T.stage === "claiming"); }

  // Should a session be running right now?
  function micShould() {
    if (!SR || mic.buzzMode || !mic.enabled || !st || document.visibilityState === "hidden") { return false; }
    if (st.phase === "lobby") { return true; }
    var T = st.turn;
    return st.phase === "turn" && !!T && T.playerId !== st.me && liveStage(T);
  }

  function micAbort() {
    var r = mic.rec; mic.rec = null;
    try { if (r) { r.onend = null; r.onresult = null; r.onerror = null; r.onstart = null; r.abort(); } } catch (e) {}
  }
  // Stop listening without turning the mic off: between turns, or whilst the page is hidden.
  function micPark() {
    if (!SR) { return; }
    mic.want = false; mic.pre = false; mic.key = null;
    micAbort();
    if (mic.state === "on" || mic.state === "starting" || mic.state === "stopped") { mic.state = mic.ok && mic.enabled ? "ready" : "off"; }
    refreshMic();
  }
  function micFresh() {
    var had = !!mic.rec;
    micAbort();
    mic.want = true;
    var go = function () {
      if (!mic.want || mic.rec) { return; }
      try { micLaunch(); } catch (e) { mic.state = "stopped"; refreshMic(); }
    };
    // Safari will not start a new session in the same breath as stopping the old one, so give it a moment.
    // With nothing to stop, start at once: the first start has to happen inside the player's tap.
    if (had) { mic.state = "starting"; setTimeout(go, 250); } else { go(); }
  }
  // Called on every state change: start a fresh session for a new turn, park it when the turn is over.
  function micSync() {
    if (!SR) { return; }
    if (!micShould()) {
      if (mic.pre && !st) { return; } // started by the tap; the lobby has not arrived yet
      if (mic.rec || mic.want) { micPark(); }
      return;
    }
    var key = st.phase === "lobby" ? "lobby" : "t" + st.turn.id;
    if (mic.pre) { mic.pre = false; mic.key = key; return; } // keep the session the tap started
    if (mic.key !== key) { mic.key = key; micFresh(); }
  }

  // A tap on the mic control, the orb or "Use the mic".
  function micStart() {
    if (!SR) { return; }
    mic.enabled = true; mic.buzzMode = false; mic.fails = 0;
    mic.key = st ? (st.phase === "lobby" ? "lobby" : st.turn ? "t" + st.turn.id : null) : null;
    if (st && !micShould()) { mic.state = mic.ok ? "ready" : "off"; refreshMic(); return; }
    micFresh();
  }

  // Called from the tap on Start lobby or Join lobby, the one moment the browser will ask for the microphone.
  function autoMic() {
    if (!SR || mic.buzzMode || mic.state === "on" || mic.state === "starting" || mic.state === "blocked") { return; }
    mic.enabled = true; mic.pre = true;
    micFresh();
  }

  // A session that would not start. The turn carries on with the buzzer, and the next turn tries again.
  // A browser that has never once started (an in-app browser, mostly) goes to the buzzer for good.
  function micFail(rec) {
    if (mic.rec !== rec) { return; }
    mic.fails = (mic.fails || 0) + 1;
    mic.want = false; mic.pre = false; micAbort(); mic.state = "stopped";
    if (!mic.ok && mic.fails >= 2) { mic.buzzMode = true; mic.why = "nostart"; mic.state = "unsupported"; toast("This browser can't hear guesses. Buzz in instead."); }
    refreshMic();
    if (st) { render(); }
  }

  function micLaunch() {
    var rec = new SR();
    rec.lang = "en-GB"; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 5;
    mic.rec = rec; mic.state = "starting"; mic.base = 0; mic.total = 0;
    var startTimer = setTimeout(function () {
      if (mic.rec === rec && mic.state === "starting") { micFail(rec); }
    }, mic.ok ? 3500 : 5000);
    rec.onsoundstart = rec.onspeechstart = function () { mic.level = Math.max(mic.level, 0.7); };
    rec.onstart = function () {
      clearTimeout(startTimer);
      if (mic.rec !== rec) { return; }
      var first = !mic.ok;
      mic.ok = true; mic.fails = 0; mic.state = "on";
      refreshMic();
      if (first && st) { render(); }
    };
    rec.onresult = function (e) {
      var text = "", i, k;
      mic.total = e.results.length;
      for (i = Math.min(mic.base || 0, e.results.length); i < e.results.length; i++) { text += e.results[i][0].transcript + " "; }
      mic.level = 1;
      mic.heard = text.replace(/\s+/g, " ").trim().slice(-90);
      mic.heardFor = st && st.turn ? st.turn.id : null;
      if (!isGuessing()) { return; }
      for (i = e.resultIndex; i < e.results.length; i++) {
        var alts = [];
        for (k = 0; k < e.results[i].length; k++) { alts.push(e.results[i][k].transcript); }
        // Also try this phrase joined to the one before it, in case the engine
        // split a title in two ("blinding" then "lights").
        if (i > (mic.base || 0) && e.results[i - 1] && e.results[i - 1][0]) {
          alts.push(e.results[i - 1][0].transcript + " " + alts[0]);
        }
        // Loud or excited speech often comes back in pieces, so also try the last
        // few phrases joined together.
        if (i - 2 >= (mic.base || 0) && e.results[i - 2] && e.results[i - 1]) {
          alts.push(e.results[i - 2][0].transcript + " " + e.results[i - 1][0].transcript + " " + alts[0]);
        }
        var key = alts.join("|");
        if (key === mic.lastSent) { continue; }
        mic.lastSent = key;
        send({ t: "guess", alts: alts, typed: false });
      }
    };
    rec.onerror = function (e) {
      // "service-not-allowed" on an iPhone means Siri and Dictation are switched off, which is a different
      // fix from a blocked microphone, so it gets its own message.
      var why = e.error === "service-not-allowed" ? "dictation" : e.error === "not-allowed" ? "perm" : e.error === "audio-capture" ? "nomic" : e.error === "language-not-supported" ? "lang" : "";
      if (!why) { return; }
      clearTimeout(startTimer);
      mic.want = false; mic.pre = false; mic.enabled = false; mic.state = "blocked"; mic.why = why; mic.buzzMode = true;
      if (mic.rec === rec) { micAbort(); }
      refreshMic(); if (st) { render(); }
    };
    rec.onend = function () {
      clearTimeout(startTimer);
      if (!mic.want || mic.rec !== rec) { return; }
      // Ended before it ever started: one more try, then give up for this turn.
      if (mic.state === "starting") { mic.fails = (mic.fails || 0) + 1; if (mic.fails >= 2) { mic.fails--; micFail(rec); return; } }
      mic.state = "starting"; refreshMic();
      setTimeout(function () {
        if (mic.want && mic.rec === rec) {
          try { micLaunch(); } catch (err) { mic.state = "stopped"; refreshMic(); }
        }
      }, 60);
    };
    try { rec.start(); } catch (err) { clearTimeout(startTimer); mic.rec = null; mic.want = false; mic.state = "stopped"; refreshMic(); }
  }

  function ico(n, c) {
    if (n !== "tick" && n !== "chevron" && n !== "mic") { return ""; }
    return '<svg class="' + (c || "") + '" aria-hidden="true"><use href="#i-' + n + '"/></svg>';
  }
  function cap(s) { s = String(s); return s.charAt(0).toUpperCase() + s.slice(1); }
  function pad2(n) { n = Math.max(0, Math.floor(n)); return n < 10 ? "0" + n : String(n); }

  // Why this phone is on the buzzer, in words the player can act on.
  function micWhy() {
    if (mic.why === "dictation") { return "This phone has Dictation switched off, so it can't hear guesses. Turn on Settings, General, Keyboard, Enable Dictation, then reload. Until then you buzz in."; }
    if (mic.why === "perm") { return "Mic blocked. Allow the microphone for this site in your browser settings, then reload. Until then you buzz in."; }
    if (mic.why === "nomic") { return "No microphone found on this device. You buzz in."; }
    if (mic.why === "inapp") { return "This in-app browser can't hear guesses. Open the link in Safari or Chrome to use your voice. Until then you buzz in."; }
    if (mic.state === "unsupported" || mic.why === "nostart" || mic.why === "lang") { return "This browser can't hear guesses, so you buzz in."; }
    return "";
  }

  function micHtml() {
    switch (mic.state) {
      case "unsupported":
        return '<span class="small">Buzzer only on this phone</span>';
      case "starting":
        return '<span class="label">Starting mic</span>';
      case "on":
        return '<span class="label">Mic on</span>';
      case "ready":
        return '<span class="label">Mic ready</span>';
      case "blocked":
        return '<p class="small">' + esc(micWhy()) + "</p>";
      default:
        return mic.buzzMode ? '<span class="small">You are on the buzzer</span>' : '<button id="micBtn" class="txt">Turn on mic</button>';
    }
  }

  // The one line of notes above the lobby's main button.
  function micRowHtml() {
    var notes = [];
    if (micWhy()) { notes.push(micWhy()); }
    if (wakeFail) { notes.push("This phone may dim its screen during the game. Give it a tap now and then."); }
    return notes.length ? '<p class="small">' + esc(notes.join(" ")) + "</p>" : "";
  }
  // The player turns the mic off themselves.
  function micStop() {
    mic.enabled = false;
    micPark();
    mic.state = "off"; refreshMic();
  }

  var lobbyMicSig = "";
  function refreshMic() {
    var mineBox = $('.mstat[data-mine]');
    if (st && mineBox) {
      var me = null; st.players.forEach(function (q) { if (q.id === st.me) { me = q; } });
      if (me) { var h = lobbyStat(st, me, st.hostId === st.me); if (mineBox.innerHTML !== h) { mineBox.innerHTML = h; } }
    }
    var boxes = document.querySelectorAll("[data-mic]");
    for (var i = 0; i < boxes.length; i++) {
      var want = boxes[i].getAttribute("data-mic") === "note" ? micRowHtml() : micHtml();
      if (boxes[i].innerHTML !== want) { boxes[i].innerHTML = want; }
      var b = $("#micBtn", boxes[i]);
      if (b) { b.onclick = micStart; }
    }
    var ms = mic.buzzMode || mic.state === "unsupported" || mic.state === "blocked" ? "typing" : (mic.state === "on" || mic.state === "ready" || (mic.state === "starting" && mic.ok) ? "on" : "off");
    if (st && !st.admin && ms !== lastMicSent) { lastMicSent = ms; send({ t: "mic", state: ms }); }
    var orb = $("#orb");
    if (orb) {
      orb.onclick = function () { if (SR && mic.state !== "on" && mic.state !== "starting") { micStart(); } };
      var off = mic.state !== "on";
      orb.classList.toggle("off", off);
      if (!orb.firstChild) { orb.innerHTML = '<i class="r"></i><i class="r"></i><i class="r"></i>' + ico("mic"); }
    }
    var hd = $("#listenHead");
    if (hd) {
      var ht = mic.state === "on" ? "Listening" : mic.state === "starting" ? "Starting mic" : "Mic is off, tap to turn on";
      if (hd.textContent !== ht) { hd.textContent = ht; }
    }
  }

  // ----------------------------------------------------------------- views
  // Pack groups, colours and text colours all come from the server (packs.js). The first group starts open.
  var openGroups = {}, openGroupsSet = false;

  function avatarHtml(s, p, cls) {
    var ch = (String(p.name).trim().charAt(0) || "?").toUpperCase();
    return '<span class="avatar pc pc' + ((p.ci || 0) % 8) + (cls ? " " + cls : "") + '">' + esc(ch) + "</span>";
  }

  function pts(n) { return Math.round(n).toLocaleString("en-GB"); }

  // Standings: rank, player, points and the rank change since the last leaderboard. Your own row is inverted.
  function standingsHtml(s, awards, winners, opt) {
    opt = opt || {};
    var gained = {};
    (awards || []).forEach(function (a) { gained[a.id] = a.points; });
    var list = s.players.slice().sort(function (a, b) { return b.total - a.total; });
    var rows = [], rank = 0, prev = null;
    list.forEach(function (p, i) {
      if (prev === null || p.total !== prev) { rank = i + 1; }
      prev = p.total;
      rows.push({ p: p, rank: rank });
    });
    if (opt.change) {
      var before = s.players.slice().sort(function (a, b) { return (b.prev || 0) - (a.prev || 0); });
      var pr = {}, r2 = 0, pv = null;
      before.forEach(function (p, i) {
        var t = p.prev || 0;
        if (pv === null || t !== pv) { r2 = i + 1; }
        pv = t; pr[p.id] = r2;
      });
      var tied = before.every(function (p) { return (p.prev || 0) === (before[0].prev || 0); });
      rows.forEach(function (r) { r.chg = tied ? undefined : pr[r.p.id] - r.rank; });
    }
    if (opt.limit && rows.length > opt.limit) {
      var top = rows.slice(0, opt.limit), me = rows.filter(function (r) { return r.p.id === s.me; })[0];
      if (me && top.indexOf(me) === -1) { top[top.length - 1] = me; }
      rows = top;
    }
    var final = !!opt.final;
    var html = rows.map(function (r) {
      var p = r.p, me = p.id === s.me, win = winners && winners.indexOf(p.id) !== -1;
      var chg = !r.chg ? "" : (r.chg > 0 ? "+" + r.chg : String(r.chg)); // places moved since the last turn; nothing when nothing moved
      return '<div class="' + (final ? "finalrow" : "stand" + (me ? " me" : "")) + '"><span class="label">' + r.rank + "</span>" +
        '<span class="title pn">' + avatarHtml(s, p) + '<span class="nmtx">' + esc(p.name) + (p.late ? '<small class="late">joined late</small>' : "") + "</span>" + (win ? '<span class="tag">Winner</span>' : "") + "</span>" +
        '<span class="title">' + pts(p.total) + "</span>" +
        (final ? "" : '<span class="ch">' + chg + "</span>") + "</div>";
    }).join("");
    return '<div class="board board--lined">' + html + "</div>";
  }

  function gamesHtml() {
    if (!gameList.length) {
      return '<div class="gamerow"><span class="gtxt"><span class="title">' + (gamesLoaded ? "Nobody\'s hosting on this wifi yet" : "Looking for games...") + "</span>" +
        (gamesLoaded ? '<span class="small">Games on your own wifi show here. Anywhere else, ask the host for the link or the QR code.</span>' : "") + "</span></div>";
    }
    return gameList.map(function (g) {
      var closed = g.inProgress, live = g.live;
      return (closed ? '<div class="gamerow dead">' : '<button class="gamebtn" data-code="' + esc(g.code) + '">') +
        '<span class="gtxt"><span class="title">' + esc(g.host) + "'s game</span>" +
        '<span class="small">' + (closed ? g.players + (g.players === 1 ? " player" : " players") + ", in a tie-break" : g.players + " of " + (g.max || 8) + " players" + (live ? ", game under way" : "")) + "</span></span>" +
        '<span class="label">' + (closed ? "Tie-break" : "Join") + "</span>" + (closed ? "</div>" : "</button>");
    }).join("");
  }

  function readName() {
    var el = $("#name"), n = el.value.replace(/\s+/g, " ").trim();
    if (!n) { el.classList.add("flag"); var h = $("#nameHint"); if (h) { h.textContent = "Enter your name first"; h.className = "title"; } el.focus(); return ""; }
    try { localStorage.setItem("whistle.name", n); } catch (e) {}
    pendingName = n;
    return n;
  }
  function nameField(val) {
    return '<div><label class="label flab" for="name">Your name</label><input id="name" class="input" maxlength="14" autocomplete="off" autocapitalize="words" placeholder="Type a name" value="' + esc(val) + '">' +
      '<p class="small" id="nameHint">Up to 14 characters</p></div>';
  }

  // A shared link opens straight on a name field and a Join lobby button.
  function viewInvite() {
    var name = ""; try { name = localStorage.getItem("whistle.name") || ""; } catch (e) {}
    var info = invite.info;
    var goHome = '<div class="homefoot"><button id="inviteHome" class="txt">Back to home</button><span></span></div>';
    if (!info || invite.loading) {
      return { key: "invite-load", field: "orange", html: '<div class="screen"><div class="brand"><h1 class="headline">Joining the game</h1><p class="title">Finding the lobby...</p></div><div class="bar"><i></i></div><div class="spacer"></div>' + goHome + "</div>",
        bind: function () { $("#inviteHome").onclick = function () { invite = null; try { history.replaceState(null, "", location.pathname); } catch (e) {} lastKey = null; render(); }; } };
    }
    var closed = !info.found ? ["Game not found", "That link's not working any more. Ask the host for a new one."]
      : info.state === "started" ? [esc(info.host) + "'s game is in a tie-break", "You can jump in once it's back in the lobby."]
      : info.state === "over" ? [esc(info.host) + "'s game has finished", "Ask the host for a new link."]
      : info.state === "full" ? [esc(info.host) + "'s game is full", "All " + info.max + " places are taken."] : null;
    if (closed) {
      return { key: "invite-closed", field: "orange", html: '<div class="screen"><div class="brand"><h1 class="headline">' + closed[0] + '</h1><p class="title">' + closed[1] + '</p></div><div class="spacer"></div><button id="inviteHome" class="btn">Back to home</button></div>',
        bind: function () { $("#inviteHome").onclick = function () { invite = null; try { history.replaceState(null, "", location.pathname); } catch (e) {} lastKey = null; render(); }; } };
    }
    return {
      key: "invite", field: "orange",
      html: '<div class="screen"><div class="brand"><h1 class="headline">' + esc(info.host) + "'s game</h1>" +
        '<p class="title">' + info.players + " of " + info.max + " players are in</p></div>" +
        '<div class="field-group">' + nameField(name) + '<button id="joinBtn" class="btn">' + (info.state === "live" ? "Join game" : "Join lobby") + "</button>" +
          (info.state === "live" ? '<p class="small">The game\'s under way. You\'ll guess for the rest of this round, then perform from the next one.</p>' : "") + "</div>" +
        '<div class="spacer"></div>' + goHome + "</div>",
      bind: function () {
        var go = function () { var n = readName(); if (n) { autoMic(); send({ t: "join", code: invite.code, name: n }); } };
        $("#joinBtn").onclick = go;
        $("#name").onkeydown = function (e) { if (e.key === "Enter") { go(); } };
        $("#inviteHome").onclick = function () { invite = null; try { history.replaceState(null, "", location.pathname); } catch (e) {} lastKey = null; render(); };
      }
    };
  }

  // ------------------------------------------------------- lifetime stats (kept on this phone, per name)
  var STATS_KEY = "ttt_stats";
  function readStats() { try { return JSON.parse(localStorage.getItem(STATS_KEY) || "{}") || {}; } catch (e) { return {}; } }
  function fmtSec(ms) { return (ms / 1000).toFixed(1) + "s"; }
  function favPack(rec) {
    var best = null;
    Object.keys(rec.packs || {}).forEach(function (id) { if (!best || rec.packs[id] > rec.packs[best]) { best = id; } });
    return best ? (rec.packNames && rec.packNames[best]) || best : null;
  }
  // Adds this game to the player's record once. Returns the "new best" labels for the results screen.
  function recordGame(s) {
    var g = s.myGame; if (!g) { return []; }
    var name = pname(s, s.me), id = name.toLowerCase();
    var all = readStats(), rec = all[id];
    if (rec && rec.seen && rec.seen.indexOf(g.key) !== -1) { return (rec.lastBests && rec.lastKey === g.key) ? rec.lastBests : []; }
    var first = !rec;
    rec = rec || { name: name, games: 0, wins: 0, points: 0, performed: 0, solved: 0, guessed: 0, hardSolved: 0, bestStreak: 0, bestGuessMs: null, bestPerformMs: null, bestGame: 0, packs: {}, packNames: {}, seen: [] };
    var bests = [];
    if (g.bestGuessMs !== null && (rec.bestGuessMs === null || g.bestGuessMs < rec.bestGuessMs)) { if (!first) { bests.push("Fastest guess"); } rec.bestGuessMs = g.bestGuessMs; }
    if (g.bestPerformMs !== null && (rec.bestPerformMs === null || g.bestPerformMs < rec.bestPerformMs)) { if (!first) { bests.push("Your song guessed fastest"); } rec.bestPerformMs = g.bestPerformMs; }
    if (g.points > rec.bestGame) { if (!first) { bests.push("Highest score"); } rec.bestGame = g.points; }
    if (g.bestStreak > rec.bestStreak) { if (!first) { bests.push("Longest streak"); } rec.bestStreak = g.bestStreak; }
    rec.name = name; rec.games++; if (g.won) { rec.wins++; }
    rec.points += g.points; rec.performed += g.performed; rec.solved += g.solved; rec.guessed += g.guessed; rec.hardSolved += g.hardSolved;
    Object.keys(g.packs || {}).forEach(function (pid) {
      rec.packs[pid] = (rec.packs[pid] || 0) + g.packs[pid];
      var pk = s.packs.filter(function (p) { return p.id === pid; })[0]; if (pk) { rec.packNames[pid] = pk.name; }
    });
    rec.seen.push(g.key); rec.seen = rec.seen.slice(-20);
    rec.lastKey = g.key; rec.lastBests = bests;
    all[id] = rec;
    try { localStorage.setItem(STATS_KEY, JSON.stringify(all)); } catch (e) {}
    return bests;
  }
  function statRows(rec) {
    var rows = [
      ["Games played", rec.games], ["Wins", rec.wins], ["Total points", rec.points],
      ["Fastest guess", rec.bestGuessMs !== null ? fmtSec(rec.bestGuessMs) : "None yet"],
      ["Your song guessed fastest", rec.bestPerformMs !== null ? fmtSec(rec.bestPerformMs) : "None yet"],
      ["Highest score in a game", rec.bestGame], ["Longest streak", rec.bestStreak],
      ["Songs guessed", rec.guessed], ["Hard songs got", rec.hardSolved],
      ["Favourite pack", favPack(rec) || "None yet"]
    ];
    return rows.map(function (r) { return '<div class="strow"><span class="small">' + r[0] + '</span><b class="title">' + esc(r[1]) + "</b></div>"; }).join("");
  }
  function showStats(name) {
    var rec = readStats()[String(name || "").toLowerCase()];
    var all = readStats(), names = Object.keys(all);
    if (!rec) { rec = all[names[0]]; }
    if (!rec) { return; }
    var o = document.createElement("div"); o.className = "ovl";
    o.innerHTML = '<div class="scrim"></div><div class="sheet"><div class="label">Your stats, ' + esc(rec.name) + "</div>" + statRows(rec) +
      '<p class="small">Saved on this phone only.</p><button class="btn" id="stDone">Done</button></div>';
    document.body.appendChild(o);
    var close = function () { if (o.parentNode) { o.parentNode.removeChild(o); } };
    o.querySelector("#stDone").onclick = close; o.querySelector(".scrim").onclick = close;
  }
  function hasStats() { return Object.keys(readStats()).length > 0; }

  function readNameQuiet() { try { return localStorage.getItem("whistle.name") || ""; } catch (e) { return ""; } }
  function viewHome() {
    if (invite) { return viewInvite(); }
    var name = ""; try { name = localStorage.getItem("whistle.name") || ""; } catch (e) {}
    return {
      key: "home", field: "orange",
      html:
        '<div class="screen">' +
          '<div class="brand"><h1 class="headline">Tip of My Tongue</h1>' +
          '<p class="title">One person performs a song. Everyone else guesses it. Quick guesses score big!</p></div>' +
          '<div class="field-group">' + nameField(name) + '<button id="hostBtn" class="btn">Start lobby</button>' +
          '<p class="small">Start a lobby and we\'ll copy a link to send to your friends.</p></div>' +
          '<div class="stack"><h2 class="label">Join a game</h2><div class="line-list" id="games">' + gamesHtml() + "</div>" +
          '</div>' +
          '<div class="spacer"></div>' +
          '<div class="homefoot"><button id="helpBtn" class="txt">How to play</button>' + (hasStats() ? '<button id="statsBtn" class="txt">Your stats</button>' : "") +
          '<button id="adminDot" class="admindot" aria-label="Admin"></button></div>' +
        "</div>",
      update: function () {
        var g = $("#games"); if (!g) { return; }
        g.innerHTML = gamesHtml();
        var bs = g.querySelectorAll(".gamebtn");
        for (var i = 0; i < bs.length; i++) {
          bs[i].onclick = function () { var n = readName(); if (n) { autoMic(); send({ t: "join", code: this.getAttribute("data-code"), name: n }); } };
        }
      },
      bind: function () {
        var go = function () { var n = readName(); if (n) { copyOnJoin = true; autoMic(); primeCopy(); send({ t: "create", name: n }); } };
        $("#hostBtn").onclick = go;
        $("#name").onkeydown = function (e) { if (e.key === "Enter") { go(); } };
        $("#helpBtn").onclick = function () { usage("howto", "home"); showHelp(); };
        var sb = $("#statsBtn"); if (sb) { sb.onclick = function () { showStats(readNameQuiet()); }; }
        $("#adminDot").onclick = function () { adminLogin = true; render(); };
      }
    };
  }

  function viewAdminLogin() {
    return {
      key: "adminlogin", field: "ground",
      html:
        '<div class="screen">' +
          '<div class="brand"><h1 class="headline">Admin</h1>' +
          '<p class="small">Stats and the demo game.</p></div>' +
          '<div class="field-group"><label class="label" for="apw">Password</label>' +
          '<input id="apw" class="input" type="password" autocomplete="off" placeholder="Password"></div>' +
          '<button id="aGo" class="btn">Sign in</button>' +
          '<div class="spacer"></div>' +
          '<button id="aBack" class="txt">Back</button>' +
        "</div>",
      bind: function () {
        var go = function () { adminPw = $("#apw").value; send({ t: "adminStats", password: adminPw }); };
        $("#aGo").onclick = go;
        $("#apw").onkeydown = function (e) { if (e.key === "Enter") { go(); } };
        $("#aBack").onclick = function () { adminLogin = false; render(); };
      }
    };
  }

  function dash(v, unit) { return v === null || v === undefined ? "No data yet" : v + (unit || ""); }
  function arow(label, value) { return '<div class="strow"><span class="small">' + esc(label) + '</span><b class="title">' + esc(value) + "</b></div>"; }
  function backupLine(d) {
    var r = d.remote || {};
    if (r.mode === "none") { return "Not backed up. Stats are lost when the server restarts or you push a change. Add the Upstash settings on Render to keep them for good."; }
    if (r.status === "connected") { return "Backed up to " + r.mode + ". " + r.loaded + " earlier events were loaded when the server started" + (r.waiting ? ", " + r.waiting + " waiting to save." : ".") + (r.lastError ? " Last error: " + r.lastError : ""); }
    if (r.status === "error") { return "Backup problem: " + (r.lastError || "unknown") + ". New events are kept in memory and the server log."; }
    return "Connecting to the backup...";
  }
  var adminTab = "overview";
  var ADMIN_TABS = [["overview", "Overview"], ["length", "Length"], ["guessing", "Guessing"], ["songs", "Songs"], ["difficulty", "Difficulty"], ["help", "Help use"], ["devices", "Devices"]];
  function pctTxt(v) { return v === null || v === undefined ? "No data yet" : v + "%"; }
  function adminTabHtml(tab, d) {
    var L = d.live || {}, V = d.voice || {}, S = d.songs || {}, G = d.games || {}, H = d.help || {}, D = d.devices || {}, F = d.funnel || {};
    var src = V.correctBySource || {};
    var guessPct = d.guessRate === null || d.guessRate === undefined ? "No data yet" : Math.round(d.guessRate * 100) + "% of turns";
    var rej = V.rejectRate === null || V.rejectRate === undefined ? "No data yet" : Math.round(V.rejectRate * 100) + "%";
    var recent = (d.recentGames || []).map(function (g) {
      var ago = Math.max(1, Math.round((Date.now() - g.at) / 60000));
      return arow((g.finished ? "" : "Abandoned, ") + g.players + " players, " + g.rounds + " rounds", g.minutes + " min, " + (ago < 120 ? ago + " min ago" : Math.round(ago / 60) + " h ago"));
    }).join("");
    var songs = function (a, f) { return (a || []).map(function (x) { return arow(x.song, f(x)); }).join("") || '<p class="small">Needs songs played at least twice.</p>'; };
    var obj = function (o, fmt) { var k = Object.keys(o || {}).sort(function (x, y) { return o[y] - o[x]; }); return k.map(function (n) { return arow(n, fmt ? fmt(o[n]) : o[n]); }).join("") || '<p class="small">No data yet</p>'; };
    var block = function (title, inner) { return '<div class="stack"><div class="label">' + title + "</div>" + inner + "</div>"; };
    if (tab === "overview") {
      return block("Right now", arow("Live rooms", L.rooms || 0) + arow("Players online", L.players || 0) + arow("Rooms in a game", L.inGame || 0) + arow("Server up", (d.serverUptimeMin || 0) + " min") + arow("Library", d.library ? d.library.songs + " songs, " + d.library.packs + " packs" : "")) +
        block("Headlines", arow("Games finished", dash(d.gamesFinished)) + arow("Average game", dash(d.avgGameMin, " min")) + arow("Songs guessed", guessPct) + arow("Voice guesses rejected", rej) + arow("Play again rate", F.playAgainRate === null || F.playAgainRate === undefined ? "No data yet" : Math.round(F.playAgainRate * 100) + "%")) +
        block("Recent games", recent || '<p class="small">No games yet</p>');
    }
    if (tab === "length") {
      var by = Object.keys(d.byPlayers || {}).map(function (k) { var b = d.byPlayers[k]; return arow(k + " players", b.avgGameMin + " min, " + b.avgSecPerTurn + "s a turn (" + b.games + (b.games === 1 ? " game)" : " games)")); }).join("");
      return block("Game length", arow("Finished", dash(d.gamesFinished)) + arow("Abandoned", dash(d.gamesAbandoned)) + arow("Average game", dash(d.avgGameMin, " min")) + arow("Median game", dash(d.medianGameMin, " min")) + arow("Seconds per turn", dash(d.avgSecPerTurn, "s")) + arow("Lobby estimate vs real", d.estimateAccuracy && d.estimateAccuracy.avgActualOverEstimate !== null ? "x" + d.estimateAccuracy.avgActualOverEstimate : "No data yet")) +
        block("By player count", by || '<p class="small">No data yet</p>') +
        block("Lobby and drop-off", arow("Average time in lobby", dash(F.avgLobbyMin, " min")) + arow("Abandoned games stop at", F.abandonedAtPct === null || F.abandonedAtPct === undefined ? "No data yet" : F.abandonedAtPct + "% of turns") + arow("Late joiners per game", dash(G.avgLateJoiners)));
    }
    if (tab === "guessing") {
      return block("Guessing", arow("Songs guessed", guessPct) + arow("Average guess time", dash(d.avgGuessSec, "s")) + arow("Median guess time", dash(d.medianGuessSec, "s")) + arow("Hints per turn", dash(d.avgHintsPerTurn)) + arow("Shuffles per turn", dash(d.avgShufflesPerTurn))) +
        block("Voice guessing", arow("Guesses the game heard", dash(V.heardGuesses)) + arow("Rejected by performer", rej) + arow("Correct by voice", dash(src.voice)) + arow("Correct by buzzer", dash(src.buzz)) + arow("Correct by Someone got it", dash(src.manual)) + (src.typed ? arow("Correct by typing (old games)", dash(src.typed)) : "")) +
        block("By difficulty", ["easy", "medium", "hard"].map(function (k) { var x = (V.byDifficulty || {})[k]; return arow(cap(k), !x || !x.turns ? "No data yet" : x.turns + (x.turns === 1 ? " turn, " : " turns, ") + x.guessedPct + "% guessed" + (x.avgGuessSec === null ? "" : ", " + x.avgGuessSec + "s average")); }).join("")) +
        block("By round limit", obj(Object.keys(d.byLimit || {}).reduce(function (o, k) { o[k] = d.byLimit[k].avgGuessSec; return o; }, {}), function (v) { return v + "s average guess"; }));
    }
    if (tab === "songs") {
      return block("Hardest songs", songs(S.hardest, function (x) { return x.guessed + " of " + x.plays + " guessed"; })) + block("Quickest songs", songs(S.quickest, function (x) { return x.avgGuessSec + "s average"; })) +
        block("Packs played", (d.packsPlayed || []).map(function (p) { return arow(p.pack, p.turns + " turns"); }).join("") || '<p class="small">No data yet</p>');
    }
    if (tab === "difficulty") {
      var Df = d.difficulty || { differ: [], judged: 0, minPlays: 6 };
      return block("How it works", '<p class="small">A song is judged once it has been played ' + Df.minPlays + ' times. Easy means guessed nearly every time, quickly. Hard means often missed or slow. Performers pick their own songs, so use this as a prompt to review, not a verdict.</p>') +
        block("Songs judged so far", arow("Songs with enough plays", Df.judged) + arow("Where real play disagrees with the tier", Df.differ.length)) +
        block("Suggested changes", Df.differ.map(function (r) { return arow(r.song, r.tier + " to " + r.suggested + ", " + r.guessedPct + "% guessed, " + (r.medianSec === null ? "no time" : r.medianSec + "s") + ", " + r.plays + " plays"); }).join("") || '<p class="small">Nothing yet. This fills in as games are played.</p>');
    }
    if (tab === "help") {
      return block("? taps by screen", (H.byScreen || []).map(function (x) { return arow(x.screen, x.taps + (x.taps === 1 ? " tap, " : " taps, ") + x.share + "%"); }).join("") || '<p class="small">No taps yet</p>') +
        block("By screen and role", (H.byScreenAndRole || []).map(function (x) { return arow(x.screen, x.taps + (x.taps === 1 ? " tap" : " taps")); }).join("") || '<p class="small">No taps yet</p>') +
        block("How to play opened from", obj(H.howToOpened)) +
        block("Played before?", arow("Yes", (H.playedBefore || {}).yes || 0) + arow("No", (H.playedBefore || {}).no || 0)) +
        block("Sound", arow("Muted", (H.mute || {}).muted || 0) + arow("Unmuted", (H.mute || {}).unmuted || 0));
    }
    return block("Visits", arow("Page loads recorded", dash(D.visits))) + block("Browsers", obj(D.browsers)) + block("Systems", obj(D.os)) +
      block("Support", arow("Voice recognition", pctTxt(D.speechSupportPct)) + arow("Vibration", pctTxt(D.vibrationSupportPct)) + arow("Installed to home screen", pctTxt(D.installedPct))) +
      block("Mics at game start", obj(G.mics));
  }
  function viewAdminHub() {
    var d = adminData || {};
    return {
      key: "adminhub-" + adminTab, field: "ground",
      html: '<div class="screen">' +
        '<div class="brand"><h1 class="headline">Admin</h1></div>' +
        '<button id="aDemo" class="btn">Launch demo game</button>' +
        '<div class="atabs" role="tablist">' + ADMIN_TABS.map(function (t) { return '<button class="atab' + (t[0] === adminTab ? " on" : "") + '" role="tab" aria-selected="' + (t[0] === adminTab) + '" data-t="' + t[0] + '">' + t[1] + "</button>"; }).join("") + "</div>" +
        adminTabHtml(adminTab, d) +
        '<p class="small">' + backupLine(d) + "</p>" +
        '<div class="btnrow"><button id="aRefresh" class="btn btn--outline">Refresh</button><button id="aCopy" class="btn btn--outline">Copy JSON</button></div>' +
        '<button id="aRaw" class="btn btn--outline">Download all raw data</button>' +
        '<button id="aOut" class="txt txt--c">Sign out</button></div>',
      bind: function () {
        $("#aDemo").onclick = function () { send({ t: "createAdmin", password: adminPw }); };
        var tabs = document.querySelectorAll(".atab"), onTab = document.querySelector(".atab.on");
        if (onTab && onTab.scrollIntoView) { try { onTab.scrollIntoView({ block: "nearest", inline: "center" }); } catch (e) {} }
        for (var i = 0; i < tabs.length; i++) { tabs[i].onclick = function () { adminTab = this.getAttribute("data-t"); lastKey = null; render(); window.scrollTo(0, 0); }; }
        $("#aRefresh").onclick = function () { send({ t: "adminStats", password: adminPw }); toast("Refreshed"); };
        $("#aRaw").onclick = function () {
          fetch("/stats/raw", { headers: { "x-admin-key": adminPw } }).then(function (r) { if (!r.ok) { throw new Error("no"); } return r.blob(); }).then(function (b) {
            var a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = "tip-of-my-tongue-stats.jsonl"; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
          }).catch(function () { toast("Could not download"); });
        };
        $("#aCopy").onclick = function () {
          var txt = JSON.stringify(adminData, null, 2);
          try { navigator.clipboard.writeText(txt).then(function () { toast("Copied"); }, function () { toast("Could not copy"); }); } catch (e) { toast("Could not copy"); }
        };
        $("#aOut").onclick = function () { adminAuthed = false; adminPw = ""; adminData = null; adminLogin = false; adminTab = "overview"; lastKey = null; render(); };
      }
    };
  }

  // Strip along the top while in admin mode: pick which test player to view as.
  var adminHtmlCache = "";
  function refreshAdmin() {
    var bar = document.getElementById("adminBar");
    if (!st || !st.admin) {
      if (bar) { bar.parentNode.removeChild(bar); }
      document.body.classList.remove("admin"); adminHtmlCache = ""; return;
    }
    var a = st.admin;
    var html = '<span class="atag">Admin</span><div class="achips">' + a.players.map(function (p) {
      return '<button class="achip' + (p.id === a.as ? " on" : "") + '" data-id="' + esc(p.id) + '">' + esc(p.name) + (p.id === st.hostId ? " (host)" : "") + "</button>";
    }).join("") + "</div>" + (a.canAdd ? '<button id="aAdd">+ Player</button>' : "") + '<button id="aAuto" class="' + (a.autoplay ? "aon" : "") + '">Bots ' + (a.autoplay ? "on" : "off") + "</button>" + '<button id="aExit">Exit</button>';
    document.body.classList.add("admin");
    if (!bar) { bar = document.createElement("div"); bar.id = "adminBar"; bar.className = "adminbar"; document.body.insertBefore(bar, app); adminHtmlCache = ""; }
    if (html === adminHtmlCache) { return; }
    adminHtmlCache = html; bar.innerHTML = html;
    var cs = bar.querySelectorAll(".achip");
    for (var i = 0; i < cs.length; i++) { cs[i].onclick = function () { send({ t: "adminAs", id: this.getAttribute("data-id") }); }; }
    var au = document.getElementById("aAuto"); if (au) { au.onclick = function () { send({ t: "adminAutoplay", on: !(st && st.admin && st.admin.autoplay) }); }; }
    var add = document.getElementById("aAdd"); if (add) { add.onclick = function () { send({ t: "adminAddBot" }); }; }
    document.getElementById("aExit").onclick = function () { adminHtmlCache = ""; pickerOpen = false; if (adminAuthed) { adminLogin = true; send({ t: "adminStats", password: adminPw }); } leaveRoom(); };
  }

  var LEN_LABEL = { 30000: "30 s", 60000: "1 min", 90000: "1 min 30", 120000: "2 min" };
  function lengthHtml(s, isHost) {
    var opts = s.limitOptions || [30000, 60000, 90000, 120000];
    if (!isHost) {
      return '<div class="setrow"><div><div class="label">Time per turn</div><p class="small">Set by the host. A turn ends as soon as the song is guessed.</p></div>' +
        '<span class="title" id="limitVal">' + (LEN_LABEL[s.limitMs] || s.limitMs / 1000 + " s") + "</span></div>";
    }
    return '<div class="stack"><div class="label">Time per turn</div><p class="small">A turn ends as soon as the song is guessed.</p><div class="seg">' + opts.map(function (ms) {
      return '<button class="segb' + (ms === s.limitMs ? " on" : "") + '" aria-pressed="' + (ms === s.limitMs) + '" data-ms="' + ms + '">' + LEN_LABEL[ms] + "</button>";
    }).join("") + "</div></div>";
  }

  function micLabel(p) {
    if (!p.connected) { return "Away"; }
    return p.mic === "on" ? "Mic on" : p.mic === "typing" ? "Buzzer" : "Mic off";
  }

  function packCard(p, on, ro, voters) {
    var vh = "";
    if (voters && voters.length) {
      vh = '<span class="voters">' + voters.slice(0, 2).join("") + '</span><span class="title">' + voters.length + "</span>";
    }
    return '<button class="pcard pack' + (on ? " on" : "") + (ro ? " ro" : "") + '" data-id="' + p.id + '" aria-pressed="' + on + '"' + (ro ? " disabled" : "") +
      ' style="--pc:' + esc(p.colour || "#111111") + ";--pt:" + esc(p.ink || "#ECEAE4") + '"><span class="pcard__in"><span class="pcard__txt"><span class="title">' + esc(p.name) + "</span>" +
      '<span class="small">' + esc(p.blurb) + '</span></span><span class="pcard__cl">' + vh +
      '<span class="tickc">' + ico("tick") + "</span></span></span></button>";
  }

  // Packs with votes, most popular first.
  function rankingList(s) {
    var votes = s.packVotes || {};
    return s.packs.map(function (p, i) { return { p: p, n: (votes[p.id] || []).length, i: i }; })
      .filter(function (r) { return r.n > 0; })
      .sort(function (a, b) { return b.n - a.n || (s.selectedPacks.indexOf(b.p.id) !== -1) - (s.selectedPacks.indexOf(a.p.id) !== -1) || a.i - b.i; });
  }

  function packSummaryLine(on) {
    if (!on.length) { return "No packs chosen yet"; }
    if (on.length === 1) { return on[0].name; }
    if (on.length === 2) { return on[0].name + " and " + on[1].name; }
    return on[0].name + " and " + (on.length - 1) + " more";
  }

  // The lobby shows one short line about the chosen packs. The picker opens on top.

  // Guests see one quiet line about the songs and, in room mode, a way to vote.

  function pickerHtml(s, isHost) {
    var room = s.packMode === "room", votes = s.packVotes || {};
    var all = s.packs.length === s.selectedPacks.length;
    var cap = s.packPicks || 3;
    var mine = room ? (packDraft || s.myPackVotes || []) : [];
    var groups = [], at = {};
    s.packs.forEach(function (p) {
      var n = p.group || "More";
      if (at[n] === undefined) { at[n] = groups.length; groups.push({ name: n, packs: [] }); }
      groups[at[n]].packs.push(p);
    });
    if (!openGroupsSet && groups.length) { openGroups[groups[0].name] = true; openGroupsSet = true; }
    var isOn = function (p) { return room ? mine.indexOf(p.id) !== -1 : s.selectedPacks.indexOf(p.id) !== -1; };
    var html = groups.map(function (g) {
      var open = !!openGroups[g.name], cnt = g.packs.filter(isOn).length;
      var cards = g.packs.map(function (p) {
        var voters = room ? (votes[p.id] || []).map(function (id) { var pl = player(s, id); return pl ? avatarHtml(s, pl) : ""; }) : [];
        return packCard(p, isOn(p), !room && !isHost, voters);
      }).join("");
      return '<div class="pgroup' + (open ? " open" : "") + '"><button class="pgroup__row" data-g="' + esc(g.name) + '" aria-expanded="' + open + '">' +
        '<span class="pgroup__name"><span class="label">' + esc(g.name) + "</span>" +
        (cnt ? '<span class="pgroup__sel">' + cnt + " picked</span>" : "") + "</span>" +
        '<span class="label lrow__c">' + (open ? "Close" : "Open") + '</span></button><div class="pdeck">' + cards + "</div></div>";
    }).join("");
    var intro = room ? "Pick up to " + cap + ". Every pack anyone picks goes into one mix, and the popular ones come up more." : isHost ? "Pick as many as you like. They decide which songs come up." : "The host picks the packs.";
    var count = room ? mine.length + " of " + cap + " picks used" : s.selectedPacks.length + " of " + s.packs.length + " packs picked";
    return '<div class="picker" id="picker"><div class="pwrap">' +
      '<div class="phead"><div class="toprow"><span class="label">Song packs</span><button class="txt" id="pkDone">' + (room ? "Close" : "Done") + '</button></div>' +
      '<h1 class="headline">' + (room ? "Pick the packs you want" : isHost ? "Choose the packs to play" : "The packs in play") + "</h1>" +
      '<div class="stack stack--4"><p class="small">' + intro + '</p><p class="small">' + count + "</p></div>" +
      (isHost ? '<div class="seg packmode"><button class="pmode" data-m="host" aria-pressed="' + !room + '">Host picks</button><button class="pmode" data-m="room" aria-pressed="' + room + '">Room picks</button></div>' : "") +
      (isHost && !room ? '<div><button class="txt" id="packAll">' + (all ? "Clear all" : "Select all packs") + "</button></div>" : "") + "</div>" +
      '<div class="pbody"><div>' + html + "</div></div>" +
    "</div>" + (room ? '<div class="pfloat"><button class="btn" id="pkSubmit">' + ((s.myPackVotes || []).length ? "Update my picks" : "Submit picks") + "</button></div>" : "") + "</div>";
  }

  function startNote(s, turns) {
    if (s.players.length < s.minPlayers) { return "Need at least " + s.minPlayers + " players to get going. Share the link!"; }
    if (!s.selectedPacks.length) { return s.packMode === "room" ? "Waiting for someone to pick some song packs" : "Pick a song pack to get going"; }
    if (s.songsInPlay < turns + 5) { return "Not enough songs for that many turns. Add more packs or drop a round."; }
    var off = s.players.filter(function (p) { return p.mic === "off"; }).map(function (p) { return p.name; });
    if (off.length) { return (off.length > 1 ? off.slice(0, -1).join(", ") + " and " + off[off.length - 1] : off[0]) + (off.length > 1 ? " have their mics off" : " has their mic off") + ". They can buzz in instead."; }
    return "";
  }

  function songsLine(s) {
    var room = s.packMode === "room";
    var on = s.packs.filter(function (p) { return s.selectedPacks.indexOf(p.id) !== -1; });
    if (room) { var r = rankingList(s); return r.length ? "In the mix: " + packSummaryLine(on) : "No picks yet"; }
    return packSummaryLine(on);
  }
  function songsDetail(s) {
    if (s.packMode === "room") {
      return rankingList(s).map(function (x) { return x.p.name + " (" + x.n + ")"; }).join(", ");
    }
    return s.packs.filter(function (p) { return s.selectedPacks.indexOf(p.id) !== -1; }).map(function (p) { return p.name; }).join(", ");
  }
  function songsTitle(s) {
    var n = s.selectedPacks.length;
    if (s.packMode === "room") { var r = rankingList(s).length; return r ? r + (r === 1 ? " pack in the mix" : " packs in the mix") : "No picks yet"; }
    return n ? n + (n === 1 ? " pack" : " packs") : "No packs chosen yet";
  }
  // One row for the songs. In room-picks mode the same row is where every player goes to pick.
  function songsRowHtml(s, isHost) {
    var room = s.packMode === "room", n = (s.myPackVotes || []).length;
    var cue = room ? (n ? "Change" : "Pick") : isHost ? "Choose" : "See";
    return '<button class="lrow" id="openPacks"><span class="lrow__t"><span class="label">Songs' + (room ? ", everyone picks " + (s.packPicks || 3) : "") + '</span>' +
      '<span class="title">' + esc(songsTitle(s)) + '</span></span><span class="lrow__c label">' + cue + "</span></button>";
  }
  // One row to invite people: the link for the group chat, and the QR code for people in the room.
  function inviteRowHtml(s, isHost) {
    return '<div class="lrow lrow--static"><span class="lrow__t"><span class="label">Invite</span></span>' +
      '<button class="txt" id="copyLink">Copy link</button>' + (isHost ? '<button class="txt" id="showQr">QR code</button>' : "") + "</div>";
  }
  // A full screen QR code that opens the join link, so friends in the room can just point their cameras at the host.
  function showQr(code) {
    if (document.getElementById("qrfull") || typeof qrcode !== "function") { return; }
    var svg = "";
    try { var q = qrcode(0, "M"); q.addData(linkFor(code)); q.make(); svg = q.createSvgTag({ cellSize: 1, margin: 4, scalable: true }); } catch (e) { return; }
    var o = document.createElement("div");
    o.id = "qrfull"; o.className = "qrfull"; o.setAttribute("role", "dialog"); o.setAttribute("aria-label", "QR code to join the game");
    o.innerHTML = '<button class="txt qrx">Close</button><div class="qrbox">' + svg + '</div>';
    document.body.appendChild(o);
    function close() { if (o.parentNode) { o.parentNode.removeChild(o); } document.removeEventListener("keydown", onKey); }
    function onKey(ev) { if (ev.key === "Escape") { close(); } }
    document.addEventListener("keydown", onKey);
    o.querySelector(".qrx").onclick = close;
    usage("qr", "lobby");
  }
  // A fair guess at game length. Most songs are guessed well inside the clock, so a turn is mostly the set-up
  // around it (picking, countdown, reveal: about 20 seconds), plus about 30 percent of the clock on average.
  function estMinutes(players, rounds, limitMs) {
    var perTurn = 20 + 0.3 * limitMs / 1000, total = perTurn * players * rounds + (rounds >= 4 ? 8 : 0);
    return Math.max(5, Math.round(total / 60 / 5) * 5);
  }
  function settingsText(s) {
    return s.rounds + (s.rounds === 1 ? " round" : " rounds") + ", up to " + (LEN_LABEL[s.limitMs] || s.limitMs / 1000 + " s") + " each";
  }
  function settingsRowHtml(s, isHost) {
    if (!isHost) { return '<div class="lrow lrow--static" id="guestSettings"><span class="lrow__t"><span class="label">Game</span><span class="title">' + settingsText(s) + "</span></span></div>"; }
    return '<button class="lrow" id="openSettings"><span class="lrow__t"><span class="label">Game</span><span class="title" id="settingsLine">' + settingsText(s) + '</span></span><span class="lrow__c label">Change</span></button>';
  }
  function settingsSheetHtml(s, turns) {
    var opts = s.limitOptions || [30000, 60000, 90000, 120000];
    return '<div class="sheetwrap"><div class="scrim" id="setScrim"></div><div class="sheet"><span class="label">Game settings</span>' +
      '<div class="setrow"><div><div class="label">Rounds</div><p class="small">' + turns + " turns in all, about " + estMinutes(Math.max(2, s.players.length), s.rounds, s.limitMs) + " min</p>" + (s.roundsAuto ? '<p class="small">Set for ' + s.players.length + (s.players.length === 1 ? " player" : " players") + ". It updates as people join, until you change it.</p>" : "") + "</div>" +
      '<div class="stepper"><button id="minus" class="txt" aria-label="Fewer rounds">Less</button><span class="title val" id="roundsVal">' + s.rounds + '</span><button id="plus" class="txt" aria-label="More rounds">More</button></div></div>' +
      '<div class="stack"><div class="label">Time per turn</div><p class="small">A turn ends as soon as the song is guessed.</p><div class="seg">' + opts.map(function (ms) {
        return '<button class="segb' + (ms === s.limitMs ? " on" : "") + '" aria-pressed="' + (ms === s.limitMs) + '" data-ms="' + ms + '">' + LEN_LABEL[ms] + "</button>";
      }).join("") + "</div></div>" +
      '<button class="btn" id="setDone">Done</button></div></div>';
  }

  // The mic line on a player's tile. `short` is for the four-across grid, where there is room for one word.
  function lobbyStat(s, p, isHost, short) {
    var mine = p.id === s.me, away = !p.connected;
    if (short === undefined) { short = s.players.length > 4; }
    var lab = away ? "Away" : mine ? (mic.buzzMode || mic.state === "blocked" || mic.state === "unsupported" ? "Buzzer" : mic.state === "on" || mic.state === "ready" ? "Mic on" : mic.state === "starting" ? "Starting" : "Mic off") : micLabel(p);
    var on = lab === "Mic on", bz = lab === "Buzzer";
    var text = !short ? lab : on ? "On" : bz ? "Buzz" : lab === "Mic off" ? "Off" : lab === "Starting" ? "Wait" : lab;
    return '<i class="mdot' + (on ? " on" : bz ? " kb" : "") + '"></i><span class="label">' + text + "</span>";
  }
  function viewLobby(s) {
    var isHost = s.hostId === s.me;
    var turns = s.rounds * s.players.length;
    var many = s.players.length > 4;
    var cells = s.players.map(function (p) {
      var mine = p.id === s.me, away = !p.connected;
      // Your own tile is the mic switch. For the host, the tile of someone who has gone is how to remove them.
      // The headline already says whose game it is, so no tile needs a host badge.
      var canMic = mine && !s.admin && SR && !IN_APP && !away && mic.state !== "blocked" && mic.state !== "unsupported";
      var canRm = isHost && away && !mine;
      var tag = canMic || canRm ? "button" : "div";
      var act = canMic ? ' data-act="mic" aria-label="Your microphone. Tap to turn it on or off"' : canRm ? ' data-act="rm" data-id="' + esc(p.id) + '" aria-label="' + esc(p.name) + ' is away. Tap to remove them"' : "";
      return "<" + tag + ' class="pcell' + (canMic || canRm ? " pcell--tap" : "") + '"' + act + ">" + avatarHtml(s, p, "avatar--md") +
        '<span class="pn"><span class="pname">' + esc(p.name) + "</span>" +
        '<span class="mstat"' + (mine ? ' data-mine="1"' : "") + ">" + lobbyStat(s, p, isHost, many) + "</span></span></" + tag + ">";
    }).join("");
    var note = isHost ? startNote(s, turns) : "";
    return {
      key: "lobby", field: "pink",
      html:
        '<div class="screen">' +
          '<div class="head"><h1 class="headline">' + esc(pname(s, s.hostId)) + "'s game</h1>" +
            '<p class="small">' + s.players.length + " of " + s.maxPlayers + " players are in</p></div>" +
          '<div class="pgrid' + (many ? " pgrid--4" : "") + '">' + cells + "</div>" +
          '<div class="lrows">' + songsRowHtml(s, isHost) + settingsRowHtml(s, isHost) + inviteRowHtml(s, isHost) + "</div>" +
          '<div class="spacer"></div>' +
          (isHost ? "" : '<p class="' + (many ? "title center" : "headline") + ' waiting">Waiting for ' + esc(pname(s, s.hostId)) + ' to start</p><div class="spacer"></div>') +
          '<div class="micst" data-mic="note"></div>' +
          (isHost
            ? '<button id="startBtn" class="btn"' + (s.players.length < s.minPlayers || !s.selectedPacks.length || s.songsInPlay < turns + 5 ? " disabled" : "") + ">Start game</button>" +
              (note ? '<p class="small center startnote">' + esc(note) + "</p>" : "")
            : "") +
          '<div class="rowc"><button id="helpBtn" class="txt">How to play</button>' +
          '<button id="sfxBtn" class="txt">' + (sfxOn ? "Sound on" : "Sound off") + "</button>" +
          '<button id="leaveBtn" class="txt">Leave game</button></div>' +
          (pickerOpen ? pickerHtml(s, isHost) : "") +
          (settingsOpen && isHost ? settingsSheetHtml(s, turns) : "") +
        "</div>",
      bind: function () {
        $("#helpBtn").onclick = function () { usage("howto", "lobby"); showHelp(); };
        $("#sfxBtn").onclick = function () { setSfx(!sfxOn); this.textContent = sfxOn ? "Sound on" : "Sound off"; };
        $("#copyLink").onclick = function () { copyText(linkFor(s.code), false); };
        if ($("#showQr")) { $("#showQr").onclick = function () { showQr(s.code); }; }
        var taps = document.querySelectorAll(".pcell--tap");
        for (var mi = 0; mi < taps.length; mi++) {
          taps[mi].onclick = function () {
            if (this.getAttribute("data-act") === "mic") {
              if (mic.state === "on" || mic.state === "starting" || mic.state === "ready") { micStop(); } else { micStart(); }
              return;
            }
            var id = this.getAttribute("data-id");
            confirmDialog("Remove " + pname(s, id) + "?", "They are taken out of the game. They can join again from the link.", "Remove", true, function () { send({ t: "removePlayer", id: id }); });
          };
        }
        var sr = $("#openSettings");
        if (sr) { sr.onclick = function () { settingsOpen = true; render(); }; }
        if (settingsOpen && isHost) {
          $("#setDone").onclick = function () { settingsOpen = false; render(); };
          $("#setScrim").onclick = function () { settingsOpen = false; render(); };
        }
        var openP = function () { pickerOpen = true; if (s.packMode === "room") { packDraft = (s.myPackVotes || []).slice(); } keepPickerScroll = false; render(); };
        var op = $("#openPacks"); if (op) { op.onclick = openP; }
        if (pickerOpen) {
          $("#pkDone").onclick = function () { pickerOpen = false; packDraft = null; render(); };
          var rows = document.querySelectorAll(".pgroup__row");
          for (var g = 0; g < rows.length; g++) {
            rows[g].onclick = function () { var n = this.getAttribute("data-g"); openGroups[n] = !openGroups[n]; render(); };
          }
          var cardsEl = document.querySelectorAll(".pack");
          if (s.packMode === "room") {
            var cap = s.packPicks || 3;
            if (!packDraft) { packDraft = (s.myPackVotes || []).slice(); }
            for (var c2 = 0; c2 < cardsEl.length; c2++) {
              cardsEl[c2].onclick = function () {
                var id = this.getAttribute("data-id"), at = packDraft.indexOf(id);
                if (at === -1) { if (packDraft.length >= cap) { toast("You can pick up to " + cap + " packs."); return; } packDraft.push(id); }
                else { packDraft.splice(at, 1); }
                render();
              };
            }
            $("#pkSubmit").onclick = function () {
              send({ t: "votePacks", packs: packDraft.slice() });
              pickerOpen = false; packDraft = null; render();
            };
          } else if (isHost) {
            var sel = s.selectedPacks.slice(), allIds = s.packs.map(function (p) { return p.id; });
            var sendPacks = function () { send({ t: "setPacks", packs: sel }); };
            for (var c = 0; c < cardsEl.length; c++) {
              cardsEl[c].onclick = function () {
                var id = this.getAttribute("data-id"), at = sel.indexOf(id);
                if (at === -1) { sel.push(id); }
                else { sel.splice(at, 1); }
                var isOn = sel.indexOf(id) !== -1;
                this.classList.toggle("on", isOn);
                this.setAttribute("aria-pressed", isOn);
                sendPacks();
              };
            }
            $("#packAll").onclick = function () {
              if (sel.length === allIds.length) { sel = []; } else { sel = allIds.slice(); }
              sendPacks();
            };
          }
        }
        var pm = document.querySelectorAll(".pmode");
        for (var q = 0; q < pm.length; q++) { pm[q].onclick = function () { send({ t: "setPackMode", mode: this.getAttribute("data-m") }); }; }
        if (isHost) {
          var want = s.rounds;
          if ($("#minus")) {
            $("#minus").onclick = function () { want = Math.max(1, want - 1); send({ t: "setRounds", rounds: want }); };
            $("#plus").onclick = function () { want = Math.min(10, want + 1); send({ t: "setRounds", rounds: want }); };
          }
          $("#startBtn").onclick = function () { send({ t: "start" }); };
          var segs = document.querySelectorAll(".segb");
          for (var i = 0; i < segs.length; i++) {
            segs[i].onclick = function () { send({ t: "setLimit", limitMs: parseInt(this.getAttribute("data-ms"), 10) }); };
          }
        }
        $("#leaveBtn").onclick = leaveRoom;
      }
    };
  }

  function listNames(a) {
    return a.length > 1 ? a.slice(0, -1).join(", ") + " and " + a[a.length - 1] : (a[0] || "");
  }
  function topLabel(s) {
    var T = s.turn, wp = player(s, T.playerId);
    // A whistler whose phone has dropped gets a grace period, and everyone can see why the game has paused.
    if (wp && !wp.connected && T.stage !== "reveal" && T.playerId !== s.me) { return "Waiting for " + wp.name; }
    if (T.sd) { return "Tie-break round " + s.sdRound; }
    return "Round " + T.round + " of " + s.rounds;
  }

  // The top row: where you are in the game and, away from a live turn, one word for help.
  // Whilst the clock is running the row is the label alone, so the timed screens stay clean.
  function topBar(s) {
    return '<div class="tbar"><span class="label" id="topLabel">' + esc(topLabel(s)) + "</span>" +
      (liveStage(s.turn) ? "" : '<button class="txt" id="helpTop">Help</button>') + '</div><div id="lastRound"></div>';
  }

  // Kept up to date on every state change, even when the screen itself is not redrawn.
  function refreshTop() {
    if (!st || !st.turn) { return; }
    var l = $("#topLabel"); if (l) { var tl = topLabel(st); if (l.textContent !== tl) { l.textContent = tl; } }
    var hb = $("#helpTop"); if (hb) { hb.onclick = showHelpSheet; }
    var b = $("#lastRound"); if (!b) { return; }
    var T = st.turn, isHost = st.hostId === st.me;
    // The last-round banner belongs on the choose and score screens, never on a timed one.
    var show = !T.sd && !st.suddenDeath && T.round === st.rounds && !liveStage(T);
    var html = "";
    if (show && isHost) {
      var n = T.roundVotes || 0;
      html = '<button id="addRound" class="lastbanner"><span class="label">Last round</span><span class="small">' +
        (n ? n + (n === 1 ? " person wants" : " people want") + " an extra round. Tap to add one" : "Tap to add an extra round") + "</span></button>";
    } else if (show) {
      html = '<button id="voteRound" class="lastbanner' + (T.iVotedRound ? " voted" : "") + '"><span class="label">Last round</span><span class="small">' +
        (T.iVotedRound ? "You asked for an extra round. Tap to undo" : "Tap to ask the host for an extra round") + "</span></button>";
    }
    if (b.getAttribute("data-h") === html) { return; }
    b.setAttribute("data-h", html); b.innerHTML = html;
    var ar = $("#addRound"); if (ar) { ar.onclick = function () { send({ t: "addRound" }); }; }
    var vr = $("#voteRound"); if (vr) { vr.onclick = function () { send({ t: "voteRound" }); }; }
  }

  function skipHtml(s) {
    // Not on a timed screen. No stage can hang for long (see the timers in game.js), so the host never needs it there.
    if (s.hostId !== s.me || liveStage(s.turn)) { return ""; }
    return '<div class="rowc rowc--c"><button id="hostMenuBtn" class="txt">Host controls</button></div>';
  }

  function confirmDialog(title, text, okLabel, danger, fn) {
    var o = document.createElement("div");
    o.className = "modalwrap";
    o.innerHTML = '<div class="scrim"></div><div class="modal"><h2 class="title">' + esc(title) + '</h2><p class="small">' + esc(text) + '</p>' +
      '<div class="modal__actions"><button class="txt" id="cdNo">Cancel</button><button class="txt" id="cdOk">' + esc(okLabel) + '</button></div></div>';
    document.body.appendChild(o);
    var close = function () { if (o.parentNode) { o.parentNode.removeChild(o); } };
    $("#cdNo", o).onclick = close;
    $("#cdOk", o).onclick = function () { close(); fn(); };
  }

  function openHostMenu() {
    var o = document.createElement("div");
    o.className = "sheetwrap";
    var canSkip = st && st.turn && st.turn.stage !== "reveal";
    o.innerHTML = '<div class="scrim" id="hmScrim"></div><div class="sheet"><span class="label">Host controls</span>' +
      (canSkip ? '<button id="skipBtn" class="btn btn--outline">Skip this turn</button>' : "") +
      (st && st.players.length > 1 ? '<button id="rmBtn" class="btn btn--outline">Remove player</button>' : "") +
      '<button id="endBtn" class="btn btn--outline">End game</button>' +
      '<button class="txt txt--c" id="hmClose">Close</button></div>';
    document.body.appendChild(o);
    var close = function () { if (o.parentNode) { o.parentNode.removeChild(o); } };
    $("#hmClose", o).onclick = close; $("#hmScrim", o).onclick = close;
    var rb = $("#rmBtn", o);
    if (rb) {
      rb.onclick = function () {
        o.querySelector(".sheet").innerHTML = '<span class="label">Remove a player</span>' +
          st.players.filter(function (p) { return p.id !== st.me; }).map(function (p) {
            return '<button class="btn btn--outline rmp" data-id="' + esc(p.id) + '">' + esc(p.name) + (p.connected ? "" : " (away)") + "</button>";
          }).join("") + '<button class="txt txt--c" id="rmBack">Back</button>';
        $("#rmBack", o).onclick = function () { close(); openHostMenu(); };
        var rms = o.querySelectorAll(".rmp");
        for (var ri = 0; ri < rms.length; ri++) {
          rms[ri].onclick = function () {
            var id = this.getAttribute("data-id"); close();
            confirmDialog("Remove " + pname(st, id) + "?", "They are taken out of the game. They can join again from the link.", "Remove", true, function () { send({ t: "removePlayer", id: id }); });
          };
        }
      };
    }
    var sk = $("#skipBtn", o);
    if (sk) { sk.onclick = function () { close(); confirmDialog("Skip this turn?", "Nobody scores for it.", "Skip turn", false, function () { send({ t: "skip" }); }); }; }
    $("#endBtn", o).onclick = function () {
      close();
      confirmDialog("End this game?", "Everyone goes back to the lobby and scores are cleared.", "End game", true, function () { send({ t: "cancelGame" }); });
    };
  }

  function bindSkip() {
    var b = $("#hostMenuBtn");
    if (b) { b.onclick = openHostMenu; }
  }

  function songBlock(T, eyebrow) {
    var d = T.difficulty;
    return '<div class="songband">' + (eyebrow ? '<span class="label">' + eyebrow + "</span>" : "") +
      (d ? '<span class="tag">' + esc(cap(d)) + " x" + T.multiplier + "</span>" : "") +
      '<h1 class="headline" id="songTitle">' + esc(T.song ? T.song.title : "") + "</h1>" +
      '<p class="title" id="songArtist">' + esc(T.song ? T.song.artist : "") + "</p></div>";
  }

  // ---- action buttons (Shuffle, Give hint, Ask for a hint)
  function actionHtml(id, cue, tag, label, small) {
    return '<button id="' + id + '" class="action"><span class="action__top"><span class="label" data-cue>' + cue + '</span><span class="tag" data-tag' + (tag ? "" : " hidden") + ">" + tag + "</span></span>" +
      '<span class="stack stack--4"><span class="title" data-label>' + label + '</span><span class="small" data-small>' + small + "</span></span></button>";
  }
  function setAction(id, cue, tag, label, small, off) {
    var b = $("#" + id); if (!b) { return; }
    var set = function (sel, v) { var e = b.querySelector(sel); if (e && e.textContent !== v) { e.textContent = v; } };
    set("[data-cue]", cue); set("[data-label]", label); set("[data-small]", small);
    var t = b.querySelector("[data-tag]"); if (t) { t.hidden = !tag; if (tag && t.textContent !== tag) { t.textContent = tag; } }
    b.classList.toggle("is-off", !!off);
  }
  function hintCostText(t) { return t.nextHintCost === null ? "All three hints given" : t.nextHintCost + " point penalty"; }
  function syncWhistlerActions(t) {
    var conf = t.stage === "confirming";
    setAction("shuffleBtn", "Song", t.shuffles ? t.shuffles + " used" : "", "Shuffle", t.penalty + " point penalty", conf);
    var asks = (t.hintAsks || []).length, none = t.nextHintCost === null;
    setAction("hintBtn", (t.hints || 0) + " of 3", asks ? asks + " asked" : (none ? "None left" : ""), "Give hint", hintCostText(t), none || conf);
    $("#shuffleBtn").disabled = conf;
    $("#hintBtn").disabled = conf || none;
    $("#gotBtn").disabled = conf;
  }
  // Ask for a hint: one plain button. It says what it does, then that it has been done.
  function syncAskBtn(t) {
    var b = $("#askHintBtn"); if (!b) { return; }
    var done = t.hints >= 3, asked = !!t.iAsked;
    b.hidden = done;
    if (done) { return; }
    var text = asked ? "Hint asked" : t.hints ? "Ask for another hint" : "Ask for a hint";
    if (b.textContent !== text) { b.textContent = text; }
    b.disabled = asked || t.stage !== "whistling";
  }

  // The newest hint on the whistler's phone: one quiet line that animates in.
  function showHintLine(t) {
    var el = $("#hintLine"); if (!el) { return; }
    var lines = t.hintLines || [];
    if (!lines.length) { el.hidden = true; el.removeAttribute("data-h"); return; }
    var n = lines.length, last = lines[n - 1];
    var html = '<span class="label">HINT ' + (n === 1 ? "1" : n + " OF 3") + ':</span><span class="small">' + esc(last) + "</span>";
    if (el.getAttribute("data-h") === html) { return; }
    var had = el.getAttribute("data-h") !== null;
    el.setAttribute("data-h", html); el.innerHTML = html; el.hidden = false;
    el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
    void had;
  }

  // Every hint as a stacked card on the guessers' phones, newest at the front.
  function showHints(t) {
    showHintLine(t);
    var hb = $("#hintBox"); if (!hb) { return; }
    var lines = t.hintLines || [];
    if (!lines.length) { hb.hidden = true; hb.removeAttribute("data-h"); hb.removeAttribute("data-n"); return; }
    var offset = (t.hintLines || []).length - lines.length;
    var n = lines.length;
    var html = lines.map(function (l, i) {
      var num = offset + i + 1, age = n - 1 - i;
      if (age === 0) { return '<div class="hcard hcard--new"><span class="label">Hint ' + num + '</span><span class="title">' + esc(l) + "</span></div>"; }
      return '<div class="hcard ' + (age === 1 ? "hcard--mid" : "hcard--old") + '"><span class="row"><span class="label">Hint ' + num + '</span><span class="small">' + esc(l) + "</span></span></div>";
    }).join("");
    if (hb.getAttribute("data-h") === html) { hb.hidden = false; return; }
    var prevN = parseInt(hb.getAttribute("data-n") || "0", 10);
    hb.setAttribute("data-h", html); hb.innerHTML = html; hb.hidden = false;
    hb.setAttribute("data-n", String((t.hintLines || []).length));
    if (prevN && (t.hintLines || []).length > prevN) { var nw = hb.querySelector(".hcard--new"); if (nw) { nw.classList.add("deal"); } }
  }

  // The sheet on the whistler's phone whilst the clock is stopped. Three cases: someone buzzed (Right or Wrong),
  // a guess was heard or the whistler tapped Someone got it (pick who), or the people named are being asked
  // to claim. Picks survive state updates for the same sheet.
  var whoState = { built: null, picks: [] };
  function buildWho(t) {
    var pend = t.pending || {}, claim = t.stage === "claiming" ? t.claim : null;
    var key = t.id + "|" + t.stage + "|" + (pend.buzz ? "b" + pend.from : pend.manual ? "m" : "h" + (pend.heard || "")) + "|" + (claim ? claim.ids.join() + "/" + claim.claimed.join() : "");
    if (whoState.built === key) { return; }
    var fresh = String(whoState.built || "").split("|")[0] !== String(t.id) || String(whoState.built || "").split("|")[1] !== t.stage;
    whoState.built = key;
    var sheet = $("#confSheet");
    if (claim) {
      var waiting = claim.ids.filter(function (id) { return claim.claimed.indexOf(id) === -1; }).map(function (id) { return pname(st, id); });
      sheet.innerHTML = '<span class="label">Checking</span><h2 class="headline">Waiting for ' + esc(listNames(waiting)) + ' to tap</h2>' +
        '<p class="small">They tap to claim it. If nobody does, the clock carries on.</p>';
      return;
    }
    if (pend.buzz) {
      sheet.innerHTML = '<span class="label">Buzzed in</span><h2 class="headline">' + esc(pname(st, pend.from)) + '</h2><p class="small">Did they say the title?</p>' +
        '<div class="btnrow"><button id="noBtn" class="btn btn--outline">Wrong</button><button id="yesBtn" class="btn">Right</button></div>';
      $("#yesBtn").onclick = function () { send({ t: "confirm", ok: true }); };
      $("#noBtn").onclick = function () { send({ t: "confirm", ok: false }); };
      return;
    }
    // Nobody is ticked to begin with. The phone that heard the answer is named in words, because it is
    // often not the person who said it.
    if (fresh) { whoState.picks = []; }
    var heard = pend.heard ? "Heard “" + pend.heard + "”" + (pend.from ? " on " + pname(st, pend.from) + "'s phone" : "") + ". " : "";
    sheet.innerHTML = '<span class="label">Who got it first?</span>' +
      '<p class="small">' + esc(heard + "Tap everyone who got it. They share the points.") + '</p><div class="whogrid" id="whoGrid">' +
      st.players.filter(function (p) { return p.id !== st.me; }).map(function (p) {
        return '<button class="who" data-id="' + esc(p.id) + '" aria-pressed="' + (whoState.picks.indexOf(p.id) !== -1) + '">' + avatarHtml(st, p) +
          '<span class="title">' + esc(p.name) + "</span></button>";
      }).join("") + '</div><button id="yesBtn" class="btn" disabled>Confirm</button><button id="noBtn" class="txt txt--c">Not yet, keep going</button>';
    var sync = function () { $("#yesBtn").disabled = !whoState.picks.length; };
    var bs = sheet.querySelectorAll(".who");
    for (var i = 0; i < bs.length; i++) {
      bs[i].onclick = function () {
        var id = this.getAttribute("data-id"), at = whoState.picks.indexOf(id);
        if (at === -1) { whoState.picks.push(id); } else { whoState.picks.splice(at, 1); }
        this.setAttribute("aria-pressed", whoState.picks.indexOf(id) !== -1);
        sync();
      };
    }
    $("#yesBtn").onclick = function () { if (whoState.picks.length) { send({ t: "confirm", ok: true, who: whoState.picks.slice() }); } };
    $("#noBtn").onclick = function () { send({ t: "confirm", ok: false }); };
    sync();
  }

  // What a guesser sees whilst the clock is stopped.
  function checkingHtml(s) {
    var T = s.turn, w = pname(s, T.playerId);
    if (T.stage === "claiming" && T.claim) {
      var mineC = T.claim.ids.indexOf(s.me) !== -1, done = T.claim.claimed.indexOf(s.me) !== -1;
      if (mineC && !done) { return '<h2 class="headline">' + esc(w) + ' says you got it</h2><p class="small">Tap to claim your points.</p><button id="claimBtn" class="btn">That was me</button>'; }
      if (mineC) { return '<h2 class="headline">Claimed</h2><p class="small">Waiting for the others.</p>'; }
      var names = T.claim.ids.map(function (id) { return pname(s, id); });
      return '<h2 class="headline pulse">Checking</h2><p class="small">' + esc(w + " says " + listNames(names) + " got it. Waiting for " + (names.length > 1 ? "them" : names[0]) + " to claim it.") + "</p>";
    }
    if (T.buzzer) {
      if (T.buzzer === s.me) { return '<h2 class="headline">You buzzed. Say it out loud</h2><p class="small">' + esc(w + " decides if you got it.") + "</p>"; }
      return '<h2 class="headline">' + esc(pname(s, T.buzzer)) + ' buzzed in</h2><p class="small">' + esc("Waiting for " + w + " to say right or wrong.") + "</p>";
    }
    return '<h2 class="headline pulse">Checking</h2><p class="small">' + esc("Someone might've got it. Waiting for " + w + " to confirm.") + "</p>";
  }

  // The line under the countdown for everyone who is about to guess. The same line on every phone.
  function showLine(turnId, name) {
    var t = esc(SPLASH_LINES[turnId % SPLASH_LINES.length]);
    return t.replace("{n}", esc(name));
  }

  function timerHtml(small) {
    return '<div class="timer grow"><div class="numeral' + (small ? " numeral--80" : "") + '" id="bigtime">00</div><div class="label" id="timeLab">Seconds left</div></div>';
  }

  var shuffleSeen = { id: null, n: 0 }, newSongTimer = null;
  function viewTurn(s) {
    var T = s.turn, isW = T.playerId === s.me, who = pname(s, T.playerId);
    var wp = player(s, T.playerId), away = !!wp && !wp.connected && !isW;

    // 1. Whistler choosing one of three songs
    if (T.stage === "choose" && isW && !T.difficulty) {
      var offs = (T.options || []).map(function (o, i) {
        return '<button class="action opt" data-i="' + i + '" data-d="' + o.difficulty + '"><span class="action__top"><span class="label">' + esc(cap(o.difficulty)) + "</span>" +
          '<span class="small">' + (o.multiplier === 1 ? "Standard points" : o.multiplier === 2 ? "Double points" : "Points x" + o.multiplier) + "</span></span>" +
          '<span class="stack stack--4"><span class="title">' + esc(o.title) + '</span><span class="small">' + esc(o.artist) + "</span></span></button>";
      }).join("");
      return {
        key: "choose-" + T.id + (T.canRefresh ? "" : "-r"), field: "ground",
        html: '<div class="screen">' + topBar(s) +
          '<div class="head"><h1 class="headline">Pick a song</h1>' +
          '<p class="title">The 3, 2, 1 starts as soon as you pick.</p>' +
          '<p class="small">Only you can see these. Harder songs score more.</p></div>' +
          '<div class="stack">' + offs + "</div>" +
          (T.canRefresh ? '<button id="refreshBtn" class="btn btn--outline">Refresh options</button>' : "") +
          '<p class="label center" id="chooseIn"></p>' +
          '<div class="spacer"></div>' + skipHtml(s) + "</div>",
        bind: function () {
          var rf = $("#refreshBtn"); if (rf) { rf.onclick = function () { send({ t: "refreshOptions" }); }; }
          var ds = document.querySelectorAll(".opt");
          for (var i = 0; i < ds.length; i++) {
            ds[i].onclick = function () { send({ t: "pickDifficulty", i: parseInt(this.getAttribute("data-i"), 10) }); };
          }
          bindSkip();
        }
      };
    }

    // 2. Whistler has picked and is getting ready (only when the automatic countdown is switched off)
    if (T.stage === "choose" && isW) {
      return {
        key: "ready-" + T.id, field: "ground",
        html: '<div class="screen">' + topBar(s) + songBlock(T, "Your song to perform") +
          '<p class="small">Only you can see this. Do not perform yet. Tap Ready and a 3, 2, 1 countdown starts for everyone; perform when it ends.</p>' +
          '<div class="spacer"></div>' +
          '<button id="readyBtn" class="btn">Ready</button>' + skipHtml(s) + "</div>",
        bind: function () {
          $("#readyBtn").onclick = function () { send({ t: "ready" }); };
          bindSkip();
        }
      };
    }

    // 3. Everyone else while the whistler chooses
    if (T.stage === "choose") {
      return {
        key: "wait-" + T.id + (away ? "-a" : "") + (T.difficulty ? "-d" : ""), field: "ground",
        html: '<div class="screen">' + topBar(s) +
          '<div class="mid"><h1 class="headline">' + esc(away ? "Waiting for " + who + " to come back" : who + (T.difficulty ? " is getting ready" : " is choosing a song")) + "</h1>" +
          '<p class="small">' + (away ? "If they are not back in half a minute, the turn is skipped." : "Get ready to guess. Shout the title, or buzz in and say it.") + "</p>" +
          '<div class="micline" data-mic></div></div>' + skipHtml(s) + "</div>",
        bind: bindSkip
      };
    }

    // 4. One beat before the turn: the name and the 3, 2, 1 together. The whistler sees the song they picked.
    if (T.stage === "countdown") {
      return {
        key: "cd-" + T.id, field: "green",
        html: '<div class="screen">' + topBar(s) +
          (isW && T.song ? songBlock(T, "Your song to perform")
            : '<div class="cdhead">' + avatarHtml(s, wp || { name: "?" }, "avatar--md") + '<h1 class="headline">' + showLine(T.id, who) + "</h1></div>") +
          '<div class="cdwrap"><div class="cdcircle"><div class="numeral" id="cd">3</div></div></div>' +
          '<p class="title center">' + (isW ? "Perform when it ends" : "Get ready to guess") + "</p></div>",
        bind: function () {}
      };
    }

    // 5. Whistling, confirming or waiting for a claim: the whistler's phone
    if (liveStage(T) && isW) {
      return {
        key: "w-" + T.id, field: "time",
        html: '<div class="screen">' + topBar(s) + songBlock({ song: T.song, multiplier: T.multiplier }, "Your song to perform").replace("</p></div>", '</p><p class="hintline" id="hintLine" hidden></p></div>') +
          timerHtml(false) +
          '<div class="actions2">' + actionHtml("shuffleBtn", "Song", "", "Shuffle", T.penalty + " point penalty") +
          actionHtml("hintBtn", (T.hints || 0) + " of 3", "", "Give hint", hintCostText(T)) + "</div>" +
          '<button id="gotBtn" class="btn gotbtn">Someone got it</button>' +
          '<div class="ovl" id="confirm" hidden><div class="scrim"></div><div class="sheet" id="confSheet"></div></div></div>',
        bind: function () {
          $("#shuffleBtn").onclick = function () { send({ t: "shuffle" }); };
          $("#hintBtn").onclick = function () { send({ t: "hint" }); };
          $("#gotBtn").onclick = function () { send({ t: "gotIt" }); };
        },
        update: function () {
          var t = st.turn, conf = (t.stage === "confirming" && t.pending) || (t.stage === "claiming" && t.claim);
          $("#songTitle").textContent = t.song ? t.song.title : "";
          $("#songArtist").textContent = t.song ? t.song.artist : "";
          $("#confirm").hidden = !conf;
          if (conf) { buildWho(t); } else { whoState.built = null; whoState.picks = []; }
          showHints(t);
          syncWhistlerActions(t);
        }
      };
    }

    // 6. Whistling, confirming or waiting for a claim: a guesser's phone. A phone that is listening shows
    // the mic. Any other phone gets the buzzer: tap, then say the title out loud.
    if (liveStage(T)) {
      var canVoice = !!SR && !IN_APP && mic.state !== "blocked" && mic.state !== "unsupported";
      var useBuzz = mic.buzzMode || !mic.enabled || !canVoice || mic.state === "stopped" || mic.state === "off";
      return {
        key: "g-" + T.id + (useBuzz ? "-b" + (mic.state === "stopped" ? "s" : "") : "-m"), field: "time",
        html: '<div class="screen">' + topBar(s) + timerHtml(false) +
          '<div class="hstack" id="hintBox" hidden></div>' +
          '<button id="askHintBtn" class="btn btn--outline">Ask for a hint</button>' +
          (useBuzz
            ? '<div class="buzzwrap"><button id="buzzBtn" class="buzz"><span class="display">Buzz</span><span class="small" id="buzzSub">Tap when you know it, then say it out loud</span></button>' +
              (canVoice ? '<button id="toMic" class="txt">' + (mic.state === "stopped" && !mic.buzzMode ? "Mic did not start. Tap to try again" : "Use the mic") + "</button>" : "") + "</div>"
            : '<div class="micwrap mid"><button class="orb off" id="orb" aria-label="Turn on mic"></button>' +
              '<p class="title" id="listenHead">Starting mic</p>' +
              '<button id="toBuzz" class="txt">Buzz in instead</button></div>') +
          '<div class="checking" id="checking" hidden></div></div>',
        bind: function () {
          if (mic.turnSeen !== st.turn.id) { mic.turnSeen = st.turn.id; mic.base = mic.total || 0; mic.heard = ""; }
          var bz = $("#buzzBtn"); if (bz) { bz.onclick = function () { if (st && st.turn && st.turn.stage === "whistling") { send({ t: "buzz" }); buzz(30); } }; }
          var ah = $("#askHintBtn"); if (ah) { ah.onclick = function () { send({ t: "askHint" }); }; }
          var tb = $("#toBuzz"); if (tb) { tb.onclick = function () { mic.buzzMode = true; micPark(); render(); }; }
          var tm = $("#toMic"); if (tm) { tm.onclick = function () { micStart(); render(); }; }
        },
        update: function () {
          var t = st.turn, chk = $("#checking"), stopped = t.stage === "confirming" || t.stage === "claiming";
          chk.hidden = !stopped;
          if (stopped) {
            var ch = checkingHtml(st);
            if (chk.getAttribute("data-h") !== ch) {
              chk.setAttribute("data-h", ch); chk.innerHTML = ch;
              var cb = $("#claimBtn"); if (cb) { cb.onclick = function () { send({ t: "claim" }); }; }
            }
          } else { chk.removeAttribute("data-h"); }
          showHints(t);
          if (mic.turnSeen !== t.id) { mic.turnSeen = t.id; mic.base = mic.total || 0; mic.heard = ""; }
          syncAskBtn(t);
          // A shuffle makes no sound on this phone, so it has to be seen: the label under the clock says so for two seconds.
          if (shuffleSeen.id !== t.id) { shuffleSeen = { id: t.id, n: t.shuffles || 0 }; }
          else if ((t.shuffles || 0) > shuffleSeen.n) {
            shuffleSeen.n = t.shuffles;
            var tl = $("#timeLab");
            if (tl) {
              tl.textContent = "New song. Forget the last one"; tl.classList.add("flashlab");
              clearTimeout(newSongTimer);
              newSongTimer = setTimeout(function () { var e = $("#timeLab"); if (e) { e.textContent = "Seconds left"; e.classList.remove("flashlab"); } }, 2000);
            }
          }
        }
      };
    }

    // 7. Reveal: the score is counted up on screen, see revealFrame()
    var R = T.result, head, sub = "";
    var gAwards = (R.awards || []).filter(function (x) { return x.role === "guesser"; });
    var guessers = gAwards.map(function (x) { return pname(s, x.id); });
    var correct = R.outcome === "correct";
    if (correct) {
      head = who + " scores";
      // Whose phone heard it, or who buzzed, is said out loud on every screen.
      var heard = R.heardFrom ? (R.source === "buzz" ? pname(s, R.heardFrom) + " buzzed in. " : "Heard on " + pname(s, R.heardFrom) + "'s phone. ") : "";
      sub = heard + (guessers.length ? listNames(guessers) + (guessers.length > 1 ? " named it and earn " + pts(gAwards[0].points) + " each." : " named it and earns " + pts(gAwards[0].points) + ".") : "");
    } else if (R.outcome === "timeout") {
      head = "Time's up";
      sub = "Nobody guessed " + who + "'s song, so no points. Ouch.";
    } else {
      head = "Turn skipped";
      sub = who + " scores nothing.";
    }
    var last = s.turnNumber >= s.totalTurns;
    var big = Math.max(R.base || 0, R.afterMult || 0, R.score || 0) >= 1000;
    // At the end of a round the score lands first, then the whole table takes its place: every player, one row each.
    var boardHtml = T.roundEnd
      ? '<div class="stack rvboard" id="board"><span class="label">' + (T.sd ? "Tie-break" : last ? "Scores after the last round" : "Scores after round " + T.round) + "</span>" +
          '<p class="small">' + esc((R.song ? R.song.title + ": " : "") + (correct ? who + " scores " + pts(R.score) : R.outcome === "timeout" ? "nobody got it" : "turn skipped")) + "</p>" +
          standingsHtml(s, R.awards, null, { change: true }) + "</div>"
      : (T.nextId ? '<div class="stack rvhide" id="board"><span class="label">Up next</span><p class="title pn">' + avatarHtml(s, player(s, T.nextId) || { name: "?" }) + esc(T.nextId === s.me ? "You" : pname(s, T.nextId)) + "</p></div>" : "");
    return {
      key: "reveal-" + T.id + "-" + s.totalTurns, field: correct ? "blue" : "ground",
      html: '<div class="screen' + (T.roundEnd ? " rv-round" : "") + '" id="rvScreen">' + topBar(s) +
        '<div class="stack stack--16" id="rvScore">' +
        '<div class="revealtop">' + (R.song ? '<span class="label">The song was</span><h1 class="headline">' + esc(R.song.title) + '</h1><p class="title">' + esc(R.song.artist) + "</p>" : "") + "</div>" +
        '<div class="scorebox"><div class="scorerow"><div class="numeral scoreNum' + (big ? " numeral--120" : "") + '" id="scoreNum">0</div></div>' +
          '<div class="rowc rowc--l"><span class="label" id="scoreCap">Guessed in</span><span class="tag stamp" id="multBadge" hidden></span><span class="tag stamp" id="deltaTag" hidden></span></div>' +
          '<div class="stack stack--4"><h2 class="title">' + esc(head) + "</h2>" + (sub ? '<p class="small">' + esc(sub) + "</p>" : "") + "</div></div></div>" +
        boardHtml +
        '<div class="spacer"></div>' +
        '<p class="label" id="nextIn"></p>' +
        (s.hostId === s.me
          ? '<button id="nextBtn" class="btn">' + (last ? "Skip to final scores" : T.roundEnd ? "Next round" : "Next turn") + "</button>"
          : "") + skipHtml(s) + "</div>",
      bind: function () { var b = $("#nextBtn"); if (b) { b.onclick = function () { send({ t: "next" }); }; } bindSkip(); },
      update: function () {}
    };
  }

  // Where the reveal animation is at, given milliseconds since the turn finished.
  var REDUCED = false;
  try { REDUCED = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (e) {}
  function ease(x) { x = Math.max(0, Math.min(1, x)); return 1 - Math.pow(1 - x, 3); }
  function revealFrame(R, el) {
    if (R.outcome !== "correct") {
      var fin0 = 900;
      return { num: 0, cap: el >= fin0 ? "No points" : "Counting up", final: el >= fin0, finalAt: fin0 };
    }
    var rawS = Math.max(0, R.timeMs / 1000 - R.lockedS), cur = 1500, run = R.base;
    // Order: base score, then the song multiplier, then shuffles, then hints, then the big reveal.
    // The whole count has to finish well inside the 8 second reveal, with every penalty in play.
    var segs = [{ from: 0, to: R.base, at: 0, len: 1000, cap: "Guessed in " + rawS.toFixed(1) + "s" }];
    if (R.multiplier && R.multiplier !== 1) {
      segs.push({ from: run, to: R.afterMult, at: cur + 300, len: 800, cap: cap(R.difficulty || "") + " song", badge: "x" + R.multiplier + " " + (R.difficulty || "").toUpperCase(), badgeAt: cur });
      run = R.afterMult; cur += 1300;
    }
    if (R.shuffles) {
      var sp = Math.max(0, Math.min(run - R.score, R.shufflePts));
      segs.push({ from: run, to: run - sp, at: cur, len: 600, cap: R.shuffles === 1 ? "Shuffle" : R.shuffles + " shuffles", delta: "-" + R.shufflePts });
      run -= sp; cur += 1000;
    }
    if (R.hints) {
      // The floor: penalties never take a correct guess below the minimum, so the count stops there.
      var hp = Math.max(0, Math.min(run - R.score, R.hintPts));
      segs.push({ from: run, to: run - hp, at: cur, len: 600, cap: R.hints === 1 ? "Hint" : R.hints + " hints", delta: "-" + R.hintPts });
      run -= hp; cur += 1000;
    }
    var finalAt = Math.max(cur + 700, 2600);
    // When the floor has stepped in, say so, or the last number looks like a mistake.
    var floored = R.score > Math.max(0, R.afterMult - R.shufflePts - R.hintPts);
    if (el >= finalAt) { return { num: R.score, cap: floored ? "Minimum for a correct guess" : "Final score", final: true, finalAt: finalAt }; }
    var out = { num: 0, cap: segs[0].cap, final: false, finalAt: finalAt, badge: "", delta: "" };
    for (var i = 0; i < segs.length; i++) {
      var g = segs[i];
      if (g.badge && el >= g.badgeAt) { out.badge = g.badge; out.cap = cap(R.difficulty || "") + " song"; }
      if (el >= g.at) { out.num = g.to; out.cap = g.cap; if (g.badge) { out.badge = g.badge; } }
      if (el >= g.at && el < g.at + g.len) { out.num = g.from + (g.to - g.from) * ease((el - g.at) / g.len); }
      if (g.delta && el >= g.at - 300 && el < g.at + g.len + 500) { out.delta = g.delta; out.cap = g.cap; }
    }
    if (el >= cur) { out.cap = "And the score is"; out.drum = true; }
    return out;
  }

  // End-of-game awards: one screen of titles, then the final scores. Awards carry no points.
  var awardState = { key: null, done: false, timer: null };

  function awardsKey(s) { return s.code + "|" + (s.endAwards || []).map(function (d) { return d.key + d.winners.map(function (w) { return w.id; }).join(","); }).join(";"); }

  function viewAwards(s) {
    var rows = s.endAwards.map(function (d) {
      var names = d.winners.map(function (w) { return pname(s, w.id); });
      return '<div class="awrow"><span class="label">' + esc(d.title) + '</span><span class="title">' + esc(listNames(names)) + "</span>" +
        '<span class="small">' + esc(d.winners.length === 1 ? d.winners[0].detail : "Shared between them") + "</span></div>";
    }).join("");
    return {
      key: "awards", field: "yellow",
      html: '<div class="screen">' +
        '<div class="label">Game awards</div><h1 class="headline">For glory, not points</h1>' +
        '<div class="awlist">' + rows + "</div>" +
        '<div class="spacer"></div>' +
        '<button id="awardNext" class="btn">See final scores</button></div>',
      bind: function () {
        clearTimeout(awardState.timer);
        var left = 12, nb = $("#awardNext");
        var done = function () { clearTimeout(awardState.timer); awardState.done = true; render(); };
        var tickA = function () {
          if (left <= 0) { done(); return; }
          nb.textContent = "See final scores (" + left + ")"; left--;
          awardState.timer = setTimeout(tickA, 1000);
        };
        tickA();
        nb.onclick = done;
      }
    };
  }

  function viewOver(s) {
    var k = awardsKey(s);
    if (awardState.key !== k) { awardState.key = k; awardState.done = false; }
    if (s.endAwards && s.endAwards.length && !awardState.done) { return viewAwards(s); }
    clearTimeout(awardState.timer);
    var isHost = s.hostId === s.me;
    var names = (s.winners || []).map(function (id) { return pname(s, id); });
    var bests = recordGame(s), mine = readStats()[pname(s, s.me).toLowerCase()];
    var head = names.length > 1 ? "It's a draw: " + names.map(esc).join(" and ") : esc(names[0] || "Nobody") + " wins";
    var hasAwards = !!(s.endAwards && s.endAwards.length);
    return {
      key: "over", field: "blue",
      html: '<div class="screen">' +
        '<div class="label">Game over</div>' +
        '<div class="head"><h1 class="display">' + head + "</h1>" +
        (s.tieBreakWon ? '<p class="small">Settled in a tie-break.</p>' : "") + "</div>" +
        '<div class="stack"><div class="label">Final scores</div>' + standingsHtml(s, null, s.winners, { final: true }) + "</div>" +
        (s.myGame && mine && bests.length ? '<p class="small">New personal best: ' + esc(bests.join(", ")) + ".</p>" : "") +
        '<div class="spacer"></div>' +
        (isHost ? "" : '<p class="title center">Waiting for ' + esc(pname(s, s.hostId)) + "</p>") +
        '<div class="btnrow">' + (hasAwards ? '<button id="awardsBtn" class="btn btn--outline">Awards</button>' : "") +
        (isHost ? '<button id="againBtn" class="btn">Play again</button>' : "") + "</div>" +
        '<div class="rowc">' + (s.myGame && mine ? '<button id="myStatsBtn" class="txt">Your stats</button>' : "<span></span>") +
        '<button id="leaveBtn" class="txt">Leave game</button></div></div>',
      bind: function () {
        var a = $("#againBtn"); if (a) { a.onclick = function () { send({ t: "playAgain" }); }; }
        $("#leaveBtn").onclick = leaveRoom;
        var ms = $("#myStatsBtn"); if (ms) { ms.onclick = function () { showStats(pname(s, s.me)); }; }
        var aw = $("#awardsBtn"); if (aw) { aw.onclick = function () { awardState.done = false; render(); }; }
      }
    };
  }

  // How to play: a short animated walkthrough. The words sit on the dark background; the game screens
  // sit inside a phone frame, so it is always clear which part is the instruction and which is the app.
  function showHelp() {
    var AV = function (n, k) { return '<span class="avatar pc pc' + k + '">' + n.charAt(0) + "</span>"; };
    var TAP = function (x, y, d) { return '<i class="hv-tap" style="left:' + x + 'px;top:' + y + 'px;animation-delay:' + d + 'ms"></i>'; };
    var scenes = [
      { ms: 5000, full: true, chip: "How to play", head: "One person performs.<br>Everyone else listens and guesses.", text: "Take turns. Guess fast, score big!", bg: FIELD_BG.orange },
      { ms: 5400, role: "w", chip: "Your turn to perform", head: "Pick a song", text: "Only you can see it. Hard songs score double!", bg: FIELD_BG.ground,
        mock: '<div class="m-cards">' +
          '<div class="m-card"><span>Easy</span><b>Dancing Queen</b><i>ABBA</i></div>' +
          '<div class="m-card m-pick"><span>Medium</span><b>Wonderwall</b><i>Oasis</i></div>' +
          '<div class="m-card"><span>Hard</span><b>Rolling in the Deep</b><i>Adele</i></div></div>' + TAP(300, 215, 1900) },
      { ms: 5000, role: "e", chip: "Everyone", head: "The countdown starts", text: "It kicks off the second a song's picked. No performing until it ends!", bg: FIELD_BG.green,
        mock: '<div class="m-disc"><div class="m-num" data-seq="3,2,1,Go" data-step="1000">3</div></div>' },
      { ms: 6200, role: "w", chip: "Your turn to perform", head: "Whistle or kazoo the tune", text: "Whistle it or kazoo it. No words allowed! Shuffles and hints cost points.", bg: FIELD_BG.green,
        mock: '<div><div class="m-label">Your song to perform</div><div class="m-song">Dancing Queen</div><div class="m-art">ABBA</div></div><div class="m-timer" data-timer="42">42</div>' +
          '<div class="m-two"><div class="m-mini"><span>Song</span><b>Shuffle</b></div><div class="m-mini"><span>0 of 3</span><b>Give hint</b></div></div><div class="m-btn">Someone got it</div>' },
      { ms: 6400, role: "l", chip: "Your turn to listen", head: "Say the title out loud", text: "Someone else is performing. Your phone's mic should catch your guess. If it doesn't, buzz in and say it.", bg: FIELD_BG.green,
        mock: '<div class="m-orbwrap"><div class="hv-orb"><i></i><i></i><i></i><svg viewBox="0 0 48 48" aria-hidden="true"><rect x="18" y="5" width="12" height="23" rx="6"/><path d="M11 22v2a13 13 0 0 0 26 0v-2"/><path d="M24 37v6M17 43h14"/></svg></div>' +
          '<div class="m-say"><span>You say</span><b>Dancing Queen</b></div></div><div class="m-head">Listening</div><div class="m-link">Buzz in instead</div>' },
      { ms: 5600, role: "w", chip: "Your turn to perform", head: "Say who got it", text: "Someone nailed it? Tap Someone got it, pick who got it first, then confirm.", bg: FIELD_BG.ground,
        mock: '<div class="m-rows">' +
          '<div class="m-row m-on">' + AV("Theo", 1) + '<b>Theo</b><em>Got it</em></div><div class="m-row">' + AV("Priya", 2) + '<b>Priya</b></div><div class="m-row">' + AV("Sam", 3) + '<b>Sam</b></div></div><div class="m-btn">Confirm</div>' + TAP(80, 135, 1500) },
      { ms: 5600, role: "e", chip: "Everyone sees the score", head: "Faster guesses score more", text: "The performer bags the full score. Whoever got it gets half.", bg: FIELD_BG.blue, light: true,
        mock: '<div class="m-big" data-count="917" data-ms="1600">0</div><div class="m-label">Guessed in 12.4s</div><div class="m-sub2">Maya scores<br>Theo named it and earns 459</div>' },
      { ms: 5600, role: "e", chip: "After the last round", head: "Most points wins", text: "Awards at the end are for glory only.", bg: FIELD_BG.pink,
        mock: '<div class="m-rows">' +
          '<div class="m-row m-light"><b class="m-rk">1</b>' + AV("Maya", 0) + '<b>Maya</b><em>2,140</em></div><div class="m-row m-light"><b class="m-rk">2</b>' + AV("Theo", 1) + '<b>Theo</b><em>1,820</em></div><div class="m-row m-light"><b class="m-rk">3</b>' + AV("Priya", 2) + '<b>Priya</b><em>1,310</em></div></div>' },
      { ms: 4500, full: true, chip: "Stuck?", head: "Stuck? Tap Help.", text: "It sits at the top of the screen between turns and tells you exactly what to do.", bg: FIELD_BG.orange }
    ];
    var o = document.createElement("div");
    o.className = "hv"; o.setAttribute("role", "dialog"); o.setAttribute("aria-label", "How to play");
    o.innerHTML = '<div class="hv-bars">' + scenes.map(function () { return '<span><i></i></span>'; }).join("") + '</div>' +
      '<button class="hv-x" aria-label="Close">Close</button><div class="hv-stage" id="hvStage"></div>' +
      '<button class="hv-prev" aria-label="Back"></button><button class="hv-next" aria-label="Next"></button>';
    document.body.appendChild(o);
    document.body.classList.add("noscroll");
    var idx = -1, timer = null, ints = [];
    var bars = o.querySelectorAll(".hv-bars i");
    var stage = $("#hvStage", o);
    var clearAll = function () { clearTimeout(timer); ints.forEach(clearInterval); ints = []; };
    var DARK = "#111111";
    var close = function () { clearAll(); document.body.classList.remove("noscroll"); window.removeEventListener("resize", fit); if (o.parentNode) { o.parentNode.removeChild(o); } lastBg = ""; syncBg(); };
    var fit = function () {
      var wrap = stage.querySelector(".hv-phone"), scr = stage.querySelector(".hv-screen"); if (!wrap || !scr) { return; }
      // The screen fills the whole frame: fixed 390 logical width, and as much logical height as the frame has.
      var w = wrap.clientWidth, h = wrap.clientHeight, k = w / 390, lh = h / k;
      scr.style.width = "390px"; scr.style.height = lh + "px";
      scr.style.transform = "scale(" + k + ")"; scr.style.left = "0px"; scr.style.top = "0px";
    };
    window.addEventListener("resize", fit);
    try { document.querySelector('meta[name="theme-color"]').setAttribute("content", DARK); document.documentElement.style.background = DARK; document.body.style.background = DARK; var bf = document.getElementById("bgfill"); if (bf) { bf.style.background = DARK; } } catch (e) {}
    var ROLE = { w: "perform", l: "listen", e: "all" };
    var go = function (n) {
      clearAll();
      if (n >= scenes.length) { close(); return; }
      idx = Math.max(0, n);
      var sc = scenes[idx];
      var bgc = sc.full ? sc.bg : DARK;
      o.style.background = bgc; o.classList.toggle("hv-full", !!sc.full);
      try { document.querySelector('meta[name="theme-color"]').setAttribute("content", bgc); document.documentElement.style.background = bgc; document.body.style.background = bgc; var bf2 = document.getElementById("bgfill"); if (bf2) { bf2.style.background = bgc; } } catch (e) {}
      if (sc.full) {
        stage.innerHTML = '<div class="hv-fullslide"><p class="hv-role e">' + sc.chip + '</p><h1 class="hv-fhead">' + sc.head + '</h1><p class="hv-ftext">' + sc.text + "</p></div>";
      } else
      stage.innerHTML = '<div class="hv-words"><p class="hv-role ' + sc.role + '">' + sc.chip + '</p><h1 class="hv-head">' + sc.head + '</h1><p class="hv-text">' + sc.text + '</p></div>' +
        '<div class="hv-phone"><div class="hv-screen' + (sc.light ? " m-lt" : "") + '" style="background:' + sc.bg + '">' + sc.mock + "</div></div>";
      if (!sc.full) { fit(); }
      for (var b = 0; b < bars.length; b++) { bars[b].style.transition = "none"; bars[b].style.width = b < idx ? "100%" : "0%"; }
      void o.offsetWidth;
      bars[idx].style.transition = "width " + sc.ms + "ms linear"; bars[idx].style.width = "100%";
      var seq = stage.querySelector("[data-seq]");
      if (seq) {
        var items = seq.getAttribute("data-seq").split(","), k = 0;
        ints.push(setInterval(function () { k = Math.min(k + 1, items.length - 1); seq.textContent = items[k]; seq.className = "m-num hv-pop"; }, parseInt(seq.getAttribute("data-step"), 10)));
      }
      var tm = stage.querySelector("[data-timer]");
      if (tm) { var v = parseInt(tm.getAttribute("data-timer"), 10); ints.push(setInterval(function () { v = Math.max(0, v - 1); tm.textContent = (v < 10 ? "0" : "") + v; }, 1000)); }
      var cnt = stage.querySelector("[data-count]");
      if (cnt) {
        var to = parseInt(cnt.getAttribute("data-count"), 10), dur = parseInt(cnt.getAttribute("data-ms"), 10), t0 = Date.now();
        ints.push(setInterval(function () { var f = Math.min(1, (Date.now() - t0) / dur); cnt.textContent = String(Math.round(to * (1 - Math.pow(1 - f, 3)))); }, 40));
      }
      timer = setTimeout(function () { go(idx + 1); }, sc.ms);
    };
    $(".hv-x", o).onclick = close;
    $(".hv-next", o).onclick = function () { go(idx + 1); };
    $(".hv-prev", o).onclick = function () { go(idx - 1); };
    go(0);
  }

  // ------------------------------------------------------- first-time tips
  var newbie = null, askedPlayed = false;
  try { var np = localStorage.getItem("ttt_played"); newbie = np === "yes" ? false : np === "no" ? true : null; } catch (e) {}

  // What to do on this screen, for the ? button. It depends on the screen and on whether you are performing or guessing.
  function helpFor(key) {
    var host = st && st.hostId === st.me, T = st && st.turn, who = T && st.players ? pname(st, T.playerId) : "The performer";
    if (/^choose-/.test(key)) { return ["Your turn to perform", "Pick one of the three songs. Medium is worth half as much again and hard is worth double. Don't know any? You get one refresh. Take too long and the middle one is picked for you. Only you can see them."]; }
    if (/^ready-/.test(key)) { return ["Get ready", "Only you can see your song. Ready? Tap Ready and a 3, 2, 1 starts for everyone. Then whistle or kazoo the tune. No words!"]; }
    if (/^wait-/.test(key)) { return ["Get ready to guess", who + " is picking a song. When the countdown ends, shout the song title. No mic? Tap Buzz, then say it out loud."]; }
    if (/^cd-/.test(key)) {
      return T && T.playerId === st.me
        ? ["Countdown", "When it ends, whistle or kazoo the tune. No words! Shuffles and hints cost points."]
        : ["Countdown", "When it ends, " + who + " starts performing. Shout the title as soon as you know it, or buzz in and say it."];
    }
    if (/^w-/.test(key)) { return ["You are performing", "Whistle or kazoo the tune. No words! If someone buzzes, tap Right or Wrong. If someone says it and the game misses it, tap Someone got it and pick who."]; }
    if (/^g-/.test(key)) { return ["You are guessing", "Listen to " + who + " and shout the song title, or buzz in and say it. The faster the guess, the more it scores. Stuck? Ask for a hint."]; }
    if (/^reveal-/.test(key)) { return ["Score", "The performer gets the full score. Whoever got it gets half, shared if more than one person is named. A correct guess never scores under 100."]; }
    if (key === "lobby") {
      return host
        ? ["You are the host", "Send the invite link to your friends, or show them the QR code. Choose the song packs and rounds, then tap Start game once everyone's in. Your own tile turns your mic on and off."]
        : ["Waiting to start", "The host starts the game once everyone's in. If room picks is on, tap Songs to pick your packs. Your own tile turns your mic on and off."];
    }
    if (/^awards/.test(key)) { return ["Awards", "Awards are for glory only. The scores stay exactly as they were."]; }
    if (key === "over") { return ["Game over", "Top score wins! " + (host ? "Tap Play again for another go with the same players." : "The host can start another go with the same players.")]; }
    return ["Need a hand?", "Tap How to play on the home screen to see the rules."];
  }
  function showHelpSheet() {
    if (document.getElementById("helpsheet")) { return; }
    usage("help");
    var h = helpFor(lastKey || "");
    var o = document.createElement("div");
    o.id = "helpsheet"; o.className = "sheetwrap";
    o.innerHTML = '<div class="scrim"></div><div class="sheet"><div class="label">' + esc(h[0]) + '</div><p class="title">' + esc(h[1]) + '</p>' +
      '<button class="btn" id="hsOk">Got it</button><div class="rowc"><button class="txt" id="hsHow">Show how to play</button>' +
      '<button class="txt" id="hsSfx">' + (sfxOn ? "Sound on" : "Sound off") + "</button></div></div>";
    document.body.appendChild(o);
    var close = function () { if (o.parentNode) { o.parentNode.removeChild(o); } };
    $("#hsOk", o).onclick = close; $(".scrim", o).onclick = close;
    $("#hsHow", o).onclick = function () { close(); usage("howto", "sheet"); showHelp(); };
    $("#hsSfx", o).onclick = function () { setSfx(!sfxOn); this.textContent = sfxOn ? "Sound on" : "Sound off"; };
  }
  // First time in a room: ask once. A first-timer gets a short line and the how-to-play walkthrough.
  function askPlayed() {
    askedPlayed = true;
    var o = document.createElement("div");
    o.className = "sheetwrap";
    o.innerHTML = '<div class="scrim"></div><div class="sheet" id="apSheet"><p class="headline">Have you played before?</p>' +
      '<div class="btnrow"><button class="btn btn--outline" id="pYes">Yes</button><button class="btn" id="pNo">No</button></div></div>';
    document.body.appendChild(o);
    var done = function (v) {
      newbie = !v; try { localStorage.setItem("ttt_played", v ? "yes" : "no"); } catch (e) {}
      usage(v ? "first_yes" : "first_no");
      if (v) { if (o.parentNode) { o.parentNode.removeChild(o); } return; }
      $("#apSheet", o).innerHTML = '<p class="headline">It\'s eaaaaaasy!</p><p class="title">Here\'s how to play.</p>';
      setTimeout(function () { if (o.parentNode) { o.parentNode.removeChild(o); } usage("howto", "first"); showHelp(); }, 1400);
    };
    $("#pYes", o).onclick = function () { done(true); };
    $("#pNo", o).onclick = function () { done(false); };
  }
  // Help is a word in the top row of every screen between turns (see topBar). There are no floating buttons.
  function refreshTip() {
    var old = document.getElementById("helpfab"); if (old) { old.parentNode.removeChild(old); }
    var sf = document.getElementById("sfxfab"); if (sf) { sf.parentNode.removeChild(sf); }
    if (!st || st.admin) { return; }
    if (newbie === null && !askedPlayed) { askPlayed(); }
  }

  // ---------------------------------------------------------------- render
  function elapsedMs(T) {
    var base = T.accumulatedMs + (T.runningSince !== null ? nowS() - T.runningSince : 0);
    return Math.max(0, Math.min(base, T.limitMs));
  }
  // Time sets the field: green with more than 30 seconds left, yellow down to 10, orange for the last 10.
  function timeField(T) {
    var left = T.limitMs - elapsedMs(T);
    return left > 30000 ? "green" : left > 10000 ? "yellow" : "orange";
  }

  // ------------------------------------------------------- sound effects and haptics (no music, all synthesised)
  var sfxOn = true; try { sfxOn = localStorage.getItem("ttt_sfx") !== "off"; } catch (e) {}
  var actx = null, hapEl = null;
  function audioCtx() {
    if (!actx) { try { var AC = window.AudioContext || window.webkitAudioContext; if (AC) { actx = new AC(); } } catch (e) {} }
    if (actx && actx.state === "suspended") { try { actx.resume(); } catch (e) {} }
    return actx;
  }
  ["touchstart", "pointerdown", "keydown"].forEach(function (ev) { document.addEventListener(ev, audioCtx, { passive: true }); });
  function tone(f, at, dur, type, vol, to, vib) {
    var c = actx; if (!c) { return; }
    var t0 = c.currentTime + at, o = c.createOscillator(), g = c.createGain();
    o.type = type || "sine"; o.frequency.setValueAtTime(f, t0);
    if (to) { o.frequency.exponentialRampToValueAtTime(to, t0 + dur); }
    if (vib) { var l = c.createOscillator(), lg = c.createGain(); l.frequency.value = vib; lg.gain.value = f * 0.03; l.connect(lg); lg.connect(o.frequency); l.start(t0); l.stop(t0 + dur + 0.05); }
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(vol || 0.2, t0 + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(c.destination); o.start(t0); o.stop(t0 + dur + 0.05);
  }
  function noise(at, dur, vol, freq, q, hp) {
    var c = actx; if (!c) { return; }
    var n = Math.max(1, Math.floor(c.sampleRate * dur)), buf = c.createBuffer(1, n, c.sampleRate), d = buf.getChannelData(0);
    for (var i = 0; i < n; i++) { d[i] = Math.random() * 2 - 1; }
    var src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain(), t0 = c.currentTime + at;
    src.buffer = buf; f.type = hp ? "highpass" : "bandpass"; f.frequency.value = freq || 2000; f.Q.value = q || 1;
    g.gain.setValueAtTime(vol || 0.15, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(c.destination); src.start(t0);
  }
  var SFX = {
    pop: function () { tone(520, 0, 0.1, "sine", 0.22, 900); },
    turn: function () { [523, 659, 784, 1047].forEach(function (f, i) { tone(f, i * 0.09, 0.22, "triangle", 0.22); }); tone(1568, 0.38, 0.4, "sine", 0.12, null, 9); noise(0.38, 0.3, 0.05, 6000, 1, true); },
    next: function () { tone(440, 0, 0.1, "triangle", 0.15); tone(587, 0.1, 0.16, "triangle", 0.15); },
    tick: function () { tone(880, 0, 0.09, "square", 0.08); },
    go: function () { [523, 659, 784].forEach(function (f) { tone(f, 0, 0.45, "sawtooth", 0.07); }); tone(1047, 0, 0.4, "triangle", 0.12); },
    ping: function () { tone(1175, 0, 0.18, "sine", 0.2); tone(1568, 0.12, 0.3, "sine", 0.2); },
    win: function () { tone(300, 0, 0.45, "sine", 0.2, 1600); [784, 1047, 1319, 1568].forEach(function (f, i) { tone(f, 0.42 + i * 0.07, 0.35, "triangle", 0.18); }); noise(0.42, 0.5, 0.1, 5000, 0.8, true); },
    fail: function () { [[294, 0], [277, 0.32], [262, 0.64]].forEach(function (a) { tone(a[0], a[1], 0.3, "sawtooth", 0.1); }); tone(247, 0.96, 0.7, "sawtooth", 0.1, 196, 6); },
    nope: function () { tone(220, 0, 0.12, "square", 0.1); tone(165, 0.12, 0.2, "square", 0.1); },
    hint: function () { tone(220, 0, 0.3, "sine", 0.25, 620, 14); tone(620, 0.3, 0.2, "sine", 0.2, 260); },
    shuffle: function () { for (var i = 0; i < 6; i++) { noise(i * 0.045, 0.06, 0.1, 2600 + i * 250, 2); } },
    drum: function () { var t = 0; for (var i = 0; i < 14; i++) { noise(t, 0.07, 0.07 + i * 0.006, 1800, 1.2); t += Math.max(0.045, 0.14 - i * 0.008); } },
    crash: function () { noise(0, 1.1, 0.14, 4000, 0.6, true); tone(110, 0, 0.3, "sine", 0.2, 55); },
    fanfare: function () { [523, 659, 784, 1047, 784, 1047, 1319].forEach(function (f, i) { tone(f, i * 0.11, 0.3, "triangle", 0.18); }); noise(0.8, 1, 0.12, 4500, 0.6, true); }
  };
  function sfx(name) {
    if (!sfxOn) { return; }
    if (!audioCtx()) { return; }
    try { SFX[name](); } catch (e) {}
  }
  // Android and desktop use the Vibration API. Safari on iPhone does not have it, so a hidden switch checkbox gives a tick instead
  // (this only works when it follows a tap).
  function iosTick() {
    try {
      if (!hapEl) {
        hapEl = document.createElement("label"); hapEl.setAttribute("aria-hidden", "true");
        hapEl.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none";
        var i = document.createElement("input"); i.type = "checkbox"; i.setAttribute("switch", ""); hapEl.appendChild(i); document.body.appendChild(hapEl);
      }
      hapEl.click();
    } catch (e) {}
  }
  function buzz(p) {
    if (!sfxOn) { return; }
    try {
      if (navigator.vibrate) { navigator.vibrate(p); return; }
      var a = [].concat(p), at = 0;
      for (var i = 0; i < a.length; i += 2) { (function (d) { setTimeout(iosTick, d); })(at); at += (a[i] || 0) + (a[i + 1] || 0); }
    } catch (e) {}
  }
  function setSfx(on) {
    sfxOn = on; try { localStorage.setItem("ttt_sfx", on ? "on" : "off"); } catch (e) {}
    usage(on ? "unmute" : "mute");
    if (on) { sfx("pop"); buzz(30); }
  }
  // Cues that follow state changes. They run before the screen is redrawn.
  // Sound plays on one phone only: the whistler's during a turn, the host's in the lobby and at the end.
  // Eight phones beeping together is noise, and most phones are on silent anyway, so every cue is also
  // something you can see, and every phone still gets the buzz.
  var sfxTimers = [], drumTurn = null, slamTurn = null;
  function clearSfxTimers() { sfxTimers.forEach(clearTimeout); sfxTimers = []; }
  function audioEvents(prev, cur) {
    if (!cur) { return; }
    var T = cur.turn, P = prev && prev.turn, host = cur.hostId === cur.me;
    if (cur.phase === "lobby" && prev && prev.phase === "lobby" && cur.players.length > prev.players.length) { if (host) { sfx("pop"); } buzz(25); }
    if (cur.phase === "gameover" && (!prev || prev.phase !== "gameover")) { if (host) { sfx("fanfare"); } buzz([60, 40, 60, 40, 140]); }
    if (!T) { return; }
    var same = P && P.id === T.id, mine = T.playerId === cur.me;
    if (!same && T.stage === "choose") { if (mine) { sfx("turn"); } buzz(mine ? [80, 50, 80, 50, 140] : 30); }
    if (T.stage === "countdown" && !(same && P.stage === "countdown")) {
      clearSfxTimers();
      var end = T.countdownEndsAt;
      [3, 2, 1].forEach(function (k) {
        var d = end - k * 1000 - nowS();
        if (d > -150) { sfxTimers.push(setTimeout(function () { if (mine) { sfx("tick"); } buzz(25); }, Math.max(0, d))); }
      });
      var gd = end - nowS();
      if (gd > -150) { sfxTimers.push(setTimeout(function () { if (mine) { sfx("go"); } buzz(mine ? [70, 40, 120] : 50); }, Math.max(0, gd))); }
    }
    if (T.stage === "confirming" && !(same && P.stage === "confirming")) {
      if (mine) { sfx("ping"); buzz([50, 40, 50]); }
      else if (T.buzzer) { buzz(T.buzzer === cur.me ? [40, 30, 40] : 30); }
    }
    if (T.stage === "claiming" && !(same && P.stage === "claiming") && T.claim && T.claim.ids.indexOf(cur.me) !== -1) { buzz([60, 40, 60]); }
    if (same && (T.hints || 0) > (P.hints || 0)) { if (mine) { sfx("hint"); } buzz(40); }
    if (same && T.shuffles !== undefined && P.shuffles !== undefined && T.shuffles > P.shuffles) { if (mine) { sfx("shuffle"); } buzz(30); }
  }

  // ---- The line that names the whistler under the 3, 2, 1 (see showLine and the countdown view).
  var SPLASH_LINES = [
    "{n}, it's show time!", "{n}, you're up!", "{n}, it's your turn!", "{n}, your time to shine!",
    "{n}, the floor is yours!", "{n}, take centre stage!", "{n}, take it away!", "{n}, over to you!",
    "{n}, the room is ready!", "{n}, give us a tune!", "{n}, let's hear it!", "{n}, the stage is set!",
    "You've got this, {n}!", "Break a leg, {n}!", "All eyes on {n}!"
  ];
  // ---- Halfway interlude: "check the scores on the doors" with a few cheeky stats, before the next round starts.
  var IV_TITLES = ["Halftime. Check the scores on the doors.", "Check the scores on the doors!", "Interval. Check the scores on the doors.", "Halfway there. Check the scores on the doors."];
  var IV_PERF = ["Star performer: {n}. Someone get this one a record deal.", "Star performer: {n}. Averaging {pts} a turn. Show off.", "Top of the bill: {n}. The rest of you have some catching up to do.", "{n} is the one to beat. {pts} a turn."];
  var IV_GUESS = ["Top guesser: {n}. Suspiciously good at this. We're watching.", "Sharpest ears: {n}. {k} so far.", "{n} has named {k} so far. Did you peek?", "Ears of the night: {n}. {k} and counting."];
  var IV_WORST = ["Needs more practice: {n}. The kazoo is not an enemy.", "Room for improvement: {n}. It's the taking part that counts.", "{n} is saving their best for later. Probably.", "Still warming up: {n}. Any minute now."];
  var IV_MS = 8000, lastIvTurn = null, ivTimer = null, ivSfx = [];
  function ivLine(list, seed, off, n, extra) {
    var t = esc(list[(seed + off) % list.length]);
    t = t.replace("{n}", '<span class="iv-n">' + esc(n) + "</span>");
    Object.keys(extra || {}).forEach(function (k) { t = t.replace("{" + k + "}", extra[k]); });
    return t;
  }
  function ivRow(s, id, html, delay) {
    var p = player(s, id);
    return '<div class="iv-row" style="animation-delay:' + delay + 'ms">' + (p ? avatarHtml(s, p, "avatar--md") : "") + '<p class="iv-tx">' + html + "</p></div>";
  }
  function showInterlude(s) {
    var iv = s.interlude, old = document.getElementById("interlude"); if (old) { old.remove(); }
    clearTimeout(ivTimer);
    var rows = "", sd = iv.seed, i = 1;
    if (iv.performer) { rows += ivRow(s, iv.performer.id, ivLine(IV_PERF, sd, 0, pname(s, iv.performer.id), { pts: iv.performer.avg }), 1400 * i++); }
    if (iv.guesser) { rows += ivRow(s, iv.guesser.id, ivLine(IV_GUESS, sd, 1, pname(s, iv.guesser.id), { k: iv.guesser.n + (iv.guesser.n === 1 ? " song" : " songs") }), 1400 * i++); }
    if (iv.worst) { rows += ivRow(s, iv.worst.id, ivLine(IV_WORST, sd, 2, pname(s, iv.worst.id)), 1400 * i++); }
    var el = document.createElement("div");
    el.id = "interlude"; el.setAttribute("role", "status");
    el.style.setProperty("--iv-ms", IV_MS + "ms");
    el.innerHTML = '<h1 class="iv-title">' + esc(IV_TITLES[sd % IV_TITLES.length]) + '</h1><div class="iv-rows">' + rows + '</div><p class="label iv-skip">Tap to skip</p>';
    document.body.appendChild(el);
    var loud = s.hostId === s.me; // one phone makes the noise
    if (loud) { sfx("drum"); } buzz(40); ivSfx.forEach(clearTimeout); ivSfx = [setTimeout(function () { if (loud) { sfx("crash"); } buzz([60, 30, 100]); }, 1250)];
    if (loud) { for (var q = 1; q < i; q++) { (function (d) { ivSfx.push(setTimeout(function () { sfx("pop"); }, d)); })(1400 * q + 150); } }
    var done = function () { clearTimeout(ivTimer); ivSfx.forEach(clearTimeout); if (el.parentNode) { el.remove(); } };
    el.onclick = done;
    ivTimer = setTimeout(done, IV_MS);
  }
  function interludeShowing() { return !!document.getElementById("interlude"); }
  function maybeInterlude() {
    if (!st || st.phase !== "turn" || !st.turn || !st.interlude || st.interlude.turnId === lastIvTurn) { return false; }
    lastIvTurn = st.interlude.turnId;
    if (st.interlude.ageMs > 3000 || st.turn.id !== st.interlude.turnId) { return false; }
    showInterlude(st); return true;
  }

  var lateNoted = false;
  function lateNote() {
    if (!st || st.phase !== "turn") { return; }
    var me = player(st, st.me);
    if (me && me.late && !lateNoted) { lateNoted = true; toast("You're in! You'll guess for now and perform from the next round."); }
  }
  function render() {
    var view;
    if (st && st.phase !== "lobby") { pickerOpen = false; packDraft = null; }
    var pb = document.querySelector(".pbody"), pTop = pb ? pb.scrollTop : 0;
    if (!st && adminLogin) { view = adminAuthed ? viewAdminHub() : viewAdminLogin(); }
    else if (!st) { view = viewHome(); }
    else if (st.phase === "lobby") { view = viewLobby(st); }
    else if (st.phase === "turn" && st.turn) { view = viewTurn(st); }
    else { view = viewOver(st); }

    var f = view.field === "time" ? timeField(st.turn) : (view.field || "ground");
    app.className = "field field--" + f;
    if (view.key === lastKey && view.update) {
      view.update();
    } else {
      app.innerHTML = view.html; lastKey = view.key;
      if (view.bind) { view.bind(); }
      if (view.update) { view.update(); }
    }
    var nb = document.querySelector(".pbody");
    if (nb && pTop && keepPickerScroll) { nb.scrollTop = pTop; }
    keepPickerScroll = true;
    document.body.classList.toggle("noscroll", pickerOpen);
    micSync();
    refreshMic();
    refreshTop();
    refreshAdmin();
    syncBg();
    refreshTip();
    lateNote();
    maybeInterlude();
  }

  // Keep the page behind the app (overscroll, notch) the same colour as the current field.
  var lastBg = "";
  var FIELD_BG = { ground: "#E4E2DD", pink: "#FF4FA3", green: "#00B86B", yellow: "#FFD21F", orange: "#FF4B14", blue: "#2640EC" }; // the same six values as the tokens in style.css
  function syncBg() {
    try {
      var m0 = /field--(\w+)/.exec(app.className), c = FIELD_BG[m0 ? m0[1] : "ground"] || FIELD_BG.ground;
      if (c === lastBg) { return; }
      lastBg = c;
      document.documentElement.style.background = c;
      document.body.style.background = c;
      var bg = document.getElementById("bgfill"); if (bg) { bg.style.background = c; }
      var m = document.querySelector('meta[name="theme-color"]'); if (m) { m.setAttribute("content", c); }
    } catch (e) {}
  }

  // The clock and countdown run locally between server messages.
  var lastSecond = null;
  function setText(el, t) { if (el && el.textContent !== t) { el.textContent = t; } }
  function tick() {
    requestAnimationFrame(tick);
    var T = st && st.turn;
    if (!T) { return; }
    var mineT = T.playerId === st.me;
    if (T.stage === "choose") {
      var ci = $("#chooseIn");
      if (ci) { setText(ci, T.chooseEndsAt ? "The middle one is picked for you in " + Math.max(0, Math.ceil((T.chooseEndsAt - nowS()) / 1000)) : ""); }
    }
    if (T.stage === "countdown") {
      var cd = $("#cd");
      if (cd) {
        var n = Math.max(1, Math.ceil((T.countdownEndsAt - nowS()) / 1000));
        if (cd.textContent !== String(n)) {
          cd.textContent = String(n);
          cd.style.animation = "none"; void cd.offsetWidth; cd.style.animation = "";
        }
      }
    }
    if (T.stage === "reveal" && T.result) {
      var R = T.result, ms = REDUCED ? 1e9 : Math.max(0, nowS() - R.revealAt), fr = revealFrame(R, ms);
      var sn = $("#scoreNum");
      if (sn) {
        setText(sn, String(Math.round(fr.num)));
        setText($("#scoreCap"), fr.cap);
        var mb = $("#multBadge"), dt = $("#deltaTag");
        if (mb) { mb.hidden = !fr.badge || fr.final; if (fr.badge) { setText(mb, fr.badge); } }
        if (dt) { dt.hidden = !fr.delta || fr.final; if (fr.delta) { setText(dt, fr.delta); } }
        sn.classList.toggle("big", !!fr.final);
        if (fr.drum && drumTurn !== T.id && R.outcome === "correct") { drumTurn = T.id; if (mineT) { sfx("drum"); } }
        if (fr.final && !sn.classList.contains("slam")) {
          sn.classList.add("slam"); buzz(R.score > 0 ? [60, 40, 90] : 40);
          if (slamTurn !== T.id) { slamTurn = T.id; if (mineT) { if (R.outcome === "correct") { sfx("win"); } else if (R.outcome !== "skipped") { sfx("fail"); } } }
        }
        // After the score has landed: "Up next" on an ordinary turn, the whole table at the end of a round.
        var scr = $("#rvScreen"), bd = $("#board");
        if (T.roundEnd) { if (scr) { scr.classList.toggle("showboard", ms >= fr.finalAt + 1200); } }
        else if (bd) { bd.classList.toggle("rvhide", ms < fr.finalAt + 300); }
      }
      var ni = $("#nextIn");
      if (ni) {
        var rem = T.nextAt ? T.nextAt - nowS() : null, last = st.turnNumber >= st.totalTurns;
        setText(ni, rem !== null && rem <= 3000 ? (last ? "Final scores in " : T.roundEnd ? "Next round in " : "Next turn in ") + Math.max(1, Math.ceil(rem / 1000)) : "");
      }
    }
    if (liveStage(T) && T.stage !== "countdown") {
      var el = elapsedMs(T), remain = T.limitMs - el;
      var big = $("#bigtime");
      if (big) { setText(big, pad2(Math.ceil(remain / 1000))); }
      var cls = "field field--" + timeField(T);
      if (app.className !== cls) { app.className = cls; syncBg(); }
      // The last ten seconds: the numeral beats once a second, on every phone, sound or no sound.
      if (remain <= 10000 && T.stage === "whistling") {
        var sec = Math.ceil(remain / 1000);
        if (sec !== lastSecond) {
          lastSecond = sec; buzz(40);
          if (big) { big.classList.remove("beat10"); void big.offsetWidth; big.classList.add("beat10"); }
        }
      } else { lastSecond = null; }
      // The buzzer: off whilst the clock is stopped, and for five seconds after a wrong buzz.
      var bb = $("#buzzBtn");
      if (bb) {
        var lock = T.buzzLockUntil && T.buzzLockUntil > nowS() ? Math.ceil((T.buzzLockUntil - nowS()) / 1000) : 0;
        var offNow = !!lock || T.stage !== "whistling";
        if (bb.disabled !== offNow) { bb.disabled = offNow; }
        setText($("#buzzSub"), lock ? "Wrong. Back in " + lock : "Tap when you know it, then say it out loud");
      }
    } else {
      lastSecond = null;
    }
  }

  // ------------------------------------------------------------------ boot
  connect();
  setInterval(function () { send({ t: "ping" }); }, 20000);
  setInterval(function () { if (!st && !adminLogin) { send({ t: "listRooms" }); } }, 3000);
  render();
  requestAnimationFrame(tick);
})();
