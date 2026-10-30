(function () {
  "use strict";

  var app = document.getElementById("app");
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  var ws = null, connected = false, session = null, rejoining = false, pendingName = "";
  var gameList = [], adminLogin = false, adminAuthed = false, adminPw = "", adminData = null, pickerOpen = false, packDraft = null, settingsOpen = false, pickerTab = "All", keepPickerScroll = true;
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
    var proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(proto + "://" + location.host + "/ws");
    ws.onopen = function () {
      connected = true; setBanner(""); lastMicSent = "";
      sendHello();
      send({ t: "listRooms" });
      if (invite && !session) { invite.loading = true; send({ t: "peek", code: invite.code }); }
      if (session) {
        rejoining = true;
        send({ t: "join", code: session.code, playerId: session.playerId, name: session.name });
      }
    };
    ws.onmessage = function (e) {
      var m; try { m = JSON.parse(e.data); } catch (err) { return; }
      onMessage(m);
    };
    ws.onclose = function () {
      connected = false;
      setBanner("Hang on, reconnecting...");
      setTimeout(connect, 1500);
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
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
      gameList = m.rooms || [];
      if (!st && !adminLogin && lastKey === "home") { var v = viewHome(); if (v.update) { v.update(); } }
    } else if (m.t === "roomInfo") {
      if (invite && invite.code === m.code) { invite.info = m; invite.loading = false; if (!st) { lastKey = null; render(); } }
    } else if (m.t === "joined") {
      session = { code: m.code, playerId: m.playerId, name: pendingName || (session && session.name) || "" };
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
    } else if (m.t === "guessFeedback") {
      toast("Nope! Try again."); sfx("nope"); buzz(40);
    }
  }

  function keepAwake() {
    try {
      if (navigator.wakeLock && !wakeLock) {
        navigator.wakeLock.request("screen").then(function (l) {
          wakeLock = l;
          l.addEventListener("release", function () { wakeLock = null; });
        }).catch(function () {});
      }
    } catch (e) {}
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && session) { keepAwake(); }
  });

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
  var mic = { state: SR ? "off" : "unsupported", rec: null, want: false, lastSent: "", heard: "", level: 0, typeMode: !SR };

  function isGuessing() {
    return !!(st && st.phase === "turn" && st.turn && st.turn.stage === "whistling" && st.turn.playerId !== st.me);
  }

  function micStart() {
    if (!SR) { return; }
    mic.want = true;
    micLaunch();
  }

  // Called from the tap on Start lobby or Join lobby, the one moment the browser lets the mic start.
  function autoMic() {
    if (SR && !mic.typeMode && mic.state !== "on" && mic.state !== "starting" && mic.state !== "blocked") { try { micStart(); } catch (e) {} }
  }

  // Some in-app and privacy browsers (DuckDuckGo on iPhone, for one) expose speech recognition but never start it.
  // After two starts that go nowhere, stop trying and let the player type.
  function micGiveUp() {
    if (mic.fails >= 2) {
      mic.want = false; mic.typeMode = true; mic.state = "stopped";
      try { if (mic.rec) { mic.rec.onend = null; mic.rec.abort(); } } catch (e) {}
      mic.rec = null;
      toast("This browser can't hear guesses. Type them instead.");
      if (st) { render(); }
    }
  }

  function micLaunch() {
    var rec = new SR();
    rec.lang = "en-GB"; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 5;
    mic.rec = rec; mic.state = "starting";
    var startTimer = setTimeout(function () {
      if (mic.rec === rec && mic.state === "starting") { mic.fails = (mic.fails || 0) + 1; mic.state = "stopped"; micGiveUp(); refreshMic(); }
    }, mic.everStarted ? 3500 : 12000);
    rec.onsoundstart = rec.onspeechstart = function () { mic.level = Math.max(mic.level, 0.7); };
    rec.onstart = function () { mic.everStarted = true; mic.fails = 0; mic.base = 0; mic.total = 0; clearTimeout(startTimer); if (mic.rec === rec) { mic.state = "on"; refreshMic(); } };
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
      if (e.error === "not-allowed" || e.error === "service-not-allowed" || e.error === "audio-capture" || e.error === "language-not-supported") {
        mic.want = false; mic.state = "blocked"; mic.typeMode = true; refreshMic(); if (st) { render(); }
      }
    };
    rec.onend = function () {
      clearTimeout(startTimer);
      if (mic.want && mic.rec === rec && mic.state === "starting") { mic.fails = (mic.fails || 0) + 1; micGiveUp(); if (!mic.want) { refreshMic(); return; } }
      if (mic.want && mic.rec === rec) {
        mic.state = "starting"; refreshMic();
        setTimeout(function () {
          if (mic.want && mic.rec === rec) {
            try { micLaunch(); } catch (err) { mic.state = "stopped"; refreshMic(); }
          }
        }, 60);
      }
    };
    try { rec.start(); } catch (err) { mic.state = "stopped"; refreshMic(); }
  }

  function ico(n, c) {
    if (n !== "tick" && n !== "chevron" && n !== "mic") { return ""; }
    return '<svg class="' + (c || "") + '" aria-hidden="true"><use href="#i-' + n + '"/></svg>';
  }
  function cap(s) { s = String(s); return s.charAt(0).toUpperCase() + s.slice(1); }
  function pad2(n) { n = Math.max(0, Math.floor(n)); return n < 10 ? "0" + n : String(n); }

  function micHtml() {
    switch (mic.state) {
      case "unsupported":
        return '<span class="small">Typing only on this phone</span>';
      case "off":
        return '<button id="micBtn" class="txt">Turn on mic</button>';
      case "starting":
        return '<span class="label">Starting mic</span>';
      case "on":
        return '<span class="label">Mic on</span>';
      case "blocked":
        return '<span class="label">Mic blocked</span><p class="small">Allow the microphone for this site in your browser settings, then reload. You can still type guesses.</p>';
      default:
        return '<button id="micBtn" class="txt">Mic stopped, tap to restart</button>';
    }
  }

  function micRowHtml() {
    return mic.state === "blocked" ? '<p class="small">Mic blocked. Allow the microphone for this site in your browser settings, then reload. You can still type guesses.</p>' : "";
  }
  function micStop() {
    mic.want = false;
    try { if (mic.rec) { mic.rec.onend = null; mic.rec.stop(); } } catch (e) {}
    mic.rec = null; mic.state = "off"; refreshMic();
  }

  var lobbyMicSig = "";
  function refreshMic() {
    var mineBox = $('.mstat[data-mine]');
    if (st && mineBox) {
      var me = null; st.players.forEach(function (q) { if (q.id === st.me) { me = q; } });
      if (me) { var h = lobbyStat(st, me, st.hostId === st.me); if (mineBox.innerHTML !== h) { mineBox.innerHTML = h; bindPill(); } }
    }
    var boxes = document.querySelectorAll("[data-mic]");
    for (var i = 0; i < boxes.length; i++) {
      boxes[i].innerHTML = boxes[i].getAttribute("data-mic") === "note" ? micRowHtml() : micHtml();
      var b = $("#micBtn", boxes[i]);
      if (b) { b.onclick = micStart; }
      var o = $("#micOffBtn", boxes[i]);
      if (o) { o.onclick = micStop; }
    }
    var ms = mic.typeMode || mic.state === "unsupported" ? "typing" : (mic.state === "on" ? "on" : "off");
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
      hd.textContent = mic.state === "on" ? "Listening" : mic.state === "blocked" ? "Mic is blocked" : mic.state === "starting" ? "Starting mic" : "Mic is off, tap to turn on";
    }
  }

  // ----------------------------------------------------------------- views
  var PACK_GROUPS = [
    { name: "Vibe", ids: ["bangers", "diva", "party", "soul", "tv", "film", "disney"] },
    { name: "Eras", ids: ["sixties", "seventies", "eighties", "nineties", "noughties", "tens", "today"] },
    { name: "Artists", ids: ["beatles", "bowie", "gaga", "talkingheads", "abba"] },
    { name: "Special events", ids: ["halloween", "xmas"] }
  ];
  // Pack colour tokens from the design system. "l" means light text, "i" ink text.
  var PACK_COL = {
    bangers: ["#00B86B", "i"], diva: ["#FF3D81", "i"], party: ["#3DDC84", "i"], soul: ["#FF9A1F", "i"], tv: ["#0FB5C8", "i"], film: ["#A66BFF", "i"], disney: ["#FFD21F", "i"],
    sixties: ["#2EE6D6", "i"], seventies: ["#F68675", "i"], eighties: ["#9BE23A", "i"], nineties: ["#FF4FA3", "i"], noughties: ["#4D7CFF", "i"], tens: ["#FF6A3D", "i"], today: ["#C77DFF", "i"],
    beatles: ["#6F8DFF", "i"], bowie: ["#00D1FF", "i"], gaga: ["#E040FB", "i"], talkingheads: ["#B09CFF", "i"], abba: ["#FFE14D", "i"],
    halloween: ["#FF5252", "i"], xmas: ["#FFC9A3", "i"]
  };
  var openGroups = { Vibe: true };

  function avatarHtml(s, p, cls) {
    var ch = (String(p.name).trim().charAt(0) || "?").toUpperCase();
    return '<span class="avatar pc pc' + ((p.ci || 0) % 20) + (cls ? " " + cls : "") + '">' + esc(ch) + "</span>";
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
    var final = !!opt.bonus;
    var html = rows.map(function (r) {
      var p = r.p, me = p.id === s.me, win = winners && winners.indexOf(p.id) !== -1;
      var chg = r.chg === undefined ? "" : (r.chg > 0 ? "+" + r.chg : String(r.chg));
      var g = gained[p.id] !== undefined && gained[p.id] > 0 && final ? "+" + pts(gained[p.id]) : "";
      return '<div class="' + (final ? "finalrow" : "stand" + (me ? " me" : "")) + '"><span class="label">' + r.rank + "</span>" +
        '<span class="title pn">' + avatarHtml(s, p) + '<span class="nmtx">' + esc(p.name) + (p.late ? '<small class="late">joined late</small>' : "") + "</span>" + (win ? '<span class="tag">Winner</span>' : "") + "</span>" +
        '<span class="title">' + pts(p.total) + "</span>" +
        (final ? '<span class="bn">' + g + "</span>" : '<span class="ch">' + chg + "</span>") + "</div>";
    }).join("");
    return '<div class="board" style="border-bottom:1.5px solid currentColor">' + html + "</div>";
  }

  function gamesHtml() {
    if (!gameList.length) {
      return '<div class="gamerow"><span class="gtxt"><span class="title">Nobody\'s hosting yet</span></span></div>';
    }
    return gameList.map(function (g) {
      var closed = g.inProgress, live = g.live;
      return (closed ? '<div class="gamerow dead">' : '<button class="gamebtn" data-code="' + esc(g.code) + '">') +
        '<span class="gtxt"><span class="title">' + esc(g.host) + "'s game</span>" +
        '<span class="small">' + (closed ? g.players + (g.players === 1 ? " player" : " players") + ", in a tie-break" : g.players + " of " + (g.max || 20) + " players" + (live ? ", game under way" : "")) + "</span></span>" +
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
      '<p class="small" id="nameHint" style="margin-top:8px">Up to 14 characters</p></div>';
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
        '<div class="field-group">' + nameField(name) + '<button id="joinBtn" class="btn" style="margin-top:12px">' + (info.state === "live" ? "Join game" : "Join lobby") + "</button>" +
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
          '<div class="field-group">' + nameField(name) + '<button id="hostBtn" class="btn" style="margin-top:12px">Start lobby</button>' +
          '<p class="small">Start a lobby and we\'ll copy a link to send to your friends.</p></div>' +
          '<div class="stack"><h2 class="label">Join a game</h2><div class="line-list" id="games">' + gamesHtml() + "</div></div>" +
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
        block("Voice guessing", arow("Guesses the game heard", dash(V.heardGuesses)) + arow("Rejected by performer", rej) + arow("Correct by voice", dash(src.voice)) + arow("Correct by typing", dash(src.typed)) + arow("Correct by Someone got it", dash(src.manual))) +
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
        '<div class="rowc" style="gap:12px"><button id="aRefresh" class="btn btn--outline" style="flex:1">Refresh</button><button id="aCopy" class="btn btn--outline" style="flex:1">Copy JSON</button></div>' +
        '<button id="aRaw" class="btn btn--outline">Download all raw data</button>' +
        '<button id="aOut" class="txt" style="align-self:center">Sign out</button></div>',
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
      return '<div class="setrow"><div><div class="label">Max round length</div><p class="small">Set by the host. A round ends as soon as the song is guessed.</p></div>' +
        '<span class="title" id="limitVal">' + (LEN_LABEL[s.limitMs] || s.limitMs / 1000 + " s") + "</span></div>";
    }
    return '<div class="stack"><div class="label">Max round length</div><p class="small">A round ends as soon as the song is guessed.</p><div class="seg">' + opts.map(function (ms) {
      return '<button class="segb' + (ms === s.limitMs ? " on" : "") + '" aria-pressed="' + (ms === s.limitMs) + '" data-ms="' + ms + '">' + LEN_LABEL[ms] + "</button>";
    }).join("") + "</div></div>";
  }

  function micLabel(p) {
    if (!p.connected) { return "Away"; }
    return p.mic === "on" ? "Mic on" : p.mic === "typing" ? "Keyboard" : "Mic off";
  }
  function micStrip() { return ""; }
  function syncMicStrip() {}

  function packCard(p, on, ro, voters) {
    var col = PACK_COL[p.id] || ["#225A31", "l"];
    var pt = col[1] === "l" ? "#ECEAE4" : "#111111";
    var vh = "";
    if (voters && voters.length) {
      vh = '<span class="voters">' + voters.slice(0, 2).join("") + '</span><span class="title">' + voters.length + "</span>";
    }
    return '<button class="pcard pack' + (on ? " on" : "") + (ro ? " ro" : "") + '" data-id="' + p.id + '" aria-pressed="' + on + '"' + (ro ? " disabled" : "") +
      ' style="--pc:' + col[0] + ";--pt:" + pt + '"><span class="pcard__in"><span class="pcard__txt"><span class="title">' + esc(p.name) + "</span>" +
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
  function packsSummaryHtml(s, isHost) {
    var room = s.packMode === "room";
    var on = s.packs.filter(function (p) { return s.selectedPacks.indexOf(p.id) !== -1; });
    var need = s.rounds * s.players.length + 5, short = s.songsInPlay < need;
    var note = !on.length ? (room ? "Everyone picks up to " + (s.packPicks || 5) + " packs" : isHost ? "Pick a pack to get going" : "Waiting for the host to pick packs")
      : short ? "Not enough songs for that many turns. Add more packs or drop a round"
      : room ? "Every pack picked goes in the mix. Popular ones come up more." : "No song is played twice in a game.";
    var mode = isHost
      ? '<div class="seg packmode"><button class="pmode" data-m="host" aria-pressed="' + !room + '">Host picks</button><button class="pmode" data-m="room" aria-pressed="' + room + '">Room picks</button></div>'
      : "";
    var btn = room ? (s.myPackVotes.length ? "Change your picks" : "Pick song packs") : (isHost ? "Select song packs" : "See packs");
    var r = rankingList(s).slice(0, 3);
    var body = room
      ? (r.length ? r.map(function (x) { return '<p class="small">' + esc(x.p.name) + ", " + x.n + (x.n === 1 ? " pick" : " picks") + "</p>"; }).join("") : '<p class="small">No picks yet</p>')
      : '<p class="title">' + esc(packSummaryLine(on)) + "</p>";
    return '<div class="stack"><div class="label">Songs</div>' + mode + '<div class="packline">' + body + '<p class="small">' + esc(note) + "</p></div>" +
      '<button class="btn btn--outline" id="openPacks">' + btn + "</button></div>";
  }

  // Guests see one quiet line about the songs and, in room mode, a way to vote.
  function guestSongsHtml(s) {
    var room = s.packMode === "room";
    var on = s.packs.filter(function (p) { return s.selectedPacks.indexOf(p.id) !== -1; });
    var line = room ? (rankingList(s).length ? "In the mix: " + packSummaryLine(on) : "No picks yet") : packSummaryLine(on);
    return '<div class="stack"><div class="label">Songs</div><p class="title">' + esc(line) + "</p>" +
      (room ? '<button class="btn btn--outline" id="openPacks">' + (s.myPackVotes.length ? "Change your picks" : "Pick song packs") + "</button>"
            : '<div><button class="txt" id="openPacks">See packs</button></div>') + "</div>";
  }

  function pickerHtml(s, isHost) {
    var room = s.packMode === "room", votes = s.packVotes || {};
    var all = s.packs.length === s.selectedPacks.length;
    var cap = s.packPicks || 5;
    var mine = room ? (packDraft || s.myPackVotes || []) : [];
    var byId = {}, used = {};
    s.packs.forEach(function (p) { byId[p.id] = p; });
    var groups = PACK_GROUPS.map(function (g) {
      var ps = g.ids.map(function (id) { used[id] = 1; return byId[id]; }).filter(Boolean);
      return { name: g.name, packs: ps };
    });
    var rest = s.packs.filter(function (p) { return !used[p.id]; });
    if (rest.length) { groups.push({ name: "More", packs: rest }); }
    var isOn = function (p) { return room ? mine.indexOf(p.id) !== -1 : s.selectedPacks.indexOf(p.id) !== -1; };
    var html = groups.map(function (g) {
      var open = !!openGroups[g.name], cnt = g.packs.filter(isOn).length;
      var cards = g.packs.map(function (p) {
        var voters = room ? (votes[p.id] || []).map(function (id) { var pl = player(s, id); return pl ? avatarHtml(s, pl) : ""; }) : [];
        var n = room ? (votes[p.id] || []).length : 0;
        if (n) { voters.count = n; }
        return packCard(p, isOn(p), !room && !isHost, voters);
      }).join("");
      return '<div class="pgroup' + (open ? " open" : "") + '"><button class="pgroup__row" data-g="' + esc(g.name) + '" aria-expanded="' + open + '">' +
        '<span class="pgroup__name"><span class="label">' + esc(g.name) + "</span>" +
        (!open && cnt ? '<span class="pgroup__sel">' + cnt + (cnt === 1 ? " pack selected" : " packs selected") + "</span>" : "") + "</span>" +
        ico("chevron", "chev") + '</button><div class="pdeck">' + cards + "</div></div>";
    }).join("");
    var intro = room ? "Pick up to " + cap + ". Every pack anyone picks goes into one mix, and the popular ones come up more." : isHost ? "Pick as many as you like. They decide which songs come up." : "The host picks the packs.";
    var count = room ? mine.length + " of " + cap + " picks used" : s.selectedPacks.length + " of " + s.packs.length + " packs picked";
    return '<div class="picker" id="picker"><div class="pwrap">' +
      '<div class="phead"><div class="toprow"><span class="label">Song packs</span><button class="txt" id="pkDone">' + (room ? "Close" : "Done") + '</button></div>' +
      '<h1 class="headline">' + (room ? "Pick the packs you want" : isHost ? "Choose the packs to play" : "The packs in play") + "</h1>" +
      '<div class="stack" style="gap:2px"><p class="small">' + intro + '</p><p class="small">' + count + "</p></div>" +
      (isHost ? '<div class="seg packmode"><button class="pmode" data-m="host" aria-pressed="' + !room + '">Host picks</button><button class="pmode" data-m="room" aria-pressed="' + room + '">Room picks</button></div>' : "") +
      (isHost && !room ? '<div><button class="txt" id="packAll" style="padding-left:0">' + (all ? "Clear all" : "Select all packs") + "</button></div>" : "") + "</div>" +
      '<div class="pbody"><div>' + html + "</div></div>" +
    "</div>" + (room ? '<div class="pfloat"><button class="btn" id="pkSubmit">' + ((s.myPackVotes || []).length ? "Update my picks" : "Submit picks") + "</button></div>" : "") + "</div>";
  }

  function startNote(s, turns) {
    if (s.players.length < s.minPlayers) { return "Need at least " + s.minPlayers + " players to get going. Share the link!"; }
    if (!s.selectedPacks.length) { return s.packMode === "room" ? "Waiting for someone to pick some song packs" : "Pick a song pack to get going"; }
    if (s.songsInPlay < turns + 5) { return "Not enough songs for that many turns. Add more packs or drop a round."; }
    var off = s.players.filter(function (p) { return p.mic === "off"; }).map(function (p) { return p.name; });
    if (off.length) { return (off.length > 1 ? off.slice(0, -1).join(", ") + " and " + off[off.length - 1] : off[0]) + (off.length > 1 ? " have their mics off" : " has their mic off") + ". They can still type guesses, no worries."; }
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
  function songsRowHtml(s, isHost) {
    var room = s.packMode === "room";
    var cue = room ? "Change" : isHost ? "Choose" : "See";
    var d = songsDetail(s);
    var inner = '<span class="lrow__t"><span class="label">Songs' + (room ? ", everyone's picks" : "") + '</span><span class="title">' + esc(songsTitle(s)) + "</span>" +
      (d ? '<span class="small lrow__list">' + esc(d) + "</span>" : "") + "</span>";
    if (room && !isHost) { return '<div class="lrow lrow--top lrow--static">' + inner + "</div>"; }
    return '<button class="lrow lrow--top" id="openPacks">' + inner + '<span class="lrow__c label">' + cue + "</span>" + ico("chevron", "chev") + "</button>";
  }
  // Room-picks mode: a clear primary action for every player, kept apart from the settings rows.
  function voteCtaHtml(s) {
    if (s.packMode !== "room") { return ""; }
    var n = (s.myPackVotes || []).length;
    return '<div class="votecta"><button class="btn" id="voteBtn">' + (n ? "Change your picks" : "Pick song packs") + "</button>" +
      '<p class="small center">' + (n ? "You picked " + n + (n === 1 ? " pack." : " packs.") : "Pick up to " + (s.packPicks || 5) + ". Everyone's picks go into one mix.") + "</p></div>";
  }
  function inviteRowHtml(s, isHost) {
    return '<button class="lrow" id="copyLink" style="min-height:56px;align-items:center"><span class="lrow__t"><span class="label">Invite friends</span></span><span class="lrow__c label">Copy link</span></button>' +
      (isHost ? '<button class="lrow" id="showQr" style="min-height:56px;align-items:center"><span class="lrow__t"><span class="label">Scan to join</span></span><span class="lrow__c label">Show QR code</span></button>' : "");
  }
  // A full screen QR code that opens the join link, so friends in the room can just point their cameras at the host.
  function showQr(code) {
    if (document.getElementById("qrfull") || typeof qrcode !== "function") { return; }
    var svg = "";
    try { var q = qrcode(0, "M"); q.addData(linkFor(code)); q.make(); svg = q.createSvgTag({ cellSize: 1, margin: 4, scalable: true }); } catch (e) { return; }
    var o = document.createElement("div");
    o.id = "qrfull"; o.className = "qrfull"; o.setAttribute("role", "dialog"); o.setAttribute("aria-label", "QR code to join the game");
    o.innerHTML = '<button class="qrx" aria-label="Close">X</button><div class="qrbox">' + svg + '</div><p class="qrcap">Room ' + esc(code) + "</p>";
    document.body.appendChild(o);
    function close() { if (o.parentNode) { o.parentNode.removeChild(o); } document.removeEventListener("keydown", onKey); }
    function onKey(ev) { if (ev.key === "Escape") { close(); } }
    document.addEventListener("keydown", onKey);
    o.querySelector(".qrx").onclick = close;
    usage("qr", "lobby");
  }
  // A fair guess at game length. Most songs are guessed well inside the clock, so a turn is mostly the set-up
  // around it (splash, picking, countdown, reveal), plus about 30 percent of the clock on average (about 18 seconds on a minute clock).
  function estMinutes(players, rounds, limitMs) {
    var perTurn = 30 + 0.3 * limitMs / 1000, total = perTurn * players * rounds + (rounds >= 4 ? 8 : 0);
    return Math.max(5, Math.round(total / 60 / 5) * 5);
  }
  function estText(s) {
    var n = Math.max(2, s.players.length);
    return "About " + estMinutes(n, s.rounds, s.limitMs) + " min with " + n + (n === 1 ? " player" : " players");
  }
  function settingsText(s) {
    return s.rounds + (s.rounds === 1 ? " round" : " rounds") + ", up to " + (LEN_LABEL[s.limitMs] || s.limitMs / 1000 + " s") + " each";
  }
  function settingsRowHtml(s, isHost) {
    if (!isHost) { return '<div class="lrow lrow--static" id="guestSettings"><span class="lrow__t"><span class="label">Game</span><span class="title">' + settingsText(s) + '</span><span class="small">' + estText(s) + "</span></span></div>"; }
    return '<button class="lrow" id="openSettings"><span class="lrow__t"><span class="label">Game settings</span><span class="title" id="settingsLine">' + settingsText(s) + '</span><span class="small">' + estText(s) + '</span></span><span class="lrow__c label">Change</span>' + ico("chevron", "chev") + "</button>";
  }
  function settingsSheetHtml(s, turns) {
    var opts = s.limitOptions || [30000, 60000, 90000, 120000];
    return '<div class="sheetwrap"><div class="scrim" id="setScrim"></div><div class="sheet"><span class="label">Game settings</span>' +
      '<div class="setrow"><div><div class="label">Rounds</div><p class="small">' + turns + " turns in all, about " + estMinutes(Math.max(2, s.players.length), s.rounds, s.limitMs) + " min</p>" + (s.roundsAuto ? '<p class="small">Set for ' + s.players.length + (s.players.length === 1 ? " player" : " players") + ". It updates as people join, until you change it.</p>" : "") + "</div>" +
      '<div class="stepper"><button id="minus" class="txt" aria-label="Fewer rounds">Less</button><span class="title val" id="roundsVal">' + s.rounds + '</span><button id="plus" class="txt" aria-label="More rounds">More</button></div></div>' +
      '<div class="stack"><div class="label">Max round length</div><p class="small">A round ends as soon as the song is guessed.</p><div class="seg">' + opts.map(function (ms) {
        return '<button class="segb' + (ms === s.limitMs ? " on" : "") + '" aria-pressed="' + (ms === s.limitMs) + '" data-ms="' + ms + '">' + LEN_LABEL[ms] + "</button>";
      }).join("") + "</div></div>" +
      '<button class="btn" id="setDone">Done</button></div></div>';
  }

  function lobbyStat(s, p, isHost) {
    var mine = p.id === s.me, away = !p.connected;
      var lab = away ? "Away" : mine ? (mic.state === "on" ? "Mic on" : mic.state === "starting" ? "Starting" : mic.state === "blocked" || mic.state === "unsupported" ? "Keyboard" : "Mic off") : micLabel(p);
      var on = lab === "Mic on", kb = lab === "Keyboard";
      var dot = '<i class="mdot' + (on ? " on" : kb ? " kb" : "") + '"></i>';
      var stat;
      if (mine && !s.admin && SR && !away && mic.state !== "blocked" && mic.state !== "starting") {
        stat = '<button class="mpill" data-act="mictoggle" aria-label="' + (on ? "Turn mic off" : "Turn mic on") + '">' + dot + '<span class="label">' + lab + "</span></button>";
      } else {
        stat = dot + '<span class="label">' + lab + "</span>" + (isHost && away ? '<button class="mon" data-act="rm" data-id="' + esc(p.id) + '">Remove</button>' : "");
      }
    return stat;
  }
  function bindPill() {
    var mps = document.querySelectorAll(".mpill");
    for (var pi = 0; pi < mps.length; pi++) {
      mps[pi].onclick = function () { if (mic.state === "on") { micStop(); } else { mic.typeMode = false; micStart(); } };
    }
  }
  function viewLobby(s) {
    var isHost = s.hostId === s.me;
    var turns = s.rounds * s.players.length;
    var cells = s.players.map(function (p) {
      var mine = p.id === s.me, away = !p.connected;
      var stat = lobbyStat(s, p, isHost);
      return '<div class="pcell">' + avatarHtml(s, p, "avatar--md") + '<span class="pn"><span class="title">' + esc(p.name) +
        (p.id === s.hostId ? '<span class="tag">Host</span>' : "") + '</span><span class="mstat"' + (mine ? ' data-mine="1"' : "") + '>' + stat + "</span></span></div>";
    }).join("");
    return {
      key: "lobby", field: "pink",
      html:
        '<div class="screen">' +
          '<div class="head"><h1 class="headline">' + esc(pname(s, s.hostId)) + "'s game</h1>" +
            '<p class="small">' + s.players.length + " of " + s.maxPlayers + " players are in</p></div>" +
          '<div class="pgrid">' + cells + "</div>" + voteCtaHtml(s) +
          '<div class="lrows">' + songsRowHtml(s, isHost) + settingsRowHtml(s, isHost) + inviteRowHtml(s, isHost) + "</div>" +
          '<div class="spacer"></div>' +
          (isHost ? "" : '<p class="headline waiting">Waiting for ' + esc(pname(s, s.hostId)) + " to start</p><div class=\"spacer\"></div>") +
          '<div class="micline micst" data-mic="note"></div>' +
          (isHost
            ? '<button id="startBtn" class="btn"' + (s.players.length < s.minPlayers || !s.selectedPacks.length || s.songsInPlay < turns + 5 ? " disabled" : "") + ">Start game</button>" +
              (startNote(s, turns) ? '<p class="small center startnote">' + esc(startNote(s, turns)) + "</p>" : "")
            : "") +
          '<div class="rowc"><button id="helpBtn" class="txt">How to play</button>' +
          '<button id="leaveBtn" class="txt">Leave game</button></div>' +
          (pickerOpen ? pickerHtml(s, isHost) : "") +
          (settingsOpen && isHost ? settingsSheetHtml(s, turns) : "") +
        "</div>",
      bind: function () {
        $("#helpBtn").onclick = function () { usage("howto", "home"); showHelp(); };
        $("#copyLink").onclick = function () { copyText(linkFor(s.code), false); };
        if ($("#showQr")) { $("#showQr").onclick = function () { showQr(s.code); }; }
        bindPill();
        var mons = document.querySelectorAll(".mon");
        for (var mi = 0; mi < mons.length; mi++) {
          mons[mi].onclick = function () {
            if (this.getAttribute("data-act") === "mic") { mic.typeMode = false; micStart(); return; }
            if (this.getAttribute("data-act") === "micoff") { micStop(); render(); return; }
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
        var vb = $("#voteBtn"); if (vb) { vb.onclick = openP; }
        if (pickerOpen) {
          $("#pkDone").onclick = function () { pickerOpen = false; packDraft = null; render(); };
          var rows = document.querySelectorAll(".pgroup__row");
          for (var g = 0; g < rows.length; g++) {
            rows[g].onclick = function () { var n = this.getAttribute("data-g"); openGroups[n] = !openGroups[n]; render(); };
          }
          var cardsEl = document.querySelectorAll(".pack");
          if (s.packMode === "room") {
            var cap = s.packPicks || 5;
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

  function topLabel(s) {
    var T = s.turn;
    if (T.sd) { return "Tie-break round " + s.sdRound; }
    var base = "Round " + T.round + " of " + s.rounds;
    if (T.stage === "whistling" || T.stage === "confirming") {
      return base + ", " + (T.playerId === s.me ? "you are performing" : pname(s, T.playerId) + " is performing");
    }
    return base + ", turn " + s.turnNumber + " of " + s.totalTurns;
  }

  function topBar(s) {
    return '<div class="label" id="topLabel">' + esc(topLabel(s)) + '</div><div id="lastRound"></div>';
  }

  // Kept up to date on every state change, even when the screen itself is not redrawn.
  function refreshTop() {
    if (!st || !st.turn) { return; }
    var l = $("#topLabel"); if (l) { l.textContent = topLabel(st); }
    var b = $("#lastRound"); if (!b) { return; }
    var T = st.turn, isHost = st.hostId === st.me;
    var show = !T.sd && !st.suddenDeath && T.round === st.rounds;
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
    if (s.hostId !== s.me) { return ""; }
    return '<div class="rowc" style="justify-content:center"><button id="hostMenuBtn" class="txt">Host controls</button></div>';
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
      '<button class="txt" id="hmClose" style="align-self:center">Close</button></div>';
    document.body.appendChild(o);
    var close = function () { if (o.parentNode) { o.parentNode.removeChild(o); } };
    $("#hmClose", o).onclick = close; $("#hmScrim", o).onclick = close;
    var rb = $("#rmBtn", o);
    if (rb) {
      rb.onclick = function () {
        o.querySelector(".sheet").innerHTML = '<span class="label">Remove a player</span>' +
          st.players.filter(function (p) { return p.id !== st.me; }).map(function (p) {
            return '<button class="btn btn--outline rmp" data-id="' + esc(p.id) + '">' + esc(p.name) + (p.connected ? "" : " (away)") + "</button>";
          }).join("") + '<button class="txt" id="rmBack" style="align-self:center">Back</button>';
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
      (d ? '<span class="tag" style="align-self:flex-start">' + esc(cap(d)) + " x" + T.multiplier + "</span>" : "") +
      '<h1 class="headline" id="songTitle">' + esc(T.song ? T.song.title : "") + "</h1>" +
      '<p class="title" id="songArtist">' + esc(T.song ? T.song.artist : "") + "</p></div>";
  }

  // ---- action buttons (Shuffle, Give hint, Ask for a hint)
  function actionHtml(id, cue, tag, label, small) {
    return '<button id="' + id + '" class="action"><span class="action__top"><span class="label" data-cue>' + cue + '</span><span class="tag" data-tag' + (tag ? "" : " hidden") + ">" + tag + "</span></span>" +
      '<span class="stack" style="gap:2px"><span class="title" data-label>' + label + '</span><span class="small" data-small>' + small + "</span></span></button>";
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
  function syncAskBtn(t) {
    var b = $("#askHintBtn"); if (!b) { return; }
    var done = t.hints >= 3, asked = !!t.iAsked;
    b.hidden = done;
    if (done) { return; }
    var cue = t.hints ? "Hint " + t.hints + " of 3" : "No hints yet";
    setAction("askHintBtn", cue, done ? "Asked" : asked ? "Asked" : "Ask",
      done ? "No more hints" : asked ? "Hint asked" : "Ask for a hint",
      done ? "All three hints given" : "Nudges the performer", done || asked);
    b.disabled = done || asked || t.stage === "confirming";
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
    if (mic.typeMode) { lines = lines.slice(-1); }
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

  // "Who got it?" sheet on the whistler's phone. Picks survive state updates for the same turn.
  var whoState = { built: null, picks: [] };
  function buildWho(t) {
    if (whoState.built === t.id) { return; }
    whoState.built = t.id;
    whoState.picks = t.pending && t.pending.from ? [t.pending.from] : [];
    var sub = (t.pending && t.pending.heard ? "Heard “" + t.pending.heard + "”. " : "") + "You can select more than one, in case two people shouted at once.";
    $("#confSub").textContent = sub;
    var grid = $("#whoGrid");
    grid.innerHTML = st.players.filter(function (p) { return p.id !== st.me; }).map(function (p) {
      return '<button class="who" data-id="' + esc(p.id) + '" aria-pressed="' + (whoState.picks.indexOf(p.id) !== -1) + '">' + avatarHtml(st, p, "avatar--md") +
        '<span class="title">' + esc(p.name) + '</span><span class="tag tagon" style="background:var(--light);color:var(--ink)">Got it</span></button>';
    }).join("");
    var sync = function () { $("#yesBtn").disabled = !whoState.picks.length; };
    var bs = grid.querySelectorAll(".who");
    for (var i = 0; i < bs.length; i++) {
      bs[i].onclick = function () {
        var id = this.getAttribute("data-id"), at = whoState.picks.indexOf(id);
        if (at === -1) { whoState.picks.push(id); } else { whoState.picks.splice(at, 1); }
        this.setAttribute("aria-pressed", whoState.picks.indexOf(id) !== -1);
        sync();
      };
    }
    sync();
  }

  function timerHtml(small) {
    return '<div class="timer grow"><div class="numeral' + (small ? " numeral--80" : "") + '" id="bigtime">00</div><div class="label">Seconds left</div></div>';
  }

  function viewTurn(s) {
    var T = s.turn, isW = T.playerId === s.me, who = pname(s, T.playerId);

    // 1. Whistler choosing one of three songs
    if (T.stage === "choose" && isW && !T.difficulty) {
      var offs = (T.options || []).map(function (o, i) {
        var bonus = Math.round((o.multiplier - 1) * 100);
        return '<button class="action opt" data-i="' + i + '" data-d="' + o.difficulty + '" style="min-height:88px"><span class="action__top"><span class="label">' + esc(cap(o.difficulty)) + "</span>" +
          '<span class="small">' + (bonus ? "+" + bonus + " per cent points" : "Standard points") + "</span></span>" +
          '<span class="stack" style="gap:2px"><span class="title">' + esc(o.title) + '</span><span class="small">' + esc(o.artist) + "</span></span></button>";
      }).join("");
      return {
        key: "choose-" + T.id, field: "ground",
        html: '<div class="screen">' + topBar(s) +
          '<div class="head"><h1 class="headline">Pick a song</h1>' +
          '<p class="small">Harder songs earn bonus points. Only you can see these! The 3, 2, 1 starts as soon as you pick.</p></div>' +
          '<div class="stack">' + offs + "</div>" +
          (T.canRefresh ? '<button id="refreshBtn" class="btn btn--outline">Refresh options (' + (T.refreshesLeft || 0) + ' left)</button>' +
            '<p class="small center">Don\'t know any of these? You can refresh up to 3 times.</p>' : "") +
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

    // 2. Whistler has picked and is getting ready
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
        key: "wait-" + T.id, field: "ground",
        html: '<div class="screen">' + topBar(s) +
          '<div class="mid"><h1 class="headline">' + esc(who) + (T.difficulty ? " is getting ready" : " is choosing a song") + "</h1>" +
          '<p class="small">' + (T.difficulty ? "The 3, 2, 1 starts as soon as they tap Ready. No performing till it ends!" : "Get ready to guess! Shout the title or type it.") + "</p>" +
          '<div class="micline" data-mic></div></div>' + skipHtml(s) + "</div>",
        bind: bindSkip
      };
    }

    // 4. Countdown for everyone. The whistler sees the song they picked.
    if (T.stage === "countdown") {
      return {
        key: "cd-" + T.id, field: "green",
        html: '<div class="screen">' + topBar(s) +
          (isW && T.song ? songBlock(T, "Your song to perform") : "") +
          '<div class="cdwrap"><div class="cdcircle"><div class="numeral" id="cd">3</div></div></div>' +
          '<h1 class="headline center">' + (isW ? "Perform when it ends" : "Get ready to guess " + esc(who)) + "</h1>" +
          skipHtml(s) + "</div>",
        bind: bindSkip
      };
    }

    // 5. Whistling or confirming, whistler's phone
    if ((T.stage === "whistling" || T.stage === "confirming") && isW) {
      return {
        key: "w-" + T.id, field: "time",
        html: '<div class="screen">' + topBar(s) + songBlock({ song: T.song, multiplier: T.multiplier }, "Your song to perform").replace("</p></div>", '</p><p class="hintline" id="hintLine" hidden></p></div>') +
          timerHtml(false) +
          '<div class="actions2">' + actionHtml("shuffleBtn", "Song", "", "Shuffle", T.penalty + " point penalty") +
          actionHtml("hintBtn", (T.hints || 0) + " of 3", "", "Give hint", hintCostText(T)) + "</div>" +
          '<button id="gotBtn" class="btn gotbtn">Someone got it</button>' + skipHtml(s) +
          '<div class="ovl" id="confirm" hidden><div class="scrim"></div><div class="sheet"><span class="label">Who got it first?</span>' +
          '<p class="small" id="confSub"></p><div class="whogrid" id="whoGrid"></div>' +
          '<button id="yesBtn" class="btn" disabled>Confirm</button><button id="noBtn" class="txt" style="align-self:center">Not yet, keep going</button></div></div></div>',
        bind: function () {
          $("#shuffleBtn").onclick = function () { send({ t: "shuffle" }); };
          $("#hintBtn").onclick = function () { send({ t: "hint" }); };
          $("#gotBtn").onclick = function () { send({ t: "gotIt" }); };
          $("#yesBtn").onclick = function () { if (whoState.picks.length) { send({ t: "confirm", ok: true, who: whoState.picks.slice() }); } };
          $("#noBtn").onclick = function () { send({ t: "confirm", ok: false }); };
          bindSkip();
        },
        update: function () {
          var t = st.turn, conf = t.stage === "confirming" && t.pending;
          $("#songTitle").textContent = t.song ? t.song.title : "";
          $("#songArtist").textContent = t.song ? t.song.artist : "";
          $("#confirm").hidden = !conf;
          if (conf) { buildWho(t); } else { whoState.built = null; }
          showHints(t);
          syncWhistlerActions(t);
        }
      };
    }

    // 6. Whistling or confirming, guesser's phone
    if (T.stage === "whistling" || T.stage === "confirming") {
      return {
        key: "g-" + T.id + (mic.typeMode ? "-t" : "-m"), field: "time",
        html: '<div class="screen">' + topBar(s) + timerHtml(mic.typeMode) +
          '<div class="hstack" id="hintBox" hidden></div>' +
          actionHtml("askHintBtn", "No hints yet", "Ask", "Ask for a hint", "Nudges the performer") +
          (mic.typeMode
            ? '<div class="typebox"><form id="gform" class="typebox">' +
              '<input id="ginput" class="input" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Type the song title">' +
              '<button class="btn" type="submit">Send guess</button></form>' +
              (SR ? '<button id="toMic" class="txt" style="align-self:center">Use the mic</button>' : "") + "</div>"
            : '<div class="micwrap mid"><button class="orb off" id="orb" aria-label="Turn on mic"></button>' +
              '<p class="title" id="listenHead">Mic is off, tap to turn on</p>' +
              '<button id="toType" class="txt">Type instead</button></div>') +
          skipHtml(s) +
          '<div class="checking" id="checking" hidden><h2 class="headline pulse">Checking</h2>' +
          '<p class="small">Someone might\'ve got it! Waiting for the performer to confirm.</p></div></div>',
        bind: function () {
          if (mic.turnSeen !== st.turn.id) { mic.turnSeen = st.turn.id; mic.base = mic.total || 0; mic.heard = ""; }
          var f = $("#gform");
          if (f) {
            f.onsubmit = function (e) {
              e.preventDefault();
              var v = $("#ginput").value.trim();
              if (v && st && st.turn && st.turn.stage === "whistling") { send({ t: "guess", alts: [v], typed: true }); }
              $("#ginput").value = "";
              return false;
            };
          }
          var ah = $("#askHintBtn"); if (ah) { ah.onclick = function () { send({ t: "askHint" }); }; }
          var tt = $("#toType"); if (tt) { tt.onclick = function () { mic.typeMode = true; render(); }; }
          var tm = $("#toMic"); if (tm) { tm.onclick = function () { mic.typeMode = false; render(); }; }
          bindSkip();
        },
        update: function () {
          $("#checking").hidden = st.turn.stage !== "confirming";
          showHints(st.turn);
          if (mic.turnSeen !== st.turn.id) { mic.turnSeen = st.turn.id; mic.base = mic.total || 0; mic.heard = ""; }
          syncAskBtn(st.turn);
        }
      };
    }

    // 7. Reveal: the score is counted up on screen, see revealFrame()
    var R = T.result, head, sub = "";
    var gAwards = (R.awards || []).filter(function (x) { return x.role === "guesser"; });
    var guessers = gAwards.map(function (x) { return pname(s, x.id); });
    var correct = R.outcome === "correct";
    if (correct) {
      head = esc(who) + " scores";
      sub = guessers.length ? guessers.map(esc).join(", ").replace(/, ([^,]*)$/, " and $1") + (guessers.length > 1 ? " named it and earn " + pts(gAwards[0].points) + " each" : " named it and earns " + pts(gAwards[0].points)) : "";
    } else if (R.outcome === "timeout") {
      head = "Time's up";
      sub = "Nobody guessed " + esc(who) + "'s song, so no points. Ouch.";
    } else {
      head = "Turn skipped";
      sub = esc(who) + " scores nothing.";
    }
    var last = s.turnNumber >= s.totalTurns;
    var big = Math.max(R.base || 0, R.afterMult || 0, R.score || 0) >= 1000;
    var lim = window.innerHeight >= 880 ? 5 : window.innerHeight >= 780 ? 4 : 3;
    return {
      key: "reveal-" + T.id + "-" + s.totalTurns, field: correct ? "blue" : "ground",
      html: '<div class="screen">' + topBar(s) +
        '<div class="revealtop">' + (R.song ? '<span class="label">The song was</span><h1 class="headline">' + esc(R.song.title) + '</h1><p class="title">' + esc(R.song.artist) + "</p>" : "") + "</div>" +
        '<div class="scorebox"><div class="scorerow"><div class="numeral scoreNum' + (big ? " numeral--120" : "") + '" id="scoreNum">0</div></div>' +
          '<div class="rowc" style="justify-content:flex-start;gap:8px"><span class="label" id="scoreCap">Guessed in</span><span class="tag stamp" id="multBadge" hidden></span><span class="tag stamp" id="deltaTag" hidden></span></div>' +
          '<div class="stack" style="gap:2px"><h2 class="title">' + head + "</h2>" + (sub ? '<p class="small">' + sub + "</p>" : "") + "</div></div>" +
        (T.roundEnd
          ? '<div class="board rvhide" id="board">' + standingsHtml(s, R.awards, null, { change: true, limit: lim }) + "</div>"
          : (T.nextId ? '<div class="stack rvhide" id="board"><span class="label">Up next</span><p class="title pn">' + avatarHtml(s, player(s, T.nextId) || { name: "?" }) + esc(T.nextId === s.me ? "You" : pname(s, T.nextId)) + "</p></div>" : "")) +
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
      var fin0 = 1200;
      return { num: 0, cap: el >= fin0 ? "No points" : "Counting up", final: el >= fin0, finalAt: fin0 };
    }
    var rawS = Math.max(0, R.timeMs / 1000 - R.lockedS), cur = 2400, run = R.base;
    // Order: base score, then the song multiplier, then shuffles, then hints, then the big reveal.
    var segs = [{ from: 0, to: R.base, at: 0, len: 1600, cap: "Guessed in " + rawS.toFixed(1) + "s" }];
    if (R.multiplier && R.multiplier !== 1) {
      segs.push({ from: run, to: R.afterMult, at: cur + 500, len: 1400, cap: cap(R.difficulty || "") + " song", badge: "x" + R.multiplier + " " + (R.difficulty || "").toUpperCase(), badgeAt: cur });
      run = R.afterMult; cur += 2300;
    }
    if (R.shuffles) {
      var sp = Math.min(run, R.shufflePts);
      segs.push({ from: run, to: run - sp, at: cur, len: 900, cap: R.shuffles === 1 ? "Shuffle" : R.shuffles + " shuffles", delta: "-" + R.shufflePts });
      run -= sp; cur += 1700;
    }
    if (R.hints) {
      var hp = Math.min(run, R.hintPts);
      segs.push({ from: run, to: run - hp, at: cur, len: 900, cap: R.hints === 1 ? "Hint" : R.hints + " hints", delta: "-" + R.hintPts });
      run -= hp; cur += 1700;
    }
    var finalAt = Math.max(cur + 1400, 4500);
    if (el >= finalAt) { return { num: R.score, cap: "Final score", final: true, finalAt: finalAt }; }
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

  // End-of-game awards: shown one at a time, then the final scores.
  var awardState = { key: null, idx: 0, done: false, timer: null };
  var AWARD_HUES = ["green", "yellow", "orange", "pink", "blue"];

  function awardsKey(s) { return s.code + "|" + (s.endAwards || []).map(function (d) { return d.key + d.winners.map(function (w) { return w.id; }).join(","); }).join(";"); }

  function awardAdvance(s) {
    clearTimeout(awardState.timer);
    if (awardState.idx + 1 >= (s.endAwards || []).length) { awardState.done = true; } else { awardState.idx++; }
    render();
  }

  function awardCardHtml(s) {
    var d = s.endAwards[awardState.idx];
    var names = d.winners.map(function (w) { return esc(pname(s, w.id)); });
    var who = names.length > 1 ? names.slice(0, -1).join(", ") + " and " + names[names.length - 1] : names[0];
    var got = d.winners[0].bonus;
    var detail = d.winners.length === 1 ? esc(d.winners[0].detail) : "Shared award";
    var dots = s.endAwards.map(function (_, i) { return '<i class="adot' + (i === awardState.idx ? " on" : "") + '"></i>'; }).join("");
    var hue = AWARD_HUES[awardState.idx % AWARD_HUES.length];
    return '<div class="awardcard awardcard--' + hue + '"><span class="label">' + esc(d.title) + '</span><h1 class="display" style="font-size:' + (who.length > 12 ? 40 : 56) + 'px;line-height:1.0">' + who + "</h1>" +
      '<p class="title">' + detail + "</p>" +
      (got > 0 ? '<div class="numeral numeral--80 awardcard__p">+' + pts(got) + '</div><p class="label">' + (d.winners.length > 1 ? "Points each" : "Bonus points") + "</p>"
               : '<p class="title awardcard__p">Bonus held back so the leader stays the leader</p>') + "</div>" +
      '<div class="adots">' + dots + "</div>";
  }

  function viewAwards(s) {
    return {
      key: "awards-" + awardState.idx, field: "ground",
      html: '<div class="screen" id="awardScreen">' +
        '<div class="label">Game awards</div>' + awardCardHtml(s) +
        '<button id="awardNext" class="btn">' + (awardState.idx + 1 >= s.endAwards.length ? "See final scores" : "Next award") + "</button>" +
        '<button id="awardSkip" class="txt" style="align-self:center">Skip</button></div>',
      bind: function () {
        clearTimeout(awardState.timer);
        var left = 5, nb = $("#awardNext"), base = nb.textContent;
        var tickA = function () {
          if (left <= 0) { awardAdvance(st); return; }
          nb.textContent = base + " (" + left + ")"; left--;
          awardState.timer = setTimeout(tickA, 1000);
        };
        tickA();
        nb.onclick = function () { awardAdvance(st); };
        $("#awardSkip").onclick = function () { clearTimeout(awardState.timer); awardState.done = true; render(); };
      }
    };
  }

  function viewOver(s) {
    var k = awardsKey(s);
    if (awardState.key !== k) { awardState.key = k; awardState.idx = 0; awardState.done = false; }
    if (s.endAwards && s.endAwards.length && !awardState.done) { return viewAwards(s); }
    clearTimeout(awardState.timer);
    var isHost = s.hostId === s.me;
    var bonuses = s.players.filter(function (p) { return p.bonus > 0; }).map(function (p) { return { id: p.id, points: p.bonus }; });
    var names = (s.winners || []).map(function (id) { return pname(s, id); });
    var bests = recordGame(s), mine = readStats()[pname(s, s.me).toLowerCase()];
    var myStatsHtml = s.myGame && mine ? '<div class="stack"><div class="label">Your lifetime stats</div>' +
      (bests.length ? '<p class="title">New best: ' + esc(bests.join(", ")) + "</p>" : "") +
      '<button id="myStatsBtn" class="txt" style="align-self:flex-start;padding-left:0">See your stats</button></div>' : "";
    var head = names.length > 1 ? "It's a draw: " + names.map(esc).join(" and ") : esc(names[0] || "Nobody") + " wins";
    return {
      key: "over", field: "blue",
      html: '<div class="screen">' +
        '<div class="label">Game over</div>' +
        '<div class="head"><h1 class="display">' + head + "</h1>" +
        (s.tieBreakWon ? '<p class="small">Settled in a tie-break.</p>' : "") + "</div>" +
        '<div class="stack"><div class="label">Final scores</div>' + standingsHtml(s, bonuses, s.winners, { bonus: true }) + "</div>" +
        myStatsHtml + (bonuses.length ? '<p class="small">Bonus points from the awards are included.' + (s.bonusCapped ? " A big lead cannot be overturned by bonuses." : "") + "</p>" : "") +
        '<div class="spacer"></div>' +
        (s.endAwards && s.endAwards.length ? '<button id="awardsBtn" class="btn btn--outline">View awards</button>' : "") +
        (isHost ? '<button id="againBtn" class="btn">Play again</button>' : '<p class="title center">Waiting for ' + esc(pname(s, s.hostId)) + "</p>") +
        '<button id="leaveBtn" class="txt" style="align-self:center">Leave room</button></div>',
      bind: function () {
        var a = $("#againBtn"); if (a) { a.onclick = function () { send({ t: "playAgain" }); }; }
        $("#leaveBtn").onclick = leaveRoom;
        var ms = $("#myStatsBtn"); if (ms) { ms.onclick = function () { showStats(pname(s, s.me)); }; }
        var aw = $("#awardsBtn"); if (aw) { aw.onclick = function () { awardState.idx = 0; awardState.done = false; render(); }; }
      }
    };
  }

  // How to play: a short animated walkthrough. The words sit on the dark background; the game screens
  // sit inside a phone frame, so it is always clear which part is the instruction and which is the app.
  function showHelp() {
    var AV = function (n, k) { return '<span class="avatar pc pc' + k + ' avatar--md">' + n.charAt(0) + "</span>"; };
    var TAP = function (x, y, d) { return '<i class="hv-tap" style="left:' + x + 'px;top:' + y + 'px;animation-delay:' + d + 'ms"></i>'; };
    var scenes = [
      { ms: 5000, full: true, chip: "How to play", head: "One person performs.<br>Everyone else listens and guesses.", text: "Take turns. Guess fast, score big!", bg: FIELD_BG.orange },
      { ms: 5400, role: "w", chip: "Your turn to perform", head: "Pick a song", text: "Only you can see it. Go harder for bonus points!", bg: FIELD_BG.ground,
        mock: '<div class="m-cards">' +
          '<div class="m-card"><span>Easy</span><b>Dancing Queen</b><i>ABBA</i></div>' +
          '<div class="m-card m-pick"><span>Medium</span><b>Wonderwall</b><i>Oasis</i></div>' +
          '<div class="m-card"><span>Hard</span><b>Rolling in the Deep</b><i>Adele</i></div></div>' + TAP(300, 215, 1900) },
      { ms: 5000, role: "e", chip: "Everyone", head: "The countdown starts", text: "It kicks off the second a song's picked. No performing until it ends!", bg: FIELD_BG.green,
        mock: '<div class="m-disc"><div class="m-num" data-seq="3,2,1,Go" data-step="1000">3</div></div>' },
      { ms: 6200, role: "w", chip: "Your turn to perform", head: "Whistle or kazoo the tune", text: "Whistle it or kazoo it. No words allowed! Shuffles and hints cost points.", bg: FIELD_BG.green,
        mock: '<div><div class="m-label">Your song to perform</div><div class="m-song">Dancing Queen</div><div class="m-art">ABBA</div></div><div class="m-timer" data-timer="42">42</div>' +
          '<div class="m-two"><div class="m-mini"><span>Song</span><b>Shuffle</b></div><div class="m-mini"><span>0 of 3</span><b>Give hint</b></div></div><div class="m-btn">Someone got it</div>' },
      { ms: 6400, role: "l", chip: "Your turn to listen", head: "Say the title out loud", text: "Someone else is performing. Your phone's mic should catch your guess. If it doesn't, tap Type instead.", bg: FIELD_BG.green,
        mock: '<div class="m-orbwrap"><div class="hv-orb"><i></i><i></i><i></i><svg viewBox="0 0 48 48" aria-hidden="true"><rect x="18" y="5" width="12" height="23" rx="6"/><path d="M11 22v2a13 13 0 0 0 26 0v-2"/><path d="M24 37v6M17 43h14"/></svg></div>' +
          '<div class="m-say"><span>You say</span><b>Dancing Queen</b></div></div><div class="m-head">Listening</div><div class="m-link">Type instead</div>' },
      { ms: 5600, role: "w", chip: "Your turn to perform", head: "Say who got it", text: "Someone nailed it? Tap Someone got it, pick who got it first, then confirm.", bg: FIELD_BG.ground,
        mock: '<div class="m-rows">' +
          '<div class="m-row m-on">' + AV("Theo", 1) + '<b>Theo</b><em>Got it</em></div><div class="m-row">' + AV("Priya", 2) + '<b>Priya</b></div><div class="m-row">' + AV("Sam", 3) + '<b>Sam</b></div></div><div class="m-btn">Confirm</div>' + TAP(80, 135, 1500) },
      { ms: 5600, role: "e", chip: "Everyone sees the score", head: "Faster guesses score more", text: "The performer bags the full score. Whoever got it first gets half.", bg: FIELD_BG.blue, light: true,
        mock: '<div class="m-big" data-count="917" data-ms="1600">0</div><div class="m-label">Guessed in 12.4s</div><div class="m-sub2">Maya scores<br>Theo named it and earns 459</div>' },
      { ms: 5600, role: "e", chip: "After the last round", head: "Most points wins", text: "Awards chuck in bonus points at the end.", bg: FIELD_BG.pink,
        mock: '<div class="m-rows">' +
          '<div class="m-row m-light"><b class="m-rk">1</b>' + AV("Maya", 0) + '<b>Maya</b><em>2,140</em></div><div class="m-row m-light"><b class="m-rk">2</b>' + AV("Theo", 1) + '<b>Theo</b><em>1,820</em></div><div class="m-row m-light"><b class="m-rk">3</b>' + AV("Priya", 2) + '<b>Priya</b><em>1,310</em></div></div>' },
      { ms: 4500, full: true, chip: "Stuck?", head: "Stuck? Hit the ? icon.", text: "It lives in the corner of every screen and tells you exactly what to do.", bg: FIELD_BG.orange }
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
    if (/^choose-/.test(key)) { return ["Your turn to perform", "Pick one of the three songs. Harder ones earn bonus points! Don't know any? Refresh once for new ones. Only you can see them."]; }
    if (/^ready-/.test(key)) { return ["Get ready", "Only you can see your song. Ready? Tap Ready and a 3, 2, 1 starts for everyone. Then whistle or kazoo the tune. No words!"]; }
    if (/^wait-/.test(key)) { return ["Get ready to guess", who + " is getting ready to perform. When they start, shout the song title. Mic off? Type it instead."]; }
    if (/^cd-/.test(key)) {
      return T && T.playerId === st.me
        ? ["Countdown", "When it ends, whistle or kazoo the tune. No words! Shuffles and hints cost points."]
        : ["Countdown", "When it ends, " + who + " starts performing. Shout the title as soon as you know it, or tap Type instead."];
    }
    if (/^w-/.test(key)) { return ["You are performing", "Whistle or kazoo the tune. No words! When someone says the right title, tap Someone got it, pick who got it first, then confirm."]; }
    if (/^g-/.test(key)) { return ["You are guessing", "Listen to " + who + " and shout the song title, or tap Type instead. The faster you guess, the more you score. Stuck? Ask for a hint."]; }
    if (/^reveal-/.test(key)) { return ["Score", "The performer bags the full score and whoever got it first gets half. Next turn coming up!"]; }
    if (key === "lobby") {
      return host
        ? ["You are the host", "Send the invite link to your friends. Choose the song packs and rounds, then tap Start game once everyone's in. Keep your mic on so the game can hear guesses!"]
        : ["Waiting to start", "The host starts the game once everyone's in. If room picks is on, tap Pick song packs. Keep your mic on so the game can hear your guesses!"];
    }
    if (/^awards-/.test(key)) { return ["Awards", "These awards add bonus points to the final scores. Tap for the next one!"]; }
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
      '<button class="btn" id="hsOk">Got it</button><button class="txt" id="hsHow" style="align-self:center">Show how to play</button></div>';
    document.body.appendChild(o);
    var close = function () { if (o.parentNode) { o.parentNode.removeChild(o); } };
    $("#hsOk", o).onclick = close; $(".scrim", o).onclick = close;
    $("#hsHow", o).onclick = function () { close(); usage("howto", "sheet"); showHelp(); };
  }
  // First time in a room: ask once. A first-timer gets a short line and the how-to-play walkthrough.
  function askPlayed() {
    askedPlayed = true;
    var o = document.createElement("div");
    o.className = "sheetwrap";
    o.innerHTML = '<div class="scrim"></div><div class="sheet" id="apSheet"><p class="headline">Have you played before?</p>' +
      '<div class="rowc" style="gap:12px"><button class="btn btn--outline" id="pYes" style="flex:1">Yes</button><button class="btn" id="pNo" style="flex:1">No</button></div></div>';
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
  // The ? button sits in the corner of every in-game screen.
  function refreshTip() {
    var old = document.getElementById("helpfab");
    if (!st || st.admin) { if (old) { old.parentNode.removeChild(old); } var sf = document.getElementById("sfxfab"); if (sf) { sf.parentNode.removeChild(sf); } return; }
    if (newbie === null && !askedPlayed) { askPlayed(); }
    if (!document.getElementById("sfxfab")) {
      var sb = document.createElement("button");
      sb.id = "sfxfab"; sb.className = "helpfab"; sb.innerHTML = sfxIcon(); sb.setAttribute("aria-pressed", String(sfxOn));
      sb.setAttribute("aria-label", sfxOn ? "Sound and buzz on, tap to mute" : "Muted, tap to turn sound and buzz on");
      sb.onclick = function () { setSfx(!sfxOn); };
      document.body.appendChild(sb);
    }
    if (!old) {
      var b = document.createElement("button");
      b.id = "helpfab"; b.className = "helpfab"; b.setAttribute("aria-label", "Help: what should I do now?"); b.textContent = "?";
      b.onclick = showHelpSheet;
      document.body.appendChild(b);
    }
  }

  // ---------------------------------------------------------------- render
  function elapsedMs(T) {
    var base = T.accumulatedMs + (T.runningSince !== null ? nowS() - T.runningSince : 0);
    return Math.max(0, Math.min(base, T.limitMs));
  }
  // Time sets the field: green over half the time left, yellow to 20 percent, then orange.
  function timeField(T) {
    var frac = (T.limitMs - elapsedMs(T)) / T.limitMs;
    return frac > 0.5 ? "green" : frac > 0.2 ? "yellow" : "orange";
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
    var b = document.getElementById("sfxfab"); if (b) { b.innerHTML = sfxIcon(); b.setAttribute("aria-pressed", String(on)); b.setAttribute("aria-label", on ? "Sound and buzz on, tap to mute" : "Muted, tap to turn sound and buzz on"); }
    usage(on ? "unmute" : "mute");
    if (on) { sfx("pop"); buzz(30); }
  }
  function sfxIcon() {
    return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z"/>' +
      (sfxOn ? '<path d="M16.5 8.5a5 5 0 0 1 0 7"/><path d="M19 6a8.5 8.5 0 0 1 0 12"/>' : '<path d="M17 9l5 6M22 9l-5 6"/>') + "</svg>";
  }
  // Sounds that follow state changes. They run before the screen is redrawn.
  var sfxTimers = [], sfxTurn = null, drumTurn = null, slamTurn = null;
  function clearSfxTimers() { sfxTimers.forEach(clearTimeout); sfxTimers = []; }
  function audioEvents(prev, cur) {
    if (!cur) { return; }
    var T = cur.turn, P = prev && prev.turn;
    if (cur.phase === "lobby" && prev && prev.phase === "lobby" && cur.players.length > prev.players.length) { sfx("pop"); buzz(25); }
    if (cur.phase === "gameover" && (!prev || prev.phase !== "gameover")) { sfx("fanfare"); buzz([60, 40, 60, 40, 140]); }
    if (!T) { return; }
    var same = P && P.id === T.id;
    if (T.stage === "countdown" && !(same && P.stage === "countdown")) {
      clearSfxTimers();
      var end = T.countdownEndsAt;
      [3, 2, 1].forEach(function (k) {
        var d = end - k * 1000 - nowS();
        if (d > -150) { sfxTimers.push(setTimeout(function () { sfx("tick"); buzz(25); }, Math.max(0, d))); }
      });
      var gd = end - nowS();
      if (gd > -150) { sfxTimers.push(setTimeout(function () { sfx("go"); buzz(T.playerId === cur.me ? [70, 40, 120] : 50); }, Math.max(0, gd))); }
    }
    if (same && T.stage !== "countdown" && P.stage === "countdown") { /* the go cue is already scheduled */ }
    if (T.stage === "confirming" && !(same && P.stage === "confirming") && T.playerId === cur.me) { sfx("ping"); buzz([50, 40, 50]); }
    if (same && (T.hints || 0) > (P.hints || 0)) { sfx("hint"); buzz(40); }
    if (same && T.shuffles !== undefined && P.shuffles !== undefined && T.shuffles > P.shuffles) { sfx("shuffle"); buzz(30); }
  }

  // ---- Turn splash: a full-screen "it's show time" card, about three seconds, before each player's turn.
  var SPLASH_LINES = [
    "{n}, it's show time!", "{n}, you're up!", "{n}, it's your turn!", "{n}, your time to shine!",
    "{n}, the floor is yours!", "{n}, take centre stage!", "{n}, take it away!", "{n}, over to you!",
    "{n}, the room is ready!", "{n}, give us a tune!", "{n}, let's hear it!", "{n}, the stage is set!",
    "You've got this, {n}!", "Break a leg, {n}!", "All eyes on {n}!"
  ];
  var SPLASH_HUES = [["#FF4B14", "#111"], ["#FF4FA3", "#111"], ["#00B86B", "#111"], ["#FFD21F", "#111"], ["#2640EC", "#ECEAE4"]];
  var SPLASH_MS = 4000, lastSplashTurn = null, lastSplashLine = -1, lastSplashHue = -1, splashTimer = null;
  function pickDifferent(n, last) { var i; do { i = Math.floor(Math.random() * n); } while (n > 1 && i === last); return i; }
  var splashSfx = [];
  function showSplash(name, avatar, mine) {
    var old = document.getElementById("splash"); if (old) { old.remove(); }
    clearTimeout(splashTimer); splashSfx.forEach(clearTimeout); splashSfx = [];
    sfx(mine ? "turn" : "next"); buzz(mine ? [80, 50, 80, 50, 140] : 30);
    [1000, 2000, 3000].forEach(function (d) { splashSfx.push(setTimeout(function () { sfx("tick"); buzz(20); }, d)); });
    var li = lastSplashLine = pickDifferent(SPLASH_LINES.length, lastSplashLine);
    var hi = lastSplashHue = pickDifferent(SPLASH_HUES.length, lastSplashHue);
    var text = esc(SPLASH_LINES[li]).replace(/\{n\}([,!]?)/, function (m, pu) { return '<span class="sp-n">' + esc(name) + pu + "</span>"; });
    var el = document.createElement("div");
    el.id = "splash"; el.setAttribute("role", "status");
    el.style.background = SPLASH_HUES[hi][0]; el.style.color = SPLASH_HUES[hi][1];
    el.style.setProperty("--sp-ms", SPLASH_MS + "ms");
    el.innerHTML = '<div class="sp-av">' + avatar + '</div><h1 class="sp-tx' + (name.length > 10 ? " sp-long" : "") + '">' + text + '</h1><div class="sp-count" aria-hidden="true"><span>3</span><span>2</span><span>1</span></div>';
    document.body.appendChild(el);
    var done = function () { clearTimeout(splashTimer); if (el.parentNode) { el.remove(); } };
    splashTimer = setTimeout(done, SPLASH_MS);
  }
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
    el.innerHTML = '<h1 class="iv-title">' + esc(IV_TITLES[sd % IV_TITLES.length]) + '</h1><div class="iv-rows">' + rows + '</div><p class="small iv-skip">Tap to skip</p>';
    document.body.appendChild(el);
    sfx("drum"); buzz(40); ivSfx.forEach(clearTimeout); ivSfx = [setTimeout(function () { sfx("crash"); buzz([60, 30, 100]); }, 1250)];
    for (var q = 1; q < i; q++) { (function (d) { ivSfx.push(setTimeout(function () { sfx("pop"); }, d)); })(1400 * q + 150); }
    var done = function () { clearTimeout(ivTimer); ivSfx.forEach(clearTimeout); if (el.parentNode) { el.remove(); } maybeSplash(); };
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
  function maybeSplash() {
    if (interludeShowing()) { return; }
    if (!st || st.phase !== "turn" || !st.turn || st.turn.stage !== "choose" || st.turn.id === lastSplashTurn) { return; }
    lastSplashTurn = st.turn.id;
    var p = null; st.players.forEach(function (q) { if (q.id === st.turn.playerId) { p = q; } });
    if (p) { showSplash(p.name, avatarHtml(st, p, "sp-avatar"), p.id === st.me); }
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
    refreshMic();
    refreshTop();
    refreshAdmin();
    syncBg();
    refreshTip();
    lateNote();
    maybeInterlude();
    maybeSplash();
  }

  // Keep the page behind the app (overscroll, notch) the same colour as the current field.
  var lastBg = "";
  var FIELD_BG = { ground: "#E4E2DD", pink: "#FF4FA3", green: "#00B86B", yellow: "#FFD21F", orange: "#FF4B14", blue: "#2640EC" };
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
  function tick() {
    requestAnimationFrame(tick);
    var T = st && st.turn;
    if (!T) { return; }
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
        var txt = String(Math.round(fr.num)); if (sn.textContent !== txt) { sn.textContent = txt; }
        var cp = $("#scoreCap"); if (cp && cp.textContent !== fr.cap) { cp.textContent = fr.cap; }
        var mb = $("#multBadge"), dt = $("#deltaTag");
        if (mb) { mb.hidden = !fr.badge || fr.final; if (fr.badge && mb.textContent !== fr.badge) { mb.textContent = fr.badge; } }
        if (dt) { dt.hidden = !fr.delta || fr.final; if (fr.delta && dt.textContent !== fr.delta) { dt.textContent = fr.delta; } }
        sn.classList.toggle("big", !!fr.final);
        if (fr.drum && drumTurn !== T.id && R.outcome === "correct") { drumTurn = T.id; sfx("drum"); }
        if (fr.final && !sn.classList.contains("slam")) { sn.classList.add("slam"); buzz(R.score > 0 ? [60, 40, 90] : 40); if (slamTurn !== T.id) { slamTurn = T.id; if (R.outcome === "correct") { sfx("win"); } else if (R.outcome !== "skipped") { sfx("fail"); } } }
        var late = ms >= fr.finalAt + 300;
        var bd = $("#board");
        if (bd) { bd.classList.toggle("rvhide", !late); }
      }
      var ni = $("#nextIn");
      if (ni) {
        var rem = T.nextAt ? T.nextAt - nowS() : null, last = st.turnNumber >= st.totalTurns;
        var nt = rem !== null && rem <= 5000 ? (last ? "Final scores in " : T.roundEnd ? "Next round in " : "Next turn in ") + Math.max(1, Math.ceil(rem / 1000)) : "";
        if (ni.textContent !== nt) { ni.textContent = nt; }
      }
    }
    if (T.stage === "whistling" || T.stage === "confirming") {
      var el = elapsedMs(T), remain = T.limitMs - el;
      var big = $("#bigtime");
      if (big) { var tt = pad2(Math.ceil(remain / 1000)); if (big.textContent !== tt) { big.textContent = tt; } }
      var cls = "field field--" + timeField(T);
      if (app.className !== cls) { app.className = cls; syncBg(); }
      if (remain <= 10000 && T.stage === "whistling") {
        var sec = Math.ceil(remain / 1000);
        if (sec !== lastSecond) { lastSecond = sec; buzz(40); }
      } else { lastSecond = null; }
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
