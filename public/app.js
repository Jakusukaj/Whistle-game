(function () {
  "use strict";

  var app = document.getElementById("app");
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  var ws = null, connected = false, session = null, rejoining = false, pendingName = "";
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
    } else if (m.t === "joined") {
      session = { code: m.code, playerId: m.playerId, name: pendingName || (session && session.name) || "" };
      saveSession(); rejoining = false; keepAwake();
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

  function micHtml() {
    switch (mic.state) {
      case "unsupported":
        return '<span class="chip">Typing only on this phone</span>';
      case "off":
        return '<button id="micBtn" class="btn teal">Turn on mic</button><p class="note">Lets this phone hear guesses. You can also type them.</p>';
      case "starting":
        return '<span class="chip">Starting mic...</span>';
      case "on":
        return '<span class="chip ok">Mic on</span>';
      case "blocked":
        return '<span class="chip bad">Mic blocked</span><p class="note">Allow the microphone for this site in your browser settings, then reload. You can still type guesses.</p>';
      default:
        return '<button id="micBtn" class="btn teal">Mic stopped. Tap to restart</button>';
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
    if (orb) { orb.classList.toggle("off", mic.state !== "on"); }
    var hd = $("#listenHead");
    if (hd) { hd.textContent = mic.state === "on" ? "Listening" : mic.state === "blocked" ? "Mic blocked" : "Mic is off"; }
  }

  var MIC_SVG = '<svg viewBox="0 0 24 24" width="64" height="64" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3" fill="#1b3447"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4M8 22h8" fill="none" stroke="#1b3447" stroke-width="2" stroke-linecap="round"/></svg>';

  // ----------------------------------------------------------------- views
  function standingsHtml(s, highlightLast, winners) {
    var list = s.players.slice().sort(function (a, b) { return a.total - b.total; });
    var rank = 0, prev = null, html = "";
    list.forEach(function (p, i) {
      if (prev === null || p.total !== prev) { rank = i + 1; }
      prev = p.total;
      var cls = "brow" + (p.id === s.me ? " me" : "") + (winners && winners.indexOf(p.id) !== -1 ? " win" : "");
      var last = highlightLast && s.turn && s.turn.playerId === p.id && p.last !== null ? '<span class="ls">+' + fmt(p.last) + "s</span>" : "";
      html += '<div class="' + cls + '"><span class="rk">' + rank + '</span><span class="nm">' + esc(p.name) + "</span>" +
        '<span class="tm">' + fmt(p.total) + "s" + last + "</span></div>";
    });
    return '<div class="board">' + html + "</div>";
  }

  function viewHome() {
    var name = ""; try { name = localStorage.getItem("whistle.name") || ""; } catch (e) {}
    return {
      key: "home",
      html:
        '<div class="screen">' +
          '<div class="logo">Whistle</div>' +
          '<p class="tag">Keep a straight face. Keep whistling.</p>' +
          '<div class="card stack">' +
            '<label class="lbl" for="name">Your name</label>' +
            '<input id="name" class="input" maxlength="14" autocomplete="off" autocapitalize="words" placeholder="Name" value="' + esc(name) + '">' +
            '<button id="hostBtn" class="btn">Host a game</button>' +
            '<div class="or">or join a room</div>' +
            '<input id="codeIn" class="input code-in" maxlength="4" autocomplete="off" autocapitalize="characters" placeholder="CODE">' +
            '<button id="joinBtn" class="btn teal">Join room</button>' +
          "</div>" +
          '<button id="helpBtn" class="link">How to play</button>' +
        "</div>",
      bind: function () {
        function nameVal() {
          var n = $("#name").value.replace(/\s+/g, " ").trim();
          if (!n) { toast("Enter your name first."); $("#name").focus(); return ""; }
          try { localStorage.setItem("whistle.name", n); } catch (e) {}
          pendingName = n;
          return n;
        }
        $("#hostBtn").onclick = function () { var n = nameVal(); if (n) { send({ t: "create", name: n }); } };
        $("#joinBtn").onclick = function () {
          var n = nameVal(); if (!n) { return; }
          var c = $("#codeIn").value.trim();
          if (c.length < 4) { toast("Enter the 4 letter room code."); return; }
          send({ t: "join", code: c, name: n });
        };
        $("#codeIn").oninput = function () { this.value = this.value.toUpperCase().replace(/[^A-Z]/g, ""); };
        $("#helpBtn").onclick = showHelp;
      }
    };
  }

  var LEN_LABEL = { 30000: "30s", 60000: "1 min", 90000: "1 min 30", 120000: "2 min" };
  function lengthHtml(s, isHost) {
    var opts = s.limitOptions || [30000, 60000, 90000, 120000];
    if (!isHost) { return '<div class="center h2" id="limitVal">' + (LEN_LABEL[s.limitMs] || s.limitMs / 1000 + "s") + "</div>"; }
    return '<div class="seg">' + opts.map(function (ms) {
      return '<button class="segb' + (ms === s.limitMs ? " on" : "") + '" data-ms="' + ms + '">' + LEN_LABEL[ms] + "</button>";
    }).join("") + "</div>";
  }

  var TICK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 12.5 10 18.5 20 6"/></svg>';

  function packsHtml(s, isHost) {
    var all = (s.packs || []).length === (s.selectedPacks || []).length;
    var cards = (s.packs || []).map(function (p) {
      var on = s.selectedPacks.indexOf(p.id) !== -1;
      return '<button class="pack' + (on ? " on" : "") + (isHost ? "" : " ro") + '" data-id="' + p.id + '" aria-pressed="' + on +
        '" style="background:' + p.colour + ";color:" + p.ink + '">' +
        '<span class="tick">' + TICK_SVG + "</span>" +
        '<span class="pn">' + esc(p.name) + '</span><span class="pb">' + esc(p.blurb) + '</span>' +
        '<span class="pc">' + p.count + " songs</span></button>";
    }).join("");
    var need = s.rounds * s.players.length + 5;
    var short = s.songsInPlay < need;
    return '<div class="card stack"><div class="packhead"><div class="top">Song packs</div>' +
      (isHost ? '<button class="packall" id="packAll">' + (all ? "Just Bangers" : "Select all") + "</button>" : "") + "</div>" +
      '<div class="packs" id="packs">' + cards + "</div>" +
      '<div class="packnote' + (short ? " bad" : "") + '" id="packNote">' +
        (short ? "Only " + s.songsInPlay + " songs: tick more packs or lower the rounds"
               : s.songsInPlay + " songs in play. No song is played twice.") + "</div>" +
      (isHost ? "" : '<p class="note center">The host picks the packs</p>') + "</div>";
  }

  function viewLobby(s) {
    var isHost = s.hostId === s.me;
    var turns = s.rounds * s.players.length;
    var list = s.players.map(function (p) {
      return '<div class="pl"><span class="dot' + (p.connected ? " on" : "") + '"></span><span class="nm">' + esc(p.name) + "</span>" +
        (p.id === s.hostId ? '<span class="tagc">HOST</span>' : "") +
        (p.id === s.me ? '<span class="tagc you">YOU</span>' : "") + "</div>";
    }).join("");
    return {
      key: "lobby",
      html:
        '<div class="screen">' +
          '<div class="top">Room code</div>' +
          '<div class="card codecard"><div class="code" id="roomCode">' + esc(s.code) + "</div>" +
            '<div class="note">Everyone joins at this web address with this code</div></div>' +
          '<div class="top">Players (' + s.players.length + " of " + s.maxPlayers + ")</div>" +
          '<div class="plist">' + list + "</div>" +
          packsHtml(s, isHost) +
          '<div class="card stack">' +
            '<div class="top">Rounds</div>' +
            (isHost
              ? '<div class="stepper"><button id="minus" class="btn">-</button><div class="val" id="roundsVal">' + s.rounds + '</div><button id="plus" class="btn">+</button></div>'
              : '<div class="center h1" id="roundsVal">' + s.rounds + "</div>") +
            '<p class="note center">Everyone whistles once per round: ' + turns + " turns in all</p>" +
          "</div>" +
          '<div class="card stack"><div class="top">Round length</div>' + lengthHtml(s, isHost) + "</div>" +
          '<div class="stack" data-mic></div>' +
          '<div class="spacer"></div>' +
          (isHost
            ? '<button id="startBtn" class="btn"' + (s.players.length < s.minPlayers || s.songsInPlay < turns + 5 ? " disabled" : "") + ">Start game</button>" +
              (s.players.length < s.minPlayers ? '<p class="note center">Waiting for at least ' + s.minPlayers + " players</p>" : "")
            : '<p class="sub center">Waiting for ' + esc(pname(s, s.hostId)) + " to start...</p>") +
          '<button id="helpBtn" class="btn ghost">How to play</button>' +
          '<button id="leaveBtn" class="link">Leave room</button>' +
        "</div>",
      bind: function () {
        $("#helpBtn").onclick = showHelp;
        if (isHost) {
          var want = s.rounds;
          $("#minus").onclick = function () { want = Math.max(1, want - 1); send({ t: "setRounds", rounds: want }); };
          $("#plus").onclick = function () { want = Math.min(10, want + 1); send({ t: "setRounds", rounds: want }); };
          $("#startBtn").onclick = function () { send({ t: "start" }); };
          var sel = s.selectedPacks.slice(), allIds = s.packs.map(function (p) { return p.id; });
          var sendPacks = function () { send({ t: "setPacks", packs: sel }); };
          var cardsEl = document.querySelectorAll(".pack");
          for (var c = 0; c < cardsEl.length; c++) {
            cardsEl[c].onclick = function () {
              var id = this.getAttribute("data-id"), at = sel.indexOf(id);
              if (at === -1) { sel.push(id); }
              else if (sel.length > 1) { sel.splice(at, 1); }
              else { toast("Keep at least one pack ticked."); return; }
              this.classList.toggle("on", sel.indexOf(id) !== -1);
              sendPacks();
            };
          }
          $("#packAll").onclick = function () {
            if (sel.length === allIds.length) { sel = [allIds[0]]; } else { sel = allIds.slice(); }
            sendPacks();
          };
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
    return T.sd ? "Tie-break round " + s.sdRound : "Round " + T.round + " of " + s.rounds + " - Turn " + s.turnNumber + " of " + s.totalTurns;
  }

  function topBar(s) {
    return '<div class="top" id="topLabel">' + esc(topLabel(s)) + '</div><div id="lastRound"></div>';
  }

  // Kept up to date on every state change, even when the screen itself is not redrawn.
  function refreshTop() {
    if (!st || !st.turn) { return; }
    var l = $("#topLabel"); if (l) { l.textContent = topLabel(st); }
    var b = $("#lastRound"); if (!b) { return; }
    var show = st.hostId === st.me && !st.turn.sd && !st.suddenDeath && st.turn.round === st.rounds;
    var has = !!$("#addRound");
    if (show && !has) {
      b.innerHTML = '<button id="addRound" class="lastbanner">Last round. Tap to add an extra round</button>';
      $("#addRound").onclick = function () { send({ t: "addRound" }); };
    } else if (!show && has) { b.innerHTML = ""; }
  }

  function skipHtml(s) {
    if (s.hostId !== s.me) { return ""; }
    return '<div class="row">' +
      (s.turn.stage !== "reveal" ? '<button id="skipBtn" class="link small">Skip this turn</button>' : "") +
      '<button id="endBtn" class="link small">End game</button></div>';
  }

  function bindSkip() {
    var b = $("#skipBtn");
    if (b) { b.onclick = function () { if (window.confirm("Skip this turn? It scores the full 60 seconds.")) { send({ t: "skip" }); } }; }
    var e = $("#endBtn");
    if (e) { e.onclick = function () { if (window.confirm("End this game? Everyone goes back to the lobby and scores are cleared.")) { send({ t: "cancelGame" }); } }; }
  }

  function lockHtml(note) {
    return '<div class="lockov" id="lock" hidden><div class="lk1">SHUFFLE!</div><div class="lk2">5s penalty</div>' +
      '<div class="lknum" id="lknum">5</div><div class="lk3">' + note + "</div></div>";
  }

  function songCardHtml(T) {
    var d = T.difficulty;
    return '<div class="card songcard"><div class="chips"><span class="chip ok">' + esc(d) + " x" + T.multiplier + "</span></div>" +
      '<div class="t" id="songTitle">' + esc(T.song ? T.song.title : "") + "</div>" +
      '<div class="a" id="songArtist">' + esc(T.song ? T.song.artist : "") + "</div></div>";
  }

  function viewTurn(s) {
    var T = s.turn, isW = T.playerId === s.me, who = pname(s, T.playerId);

    // 1. Whistler choosing one of three songs
    if (T.stage === "choose" && isW && !T.difficulty) {
      var offs = (T.options || []).map(function (o, i) {
        var off = Math.round((1 - o.multiplier) * 100);
        return '<button class="opt" data-i="' + i + '" data-d="' + o.difficulty + '"><span class="od">' + o.difficulty +
          (off ? " - " + off + "% off your time" : " - normal score") + '</span><span class="ot">' + esc(o.title) +
          '</span><span class="oa">' + esc(o.artist) + "</span></button>";
      }).join("");
      return {
        key: "choose-" + T.id,
        html: '<div class="screen">' + topBar(s) +
          '<div class="h1">' + esc(who) + ", you're up!</div>" +
          '<p class="sub">Pick a song. Choosing a harder song gives you a better score.</p>' + offs +
          '<p class="note center">Only you can see these. Keep your screen to yourself.</p>' +
          '<div class="spacer"></div>' + skipHtml(s) + "</div>",
        bind: function () {
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
        key: "ready-" + T.id,
        html: '<div class="screen">' + topBar(s) +
          '<div class="h1">Your song</div>' + songCardHtml(T) +
          '<p class="note center">Only you can see this. Stuck once the clock is running? Shuffle gives you a new song but locks your screen for ' + T.penalty + ' seconds.</p>' +
          '<div class="spacer"></div>' +
          '<button id="readyBtn" class="btn">Ready?</button>' + skipHtml(s) + "</div>",
        bind: function () {
          $("#readyBtn").onclick = function () { send({ t: "ready" }); };
          bindSkip();
        }
      };
    }

    // 3. Everyone else while the whistler chooses
    if (T.stage === "choose") {
      return {
        key: "wait-" + T.id,
        html: '<div class="screen">' + topBar(s) +
          '<div class="h1">' + esc(who) + " is picking a song</div>" +
          '<p class="sub">Get ready to guess. Say the title out loud or type it.</p>' +
          '<div class="stack" data-mic></div><div class="spacer"></div>' + skipHtml(s) + "</div>",
        bind: bindSkip
      };
    }

    // 4. Countdown for everyone
    if (T.stage === "countdown") {
      return {
        key: "cd-" + T.id,
        html: '<div class="screen">' + topBar(s) +
          '<div class="h2 center">' + (isW ? "Get ready to whistle" : "Get ready to guess " + esc(who)) + "</div>" +
          '<div class="cd" id="cd">3</div>' + (isW ? songCardHtml(T) : '<div class="stack" data-mic></div>') +
          '<div class="spacer"></div>' + skipHtml(s) + "</div>",
        bind: bindSkip
      };
    }

    // 5. Whistling or confirming, whistler's phone
    if ((T.stage === "whistling" || T.stage === "confirming") && isW) {
      return {
        key: "w-" + T.id,
        html: '<div class="screen">' + topBar(s) +
          '<div class="timerbox"><div class="tlabel" id="tlabel">TIME</div><div class="bigtime" id="bigtime">0.0</div>' +
          '<div class="bar"><i id="bar"></i></div></div>' + songCardHtml(T) +
          '<div class="spacer"></div>' +
          '<div class="row"><button id="shuffleBtn" class="btn teal">Shuffle (' + T.penalty + 's penalty)</button>' +
          '<button id="gotBtn" class="btn navy">Someone got it</button></div>' + skipHtml(s) +
          lockHtml("New song coming up.") +
          '<div class="overlay" id="confirm" hidden><div class="card"><div class="h2">Did they get it?</div>' +
          '<p class="sub">Heard: <b id="heardTxt"></b></p>' +
          '<button id="yesBtn" class="btn">Yes, that\'s it</button><button id="noBtn" class="btn ghost">No, keep going</button></div></div></div>',
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
        key: "g-" + T.id + (mic.typeMode ? "-t" : "-m"),
        html: '<div class="screen">' + topBar(s) +
          '<div class="timerbox"><div class="tlabel" id="tlabel">TIME</div><div class="bigtime" id="bigtime">0.0</div>' +
          '<div class="bar"><i id="bar"></i></div></div>' +
          (mic.typeMode
            ? '<div class="card stack"><div class="h2">Type your guess</div>' +
              '<form id="gform" class="stack"><input id="ginput" class="input" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Type the song title">' +
              '<button class="btn" type="submit">Send guess</button></form>' +
              (SR ? '<button id="toMic" class="link">\u2190 Go back to mic mode</button>' : "") + "</div>"
            : '<div class="card stack center"><div class="orb off" id="orb">' + MIC_SVG + '</div>' +
              '<div class="h1" id="listenHead">Listening</div>' +
              '<p class="sub">Shout your guesses! The game pauses by itself when it hears the right answer.</p>' +
              '<div data-mic="quiet"></div><div class="heard" id="heard"></div></div>' +
              '<button id="toType" class="link">Mic not working? Type your answer \u2192</button>') +
          '<div class="spacer"></div>' + skipHtml(s) +
          lockHtml("Song changing. Guessing is paused.") +
          '<div class="overlay" id="checking" hidden><div class="card"><div class="h2">Checking...</div>' +
          '<p class="sub">Someone may have got it. Hold tight.</p></div></div></div>',
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
    var R = T.result, p = player(s, T.playerId), head, lines = "";
    if (R.outcome === "correct") {
      head = esc(who) + " got it!";
      lines = "Time " + fmt(R.timeMs / 1000) + "s" + (R.difficulty ? " x " + R.multiplier + " (" + R.difficulty + ")" : "") +
        (R.shuffles ? " + " + (R.shuffles * T.penalty) + "s for " + R.shuffles + " shuffle" + (R.shuffles > 1 ? "s" : "") : "");
    } else if (R.outcome === "timeout") {
      head = "Time's up!";
      lines = "Nobody guessed " + esc(who) + "'s song, so it scores the full " + fmt(R.timeMs / 1000) + "s.";
    } else {
      head = "Turn skipped";
      lines = esc(who) + " scores the full " + fmt(R.timeMs / 1000) + "s.";
    }
    var last = s.turnNumber >= s.totalTurns;
    return {
      key: "reveal-" + T.id + "-" + s.totalTurns,
      html: '<div class="screen">' + topBar(s) +
        '<div class="winline">' + head + "</div>" +
        (R.song ? '<div class="card songcard"><div class="note">The song was</div><div class="t">' + esc(R.song.title) + '</div><div class="a">' + esc(R.song.artist) + "</div></div>" : "") +
        '<div class="card stack"><div class="breakdown">' + lines + '</div><div class="score">' + fmt(R.score) + "s</div></div>" +
        '<div class="top">' + (T.sd ? "Tie-break" : "Standings") + "</div>" + standingsHtml(s, !T.sd, null) +
        '<div class="spacer"></div>' +
        (s.hostId === s.me
          ? '<button id="nextBtn" class="btn">' + (last ? "Finish" : "Next player") + "</button>"
          : '<p class="sub center">Waiting for ' + esc(pname(s, s.hostId)) + "...</p>") + skipHtml(s) + "</div>",
      bind: function () { var b = $("#nextBtn"); if (b) { b.onclick = function () { send({ t: "next" }); }; } bindSkip(); }
    };
  }

  function viewOver(s) {
    var isHost = s.hostId === s.me;
    var names = (s.winners || []).map(function (id) { return pname(s, id); });
    var head = names.length > 1 ? "It's a draw: " + names.map(esc).join(" and ") : esc(names[0] || "Nobody") + " wins!";
    return {
      key: "over",
      html: '<div class="screen"><div class="top">Game over</div>' +
        '<div class="h1">' + head + "</div>" +
        (s.tieBreakWon ? '<p class="sub">Settled in a tie-break.</p>' : "") +
        '<div class="top">Final scores (lower is better)</div>' + standingsHtml(s, false, s.winners) +
        '<div class="spacer"></div>' +
        (isHost ? '<button id="againBtn" class="btn">Play again</button>' : '<p class="sub center">Waiting for ' + esc(pname(s, s.hostId)) + "...</p>") +
        '<button id="leaveBtn" class="link">Leave room</button></div>',
      bind: function () {
        var a = $("#againBtn"); if (a) { a.onclick = function () { send({ t: "playAgain" }); }; }
        $("#leaveBtn").onclick = leaveRoom;
      }
    };
  }

  function showHelp() {
    var o = document.createElement("div");
    o.className = "overlay modal";
    o.innerHTML = '<div class="card stack"><div class="h2">How to play</div>' +
      "<p class=\"sub\">The aim of the game is to get everyone to guess your song as quickly as possible. Points are the seconds it takes, so more seconds means more points \u2013 but in this game the fewest points wins!</p><ol>" +
      "<li>On your turn, pick one of three songs: Easy, Medium or Hard. Harder songs take points off your time.</li>" +
      "<li>You'll see a song on your phone. Whistle it! Only you can see it \u2013 so don't show anyone else!</li>" +
      "<li>Everyone else shouts (or types) guesses. The clock stops when the mic detects the correct answer.</li>" +
      "<li>Stuck? Shuffle for a new song, but your screen locks for 5 seconds. No guess before time runs out scores the full time.</li>" +
      "<li>After the last round, the lowest total wins.</li>" +
      '</ol><button class="btn" id="helpClose">Got it</button></div>';
    document.body.appendChild(o);
    $("#helpClose", o).onclick = function () { document.body.removeChild(o); };
  }

  // ---------------------------------------------------------------- render
  function render() {
    var view;
    if (!st) { view = viewHome(); }
    else if (st.phase === "lobby") { view = viewLobby(st); }
    else if (st.phase === "turn" && st.turn) { view = viewTurn(st); }
    else { view = viewOver(st); }

    if (view.key === lastKey && view.update) {
      view.update();
    } else {
      app.innerHTML = view.html; lastKey = view.key;
      if (view.bind) { view.bind(); }
      if (view.update) { view.update(); }
    }
    refreshMic();
    refreshTop();
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
    if (orb) { orb.style.setProperty("--lvl", mic.state === "on" ? mic.level.toFixed(2) : "0"); }
    var T = st && st.turn;
    if (!T) { document.body.classList.remove("danger"); return; }
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
      document.body.classList.toggle("danger", danger);
      var big = $("#bigtime"), lab = $("#tlabel"), bar = $("#bar");
      if (big) {
        if (danger) { big.textContent = Math.max(0, Math.ceil(remain / 1000)); if (lab) { lab.textContent = "SECONDS LEFT"; } }
        else { big.textContent = fmt(el / 1000); if (lab) { lab.textContent = "TIME SO FAR"; } }
      }
      if (bar) { bar.style.width = Math.min(100, (el / T.limitMs) * 100) + "%"; }
      if (danger && T.stage === "whistling") {
        var sec = Math.ceil(remain / 1000);
        if (sec !== lastSecond) { lastSecond = sec; try { if (navigator.vibrate) { navigator.vibrate(40); } } catch (e) {} }
      } else { lastSecond = null; }
    } else {
      document.body.classList.remove("danger"); lastSecond = null;
    }
  }

  // ------------------------------------------------------------------ boot
  connect();
  setInterval(function () { send({ t: "ping" }); }, 20000);
  render();
  requestAnimationFrame(tick);
})();
