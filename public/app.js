(function () {
  "use strict";

  var app = document.getElementById("app");
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  var ws = null, connected = false, session = null, rejoining = false, pendingName = "";
  var gameList = [], adminLogin = false, pickerOpen = false, pickerTab = "All", keepPickerScroll = true;
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
      connected = true; setBanner("");
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
      saveSession(); rejoining = false; keepAwake(); adminLogin = false;
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
    var orb = $("#orb");
    if (orb) {
      var off = mic.state !== "on";
      orb.classList.toggle("off", off);
      orb.classList.toggle("wh-orb--off", off);
      orb.classList.toggle("wh-orb--live", !off);
      orb.innerHTML = '<span class="wh-orb__core">' + ico(off ? "mic-off" : "mic") + "</span>";
    }
    var hd = $("#listenHead");
    if (hd) { hd.textContent = mic.state === "on" ? "Listening" : mic.state === "blocked" ? "Mic blocked" : "Mic is off"; }
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

  function standingsHtml(s, highlightLast, winners) {
    var list = s.players.slice().sort(function (a, b) { return a.total - b.total; });
    var rank = 0, prev = null, html = "";
    list.forEach(function (p, i) {
      if (prev === null || p.total !== prev) { rank = i + 1; }
      prev = p.total;
      var me = p.id === s.me, win = winners && winners.indexOf(p.id) !== -1;
      var last = highlightLast && s.turn && s.turn.playerId === p.id && p.last !== null ? "<small>+" + fmt(p.last) + "s</small>" : "";
      html += '<div class="wh-prow' + (me ? " wh-prow--you" : "") + (win ? " win" : "") + '">' +
        '<span class="wh-rank' + (rank === 1 ? " wh-rank--1" : "") + '">' + rank + "</span>" + avatarHtml(s, p, "wh-avatar--sm") +
        '<span class="wh-prow__name">' + esc(p.name) +
          (win ? '<span class="wh-tag wh-tag--host">' + ico("trophy") + "Winner</span>" : "") +
          (me ? '<span class="wh-tag wh-tag--you">You</span>' : "") + "</span>" +
        '<span class="wh-time">' + fmt(p.total) + "s" + last + "</span></div>";
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
          '<p class="wh-sub">Keep a straight face. Keep whistling.</p></div>' +
          '<div class="wh-card wh-stack">' +
            '<div class="wh-fieldgroup"><label class="wh-label" for="name">Your name</label>' +
            '<input id="name" class="wh-input" maxlength="14" autocomplete="off" autocapitalize="words" placeholder="Name" value="' + esc(name) + '"></div>' +
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
      '<div class="packnote' + (short || !on.length ? " bad" : "") + '">' + (short || !on.length ? ico("info", "wh-i--sm") : "") + "<span>" + esc(note) + "</span></div></div>";
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

  function viewLobby(s) {
    var isHost = s.hostId === s.me;
    var turns = s.rounds * s.players.length;
    var list = s.players.map(function (p) {
      return '<div class="wh-prow pl">' + avatarHtml(s, p) + '<span class="wh-prow__name nm">' + esc(p.name) +
        (p.id === s.hostId ? '<span class="wh-tag wh-tag--host">Host</span>' : "") +
        (p.id === s.me ? '<span class="wh-tag wh-tag--you">You</span>' : "") + "</span>" +
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
              (s.players.length < s.minPlayers ? '<p class="wh-note center">Waiting for at least ' + s.minPlayers + " players</p>" : "")
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
    return '<div class="wh-row rowc">' +
      (s.turn.stage !== "reveal" ? '<button id="skipBtn" class="wh-btn wh-btn--ghost wh-btn--sm">' + ico("skip", "wh-i--sm") + "Skip this turn</button>" : "") +
      '<button id="endBtn" class="wh-btn wh-btn--ghost wh-btn--sm">End game</button></div>';
  }

  function bindSkip() {
    var b = $("#skipBtn");
    if (b) { b.onclick = function () { if (window.confirm("Skip this turn? It scores the full 60 seconds.")) { send({ t: "skip" }); } }; }
    var e = $("#endBtn");
    if (e) { e.onclick = function () { if (window.confirm("End this game? Everyone goes back to the lobby and scores are cleared.")) { send({ t: "cancelGame" }); } }; }
  }

  function lockHtml(note) {
    return '<div class="lockov wh-field wh-field--ink" id="lock" hidden><div class="lk1">Shuffle!</div><div class="lk2">5s penalty</div>' +
      '<div class="lknum" id="lknum">5</div><div class="lk3">' + note + "</div></div>";
  }

  function songCardHtml(T) {
    var d = T.difficulty;
    return '<div class="wh-card songcard"><span class="wh-chip wh-chip--static"><i style="--c:var(--' + (d || "easy") + ')"></i>' + esc(cap(d)) + ", x" + T.multiplier + "</span>" +
      '<div class="t wh-title" id="songTitle">' + esc(T.song ? T.song.title : "") + "</div>" +
      '<div class="a wh-sub" id="songArtist">' + esc(T.song ? T.song.artist : "") + "</div></div>";
  }

  function viewTurn(s) {
    var T = s.turn, isW = T.playerId === s.me, who = pname(s, T.playerId);
    var dfield = DIFF_FIELD[T.difficulty] || "sun";

    // 1. Whistler choosing one of three songs
    if (T.stage === "choose" && isW && !T.difficulty) {
      var offs = (T.options || []).map(function (o, i) {
        var off = Math.round((1 - o.multiplier) * 100);
        return '<button class="wh-song wh-song--' + o.difficulty + ' opt" data-i="' + i + '" data-d="' + o.difficulty + '">' +
          '<span class="wh-song__mark">' + (SHAPE[o.difficulty] || "") + "</span>" +
          '<span class="wh-song__meta od">' + esc(cap(o.difficulty)) + (off ? ", " + off + "% off your time" : ", normal score") + "</span>" +
          '<span class="wh-song__title ot">' + esc(o.title) + "</span>" +
          '<span class="wh-song__artist oa">' + esc(o.artist) + "</span></button>";
      }).join("");
      return {
        key: "choose-" + T.id, field: "ink",
        html: '<div class="screen">' + topBar(s) +
          '<div class="wh-stack"><h1 class="wh-title">' + esc(who) + ", you're up</h1>" +
          '<p class="wh-sub">Pick a song. A harder song takes time off your score.</p></div>' +
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
          '<p class="wh-note center">Only you can see this. Everyone else is waiting. A 3, 2, 1 countdown starts when you tap. Stuck once the clock is running? Shuffle gives you a new song but locks your screen for ' + T.penalty + 's.</p>' +
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
          '<div class="wh-stack midc"><div class="wh-spin"></div><h1 class="wh-title">' + esc(who) + " is picking a song</h1>" +
          '<p class="wh-sub">Get ready to guess. Say the title out loud or type it.</p></div>' +
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
          '<div class="wh-progress"><i id="bar"></i></div></div>' + songCardHtml(T) +
          '<div class="spacer"></div>' +
          '<button id="gotBtn" class="wh-btn wh-btn--block gotbtn">Someone got it</button>' +
          '<button id="shuffleBtn" class="wh-btn wh-btn--secondary wh-btn--block">' + ico("shuffle") + "Shuffle, " + T.penalty + "s penalty</button>" + skipHtml(s) +
          lockHtml("New song coming up.") +
          '<div class="ovl" id="confirm" hidden><div class="wh-scrim"></div><div class="wh-modal"><h2 class="wh-title">Did they get it?</h2>' +
          '<p class="wh-sub">Heard: <b id="heardTxt"></b></p><div class="wh-modal__actions">' +
          '<button id="yesBtn" class="wh-btn wh-btn--block">Yes, that\'s it</button><button id="noBtn" class="wh-btn wh-btn--secondary wh-btn--block">No, keep going</button></div></div></div></div>',
        bind: function () {
          $("#shuffleBtn").onclick = function () { send({ t: "shuffle" }); };
          $("#gotBtn").onclick = function () { send({ t: "gotIt" }); };
          $("#yesBtn").onclick = function () { send({ t: "confirm", ok: true }); };
          $("#noBtn").onclick = function () { send({ t: "confirm", ok: false }); };
          bindSkip();
        },
        update: function () {
          var t = st.turn, conf = t.stage === "confirming" && t.pending;
          $("#songTitle").textContent = t.song ? t.song.title : "";
          $("#songArtist").textContent = t.song ? t.song.artist : "";
          $("#confirm").hidden = !conf;
          if (conf) { $("#heardTxt").textContent = "“" + t.pending.heard + "”"; }
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
          '<div class="wh-progress"><i id="bar"></i></div></div>' +
          (mic.typeMode
            ? '<div class="wh-card wh-stack"><h2 class="wh-title">Type your guess</h2>' +
              '<form id="gform" class="wh-stack"><input id="ginput" class="wh-input" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Type the song title">' +
              '<button class="wh-btn wh-btn--block" type="submit">Send guess</button></form>' +
              (SR ? '<button id="toMic" class="wh-btn wh-btn--ghost wh-btn--sm">' + ico("mic", "wh-i--sm") + 'Back to mic mode</button>' : "") + "</div>"
            : '<div class="wh-stack midc"><div class="wh-orb wh-orb--off off" id="orb"><span class="wh-orb__core">' + ico("mic-off") + '</span></div>' +
              '<h2 class="wh-title" id="listenHead">Listening</h2>' +
              '<p class="wh-sub">Shout your guesses. The game pauses by itself when it hears the right answer.</p>' +
              '<div class="wh-stack" data-mic="quiet"></div><div class="heard wh-note" id="heard"></div></div>' +
              '<button id="toType" class="wh-btn wh-btn--secondary wh-btn--block">' + ico("keyboard") + 'Mic not working? Type your answer</button>') +
          '<div class="spacer"></div>' + skipHtml(s) +
          lockHtml("Song changing. Guessing is paused.") +
          '<div class="wh-overlay wh-field wh-field--sky fixedov" id="checking" hidden><div class="wh-spin"></div><h2 class="wh-title">Checking...</h2>' +
          '<p class="wh-sub">Someone may have got it. Hold tight.</p></div></div>',
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
          var h = $("#heard"); if (h && mic.heard) { h.textContent = "Heard: " + mic.heard; }
        }
      };
    }

    // 7. Reveal
    var R = T.result, head, lines = "";
    if (R.outcome === "correct") {
      head = esc(who) + " got it";
      lines = "Time " + fmt(R.timeMs / 1000) + "s" + (R.difficulty ? " x " + R.multiplier + " (" + R.difficulty + ")" : "") +
        (R.shuffles ? " + " + (R.shuffles * T.penalty) + "s for " + R.shuffles + " shuffle" + (R.shuffles > 1 ? "s" : "") : "");
    } else if (R.outcome === "timeout") {
      head = "Time's up";
      lines = "Nobody guessed " + esc(who) + "'s song, so it scores the full " + fmt(R.timeMs / 1000) + "s.";
    } else {
      head = "Turn skipped";
      lines = esc(who) + " scores the full " + fmt(R.timeMs / 1000) + "s.";
    }
    var last = s.turnNumber >= s.totalTurns;
    return {
      key: "reveal-" + T.id + "-" + s.totalTurns, field: "cobalt",
      html: '<div class="screen">' + topBar(s) +
        '<h1 class="wh-title winline">' + head + "</h1>" +
        (R.song ? '<div class="wh-card songcard"><div class="wh-over">The song was</div><div class="t wh-title">' + esc(R.song.title) + '</div><div class="a wh-sub">' + esc(R.song.artist) + "</div></div>" : "") +
        '<div class="wh-card scorecard"><div class="breakdown wh-sub">' + lines + '</div><div class="score">' + fmt(R.score) + "s</div></div>" +
        '<h2 class="wh-over">' + (T.sd ? "Tie-break" : "Standings") + "</h2>" + standingsHtml(s, !T.sd, null) +
        '<div class="spacer"></div>' +
        (s.hostId === s.me
          ? '<button id="nextBtn" class="wh-btn wh-btn--block">' + (last ? "Finish" : "Next player") + "</button>"
          : '<p class="wh-sub center">Waiting for ' + esc(pname(s, s.hostId)) + "...</p>") + skipHtml(s) + "</div>",
      bind: function () { var b = $("#nextBtn"); if (b) { b.onclick = function () { send({ t: "next" }); }; } bindSkip(); }
    };
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
        '<h2 class="wh-over">Final scores, lower is better</h2>' + standingsHtml(s, false, s.winners) +
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
      "On your turn, pick one of three songs: easy, medium or hard. Harder songs take time off your score.",
      "Whistle the song on your phone. Only you can see it, so keep your screen to yourself.",
      "Everyone else shouts or types guesses. The clock stops when the mic hears the right answer.",
      "Stuck? Shuffle for a new song, but your screen locks for 5 seconds. If nobody guesses in time, you score the full time.",
      "After the last round, the lowest total wins."
    ];
    o.innerHTML = '<div class="wh-scrim"></div><div class="wh-modal"><h2 class="wh-title">How to play</h2>' +
      '<p class="wh-sub">Get everyone to guess your song as quickly as you can. Your score is the seconds it takes, so the fewest points wins.</p>' +
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
        var lp = lk.querySelector(".lk2"); if (lp) { lp.textContent = T.penalty + "s penalty"; }
      }
      var sb = document.getElementById("shuffleBtn"), gb = document.getElementById("gotBtn");
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
