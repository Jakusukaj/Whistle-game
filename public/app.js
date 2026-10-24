(function () {
  "use strict";

  var app = document.getElementById("app");
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  var ws = null, connected = false, session = null, rejoining = false, pendingName = "";
  var gameList = [], adminLogin = false, pickerOpen = false, settingsOpen = false, pickerTab = "All", keepPickerScroll = true;
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
    rec.lang = "en-GB"; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 5;
    mic.rec = rec; mic.state = "starting";
    var startTimer = setTimeout(function () {
      if (mic.rec === rec && mic.state === "starting") { mic.state = "stopped"; refreshMic(); }
    }, 3500);
    rec.onsoundstart = rec.onspeechstart = function () { mic.level = Math.max(mic.level, 0.7); };
    rec.onstart = function () { mic.base = 0; mic.total = 0; clearTimeout(startTimer); if (mic.rec === rec) { mic.state = "on"; refreshMic(); } };
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

  function refreshMic() {
    var boxes = document.querySelectorAll("[data-mic]");
    for (var i = 0; i < boxes.length; i++) {
      boxes[i].innerHTML = micHtml();
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
      if (!orb.firstChild) { orb.innerHTML = '<i class="r"></i><i class="r"></i><i class="r"></i>' + ico("mic"); }
    }
    var hd = $("#listenHead");
    if (hd) {
      hd.textContent = mic.state === "on" ? "Listening" : mic.state === "blocked" ? "Mic is blocked" : mic.state === "starting" ? "Starting mic" : "Mic is off, tap to turn on";
    }
  }

  // ----------------------------------------------------------------- views
  var PACK_GROUPS = [
    { name: "Vibe", ids: ["bangers", "rock", "party", "soul", "tv", "film", "disney"] },
    { name: "Eras", ids: ["sixties", "seventies", "eighties", "nineties", "noughties", "tens", "today"] },
    { name: "Artists", ids: ["beatles", "bowie", "gaga", "talkingheads"] },
    { name: "Special events", ids: ["halloween", "xmas"] }
  ];
  // Pack colour tokens from the design system. "l" means light text, "i" ink text.
  var PACK_COL = {
    bangers: ["#225A31", "l"], rock: ["#972622", "l"], party: ["#41AE61", "i"], soul: ["#FE973B", "i"], tv: ["#115E5E", "l"], film: ["#95330F", "l"], disney: ["#E4DC71", "i"],
    sixties: ["#43B2AC", "i"], seventies: ["#F68675", "i"], eighties: ["#6EBB5D", "i"], nineties: ["#FF4FA3", "i"], noughties: ["#575A13", "l"], tens: ["#F77036", "i"], today: ["#C1CF51", "i"],
    beatles: ["#2640EC", "l"], bowie: ["#D1AD41", "i"], gaga: ["#4DBC92", "i"], talkingheads: ["#FFAE34", "i"],
    halloween: ["#F85452", "i"], xmas: ["#8CAD40", "i"]
  };
  var openGroups = { Vibe: true };

  function avatarHtml(s, p, cls) {
    var ch = (String(p.name).trim().charAt(0) || "?").toUpperCase();
    return '<span class="avatar' + (cls ? " " + cls : "") + '">' + esc(ch) + "</span>";
  }

  function pts(n) { return Math.round(n).toLocaleString("en-GB"); }

  // Standings: rank, name, text rank change, points. Your own row is underlined heavier.
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
      var before = s.players.slice().sort(function (a, b) { return (b.total - (gained[b.id] || 0)) - (a.total - (gained[a.id] || 0)); });
      var pr = {}, r2 = 0, pv = null;
      before.forEach(function (p, i) {
        var t = p.total - (gained[p.id] || 0);
        if (pv === null || t !== pv) { r2 = i + 1; }
        pv = t; pr[p.id] = r2;
      });
      var tied = before.every(function (p) { return p.total - (gained[p.id] || 0) === before[0].total - (gained[before[0].id] || 0); });
      if (!tied) { rows.forEach(function (r) { r.chg = pr[r.p.id] - r.rank; }); }
    }
    if (opt.limit && rows.length > opt.limit) {
      var top = rows.slice(0, opt.limit), me = rows.filter(function (r) { return r.p.id === s.me; })[0];
      if (me && top.indexOf(me) === -1) { top[top.length - 1] = me; }
      rows = top;
    }
    var html = rows.map(function (r) {
      var p = r.p, me = p.id === s.me, win = winners && winners.indexOf(p.id) !== -1;
      var g = gained[p.id] !== undefined && gained[p.id] > 0 && opt.bonus ? "<small>+" + pts(gained[p.id]) + "</small>" : "";
      var chg = r.chg === undefined ? "" : (r.chg > 0 ? "+" + r.chg : String(r.chg));
      return '<div class="srow' + (me ? " srow--you" : "") + '"><span class="srow__rank title">' + r.rank + "</span>" +
        '<span class="srow__name title">' + esc(p.name) + (win ? '<span class="tag">Winner</span>' : "") + "</span>" +
        (chg !== "" ? '<span class="srow__chg small">' + chg + "</span>" : "") +
        '<span class="srow__pts title">' + pts(p.total) + g + "</span></div>";
    }).join("");
    return '<div class="board" style="border-top:1.5px solid currentColor">' + html + "</div>";
  }

  function gamesHtml() {
    if (!gameList.length) {
      return '<div class="stack" style="padding:12px 0"><p class="title">Nobody is hosting yet</p><p class="small">Ask someone to host a game, then it will show up here.</p></div>';
    }
    return gameList.map(function (g) {
      return '<button class="gamebtn" data-code="' + esc(g.code) + '"><span class="gtxt"><span class="title">' + esc(g.host) + "'s game</span>" +
        '<span class="small">' + g.players + (g.players === 1 ? " player" : " players") + (g.inProgress ? ", in progress" : ", waiting to start") + "</span></span>" +
        '<span class="tag">Join</span></button>';
    }).join("");
  }

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
      key: "home", field: "yellow",
      html:
        '<div class="screen">' +
          '<div class="brand"><h1 class="display">Tip of My Tongue</h1>' +
          '<p class="small">One person whistles a song and everyone else guesses it. The quicker the guess, the more points.</p></div>' +
          '<div class="field-group"><label class="label" for="name">Your name</label>' +
          '<input id="name" class="input" maxlength="14" autocomplete="off" autocapitalize="words" placeholder="Name" value="' + esc(name) + '"><p class="small">Up to 14 characters</p></div>' +
          '<button id="hostBtn" class="btn">Host a game</button>' +
          '<div class="stack"><h2 class="label">Join a game</h2><div class="line-list" id="games">' + gamesHtml() + "</div></div>" +
          '<div class="spacer"></div>' +
          '<div class="homefoot"><button id="helpBtn" class="txt">How to play</button>' +
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
      key: "adminlogin", field: "ground",
      html:
        '<div class="screen">' +
          '<div class="brand"><h1 class="headline">Admin</h1>' +
          '<p class="small">Test mode. Play a whole game on your own.</p></div>' +
          '<div class="field-group"><label class="label" for="apw">Password</label>' +
          '<input id="apw" class="input" type="password" autocomplete="off" placeholder="Password"></div>' +
          '<button id="aGo" class="btn">Enter admin mode</button>' +
          '<div class="spacer"></div>' +
          '<button id="aBack" class="txt">Back</button>' +
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
    document.getElementById("aExit").onclick = function () { adminHtmlCache = ""; pickerOpen = false; leaveRoom(); };
  }

  var LEN_LABEL = { 30000: "30 s", 60000: "1 min", 90000: "1 min 30", 120000: "2 min" };
  function lengthHtml(s, isHost) {
    var opts = s.limitOptions || [30000, 60000, 90000, 120000];
    if (!isHost) {
      return '<div class="setrow"><div><div class="label">Round length</div><p class="small">Set by the host</p></div>' +
        '<span class="title" id="limitVal">' + (LEN_LABEL[s.limitMs] || s.limitMs / 1000 + " s") + "</span></div>";
    }
    return '<div class="stack"><div class="label">Round length</div><div class="seg">' + opts.map(function (ms) {
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
    var note = !on.length ? (room ? "Everyone votes for up to 3 packs" : isHost ? "Pick at least one pack to start" : "Waiting for the host to pick packs")
      : short ? "Not enough songs for this many turns: pick more packs or lower the rounds"
      : room ? "The top 3 packs play. Small ties all play." : "No song is played twice in a game.";
    var mode = isHost
      ? '<div class="seg packmode"><button class="pmode" data-m="host" aria-pressed="' + !room + '">Host picks</button><button class="pmode" data-m="room" aria-pressed="' + room + '">Room picks</button></div>'
      : "";
    var btn = room ? (s.myPackVotes.length ? "Change votes" : "Vote for song packs") : (isHost ? "Select song packs" : "See packs");
    var r = rankingList(s).slice(0, 3);
    var body = room
      ? (r.length ? r.map(function (x) { return '<p class="small">' + esc(x.p.name) + ", " + x.n + (x.n === 1 ? " vote" : " votes") + "</p>"; }).join("") : '<p class="small">No votes yet</p>')
      : '<p class="title">' + esc(packSummaryLine(on)) + "</p>";
    return '<div class="stack"><div class="label">Songs</div>' + mode + '<div class="packline">' + body + '<p class="small">' + esc(note) + "</p></div>" +
      '<button class="btn btn--outline" id="openPacks">' + btn + "</button></div>";
  }

  // Guests see one quiet line about the songs and, in room mode, a way to vote.
  function guestSongsHtml(s) {
    var room = s.packMode === "room";
    var on = s.packs.filter(function (p) { return s.selectedPacks.indexOf(p.id) !== -1; });
    var line = room ? (rankingList(s).length ? "Leading: " + rankingList(s).slice(0, 3).map(function (x) { return x.p.name; }).join(", ") : "No votes yet") : packSummaryLine(on);
    return '<div class="stack"><div class="label">Songs</div><p class="title">' + esc(line) + "</p>" +
      (room ? '<button class="btn btn--outline" id="openPacks">' + (s.myPackVotes.length ? "Change votes" : "Vote for song packs") + "</button>"
            : '<div><button class="txt" id="openPacks">See packs</button></div>') + "</div>";
  }

  function pickerHtml(s, isHost) {
    var room = s.packMode === "room", votes = s.packVotes || {};
    var all = s.packs.length === s.selectedPacks.length;
    var mine = s.myPackVotes || [];
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
    var intro = room ? "Pick up to 3. The most popular play first." : isHost ? "Pick as many as you like. They decide which songs come up." : "The host picks the packs.";
    var count = room ? mine.length + " of 3 votes used" : s.selectedPacks.length + " of " + s.packs.length + " packs picked";
    return '<div class="picker" id="picker"><div class="pwrap">' +
      '<div class="phead"><div class="toprow"><span class="label">Song packs</span><button class="txt" id="pkDone">Done</button></div>' +
      '<h1 class="headline">' + (room ? "Vote for the packs you want" : isHost ? "Choose the packs to play" : "The packs in play") + "</h1>" +
      '<div class="stack" style="gap:2px"><p class="small">' + intro + '</p><p class="small">' + count + "</p></div>" +
      (isHost ? '<div class="seg packmode"><button class="pmode" data-m="host" aria-pressed="' + !room + '">Host picks</button><button class="pmode" data-m="room" aria-pressed="' + room + '">Room picks</button></div>' : "") +
      (isHost && !room ? '<div><button class="txt" id="packAll" style="padding-left:0">' + (all ? "Clear all" : "Select all packs") + "</button></div>" : "") + "</div>" +
      '<div class="pbody"><div>' + html + "</div></div>" +
    "</div></div>";
  }

  function startNote(s, turns) {
    if (s.players.length < s.minPlayers) { return "Waiting for at least " + s.minPlayers + " players"; }
    if (!s.selectedPacks.length) { return s.packMode === "room" ? "Waiting for votes on the song packs" : "Pick at least one song pack to start"; }
    if (s.songsInPlay < turns + 5) { return "Not enough songs for this many turns. Pick more packs or lower the rounds."; }
    var off = s.players.filter(function (p) { return p.mic === "off"; }).map(function (p) { return p.name; });
    if (off.length) { return off.join(" and ").replace(/^(.*), /, "$1, ") + (off.length > 1 ? " have their mics off" : " has their mic off") + ". They can still type guesses."; }
    return "";
  }

  function songsLine(s) {
    var room = s.packMode === "room";
    var on = s.packs.filter(function (p) { return s.selectedPacks.indexOf(p.id) !== -1; });
    if (room) { var r = rankingList(s); return r.length ? "Leading: " + r.slice(0, 3).map(function (x) { return x.p.name; }).join(", ") : "No votes yet"; }
    return packSummaryLine(on);
  }
  function songsRowHtml(s, isHost) {
    var room = s.packMode === "room";
    var cue = room ? (s.myPackVotes.length ? "Change votes" : "Vote") : isHost ? "Choose" : "See";
    return '<button class="lrow" id="openPacks"><span class="lrow__t"><span class="label">Songs' + (room ? ", room picks" : "") + '</span><span class="title">' + esc(songsLine(s)) + '</span></span><span class="lrow__c label">' + cue + "</span>" + ico("chevron", "chev") + "</button>";
  }
  function settingsText(s) {
    return s.rounds + (s.rounds === 1 ? " round" : " rounds") + ", " + (LEN_LABEL[s.limitMs] || s.limitMs / 1000 + " s") + " each";
  }
  function settingsRowHtml(s, isHost) {
    if (!isHost) { return '<div class="lrow lrow--static" id="guestSettings"><span class="lrow__t"><span class="label">Game</span><span class="title">' + settingsText(s) + "</span></span></div>"; }
    return '<button class="lrow" id="openSettings"><span class="lrow__t"><span class="label">Game settings</span><span class="title" id="settingsLine">' + settingsText(s) + '</span></span><span class="lrow__c label">Change</span>' + ico("chevron", "chev") + "</button>";
  }
  function settingsSheetHtml(s, turns) {
    var opts = s.limitOptions || [30000, 60000, 90000, 120000];
    return '<div class="sheetwrap"><div class="scrim" id="setScrim"></div><div class="sheet"><span class="label">Game settings</span>' +
      '<div class="setrow"><div><div class="label">Rounds</div><p class="small">' + turns + " turns in all</p></div>" +
      '<div class="stepper"><button id="minus" class="txt" aria-label="Fewer rounds">Less</button><span class="title val" id="roundsVal">' + s.rounds + '</span><button id="plus" class="txt" aria-label="More rounds">More</button></div></div>' +
      '<div class="stack"><div class="label">Round length</div><div class="seg">' + opts.map(function (ms) {
        return '<button class="segb' + (ms === s.limitMs ? " on" : "") + '" aria-pressed="' + (ms === s.limitMs) + '" data-ms="' + ms + '">' + LEN_LABEL[ms] + "</button>";
      }).join("") + "</div></div>" +
      '<button class="btn" id="setDone">Done</button></div></div>';
  }

  function viewLobby(s) {
    var isHost = s.hostId === s.me;
    var turns = s.rounds * s.players.length;
    var cells = s.players.map(function (p) {
      return '<div class="pcell">' + avatarHtml(s, p, "avatar--md") + '<span class="pn"><span class="title">' + esc(p.name) +
        (p.id === s.hostId ? '<span class="tag">Host</span>' : "") + '</span><span class="label">' + micLabel(p) + "</span></span></div>";
    }).join("");
    return {
      key: "lobby", field: "pink",
      html:
        '<div class="screen">' +
          '<div class="head"><h1 class="headline">' + esc(pname(s, s.hostId)) + "'s game</h1>" +
            '<p class="small">' + s.players.length + " of " + s.maxPlayers + " players are in</p></div>" +
          '<div class="pgrid">' + cells + "</div>" +
          '<div class="lrows">' + songsRowHtml(s, isHost) + settingsRowHtml(s, isHost) + "</div>" +
          '<div class="micline" data-mic></div>' +
          '<div class="spacer"></div>' +
          (isHost
            ? '<button id="startBtn" class="btn"' + (s.players.length < s.minPlayers || !s.selectedPacks.length || s.songsInPlay < turns + 5 ? " disabled" : "") + ">Start game</button>" +
              (startNote(s, turns) ? '<p class="small center startnote">' + esc(startNote(s, turns)) + "</p>" : "")
            : '<p class="title center">Waiting for ' + esc(pname(s, s.hostId)) + " to start</p>") +
          '<div class="rowc"><button id="helpBtn" class="txt">How to play</button>' +
          '<button id="leaveBtn" class="txt">Leave game</button></div>' +
          (pickerOpen ? pickerHtml(s, isHost) : "") +
          (settingsOpen && isHost ? settingsSheetHtml(s, turns) : "") +
        "</div>",
      bind: function () {
        $("#helpBtn").onclick = showHelp;
        var sr = $("#openSettings");
        if (sr) { sr.onclick = function () { settingsOpen = true; render(); }; }
        if (settingsOpen && isHost) {
          $("#setDone").onclick = function () { settingsOpen = false; render(); };
          $("#setScrim").onclick = function () { settingsOpen = false; render(); };
        }
        $("#openPacks").onclick = function () { pickerOpen = true; keepPickerScroll = false; render(); };
        if (pickerOpen) {
          $("#pkDone").onclick = function () { pickerOpen = false; render(); };
          var rows = document.querySelectorAll(".pgroup__row");
          for (var g = 0; g < rows.length; g++) {
            rows[g].onclick = function () { var n = this.getAttribute("data-g"); openGroups[n] = !openGroups[n]; render(); };
          }
          var cardsEl = document.querySelectorAll(".pack");
          if (s.packMode === "room") {
            var mine = (s.myPackVotes || []).slice();
            for (var c2 = 0; c2 < cardsEl.length; c2++) {
              cardsEl[c2].onclick = function () {
                var id = this.getAttribute("data-id"), at = mine.indexOf(id);
                if (at === -1) { if (mine.length >= 3) { toast("You can vote for up to 3 packs."); return; } mine.push(id); }
                else { mine.splice(at, 1); }
                send({ t: "votePacks", packs: mine.slice() });
              };
            }
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
      return base + ", " + (T.playerId === s.me ? "you are whistling" : pname(s, T.playerId) + " is whistling");
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
      '<button id="endBtn" class="btn btn--outline">End game</button>' +
      '<button class="txt" id="hmClose" style="align-self:center">Close</button></div>';
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
    var cue = t.hints ? "Hint " + t.hints + " of 3" : "No hints yet";
    setAction("askHintBtn", cue, done ? "Asked" : asked ? "Asked" : "Ask",
      done ? "No more hints" : asked ? "Hint asked" : "Ask for a hint",
      done ? "All three hints given" : "Sends a request to the whistler", done || asked);
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
    var sub = (t.pending && t.pending.heard ? "Heard “" + t.pending.heard + "”. " : "") + "Tap everyone who got it right. Each of them earns half the points.";
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
          '<p class="small">A harder song earns bonus points. Only you can see these. Keep your screen to yourself.</p></div>' +
          '<div class="stack">' + offs + "</div>" +
          (T.canRefresh ? '<button id="refreshBtn" class="btn btn--outline">Refresh options</button>' +
            '<p class="small center">Don\'t know any of these? Refresh once for three new songs.</p>' : "") +
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
          '<p class="small">Only you can see this. Tap Ready and a 3, 2, 1 countdown starts for everyone.</p>' +
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
          '<p class="small">' + (T.difficulty ? "A 3, 2, 1 countdown starts as soon as they tap Ready." : "Get ready to guess. Say the title out loud or type it.") + "</p>" +
          '<div class="micline" data-mic></div></div>' + skipHtml(s) + "</div>",
        bind: bindSkip
      };
    }

    // 4. Countdown for everyone
    if (T.stage === "countdown") {
      return {
        key: "cd-" + T.id, field: "green",
        html: '<div class="screen">' + topBar(s) +
          '<div class="cdwrap"><div class="cdcircle"><div class="numeral" id="cd">3</div></div></div>' +
          '<h1 class="headline center">' + (isW ? "Get ready to whistle" : "Get ready to guess " + esc(who)) + "</h1>" +
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
          '<div class="ovl" id="confirm" hidden><div class="scrim"></div><div class="sheet"><span class="label">Who got it?</span>' +
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
          actionHtml("askHintBtn", "No hints yet", "Ask", "Ask for a hint", "Sends a request to the whistler") +
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
          '<p class="small">Someone may have got it. Waiting for the whistler to confirm.</p></div></div>',
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
      sub = guessers.length ? guessers.map(esc).join(", ").replace(/, ([^,]*)$/, " and $1") + " named it and earn " + pts(gAwards[0].points) + " each" : "";
    } else if (R.outcome === "timeout") {
      head = "Time's up";
      sub = "Nobody guessed " + esc(who) + "'s song, so it scores nothing.";
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
        '<div class="board rvhide" id="board">' + standingsHtml(s, R.awards, null, { change: true, limit: lim }) + "</div>" +
        '<div class="spacer"></div>' +
        '<p class="small center" id="nextIn"></p>' +
        (s.hostId === s.me
          ? '<button id="nextBtn" class="btn">' + (last ? "Skip to final scores" : "Next round") + "</button>"
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
               : '<p class="title awardcard__p">Bonus held back to keep the lead</p>') + "</div>" +
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
        awardState.timer = setTimeout(function () { awardAdvance(st); }, 2600);
        $("#awardNext").onclick = function () { awardAdvance(st); };
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
    var head = names.length > 1 ? "It's a draw: " + names.map(esc).join(" and ") : esc(names[0] || "Nobody") + " wins";
    return {
      key: "over", field: "yellow",
      html: '<div class="screen">' +
        '<div class="label">Game over</div>' +
        '<div class="head"><h1 class="display">' + head + "</h1>" +
        (s.tieBreakWon ? '<p class="small">Settled in a tie-break.</p>' : "") + "</div>" +
        '<div class="stack"><div class="label">Final scores</div>' + standingsHtml(s, bonuses, s.winners, { bonus: true }) + "</div>" +
        (bonuses.length ? '<p class="small">Bonus points from the awards are included.' + (s.bonusCapped ? " A big lead cannot be overturned by bonuses." : "") + "</p>" : "") +
        '<div class="spacer"></div>' +
        (isHost ? '<button id="againBtn" class="btn">Play again</button>' : '<p class="title center">Waiting for ' + esc(pname(s, s.hostId)) + "</p>") +
        '<button id="leaveBtn" class="txt" style="align-self:center">Leave room</button></div>',
      bind: function () {
        var a = $("#againBtn"); if (a) { a.onclick = function () { send({ t: "playAgain" }); }; }
        $("#leaveBtn").onclick = leaveRoom;
      }
    };
  }

  function showHelp() {
    var o = document.createElement("div");
    o.className = "sheetwrap";
    var steps = [
      "Whistle it. Only you can see the song.",
      "Everyone else shouts or types guesses. The quicker they get it, the more it is worth.",
      "Say who got it. You and everyone you name earn points."
    ];
    o.innerHTML = '<div class="scrim" id="helpScrim"></div><div class="sheet"><span class="label">How to play</span>' +
      '<p class="title">A guess at the start is worth 1000 points, and the value falls as the clock runs.</p>' +
      '<ol class="steps">' + steps.map(function (t, i) { return "<li><b>" + (i + 1) + '</b><span class="small">' + t + "</span></li>"; }).join("") + "</ol>" +
      '<p class="small">Harder songs earn bonus points. A shuffle costs 100 points and hints cost 50, 100 and 150. After the last round, awards give bonus points.</p>' +
      '<button class="btn" id="helpClose">Done</button></div>';
    document.body.appendChild(o);
    var close = function () { if (o.parentNode) { o.parentNode.removeChild(o); } };
    $("#helpClose", o).onclick = close; $("#helpScrim", o).onclick = close;
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

  function render() {
    var view;
    if (st && st.phase !== "lobby") { pickerOpen = false; }
    var pb = document.querySelector(".pbody"), pTop = pb ? pb.scrollTop : 0;
    if (!st && adminLogin) { view = viewAdminLogin(); }
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
        if (fr.final && !sn.classList.contains("slam")) { sn.classList.add("slam"); try { if (navigator.vibrate) { navigator.vibrate(R.score > 0 ? [60, 40, 90] : 40); } } catch (e) {} }
        var late = ms >= fr.finalAt + 300;
        var bd = $("#board");
        if (bd) { bd.classList.toggle("rvhide", !late); }
      }
      var ni = $("#nextIn");
      if (ni) {
        var rem = T.nextAt ? T.nextAt - nowS() : null, last = st.turnNumber >= st.totalTurns;
        var nt = rem !== null && rem <= 5000 ? (last ? "Final scores in " : "Next round in ") + Math.max(1, Math.ceil(rem / 1000)) : "";
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
        if (sec !== lastSecond) { lastSecond = sec; try { if (navigator.vibrate) { navigator.vibrate(40); } } catch (e) {} }
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
