(function () {
  "use strict";

  var app = document.getElementById("app");
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  var ws = null, connected = false, session = null, rejoining = false, pendingName = "";
  var gameList = [], adminLogin = false, pickerOpen = false, pickerTab = "All", keepPickerScroll = true;
  var lastMicSent = "";
  var st = null, offset = 0, lastKey = null, wakeLock = null, prevStage = null, prevTurnId = null;

  try { session = JSON.parse(localStorage.getItem("whistle.session") || "null"); } catch (e) { session = null; }

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
      send({ t: "listRooms" });
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
      setBanner("Reconnecting...");
      setTimeout(connect, 1500);
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  function onMessage(m) {
    if (m.t === "state") {
      st = m.state;
      offset = st.serverNow - Date.now();
      var T = st.turn;
      if (T && T.stage === "whistling" && (prevStage !== "whistling" || prevTurnId !== T.id)) { mic.lastSent = ""; }
      prevStage = T ? T.stage : null; prevTurnId = T ? T.id : null;
      render();
    } else if (m.t === "rooms") {
      gameList = m.rooms || [];
      if (!st && !adminLogin && lastKey === "home") { var v = viewHome(); if (v.update) { v.update(); } }
    } else if (m.t === "joined") {
      session = { code: m.code, playerId: m.playerId, name: pendingName || (session && session.name) || "" };
      saveSession(); rejoining = false; keepAwake(); adminLogin = false; lastMicSent = "";
    } else if (m.t === "error") {
      if (rejoining && (m.code === "room_not_found" || m.code === "game_started")) {
        session = null; saveSession(); st = null; rejoining = false; lastKey = null;
        toast("That game has ended."); render();
      } else {
        toast(m.message || "Something went wrong.");
      }
    } else if (m.t === "guessFeedback") {
      toast("Not it. Try again.");
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

  function micLaunch() {
    var rec = new SR();
    rec.lang = "en-GB"; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 3;
    mic.rec = rec; mic.state = "starting";
    var startTimer = setTimeout(function () {
      if (mic.rec === rec && mic.state === "starting") { mic.state = "stopped"; refreshMic(); }
    }, 3500);
    rec.onsoundstart = rec.onspeechstart = function () { mic.level = Math.max(mic.level, 0.7); };
    rec.onstart = function () { clearTimeout(startTimer); if (mic.rec === rec) { mic.state = "on"; refreshMic(); } };
    rec.onresult = function (e) {
      var text = "", i, k;
      for (i = 0; i < e.results.length; i++) { text += e.results[i][0].transcript + " "; }
      mic.level = 1;
      mic.heard = text.replace(/\s+/g, " ").trim().slice(-90);
      var h = $("#heard"); if (h) { h.textContent = mic.heard ? "Heard: " + mic.heard : ""; }
      if (!isGuessing()) { return; }
      for (i = e.resultIndex; i < e.results.length; i++) {
        var alts = [];
        for (k = 0; k < e.results[i].length; k++) { alts.push(e.results[i][k].transcript); }
        var key = alts.join("|");
        if (key === mic.lastSent) { continue; }
        mic.lastSent = key;
        send({ t: "guess", alts: alts, typed: false });
      }
    };
    rec.onerror = function (e) {
      if (e.error === "not-allowed" || e.error === "service-not-allowed" || e.error === "audio-capture") {
        mic.want = false; mic.state = "blocked"; refreshMic();
      }
    };
    rec.onend = function () {
      clearTimeout(startTimer);
      if (mic.want && mic.rec === rec) {
        mic.state = "starting"; refreshMic();
        setTimeout(function () {
          if (mic.want && mic.rec === rec) {
            try { micLaunch(); } catch (err) { mic.state = "stopped"; refreshMic(); }
          }
        }, 250);
      }
    };
    try { rec.start(); } catch (err) { mic.state = "stopped"; refreshMic(); }
  }

  function ico(n, c) { return '<svg class="wh-i' + (c ? " " + c : "") + '" aria-hidden="true"><use href="#i-' + n + '"/></svg>'; }
  function cap(s) { s = String(s); return s.charAt(0).toUpperCase() + s.slice(1); }

  function micHtml() {
    switch (mic.state) {
      case "unsupported":
        return '<span class="wh-chip wh-chip--static">Typing only on this phone</span>';
      case "off":
        return '<button id="micBtn" class="wh-btn wh-btn--secondary wh-btn--block">' + ico("mic") + 'Turn on mic</button><p class="wh-note">Lets this phone hear guesses. You can also type them.</p>';
      case "starting":
        return '<span class="wh-chip wh-chip--static">Starting mic...</span>';
      case "on":
        return '<span class="wh-chip wh-chip--static"><i style="--c:var(--success)"></i>Mic on</span>';
      case "blocked":
        return '<span class="wh-chip wh-chip--static"><i style="--c:var(--danger)"></i>Mic blocked</span><p class="wh-note">Allow the microphone for this site in your browser settings, then reload. You can still type guesses.</p>';
      default:
        return '<button id="micBtn" class="wh-btn wh-btn--secondary wh-btn--block">' + ico("mic") + 'Mic stopped, tap to restart</button>';
    }
  }

  function refreshMic() {
    var boxes = document.querySelectorAll("[data-mic]");
    for (var i = 0; i < boxes.length; i++) {
      var quiet = boxes[i].getAttribute("data-mic") === "quiet";
      boxes[i].innerHTML = quiet && mic.state === "on" ? "" : micHtml();
      var b = $("#micBtn", boxes[i]);
      if (b) { b.onclick = micStart; }
    }
    var ms = mic.typeMode || mic.state === "unsupported" ? "typing" : (mic.state === "on" ? "on" : "off");
    if (st && !st.admin && ms !== lastMicSent) { lastMicSent = ms; send({ t: "mic", state: ms }); }
    var orb = $("#orb");
    if (orb) {
      orb.onclick = function () { if (SR && mic.state !== "on" && mic.state !== "starting") { micStart(); } };
      var off = mic.state !== "on";
      orb.classList.toggle("off", off);
      orb.classList.toggle("wh-orb--off", off);
      orb.classList.toggle("wh-orb--live", !off);
      orb.innerHTML = '<span class="wh-orb__core">' + ico(off ? "mic-off" : "mic") + "</span>";
    }
    var hd = $("#listenHead");
    if (hd) { hd.textContent = mic.state === "on" ? "Listening" : mic.state === "blocked" ? "Mic blocked" : mic.state === "starting" ? "Starting mic..." : "Tap the circle to turn on your mic"; }
  }

  // ----------------------------------------------------------------- views
  var PACK_ART = {
    bangers: "bangers", sixties: "60s", seventies: "70s", eighties: "80s", nineties: "90s", noughties: "00s", tens: "10s",
    today: "fresh", rock: "air-guitar", party: "floor-fillers", soul: "motown", tv: "telly", film: "popcorn", disney: "ever-after",
    halloween: "spooky", xmas: "christmas", beatles: "beatles", bowie: "bowie", gaga: "gaga", talkingheads: "heads"
  };
  function packArt(id, cls) {
    return '<svg class="' + (cls || "") + '" viewBox="0 0 120 120" aria-hidden="true"><use href="#p-' + (PACK_ART[id] || "bangers") + '"/></svg>';
  }
  var SHAPE = {
    easy: '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#15131C"/></svg>',
    medium: '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3" fill="#15131C"/></svg>',
    hard: '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><path d="M12 3L21.5 20H2.5Z" fill="#15131C" stroke="#15131C" stroke-width="2" stroke-linejoin="round"/></svg>'
  };
  var DIFF_FIELD = { easy: "leaf", medium: "sun", hard: "tomato" };

  function avatarHtml(s, p, cls) {
    var i = Math.max(0, s.players.indexOf(p));
    var ch = (String(p.name).trim().charAt(0) || "?").toUpperCase();
    return '<span class="wh-avatar' + (cls ? " " + cls : "") + '" style="--c:var(--player-' + (i % 8 + 1) + ')">' + esc(ch) + "</span>";
  }

  function pts(n) { return Math.round(n).toLocaleString("en-GB"); }

  function standingsHtml(s, awards, winners) {
    var gained = {};
    (awards || []).forEach(function (a) { gained[a.id] = a.points; });
    var list = s.players.slice().sort(function (a, b) { return b.total - a.total; });
    var rank = 0, prev = null, html = "";
    list.forEach(function (p, i) {
      if (prev === null || p.total !== prev) { rank = i + 1; }
      prev = p.total;
      var me = p.id === s.me, win = winners && winners.indexOf(p.id) !== -1;
      var last = gained[p.id] !== undefined && gained[p.id] > 0 ? "<small>+" + pts(gained[p.id]) + "</small>" : "";
      html += '<div class="wh-prow' + (me ? " wh-prow--you" : "") + (win ? " win" : "") + '">' +
        '<span class="wh-rank' + (rank === 1 ? " wh-rank--1" : "") + '">' + rank + "</span>" + avatarHtml(s, p, "wh-avatar--sm") +
        '<span class="wh-prow__name">' + esc(p.name) +
          (win ? '<span class="wh-tag wh-tag--host">' + ico("trophy") + "Winner</span>" : "") +
          (me ? '<span class="wh-tag wh-tag--you">You</span>' : "") + "</span>" +
        '<span class="wh-time">' + pts(p.total) + last + "</span></div>";
    });
    return '<div class="wh-list board">' + html + "</div>";
  }

  function gamesHtml() {
    if (!gameList.length) {
      return '<div class="wh-empty"><h3>No games open yet</h3><p>Ask someone to host one, then it will show up here.</p></div>';
    }
    return gameList.map(function (g) {
      return '<button class="wh-game gamebtn" data-code="' + esc(g.code) + '"><span class="gtxt"><p class="wh-game__t">' + esc(g.host) + "'s game</p>" +
        '<p class="wh-game__s">' + g.players + (g.players === 1 ? " player" : " players") + (g.inProgress ? ", in progress" : ", waiting to start") + "</p></span>" +
        '<span class="wh-tag wh-tag--host">Join</span></button>';
    }).join("");
  }

  function blob(css) { return '<span class="wh-blob" style="' + css + '"></span>'; }

  function viewHome() {
    var name = ""; try { name = localStorage.getItem("whistle.name") || ""; } catch (e) {}
    function nameVal() {
      var n = $("#name").value.replace(/\s+/g, " ").trim();
      if (!n) { toast("Enter your name first."); $("#name").focus(); return ""; }
      try { localStorage.setItem("whistle.name", n); } catch (e) {}
      pendingName = n;
      return n;
    }
    return {
      key: "home", field: "sun",
      html:
        '<div class="screen">' +
          blob("width:170px;height:170px;right:-70px;top:-60px;background:var(--tomato)") +
          blob("width:130px;height:130px;left:-60px;bottom:70px;background:var(--cobalt)") +
          '<div class="brand"><h1 class="wh-title">Whistle</h1>' +
          '<p class="wh-sub">Keep a straight face. Keep whistling.</p>' +
          '<p class="wh-sub intro">One person whistles a song and everyone else guesses it. The quicker the guess, the more points.</p></div>' +
          '<div class="wh-card wh-stack">' +
            '<div class="wh-fieldgroup"><label class="wh-label" for="name">Your name</label>' +
            '<input id="name" class="wh-input" maxlength="14" autocomplete="off" autocapitalize="words" placeholder="Name" value="' + esc(name) + '"><p class="wh-help">Up to 14 characters</p></div>' +
            '<button id="hostBtn" class="wh-btn wh-btn--block">Host a game</button>' +
          "</div>" +
          '<h2 class="wh-over">Join a game</h2><div class="wh-stack" id="games">' + gamesHtml() + "</div>" +
          '<div class="spacer"></div>' +
          '<div class="homefoot"><button id="helpBtn" class="wh-btn wh-btn--ghost">' + ico("info") + 'How to play</button>' +
          '<button id="adminDot" class="admindot" aria-label="Admin"></button></div>' +
        "</div>",
      update: function () {
        var g = $("#games"); if (!g) { return; }
        g.innerHTML = gamesHtml();
        var bs = g.querySelectorAll(".gamebtn");
        for (var i = 0; i < bs.length; i++) {
          bs[i].onclick = function () { var n = nameVal(); if (n) { send({ t: "join", code: this.getAttribute("data-code"), name: n }); } };
        }
      },
      bind: function () {
        $("#hostBtn").onclick = function () { var n = nameVal(); if (n) { send({ t: "create", name: n }); } };
        $("#helpBtn").onclick = showHelp;
        $("#adminDot").onclick = function () { adminLogin = true; render(); };
      }
    };
  }

  function viewAdminLogin() {
    return {
      key: "adminlogin", field: "sun",
      html:
        '<div class="screen">' +
          '<div class="brand"><h1 class="wh-title">Admin</h1>' +
          '<p class="wh-sub">Test mode. Play a whole game on your own.</p></div>' +
          '<div class="wh-card wh-stack">' +
            '<div class="wh-fieldgroup"><label class="wh-label" for="apw">Password</label>' +
            '<input id="apw" class="wh-input" type="password" autocomplete="off" placeholder="Password"></div>' +
            '<button id="aGo" class="wh-btn wh-btn--block">Enter admin mode</button>' +
          "</div>" +
          '<div class="spacer"></div>' +
          '<button id="aBack" class="wh-btn wh-btn--ghost">Back</button>' +
        "</div>",
      bind: function () {
        var go = function () { send({ t: "createAdmin", password: $("#apw").value }); };
        $("#aGo").onclick = go;
        $("#apw").onkeydown = function (e) { if (e.key === "Enter") { go(); } };
        $("#aBack").onclick = function () { adminLogin = false; render(); };
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
    var html = '<span class="wh-admin__dot"></span><span class="atag">Admin</span><div class="achips">' + a.players.map(function (p) {
      return '<button class="achip' + (p.id === a.as ? " on" : "") + '" data-id="' + esc(p.id) + '">' + esc(p.name) + "</button>";
    }).join("") + "</div>" + (a.canAdd ? '<button class="aact" id="aAdd">+ Player</button>' : "") + '<button class="aact" id="aExit">Exit</button>';
    document.body.classList.add("admin");
    if (!bar) { bar = document.createElement("div"); bar.id = "adminBar"; bar.className = "wh-admin"; document.body.appendChild(bar); adminHtmlCache = ""; }
    if (html === adminHtmlCache) { return; }
    adminHtmlCache = html; bar.innerHTML = html;
    var cs = bar.querySelectorAll(".achip");
    for (var i = 0; i < cs.length; i++) { cs[i].onclick = function () { send({ t: "adminAs", id: this.getAttribute("data-id") }); }; }
    var add = document.getElementById("aAdd"); if (add) { add.onclick = function () { send({ t: "adminAddBot" }); }; }
    document.getElementById("aExit").onclick = function () { adminHtmlCache = ""; pickerOpen = false; leaveRoom(); };
  }

  var LEN_LABEL = { 30000: "30s", 60000: "1 min", 90000: "1 min 30", 120000: "2 min" };
  function lengthHtml(s, isHost) {
    var opts = s.limitOptions || [30000, 60000, 90000, 120000];
    if (!isHost) {
      return '<div class="wh-setting"><div><div class="wh-setting__title">Round length</div><div class="wh-setting__sub">Set by the host</div></div>' +
        '<span class="wh-time" id="limitVal">' + (LEN_LABEL[s.limitMs] || s.limitMs / 1000 + "s") + "</span></div>";
    }
    return '<div class="wh-setting wh-setting--col"><div class="wh-setting__title">Round length</div><div class="wh-seg">' + opts.map(function (ms) {
      return '<button class="wh-seg__item segb' + (ms === s.limitMs ? " on" : "") + '" aria-pressed="' + (ms === s.limitMs) + '" data-ms="' + ms + '">' + LEN_LABEL[ms] + "</button>";
    }).join("") + "</div></div>";
  }

  function packCard(p, on, ro) {
    return '<button class="wh-pack pack' + (on ? " on" : "") + (ro ? " ro wh-pack--readonly" : "") + '" data-id="' + p.id + '" aria-pressed="' + on + '">' +
      '<span class="tick wh-tick" data-on="' + on + '">' + ico("tick") + "</span>" +
      '<span class="pico">' + packArt(p.id, "wh-pack__art") + "</span>" +
      '<span class="wh-pack__body"><span class="wh-pack__name pn">' + esc(p.name) + '</span>' +
      '<span class="wh-pack__desc pb">' + esc(p.blurb) + "</span></span></button>";
  }

  // The lobby shows one short line about the chosen packs. The picker opens on top.
  function packsSummaryHtml(s, isHost) {
    var on = s.packs.filter(function (p) { return s.selectedPacks.indexOf(p.id) !== -1; });
    var need = s.rounds * s.players.length + 5, short = s.songsInPlay < need;
    var line = !on.length ? "No packs picked yet"
      : on.slice(0, 2).map(function (p) { return p.name; }).join(", ") + (on.length > 2 ? " +" + (on.length - 2) + " more" : "");
    var note = !on.length ? (isHost ? "Pick at least one pack to start" : "Waiting for the host to pick packs")
      : short ? "Not enough songs for this many turns: pick more packs or lower the rounds"
      : "No song is played twice in a game.";
    var thumbs = on.slice(0, 3).map(function (p) { return packArt(p.id, "pthumb"); }).join("");
    return '<div class="wh-card wh-stack"><div class="packhead"><div class="wh-title">Song packs</div>' +
      '<button class="wh-btn wh-btn--secondary wh-btn--sm" id="openPacks">' + (isHost ? (on.length ? "Change" : "Choose packs") : "See packs") + "</button></div>" +
      '<div class="wh-packrow">' + (thumbs ? '<span class="pthumbs">' + thumbs + "</span>" : "") + '<div class="packline">' + esc(line) + "</div></div>" +
      '<div class="packnote' + (isHost && (short || !on.length) ? " bad" : "") + '">' + (isHost && (short || !on.length) ? ico("info", "wh-i--sm") : "") + "<span>" + esc(note) + "</span></div></div>";
  }

  function pickerHtml(s, isHost) {
    var all = s.packs.length === s.selectedPacks.length;
    var cards = s.packs.map(function (p) { return packCard(p, s.selectedPacks.indexOf(p.id) !== -1, !isHost); }).join("");
    return '<div class="picker" id="picker"><div class="pwrap">' +
      '<div class="phead"><div class="wh-title ptitle">Choose your song packs</div>' +
      '<p class="wh-sub pintro">' + (isHost ? "These decide which songs come up in the game. Tick one pack or as many as you like." : "These decide which songs come up in the game. The host picks them.") + "</p>" +
      (isHost ? '<div class="pactions"><button class="wh-chip" id="packAll">' + (all ? "Clear all" : "Select all packs") + "</button></div>" : "") + "</div>" +
      '<div class="pbody"><div class="packs">' + cards + "</div>" +
        (isHost ? "" : '<p class="wh-note center">The host picks the packs</p>') + "</div>" +
      '<div class="pfoot"><div class="pcount"><b>' + s.selectedPacks.length + "</b> of " + s.packs.length + " packs picked</div>" +
        '<button class="wh-btn wh-btn--block" id="pkDone">Done</button></div>' +
    "</div></div>";
  }

  function startNote(s, turns) {
    if (s.players.length < s.minPlayers) { return "Waiting for at least " + s.minPlayers + " players"; }
    if (!s.selectedPacks.length) { return "Pick at least one song pack to start"; }
    if (s.songsInPlay < turns + 5) { return "Not enough songs for this many turns. Pick more packs or lower the rounds."; }
    var off = s.players.filter(function (p) { return p.mic === "off"; }).map(function (p) { return p.name; });
    if (off.length) { return off.join(" and ").replace(/^(.*), /, "$1, ") + (off.length > 1 ? " have their mics off" : " has their mic off") + ". They can still type guesses."; }
    return "";
  }

  function viewLobby(s) {
    var isHost = s.hostId === s.me;
    var turns = s.rounds * s.players.length;
    var list = s.players.map(function (p) {
      return '<div class="wh-prow pl">' + avatarHtml(s, p) + '<span class="wh-prow__name nm">' + esc(p.name) +
        (p.id === s.hostId ? '<span class="wh-tag wh-tag--host">Host</span>' : "") +
        (p.id === s.me ? '<span class="wh-tag wh-tag--you">You</span>' : "") +
        (p.mic === "off" ? '<span class="wh-tag micoff">' + ico("mic-off") + "Mic off</span>" : "") + "</span>" +
        '<span class="wh-prow__meta"><i class="pdot' + (p.connected ? " on" : "") + '"></i>' + (p.connected ? "Online" : "Away") + "</span></div>";
    }).join("");
    return {
      key: "lobby", field: "cobalt",
      html:
        '<div class="screen">' +
          '<div class="wh-topbar"><div class="wh-topbar__title">Game lobby</div></div>' +
          '<div class="codecard"><div class="gname wh-title">' + esc(pname(s, s.hostId)) + "'s game</div>" +
            '<span id="roomCode" hidden>' + esc(s.code) + "</span>" +
            '<p class="wh-sub">Everyone else opens this web page and taps your game to join</p></div>' +
          '<h2 class="wh-over">Players, ' + s.players.length + " of " + s.maxPlayers + "</h2>" +
          '<div class="wh-list plist">' + list + "</div>" +
          packsSummaryHtml(s, isHost) +
          '<div class="wh-setting"><div><div class="wh-setting__title">Rounds</div>' +
            '<div class="wh-setting__sub">' + turns + " turns in all, one whistle each per round</div></div>" +
            (isHost
              ? '<div class="wh-stepper"><button id="minus" class="wh-stepper__btn" aria-label="Fewer rounds">' + ico("remove") + '</button><span class="wh-stepper__val" id="roundsVal">' + s.rounds + '</span><button id="plus" class="wh-stepper__btn" aria-label="More rounds">' + ico("add") + "</button></div>"
              : '<span class="wh-stepper__val" id="roundsVal">' + s.rounds + "</span>") +
          "</div>" +
          lengthHtml(s, isHost) +
          '<div class="wh-stack" data-mic></div>' +
          '<div class="spacer"></div>' +
          (isHost
            ? '<button id="startBtn" class="wh-btn wh-btn--block"' + (s.players.length < s.minPlayers || !s.selectedPacks.length || s.songsInPlay < turns + 5 ? " disabled" : "") + ">Start game</button>" +
              (startNote(s, turns) ? '<p class="wh-note center startnote">' + esc(startNote(s, turns)) + "</p>" : "")
            : '<p class="wh-sub center">Waiting for ' + esc(pname(s, s.hostId)) + " to start...</p>") +
          '<div class="wh-row rowc"><button id="helpBtn" class="wh-btn wh-btn--ghost">How to play</button>' +
          '<button id="leaveBtn" class="wh-btn wh-btn--ghost">Leave game</button></div>' +
          (pickerOpen ? pickerHtml(s, isHost) : "") +
        "</div>",
      bind: function () {
        $("#helpBtn").onclick = showHelp;
        $("#openPacks").onclick = function () { pickerOpen = true; keepPickerScroll = false; render(); };
        if (pickerOpen) {
          $("#pkDone").onclick = function () { pickerOpen = false; render(); };
          if (isHost) {
            var sel = s.selectedPacks.slice(), allIds = s.packs.map(function (p) { return p.id; });
            var sendPacks = function () { send({ t: "setPacks", packs: sel }); };
            var cardsEl = document.querySelectorAll(".pack");
            for (var c = 0; c < cardsEl.length; c++) {
              cardsEl[c].onclick = function () {
                var id = this.getAttribute("data-id"), at = sel.indexOf(id);
                if (at === -1) { sel.push(id); }
                else { sel.splice(at, 1); }
                var isOn = sel.indexOf(id) !== -1;
                this.classList.toggle("on", isOn);
                this.setAttribute("aria-pressed", isOn);
                var tk = this.querySelector(".tick"); if (tk) { tk.setAttribute("data-on", isOn); }
                sendPacks();
              };
            }
            $("#packAll").onclick = function () {
              if (sel.length === allIds.length) { sel = []; } else { sel = allIds.slice(); }
              sendPacks();
            };
          }
        }
        if (isHost) {
          var want = s.rounds;
          $("#minus").onclick = function () { want = Math.max(1, want - 1); send({ t: "setRounds", rounds: want }); };
          $("#plus").onclick = function () { want = Math.min(10, want + 1); send({ t: "setRounds", rounds: want }); };
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
    return T.sd ? "Tie-break round " + s.sdRound : "Round " + T.round + " of " + s.rounds + ", turn " + s.turnNumber + " of " + s.totalTurns;
  }

  function topBar(s) {
    return '<div class="wh-topbar"><div class="wh-topbar__title" id="topLabel">' + esc(topLabel(s)) + '</div></div><div id="lastRound"></div>';
  }

  // Kept up to date on every state change, even when the screen itself is not redrawn.
  function refreshTop() {
    if (!st || !st.turn) { return; }
    var l = $("#topLabel"); if (l) { l.textContent = topLabel(st); }
    var b = $("#lastRound"); if (!b) { return; }
    var show = st.hostId === st.me && !st.turn.sd && !st.suddenDeath && st.turn.round === st.rounds;
    var has = !!$("#addRound");
    if (show && !has) {
      b.innerHTML = '<button id="addRound" class="wh-banner wh-banner--accent lastbanner">' + ico("add") + '<span class="wh-banner__text">Last round<small>Tap to add an extra round</small></span></button>';
      $("#addRound").onclick = function () { send({ t: "addRound" }); };
    } else if (!show && has) { b.innerHTML = ""; }
  }

  function skipHtml(s) {
    if (s.hostId !== s.me) { return ""; }
    return '<div class="wh-row rowc"><button id="hostMenuBtn" class="wh-btn wh-btn--ghost wh-btn--sm">' + ico("settings", "wh-i--sm") + "Host controls</button></div>";
  }

  function confirmDialog(title, text, okLabel, danger, fn) {
    var o = document.createElement("div");
    o.className = "overlay modal";
    o.innerHTML = '<div class="wh-scrim"></div><div class="wh-modal"><h2 class="wh-title">' + esc(title) + '</h2><p class="wh-sub">' + esc(text) + '</p>' +
      '<div class="wh-modal__actions"><button class="wh-btn wh-btn--block' + (danger ? " wh-btn--danger" : "") + '" id="cdOk">' + esc(okLabel) + '</button>' +
      '<button class="wh-btn wh-btn--secondary wh-btn--block" id="cdNo">Cancel</button></div></div>';
    document.body.appendChild(o);
    var close = function () { if (o.parentNode) { o.parentNode.removeChild(o); } };
    $("#cdNo", o).onclick = close;
    $("#cdOk", o).onclick = function () { close(); fn(); };
  }

  function openHostMenu() {
    var o = document.createElement("div");
    o.className = "ovl sheetwrap";
    var canSkip = st && st.turn && st.turn.stage !== "reveal";
    o.innerHTML = '<div class="wh-scrim" id="hmScrim"></div><div class="wh-sheet"><div class="wh-sheet__grab"></div>' +
      '<div class="wh-sheet__head"><h2 class="wh-title">Host controls</h2><button class="wh-iconbtn" id="hmClose" aria-label="Close">' + ico("close") + "</button></div>" +
      (canSkip ? '<button id="skipBtn" class="wh-btn wh-btn--secondary wh-btn--block">' + ico("skip", "wh-i--sm") + "Skip this turn</button>" : "") +
      '<button id="endBtn" class="wh-btn wh-btn--danger wh-btn--block">End game</button></div>';
    document.body.appendChild(o);
    var close = function () { if (o.parentNode) { o.parentNode.removeChild(o); } };
    $("#hmClose", o).onclick = close; $("#hmScrim", o).onclick = close;
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

  function lockHtml(note) {
    return '<div class="lockov wh-field wh-field--ink" id="lock" hidden><div class="lk1">Shuffle!</div><div class="lk2">Shuffle costs 100 points</div>' +
      '<div class="lknum" id="lknum">5</div><div class="lk3">' + note + "</div></div>";
  }

  function songCardHtml(T) {
    var d = T.difficulty;
    return '<div class="wh-card songcard"><span class="wh-chip wh-chip--static"><i style="--c:var(--' + (d || "easy") + ')"></i>' + esc(cap(d)) + ", x" + T.multiplier + "</span>" +
      '<div class="t wh-title" id="songTitle">' + esc(T.song ? T.song.title : "") + "</div>" +
      '<div class="a wh-sub" id="songArtist">' + esc(T.song ? T.song.artist : "") + "</div></div>";
  }

  function hintCostText(t) { return t.nextHintCost === null ? "No hints left" : "-" + t.nextHintCost + " points"; }
  // The hints revealed so far, shown on every phone.
  function showHints(t) {
    var hb = $("#hintBox"); if (!hb) { return; }
    var lines = t.hintLines || [];
    if (!lines.length) { hb.hidden = true; return; }
    var html = '<div class="wh-over">Hint' + (lines.length > 1 ? "s" : "") + "</div>" + lines.map(function (l) { return '<div class="wh-sub">' + esc(l) + "</div>"; }).join("");
    if (hb.getAttribute("data-h") !== html) { hb.innerHTML = html; hb.setAttribute("data-h", html); }
    hb.hidden = false;
  }

  // "Who got it?" sheet on the whistler's phone. Picks survive state updates for the same turn.
  var whoState = { built: null, picks: [] };
  function buildWho(t) {
    if (whoState.built === t.id) { return; }
    whoState.built = t.id;
    whoState.picks = t.pending && t.pending.from ? [t.pending.from] : [];
    var sub = (t.pending && t.pending.heard ? "Heard \u201c" + t.pending.heard + "\u201d. " : "") + "Tap everyone who got it right. Each of them earns points.";
    $("#confSub").textContent = sub;
    var grid = $("#whoGrid");
    grid.innerHTML = st.players.filter(function (p) { return p.id !== st.me; }).map(function (p) {
      return '<button class="who" data-id="' + esc(p.id) + '" aria-pressed="' + (whoState.picks.indexOf(p.id) !== -1) + '">' + avatarHtml(st, p, "wh-avatar--sm") +
        '<span class="whoname">' + esc(p.name) + "</span>" + ico("tick", "whotick") + "</button>";
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

  function viewTurn(s) {
    var T = s.turn, isW = T.playerId === s.me, who = pname(s, T.playerId);
    var dfield = DIFF_FIELD[T.difficulty] || "sun";

    // 1. Whistler choosing one of three songs
    if (T.stage === "choose" && isW && !T.difficulty) {
      var offs = (T.options || []).map(function (o, i) {
        var bonus = Math.round((o.multiplier - 1) * 100);
        return '<button class="wh-song wh-song--' + o.difficulty + ' opt" data-i="' + i + '" data-d="' + o.difficulty + '">' +
          '<span class="wh-song__mark">' + (SHAPE[o.difficulty] || "") + "</span>" +
          '<span class="wh-song__meta od">' + esc(cap(o.difficulty)) + (bonus ? ", +" + bonus + "% points" : ", standard points") + "</span>" +
          '<span class="wh-song__title ot">' + esc(o.title) + "</span>" +
          '<span class="wh-song__artist oa">' + esc(o.artist) + "</span></button>";
      }).join("");
      return {
        key: "choose-" + T.id, field: "ink",
        html: '<div class="screen">' + topBar(s) +
          '<div class="wh-stack"><h1 class="wh-title">' + esc(who) + ", you're up</h1>" +
          '<p class="wh-sub">Pick a song. A harder song earns bonus points.</p></div>' +
          '<div class="wh-stack">' + offs + "</div>" +
          (T.canRefresh ? '<button id="refreshBtn" class="wh-btn wh-btn--secondary wh-btn--block refresh">' + ico("refresh") + "<span>Refresh options</span></button>" +
            '<p class="wh-note center">Don\'t know any of these? Refresh once for three new songs.</p>' : "") +
          '<p class="wh-note center">' + ico("info", "wh-i--sm") + ' Only you can see these. Keep your screen to yourself.</p>' +
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
        key: "ready-" + T.id, field: dfield,
        html: '<div class="screen">' + topBar(s) +
          '<h1 class="wh-title">Your song</h1>' + songCardHtml(T) +
          '<p class="wh-note center">Only you can see this. Tap Ready and a 3, 2, 1 countdown starts for everyone.</p>' +
          '<div class="spacer"></div>' +
          '<button id="readyBtn" class="wh-btn wh-btn--block">Ready</button>' + skipHtml(s) + "</div>",
        bind: function () {
          $("#readyBtn").onclick = function () { send({ t: "ready" }); };
          bindSkip();
        }
      };
    }

    // 3. Everyone else while the whistler chooses
    if (T.stage === "choose") {
      return {
        key: "wait-" + T.id, field: "lilac",
        html: '<div class="screen">' + topBar(s) +
          '<div class="wh-stack midc"><div class="wh-spin"></div><h1 class="wh-title">' + esc(who) + (T.difficulty ? " is getting ready" : " is picking a song") + "</h1>" +
          '<p class="wh-sub">' + (T.difficulty ? "A 3, 2, 1 countdown starts as soon as they tap Ready." : "Get ready to guess. Say the title out loud or type it.") + "</p></div>" +
          '<div class="wh-stack" data-mic></div><div class="spacer"></div>' + skipHtml(s) + "</div>",
        bind: bindSkip
      };
    }

    // 4. Countdown for everyone
    if (T.stage === "countdown") {
      return {
        key: "cd-" + T.id, field: isW ? dfield : "leaf",
        html: '<div class="screen">' + topBar(s) +
          '<div class="wh-stack midc"><h1 class="wh-title">' + (isW ? "Get ready to whistle" : "Get ready to guess " + esc(who)) + "</h1>" +
          '<div class="cd" id="cd">3</div></div>' + (isW ? songCardHtml(T) : '<div class="wh-stack" data-mic></div>') +
          '<div class="spacer"></div>' + skipHtml(s) + "</div>",
        bind: bindSkip
      };
    }

    // 5. Whistling or confirming, whistler's phone
    if ((T.stage === "whistling" || T.stage === "confirming") && isW) {
      return {
        key: "w-" + T.id, field: dfield,
        html: '<div class="screen">' + topBar(s) +
          '<div class="timerbox"><div class="wh-over" id="tlabel">Time</div><div class="wh-timer" id="bigtime">0.0</div>' +
          '<div class="wh-progress"><i id="bar"></i></div><div class="wh-sub worth" id="worth"></div></div>' + songCardHtml(T) + '<div class="wh-card hintcard" id="hintBox" hidden></div>' +
          '<div class="spacer"></div>' +
          '<button id="gotBtn" class="wh-btn wh-btn--block gotbtn">Someone got it</button>' +
          '<div class="lifelines"><button id="shuffleBtn" class="wh-btn wh-btn--secondary lifeline">' + ico("shuffle") + "<span>Shuffle<small>" + "-" + T.penalty + " points</small></span></button>" +
          '<button id="hintBtn" class="wh-btn wh-btn--secondary lifeline">' + ico("info") + "<span>Hint<small id=\"hintCost\">" + hintCostText(T) + "</small></span></button></div>" + skipHtml(s) +
          lockHtml("New song coming up.") +
          '<div class="ovl" id="confirm" hidden><div class="wh-scrim"></div><div class="wh-modal"><h2 class="wh-title">Who got it?</h2>' +
          '<p class="wh-sub" id="confSub"></p><div class="whogrid" id="whoGrid"></div><div class="wh-modal__actions">' +
          '<button id="yesBtn" class="wh-btn wh-btn--block" disabled>Confirm</button><button id="noBtn" class="wh-btn wh-btn--secondary wh-btn--block">Not yet, keep going</button></div></div></div></div>',
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
          $("#hintCost").textContent = hintCostText(t);
          $("#hintBtn").disabled = t.stage === "confirming" || t.nextHintCost === null;
          $("#shuffleBtn").disabled = t.stage === "confirming";
          $("#gotBtn").disabled = t.stage === "confirming";
        }
      };
    }

    // 6. Whistling or confirming, guesser's phone
    if (T.stage === "whistling" || T.stage === "confirming") {
      return {
        key: "g-" + T.id + (mic.typeMode ? "-t" : "-m"), field: T.stage === "confirming" ? "sky" : "leaf",
        html: '<div class="screen">' + topBar(s) +
          '<div class="timerbox"><div class="wh-over" id="tlabel">Time</div><div class="wh-timer" id="bigtime">0.0</div>' +
          '<div class="wh-progress"><i id="bar"></i></div><div class="wh-sub worth" id="worth"></div></div>' +
          '<div class="wh-card hintcard" id="hintBox" hidden></div>' +
          (mic.typeMode
            ? '<div class="wh-card wh-stack"><h2 class="wh-title">Type your guess</h2>' +
              '<form id="gform" class="wh-stack"><input id="ginput" class="wh-input" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Type the song title">' +
              '<button class="wh-btn wh-btn--block" type="submit">Send guess</button></form>' +
              (SR ? '<button id="toMic" class="wh-btn wh-btn--ghost wh-btn--sm">' + ico("mic", "wh-i--sm") + 'Back to mic mode</button>' : "") + "</div>"
            : '<div class="wh-stack midc"><div class="wh-orb wh-orb--off off" id="orb"><span class="wh-orb__core">' + ico("mic-off") + '</span></div>' +
              '<h2 class="wh-title" id="listenHead">Listening</h2>' +
              '<p class="wh-sub">Shout your guesses. Get it right and you earn points too.</p>' +
              '<div class="wh-stack" data-mic="quiet"></div><div class="heard wh-note" id="heard"></div></div>' +
              '<button id="toType" class="wh-btn wh-btn--secondary wh-btn--block">' + ico("keyboard") + 'Mic not working? Type your answer</button>') +
          '<div class="spacer"></div>' + skipHtml(s) +
          lockHtml("Song changing. Guessing is paused.") +
          '<div class="wh-overlay wh-field wh-field--sky fixedov" id="checking" hidden><div class="wh-spin"></div><h2 class="wh-title">Checking...</h2>' +
          '<p class="wh-sub">Someone may have got it. Waiting for the whistler to confirm.</p></div></div>',
        bind: function () {
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
          var tt = $("#toType"); if (tt) { tt.onclick = function () { mic.typeMode = true; render(); }; }
          var tm = $("#toMic"); if (tm) { tm.onclick = function () { mic.typeMode = false; render(); }; }
          bindSkip();
        },
        update: function () {
          $("#checking").hidden = st.turn.stage !== "confirming";
          showHints(st.turn);
          var h = $("#heard"); if (h && mic.heard) { h.textContent = "Heard: " + mic.heard; }
        }
      };
    }

    // 7. Reveal: the score is counted up on screen, see revealFrame()
    var R = T.result, head, sub = "";
    var guessers = (R.awards || []).filter(function (x) { return x.role === "guesser"; }).map(function (x) { return pname(s, x.id); });
    if (R.outcome === "correct") {
      head = esc(who) + " whistled it";
      sub = guessers.length ? "Guessed by " + guessers.map(esc).join(", ").replace(/, ([^,]*)$/, " and $1") : "";
    } else if (R.outcome === "timeout") {
      head = "Time's up";
      sub = "Nobody guessed " + esc(who) + "'s song, so it scores nothing.";
    } else {
      head = "Turn skipped";
      sub = esc(who) + " scores nothing.";
    }
    var last = s.turnNumber >= s.totalTurns;
    var awards = (R.awards || []).slice().sort(function (a, b) { return b.points - a.points; }).filter(function (a) { return a.points > 0; }).map(function (a) {
      return '<span class="wh-chip wh-chip--static award"><b>+' + pts(a.points) + "</b> " + esc(pname(s, a.id)) + "</span>";
    }).join("");
    return {
      key: "reveal-" + T.id + "-" + s.totalTurns, field: "cobalt",
      html: '<div class="screen">' + topBar(s) +
        '<div class="wh-stack"><h1 class="wh-title winline">' + head + "</h1>" + (sub ? '<p class="wh-sub">' + sub + "</p>" : "") + "</div>" +
        (R.song ? '<div class="wh-card songcard"><div class="wh-over">The song was</div><div class="t wh-title">' + esc(R.song.title) + '</div><div class="a wh-sub">' + esc(R.song.artist) + "</div></div>" : "") +
        '<div class="wh-card scorecard"><div class="wh-over" id="scoreCap">Guessed in</div><div class="scorerow"><span class="multBadge" id="multBadge" hidden></span><div class="scoreNum" id="scoreNum">0</div><span class="deltaTag" id="deltaTag" hidden></span></div></div>' +
        '<div class="awards rvhide" id="awards">' + awards + "</div>" +
        '<div class="rvhide" id="board"><h2 class="wh-over">Standings</h2>' + standingsHtml(s, R.awards, null) + "</div>" +
        '<div class="spacer"></div>' +
        '<p class="wh-sub center" id="nextIn"></p>' +
        (s.hostId === s.me
          ? '<button id="nextBtn" class="wh-btn wh-btn--secondary wh-btn--block">' + (last ? "Skip to final scores" : "Skip ahead") + "</button>"
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
      segs.push({ from: run, to: R.afterMult, at: cur + 500, len: 1400, cap: cap(R.difficulty || "") + " song", badge: "x" + R.multiplier, badgeAt: cur });
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
    if (el >= cur) { out.cap = "And the score is..."; out.drum = true; }
    return out;
  }

  function viewOver(s) {
    var isHost = s.hostId === s.me;
    var names = (s.winners || []).map(function (id) { return pname(s, id); });
    var head = names.length > 1 ? "It's a draw: " + names.map(esc).join(" and ") : esc(names[0] || "Nobody") + " wins";
    return {
      key: "over", field: "sun",
      html: '<div class="screen">' +
        blob("width:170px;height:170px;right:-70px;top:-60px;background:var(--blush)") +
        blob("width:120px;height:120px;left:-60px;bottom:90px;background:var(--lilac)") +
        '<div class="wh-topbar"><div class="wh-topbar__title">Game over</div></div>' +
        '<h1 class="wh-title">' + head + "</h1>" +
        (s.tieBreakWon ? '<p class="wh-sub">Settled in a tie-break.</p>' : "") +
        '<h2 class="wh-over">Final scores</h2>' + standingsHtml(s, null, s.winners) +
        '<div class="spacer"></div>' +
        (isHost ? '<button id="againBtn" class="wh-btn wh-btn--block">Play again</button>' : '<p class="wh-sub center">Waiting for ' + esc(pname(s, s.hostId)) + "...</p>") +
        '<button id="leaveBtn" class="wh-btn wh-btn--ghost">Leave room</button></div>',
      bind: function () {
        var a = $("#againBtn"); if (a) { a.onclick = function () { send({ t: "playAgain" }); }; }
        $("#leaveBtn").onclick = leaveRoom;
      }
    };
  }

  function showHelp() {
    var o = document.createElement("div");
    o.className = "overlay modal";
    var steps = [
      "Pick a song: easy, medium or hard. Harder songs earn bonus points, so scores can go above 1000.",
      "Whistle it. Only you can see the song.",
      "Everyone else shouts or types guesses. The quicker they get it, the more it is worth.",
      "Say who got it. You and everyone you name earn points.",
      "Stuck? Shuffle for a new song (100 points) or ask for a hint (50, then 100, then 150). The highest total wins."
    ];


    o.innerHTML = '<div class="wh-scrim"></div><div class="wh-modal"><h2 class="wh-title">How to play</h2>' +
      '<p class="wh-sub">Whistle a song and get the room to guess it. A guess at the start is worth 1000 points, and the value falls as the clock runs.</p>' +
      '<ol class="wh-steps">' + steps.map(function (t, i) { return "<li><b>" + (i + 1) + "</b><span>" + t + "</span></li>"; }).join("") + "</ol>" +
      '<div class="wh-modal__actions"><button class="wh-btn wh-btn--block" id="helpClose">Got it</button></div></div>';
    document.body.appendChild(o);
    $("#helpClose", o).onclick = function () { document.body.removeChild(o); };
  }

  // ---------------------------------------------------------------- render
  function render() {
    var view;
    if (st && st.phase !== "lobby") { pickerOpen = false; }
    var pb = document.querySelector(".pbody"), pTop = pb ? pb.scrollTop : 0;
    if (!st && adminLogin) { view = viewAdminLogin(); }
    else if (!st) { view = viewHome(); }
    else if (st.phase === "lobby") { view = viewLobby(st); }
    else if (st.phase === "turn" && st.turn) { view = viewTurn(st); }
    else { view = viewOver(st); }

    app.className = "wh-field wh-field--" + (view.field || "sun") + (document.body.classList.contains("danger") ? " wh-urgent" : "");
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
  }

  // Keep the page behind the app (overscroll, notch) the same colour as the current field.
  var lastBg = "";
  function syncBg() {
    try {
      var c = getComputedStyle(app).backgroundColor;
      if (c && c !== lastBg) {
        lastBg = c; document.documentElement.style.background = c;
        var m = document.querySelector('meta[name="theme-color"]'); if (m) { m.setAttribute("content", c); }
      }
    } catch (e) {}
  }

  // The clock and countdown run locally between server messages.
  var lastSecond = null;
  function elapsedMs(T) {
    var base = T.accumulatedMs + (T.runningSince !== null ? nowS() - T.runningSince : 0);
    return Math.max(0, Math.min(base, T.limitMs));
  }
  function tick() {
    requestAnimationFrame(tick);
    mic.level = Math.max(0, mic.level - 0.03);
    var orb = document.getElementById("orb");
    if (orb) { orb.style.setProperty("--level", mic.state === "on" ? mic.level.toFixed(2) : "0"); }
    var T = st && st.turn;
    if (!T) { if (document.body.classList.contains("danger")) { document.body.classList.remove("danger"); app.classList.remove("wh-urgent"); syncBg(); } return; }
    var lk = document.getElementById("lock");
    if (lk) {
      var L = T.lockUntil, on = !!(L && L > nowS() && T.stage === "whistling");
      lk.hidden = !on;
      if (on) {
        var ln = document.getElementById("lknum"), n = Math.max(1, Math.ceil((L - nowS()) / 1000));
        if (ln && ln.textContent !== String(n)) { ln.textContent = n; }
        var lp = lk.querySelector(".lk2"); if (lp) { lp.textContent = "Shuffle costs " + T.penalty + " points"; }
      }
      var sb = document.getElementById("shuffleBtn"), gb = document.getElementById("gotBtn"), hbn = document.getElementById("hintBtn");
      if (hbn) { hbn.disabled = on || T.stage === "confirming" || T.nextHintCost === null; }
      if (sb) { sb.disabled = on || T.stage === "confirming"; }
      if (gb) { gb.disabled = on || T.stage === "confirming"; }
    }
    if (T.stage === "countdown") {
      var cd = $("#cd");
      if (cd) {
        var n = Math.max(1, Math.ceil((T.countdownEndsAt - nowS()) / 1000));
        if (cd.textContent !== String(n)) { cd.textContent = n; }
      }
    }
    if (T.stage === "reveal" && T.result) {
      var R = T.result, ms = REDUCED ? 1e9 : Math.max(0, nowS() - R.revealAt), fr = revealFrame(R, ms);
      var sn = $("#scoreNum");
      if (sn) {
        var txt = pts(fr.num); if (sn.textContent !== txt) { sn.textContent = txt; }
        var cp = $("#scoreCap"); if (cp && cp.textContent !== fr.cap) { cp.textContent = fr.cap; }
        sn.classList.toggle("drum", !!fr.drum);
        var mb = $("#multBadge"), dt = $("#deltaTag");
        if (mb) { mb.hidden = !fr.badge; if (fr.badge && mb.textContent !== fr.badge) { mb.textContent = fr.badge; } }
        if (dt) { dt.hidden = !fr.delta; if (fr.delta && dt.textContent !== fr.delta) { dt.textContent = fr.delta; } }
        if (fr.final && mb) { mb.hidden = true; }
        sn.classList.toggle("big", !!fr.final);
        if (fr.final && !sn.classList.contains("slam")) { sn.classList.add("slam"); try { if (navigator.vibrate) { navigator.vibrate(R.score > 0 ? [60, 40, 90] : 40); } } catch (e) {} }
        var late = ms >= fr.finalAt + 300;
        var aw = $("#awards"), bd = $("#board");
        if (aw) { aw.classList.toggle("rvhide", !late); }
        if (bd) { bd.classList.toggle("rvhide", !late); }
      }
      var ni = $("#nextIn");
      if (ni) {
        var rem = T.nextAt ? T.nextAt - nowS() : null, last = st.turnNumber >= st.totalTurns;
        var nt = rem !== null && rem <= 5000 ? (last ? "Final scores in " : "Next turn in ") + Math.max(1, Math.ceil(rem / 1000)) : "";
        if (ni.textContent !== nt) { ni.textContent = nt; }
      }
    }
    if (T.stage === "whistling" || T.stage === "confirming") {
      var el = elapsedMs(T), remain = T.limitMs - el, danger = remain <= 10000;
      if (document.body.classList.contains("danger") !== danger) {
        document.body.classList.toggle("danger", danger); app.classList.toggle("wh-urgent", danger); syncBg();
      }
      var big = $("#bigtime"), lab = $("#tlabel"), bar = $("#bar");
      if (big) {
        if (danger) { big.textContent = Math.max(0, Math.ceil(remain / 1000)); if (lab) { lab.textContent = "Seconds left"; } }
        else { big.textContent = fmt(el / 1000); if (lab) { lab.textContent = "Time so far"; } }
      }
      if (bar) { bar.style.width = Math.min(100, (el / T.limitMs) * 100) + "%"; }
      var wv = $("#worth");
      if (wv) {
        var worth = Math.max(0, Math.round(1000 * (1 - Math.max(0, el / 1000 - (T.lockS || 0) * (T.shuffles || 0)) / (T.limitMs / 1000)) * (T.multiplier || 1)) - (T.penalty || 0) * (T.shuffles || 0) - (T.hintCost || 0)), wt = "Worth " + pts(worth) + " points";
        if (wv.textContent !== wt) { wv.textContent = wt; }
      }
      if (danger && T.stage === "whistling") {
        var sec = Math.ceil(remain / 1000);
        if (sec !== lastSecond) { lastSecond = sec; try { if (navigator.vibrate) { navigator.vibrate(40); } } catch (e) {} }
      } else { lastSecond = null; }
    } else {
      if (document.body.classList.contains("danger")) { document.body.classList.remove("danger"); app.classList.remove("wh-urgent"); syncBg(); }
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
