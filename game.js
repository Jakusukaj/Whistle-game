"use strict";
var analytics = require("./analytics.js");
// Game rules and rooms. No networking in here: server.js hands each message to
// RoomManager.handle(conn, msg), and conn.send(obj) is how replies go back.
//
// Rules in one paragraph: every player whistles once per round. The whistler
// picks easy, medium or hard (point multipliers x1.0, x1.1, x1.2), sees the song
// on their own phone, and the clock runs until the room guesses it (max 60s).
// A quicker guess is worth more: 1000 x (1 - time / limit), shuffle penalties
// count as extra time, then the multiplier applies. The whistler names who got
// it right and each of them earns half of the whistler's points. Guesses come from the other phones, by voice
// or typing, and are checked HERE so the song never reaches a guesser's phone.
// A likely match pauses the clock and asks the whistler to confirm, which keeps
// the answer secret if the detection was wrong. Shuffling for a new song costs
// +5s. Highest total wins; a tie goes to a sudden-death round.

var crypto = require("crypto");
var SONGS = require("./songs.js");
var PACKS = require("./packs.js");
var Matcher = require("./matcher.js");
Matcher.useSongs(SONGS);

var PACK_COUNTS = {};
SONGS.forEach(function (s) { (s.packs || []).forEach(function (id) { PACK_COUNTS[id] = (PACK_COUNTS[id] || 0) + 1; }); });
var PACK_IDS = PACKS.map(function (p) { return p.id; });
var PACK_PICKS = 5;
var SONG_BUFFER = 5; // spare songs a game needs beyond one per turn (shuffles, tie-breaks)

var DEFAULTS = {
  limitMs: 60000,        // a turn that nobody guesses scores nothing
  countdownMs: 3000,     // 3, 2, 1 before the clock starts
  awayMs: 12000,         // a whistler who drops out is skipped after this long unless they come back
  confirmMs: 10000,      // whistler has this long to confirm a detected guess
  cooldownMs: 4000,      // ignore guesses this long after the whistler says "no"
  shufflePoints: 100,    // each shuffle costs this many points, taken off after the multiplier
  hintPoints: [50, 100, 150], // the 1st, 2nd and 3rd hint on a song cost this many points
  multipliers: { easy: 1, medium: 1.1, hard: 1.2 },
  maxPoints: 1000,       // a guess at 0s is worth this before the multiplier
  guesserShare: 0.5,     // each named guesser earns this share of the whistler's points
  revealMs: 13000,       // reveal animation plus the 5 second countdown, then the game moves on (0 turns it off)
  // End-of-game awards. Each gives bonus points, scaled to the game length. A
  // bonus can never lift a player past someone who was clearly ahead (more than
  // closeGap points, scaled the same way) before the bonuses were counted.
  awardBonus: { whistler: 250, guesser: 250, quickest: 150, streak: 150, daredevil: 150 },
  maxBonus: 400,
  closeGap: 300,
  sdDifficulty: "medium",
  sdMaxRounds: 3,
  minPlayers: 2,
  maxPlayers: 20,
  adminPassword: process.env.ADMIN_PASSWORD || "bean",
  defaultRounds: 5,
  minRounds: 1,
  maxRounds: 10,
  roomIdleMs: 15 * 60 * 1000,
  roomMaxAgeMs: 12 * 60 * 60 * 1000
};

// The three hints, in order, from a gentle nudge to nearly obvious. Most songs have their own, written in
// songs-src/hints-*.txt. A song without them falls back to: how long the title is, the year, then who it is by.
// They are built from facts about the song, never its lyrics, and never give away the title.
function hintLines(song) {
  if (song.hints && song.hints.length === 3) { return song.hints.slice(); }
  var words = String(song.title).replace(/\(.*?\)/g, "").split(/\s+/).filter(Boolean).length;
  var packs = song.packs || [], a = song.artist;
  var h3;
  if (a === "TV theme") { h3 = "It is a TV theme tune"; }
  else if (a === "Film theme") { h3 = "It is a film theme"; }
  else if (a === "-" || !a) { h3 = "It is sung at Christmas"; }
  else if (packs.indexOf("disney") !== -1) { h3 = "From \u201c" + a + "\u201d"; }
  else { h3 = "By " + a; }
  return [
    "The title has " + words + (words === 1 ? " word" : " words"),
    song.year ? "From " + song.year : "A traditional carol",
    h3
  ];
}

function round1(x) { return Math.round(x * 10) / 10; }
function newId() { return crypto.randomBytes(8).toString("hex"); }

function cleanName(n) {
  return String(n == null ? "" : n).replace(/[<>&"]/g, "").replace(/\s+/g, " ").trim().slice(0, 14);
}

function RoomManager(options) {
  this.opts = Object.assign({}, DEFAULTS, options || {});
  this.rooms = {};
  this.now = this.opts.now || Date.now;
  this.random = this.opts.random || Math.random;
}

// ------------------------------------------------------------------ helpers
RoomManager.prototype.makeCode = function () {
  var letters = "ABCDEFGHJKLMNPQRSTUVWXYZ", code, i;
  do {
    code = "";
    for (i = 0; i < 4; i++) { code += letters.charAt(Math.floor(this.random() * letters.length)); }
  } while (this.rooms[code]);
  return code;
};

function findPlayer(room, id) {
  for (var i = 0; i < room.players.length; i++) {
    if (room.players[i].id === id) { return room.players[i]; }
  }
  return null;
}

var LIMIT_OPTIONS_MS = [30000, 60000, 90000, 120000];

function err(conn, code, message) { conn.send({ t: "error", code: code, message: message }); }

RoomManager.prototype.elapsed = function (turn) {
  return turn.accumulatedMs + (turn.runningSince !== null ? this.now() - turn.runningSince : 0);
};

// True when the turn in play is the last of its round (or of the whole game), so the leaderboard is shown.
function isRoundEnd(room) {
  var cur = room.turns[room.turnPos], nxt = room.turns[room.turnPos + 1];
  if (!cur || !nxt) { return true; }
  return !!(cur.sd || nxt.sd) || nxt.round !== cur.round;
}

// ------------------------------------------------------------------- views
RoomManager.prototype.viewFor = function (room, pid) {
  var self = this, t = room.turn, tv = null;
  if (t) {
    var isW = t.playerId === pid;
    tv = {
      id: t.id, playerId: t.playerId, stage: t.stage, difficulty: t.difficulty,
      multiplier: t.multiplier, shuffles: t.shuffles, sd: t.sd, round: t.round, roundEnd: isRoundEnd(room), nextId: room.turns[room.turnPos + 1] ? room.turns[room.turnPos + 1].playerId : null,
      countdownEndsAt: t.countdownEndsAt, accumulatedMs: t.accumulatedMs,
      runningSince: t.runningSince, limitMs: room.limitMs,
      penalty: this.opts.shufflePoints, nextAt: t.nextAt || null,
      hints: t.hints || 0, hintCost: t.hintCost || 0,
      nextHintCost: (t.hints || 0) < 3 ? this.opts.hintPoints[t.hints || 0] : null
    };
    if (t.stage === "whistling" || t.stage === "confirming") {
      if (isW) { tv.hintAsks = (t.hintAsks || []).slice(); }
      else { tv.iAsked = (t.hintAsks || []).indexOf(pid) !== -1; }
    }
    if (room.phase === "turn" && !t.sd && !room.sd && t.round === room.rounds) {
      var rv = Object.keys(room.roundVotes || {});
      tv.roundVotes = rv.length; tv.iVotedRound = !!(room.roundVotes || {})[pid];
      tv.roundVoters = room.hostId === pid ? rv : undefined;
    }
    var locked = t.lockUntil && t.lockUntil > this.now();
    if (locked) { tv.lockUntil = t.lockUntil; }
    if (isW && t.options && t.stage === "choose" && !t.difficulty) {
      tv.canRefresh = (t.refreshes || 0) < 3; tv.refreshesLeft = 3 - (t.refreshes || 0);
      tv.options = t.options.map(function (o) {
        return { difficulty: o.difficulty, multiplier: self.opts.multipliers[o.difficulty], title: o.song.title, artist: o.song.artist };
      });
    }
    if (isW && t.song && t.stage !== "reveal" && !locked) { tv.song = { title: t.song.title, artist: t.song.artist }; }
    // Hints go to every phone: they are for the guessers too.
    if (t.song && t.hints && t.stage !== "reveal" && !locked) { tv.hintLines = hintLines(t.song).slice(0, t.hints); }
    if (isW && t.stage === "confirming" && t.pending) { tv.pending = { heard: t.pending.heard, from: t.pending.from || null, manual: !!t.pending.manual }; }
    if (t.stage === "reveal") { tv.result = t.result; }
  }
  return {
    code: room.code, phase: room.phase, hostId: room.hostId, me: pid,
    rounds: room.rounds, limitMs: room.limitMs, limitOptions: LIMIT_OPTIONS_MS, minPlayers: this.opts.minPlayers, maxPlayers: this.opts.maxPlayers,
    serverNow: this.now(),
    turnNumber: room.turnPos + 1, totalTurns: room.turns.length,
    suddenDeath: !!room.sd, sdRound: room.sd ? room.sd.round : 0,
    players: room.players.filter(function (p) { return !p.sitOut; }).map(function (p) {
      return { id: p.id, name: p.name, ci: (p.ci || 0) % 20, connected: p.connected, total: p.total, prev: p.prev || 0, last: p.last, turns: p.turns, mic: p.mic || null, bonus: p.bonus || 0, late: !!p.late };
    }),
    packs: PACKS.map(function (p) {
      return { id: p.id, group: p.group, name: p.name, blurb: p.blurb, colour: p.colour, ink: p.ink, count: PACK_COUNTS[p.id] || 0 };
    }),
    selectedPacks: room.packs.slice(),
    packMode: room.packMode,
    packPicks: PACK_PICKS,
    packVotes: this.packVoteMap(room),
    myPackVotes: (room.packVotes[pid] || []).slice(),
    interlude: room.interlude ? { turnId: room.interlude.turnId, ageMs: this.now() - room.interlude.at, seed: room.interlude.seed, performer: room.interlude.performer, guesser: room.interlude.guesser, worst: room.interlude.worst } : null,
    myGame: room.phase === "gameover" ? this.gameSummary(room, pid) : null,
    songsInPlay: this.poolFor(room).length,
    turn: tv,
    winners: room.winners || null,
    endAwards: room.endAwards || null,
    bonusCapped: !!room.bonusCapped,
    tieBreakWon: !!room.tieBreakWon,
    multipliers: this.opts.multipliers
  };
};

RoomManager.prototype.broadcast = function (room) {
  room.lastActive = this.now();
  for (var i = 0; i < room.players.length; i++) {
    var p = room.players[i];
    if (!p.conn) { continue; }
    if (room.admin && p.id === room.admin.pid) {
      // The admin sees the game as whichever test player they are "viewing as",
      // as a host only when that player really is the host, so guest screens are true guest screens.
      var as = findPlayer(room, room.admin.as) ? room.admin.as : p.id;
      var v = this.viewFor(room, as);
      v.hostId = room.hostId;
      v.admin = {
        as: as,
        autoplay: !!room.admin.autoplay,
        canAdd: room.phase === "lobby" && room.players.length < this.opts.maxPlayers,
        players: room.players.filter(function (q) { return !q.sitOut; }).map(function (q) { return { id: q.id, name: q.name }; })
      };
      p.conn.send({ t: "state", state: v });
    } else {
      p.conn.send({ t: "state", state: this.viewFor(room, p.id) });
    }
  }
};

// Games people can join from the home screen (no code needed).
RoomManager.prototype.listRooms = function () {
  var out = [];
  for (var code in this.rooms) {
    var r = this.rooms[code];
    if (r.admin || r.sd || r.phase === "gameover") { continue; }
    var host = findPlayer(r, r.hostId);
    var count = r.players.filter(function (p) { return !p.sitOut; }).length;
    if (!host || count >= this.opts.maxPlayers) { continue; }
    out.push({ code: r.code, host: host.name, players: count, max: this.opts.maxPlayers, inProgress: r.phase === "turn" && !!r.sd, live: r.phase === "turn" && !r.sd });
  }
  return out;
};

// The admin hub: timing and usage numbers plus a look at what is live right now.
RoomManager.prototype.adminStats = function (conn, msg) {
  var pw = String(msg.password == null ? "" : msg.password).trim().toLowerCase();
  if (pw !== String(this.opts.adminPassword).toLowerCase()) { return err(conn, "bad_password", "Wrong password. Nice try!"); }
  var self = this, live = { rooms: 0, players: 0, inGame: 0 };
  Object.keys(this.rooms).forEach(function (c) {
    var r = self.rooms[c]; if (r.admin) { return; }
    live.rooms++; live.players += r.players.filter(function (p) { return p.connected && !p.bot; }).length;
    if (r.phase === "turn") { live.inGame++; }
  });
  var data = analytics.summary();
  data.live = live;
  data.serverUptimeMin = Math.round(process.uptime() / 60);
  data.library = { songs: SONGS.length, packs: PACKS.length };
  data.packsPlayed = (data.packsPlayed || []).map(function (p) { var pk = PACKS.filter(function (x) { return x.id === p.pack; })[0]; return { pack: pk ? pk.name : p.pack, turns: p.turns }; });
  data.recentGames = analytics.recentGames(8);
  data.eventsStored = analytics._events.length;
  data.persistent = analytics.persistent();
  conn.send({ t: "adminStats", data: data });
};

// Admin / test mode: a room with test players, driven by one person.
RoomManager.prototype.createAdmin = function (conn, msg) {
  var pw = String(msg.password == null ? "" : msg.password).trim().toLowerCase();
  if (pw !== String(this.opts.adminPassword).toLowerCase()) { return err(conn, "bad_password", "Wrong password. Nice try!"); }
  this.create(conn, { name: "Admin" });
  var room = this.rooms[conn.roomCode];
  if (!room) { return; }
  room.admin = { pid: room.hostId, as: room.hostId };
  this.addBot(room); this.addBot(room);
  this.broadcast(room);
};

RoomManager.prototype.addBot = function (room) {
  if (room.players.length >= this.opts.maxPlayers) { return null; }
  var n = 1, name;
  do { name = "Test " + n++; } while (room.players.some(function (p) { return p.name === name; }));
  var p = this.addPlayer(room, name);
  p.bot = true; p.connected = true; p.mic = "on";
  return p;
};

// ---------------------------------------------------------------- entry point
RoomManager.prototype.handle = function (conn, msg) {
  if (!msg || typeof msg.t !== "string") { return; }
  if (msg.t === "ping") { return conn.send({ t: "pong" }); }
  if (msg.t === "create") { return this.create(conn, msg); }
  if (msg.t === "createAdmin") { return this.createAdmin(conn, msg); }
  if (msg.t === "adminStats") { return this.adminStats(conn, msg); }
  if (msg.t === "listRooms") { return conn.send({ t: "rooms", rooms: this.listRooms() }); }
  if (msg.t === "join") { return this.join(conn, msg); }
  if (msg.t === "peek") { return this.peek(conn, msg); }

  var room = conn.roomCode ? this.rooms[conn.roomCode] : null;
  if (!room) { return err(conn, "room_not_found", "You're not in a room."); }
  var me = findPlayer(room, conn.playerId);
  if (!me) { return err(conn, "room_not_found", "You're not in this room."); }
  var isHost = room.hostId === me.id;

  if (room.admin && me.id === room.admin.pid) {
    if (msg.t === "leave") { return this.closeAdmin(room, conn); }
    if (msg.t === "adminAs") {
      if (findPlayer(room, msg.id)) { room.admin.as = msg.id; this.broadcast(room); }
      return;
    }
    if (msg.t === "adminAutoplay") { return this.setAutoplay(room, !!msg.on); }
    if (msg.t === "adminAddBot") {
      if (room.phase === "lobby") { this.addBot(room); this.broadcast(room); }
      return;
    }
    // This phone's real microphone belongs to the admin's own player, not the one being viewed.
    if (msg.t === "mic") {
      var own = findPlayer(room, room.admin.pid);
      if (own) { own.mic = ["on", "off", "typing"].indexOf(msg.state) !== -1 ? msg.state : null; this.broadcast(room); }
      return;
    }
    // Everything else is done as the test player being viewed.
    var as = findPlayer(room, room.admin.as);
    if (as) { me = as; }
    // Viewing as a bot is a true guest view: host-only actions are refused until the admin switches back.
    isHost = room.hostId === me.id;
  }

  switch (msg.t) {
    case "setRounds":  return isHost ? this.setRounds(room, msg) : err(conn, "not_host", "Only the host can do that one.");
    case "start":      return isHost ? this.start(room, conn) : err(conn, "not_host", "Only the host can do that one.");
    case "next":       return isHost ? this.next(room) : err(conn, "not_host", "Only the host can do that one.");
    case "skip":       return isHost ? this.skip(room) : err(conn, "not_host", "Only the host can do that one.");
    case "playAgain":  return isHost ? this.playAgain(room) : err(conn, "not_host", "Only the host can do that one.");
    case "setLimit":   return isHost ? this.setLimit(room, msg) : err(conn, "not_host", "Only the host can do that one.");
    case "setPacks":   return isHost ? this.setPacks(room, msg) : err(conn, "not_host", "Only the host can do that one.");
    case "setPackMode": return isHost ? this.setPackMode(room, msg) : err(conn, "not_host", "Only the host can do that one.");
    case "votePacks":  return this.votePacks(room, me, msg);
    case "voteRound":  return this.voteRound(room, me);
    case "askHint":    return this.askHint(room, me);
    case "addRound":   return isHost ? this.addRound(room, conn) : err(conn, "not_host", "Only the host can do that one.");
    case "cancelGame": return isHost ? this.cancelGame(room) : err(conn, "not_host", "Only the host can do that one.");
    case "removePlayer": return isHost ? this.removePlayer(room, me, msg) : err(conn, "not_host", "Only the host can do that one.");
    case "refreshOptions": return this.refreshOptions(room, me);
    case "pickDifficulty": return this.pickDifficulty(room, me, msg);
    case "shuffle":    return this.shuffle(room, me);
    case "hint":       return this.hint(room, me);
    case "mic":        me.mic = ["on", "off", "typing"].indexOf(msg.state) !== -1 ? msg.state : null; return this.broadcast(room);
    case "ready":      return this.ready(room, me);
    case "gotIt":      return this.gotIt(room, me);
    case "confirm":    return this.confirmGuess(room, me, !!msg.ok, false, msg.who);
    case "guess":      return this.guess(room, me, conn, msg);
    case "leave":      return this.leave(room, me, conn);
    default: return;
  }
};

// -------------------------------------------------------- create / join / leave
RoomManager.prototype.attach = function (room, player, conn) {
  if (player.conn && player.conn !== conn) { player.conn.roomCode = null; player.conn.playerId = null; }
  player.conn = conn; player.connected = true;
  if (room.turn && room.turn.playerId === player.id && room.turn.timers && room.turn.timers.away) { clearTimeout(room.turn.timers.away); room.turn.timers.away = null; }
  conn.roomCode = room.code; conn.playerId = player.id;
};

RoomManager.prototype.addPlayer = function (room, name) {
  var p = { id: newId(), name: name, conn: null, connected: false, total: 0, prev: 0, last: null, turns: 0, ci: (room.colourSeq = (room.colourSeq || 0) + 1) - 1 };
  room.players.push(p);
  return p;
};

RoomManager.prototype.create = function (conn, msg) {
  var name = cleanName(msg.name);
  if (!name) { return err(conn, "bad_name", "Pop a name in first!"); }
  var room = {
    code: this.makeCode(), hostId: null, players: [], phase: "lobby",
    rounds: this.opts.defaultRounds, limitMs: this.opts.limitMs, turns: [], turnPos: -1, turn: null, turnCounter: 0,
    packs: (this.opts.defaultPacks || []).slice(), used: {}, sd: null, winners: null, tieBreakWon: false,
    packMode: "host", packVotes: {}, roundVotes: {},
    createdAt: this.now(), lastActive: this.now()
  };
  var p = this.addPlayer(room, name);
  room.hostId = p.id;
  this.rooms[room.code] = room;
  this.attach(room, p, conn);
  conn.send({ t: "joined", code: room.code, playerId: p.id });
  this.broadcast(room);
};

// What a shared join link needs to know before the guest has typed a name.
RoomManager.prototype.peek = function (conn, msg) {
  var code = String(msg.code || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
  var room = this.rooms[code], host = room ? findPlayer(room, room.hostId) : null;
  if (!room || !host) { return conn.send({ t: "roomInfo", code: code, found: false }); }
  var count = room.players.filter(function (p) { return !p.sitOut; }).length;
  var state = room.phase === "lobby" ? "open" : (room.phase === "gameover" ? "over" : (room.sd ? "started" : "live"));
  if ((state === "open" || state === "live") && count >= this.opts.maxPlayers) { state = "full"; }
  conn.send({ t: "roomInfo", code: room.code, found: true, host: host.name, players: count, max: this.opts.maxPlayers, state: state });
};

RoomManager.prototype.join = function (conn, msg) {
  var code = String(msg.code || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
  var room = this.rooms[code];
  if (!room) { return err(conn, "room_not_found", "Hmm, no room with that code."); }

  if (msg.playerId) {
    var existing = findPlayer(room, msg.playerId);
    if (existing && existing.removed) { return err(conn, "removed", "The host removed you from this game."); }
    if (existing) {
      this.attach(room, existing, conn);
      conn.send({ t: "joined", code: room.code, playerId: existing.id });
      return this.broadcast(room);
    }
  }
  if (room.phase === "turn" && room.sd) {
    return err(conn, "game_started", "That game's in a nail-biting tie-break. Try again once it's over!");
  }
  var name = cleanName(msg.name);
  if (!name) { return err(conn, "bad_name", "Pop a name in first!"); }
  for (var i = 0; i < room.players.length; i++) {
    var same = room.players[i];
    if (same.removed || same.name.toLowerCase() !== name.toLowerCase()) { continue; }
    // Someone who dropped out and comes back under the same name takes their place again.
    if (!same.connected && !same.bot) {
      this.attach(room, same, conn);
      conn.send({ t: "joined", code: room.code, playerId: same.id });
      return this.broadcast(room);
    }
    return err(conn, "name_taken", "Someone's already using that name. Try another!");
  }
  if (room.players.length >= this.opts.maxPlayers) { return err(conn, "full", "That room's full. Popular, aren't you?"); }
  var p = this.addPlayer(room, name);
  if (room.phase === "turn") { this.scheduleLatePlayer(room, p); }
  if (room.phase === "gameover") { p.sitOut = true; }
  this.attach(room, p, conn);
  conn.send({ t: "joined", code: room.code, playerId: p.id });
  this.broadcast(room);
};

// Someone joining mid-game guesses for the rest of this round and performs from the next round on.
// They are not given extra turns for the rounds they missed.
RoomManager.prototype.scheduleLatePlayer = function (room, p) {
  var cur = room.turns[room.turnPos] ? room.turns[room.turnPos].round : room.rounds;
  var r, i, last;
  p.late = true;
  for (r = cur + 1; r <= room.rounds; r++) {
    last = -1;
    for (i = 0; i < room.turns.length; i++) { if (room.turns[i].round === r && !room.turns[i].sd) { last = i; } }
    if (last < 0) { continue; }
    room.turns.splice(last + 1, 0, { playerId: p.id, round: r, sd: false });
  }
};

RoomManager.prototype.closeAdmin = function (room, conn) {
  conn.roomCode = null; conn.playerId = null;
  room.players.forEach(function (p) { if (p.conn) { p.conn.roomCode = null; p.conn.playerId = null; p.conn = null; } });
  if (room.turn) { this.clearTimers(room.turn); }
  if (room.autoTimer) { clearInterval(room.autoTimer); }
  delete this.rooms[room.code];
};

RoomManager.prototype.promoteHost = function (room) {
  var host = findPlayer(room, room.hostId);
  if (host && host.connected) { return; }
  for (var i = 0; i < room.players.length; i++) {
    if (room.players[i].connected) { room.hostId = room.players[i].id; return; }
  }
};

RoomManager.prototype.disconnect = function (conn) {
  var room = conn.roomCode ? this.rooms[conn.roomCode] : null;
  if (!room) { return; }
  var p = findPlayer(room, conn.playerId);
  if (!p || p.conn !== conn) { return; }
  p.conn = null; p.connected = false;
  conn.roomCode = null; conn.playerId = null;
  this.promoteHost(room);
  var t = room.turn;
  if (room.phase === "turn" && t && t.playerId === p.id && t.stage !== "reveal" && t.timers && !t.timers.away) {
    var self = this, id = t.id;
    t.timers.away = setTimeout(function () {
      var cur = room.turn;
      if (cur && cur.id === id && cur.stage !== "reveal" && !p.connected) {
        if (cur.stage === "whistling") { self.pause(cur); }
        self.finishTurn(room, "skipped");
      }
    }, this.opts.awayMs);
  }
  this.broadcast(room);
};

// The host removes a player, usually one who has dropped out and is not coming back.
RoomManager.prototype.removePlayer = function (room, me, msg) {
  var t = findPlayer(room, msg.id);
  if (!t || t.id === me.id || t.removed) { return; }
  var wasWhistler = room.turn && room.turn.playerId === t.id && room.turn.stage !== "reveal";
  if (t.conn) { t.conn.send({ t: "error", code: "removed", message: "The host removed you from this game." }); t.conn.roomCode = null; t.conn.playerId = null; t.conn = null; }
  t.connected = false;
  if (room.phase === "lobby") {
    room.players = room.players.filter(function (p) { return p.id !== t.id; });
    delete room.packVotes[t.id];
    this.recomputePacks(room);
  } else {
    t.removed = true; t.sitOut = true;
    var pos = room.turnPos;
    room.turns = room.turns.filter(function (x, i) { return i <= pos || x.playerId !== t.id; });
    if (room.turn && room.turn.hintAsks) { room.turn.hintAsks = room.turn.hintAsks.filter(function (id) { return id !== t.id; }); }
    if (room.phase === "turn" && wasWhistler) { return this.finishTurn(room, "skipped"); }
  }
  this.broadcast(room);
};

RoomManager.prototype.leave = function (room, me, conn) {
  var wasWhistler = room.turn && room.turn.playerId === me.id && room.turn.stage !== "reveal";
  conn.roomCode = null; conn.playerId = null;
  me.conn = null; me.connected = false;
  if (room.phase === "lobby") {
    room.players = room.players.filter(function (p) { return p.id !== me.id; });
    delete room.packVotes[me.id];
    this.recomputePacks(room);
  }
  this.promoteHost(room);
  if (room.phase === "turn" && wasWhistler) { return this.finishTurn(room, "skipped"); }
  this.broadcast(room);
};

// --------------------------------------------------------------------- lobby
RoomManager.prototype.setRounds = function (room, msg) {
  if (room.phase !== "lobby") { return; }
  var n = parseInt(msg.rounds, 10);
  if (isNaN(n)) { return; }
  room.rounds = Math.max(this.opts.minRounds, Math.min(this.opts.maxRounds, n));
  this.broadcast(room);
};

RoomManager.prototype.setLimit = function (room, msg) {
  if (room.phase !== "lobby") { return; }
  var ms = parseInt(msg.limitMs, 10);
  if (LIMIT_OPTIONS_MS.indexOf(ms) === -1) { return; }
  room.limitMs = ms;
  this.broadcast(room);
};

// Songs the room can use: every song in at least one ticked pack. Each song is
// a single entry in the library, so a song that sits in several ticked packs is
// still only here once.
RoomManager.prototype.poolFor = function (room) {
  return SONGS.filter(function (s) {
    for (var i = 0; i < s.packs.length; i++) { if (room.packs.indexOf(s.packs[i]) !== -1) { return true; } }
    return false;
  });
};

RoomManager.prototype.unusedCount = function (room) {
  return this.poolFor(room).filter(function (s) { return !room.used[s.title]; }).length;
};

// Host ticks packs in the lobby. None are ticked to begin with.
RoomManager.prototype.setPacks = function (room, msg) {
  if (room.phase !== "lobby" || room.packMode === "room" || !Array.isArray(msg.packs)) { return; }
  var chosen = PACK_IDS.filter(function (id) { return msg.packs.indexOf(id) !== -1; });
  room.packs = chosen;
  this.broadcast(room);
};

// Host adds one more round while the final round is being played.
RoomManager.prototype.addRound = function (room, conn) {
  if (room.phase !== "turn" || room.sd || !room.turn || room.turn.sd) { return; }
  if (room.turn.round !== room.rounds) { return; }
  var extra = room.players.filter(function (p) { return !p.sitOut; }).length;
  if (this.unusedCount(room) < extra + SONG_BUFFER) {
    return err(conn, "too_few_songs", "We've run out of fresh songs for another round. Add more packs next time!");
  }
  room.rounds++;
  room.roundVotes = {};
  for (var i = 0; i < room.players.length; i++) {
    if (!room.players[i].sitOut) { room.turns.push({ playerId: room.players[i].id, round: room.rounds, sd: false }); }
  }
  this.broadcast(room);
};

// Non-hosts ask for an extra round on the last round; the host sees how many want one.
RoomManager.prototype.voteRound = function (room, me) {
  var t = room.turn;
  if (room.phase !== "turn" || room.sd || !t || t.sd || t.round !== room.rounds || room.hostId === me.id) { return; }
  if (room.roundVotes[me.id]) { delete room.roundVotes[me.id]; } else { room.roundVotes[me.id] = true; }
  this.broadcast(room);
};

// ---- pack voting: the host either picks the packs or hands the choice to the room.
RoomManager.prototype.setPackMode = function (room, msg) {
  if (room.phase !== "lobby" || (msg.mode !== "host" && msg.mode !== "room")) { return; }
  room.packMode = msg.mode;
  if (room.packMode === "room") { this.recomputePacks(room); }
  this.broadcast(room);
};

RoomManager.prototype.votePacks = function (room, me, msg) {
  if (room.phase !== "lobby" || room.packMode !== "room" || !Array.isArray(msg.packs)) { return; }
  room.packVotes[me.id] = msg.packs.filter(function (id, i) { return PACK_IDS.indexOf(id) !== -1 && msg.packs.indexOf(id) === i; }).slice(0, PACK_PICKS);
  this.recomputePacks(room);
  this.broadcast(room);
};

RoomManager.prototype.packTally = function (room) {
  var tally = {};
  room.players.forEach(function (p) {
    (room.packVotes[p.id] || []).forEach(function (id) { tally[id] = (tally[id] || 0) + 1; });
  });
  return PACK_IDS.filter(function (id) { return tally[id]; }).map(function (id) { return { id: id, votes: tally[id] }; })
    .sort(function (a, b) { return b.votes - a.votes || PACK_IDS.indexOf(a.id) - PACK_IDS.indexOf(b.id); });
};

RoomManager.prototype.packVoteMap = function (room) {
  var map = {};
  room.players.forEach(function (p) {
    (room.packVotes[p.id] || []).forEach(function (id) { (map[id] = map[id] || []).push(p.id); });
  });
  return map;
};

// Shared pool: every pack anyone has ticked goes into the deck. Songs are
// drawn at random, weighted by how many players ticked the packs they sit in.
RoomManager.prototype.recomputePacks = function (room) {
  if (room.packMode !== "room") { return; }
  var tally = {};
  this.packTally(room).forEach(function (r) { tally[r.id] = r.votes; });
  room.packs = PACK_IDS.filter(function (id) { return tally[id]; });
  room.packWeight = tally;
};

RoomManager.prototype.start = function (room, conn) {
  if (room.phase !== "lobby") { return; }
  if (room.packMode === "room" && !room.packs.length) { room.packs = ["bangers"]; room.packWeight = { bangers: 1 }; }
  if (room.players.length < this.opts.minPlayers) {
    return err(conn, "too_few", "You need at least " + this.opts.minPlayers + " players. Round up some friends!");
  }
  if (!room.packs.length) { return err(conn, "no_packs", "Pick a song pack first!"); }
  var need = room.players.length * room.rounds + SONG_BUFFER;
  if (this.poolFor(room).length < need) {
    return err(conn, "too_few_songs", "These packs only have " + this.poolFor(room).length + " songs, and this game needs about " + need + ". Tick more packs or drop a round.");
  }
  room.players.forEach(function (p) { p.total = 0; p.prev = 0; p.last = null; p.turns = 0; });
  room.turns = [];
  for (var r = 1; r <= room.rounds; r++) {
    for (var i = 0; i < room.players.length; i++) {
      room.turns.push({ playerId: room.players[i].id, round: r, sd: false });
    }
  }
  room.turnPos = -1; room.sd = null; room.winners = null; room.tieBreakWon = false; room.used = {}; room.roundVotes = {};
  room.stats = {}; room.endAwards = null; room.bonusCapped = false; room.gameNo = (room.gameNo || 0) + 1; room.micAtStart = room.players.reduce(function (m, p) { var k = p.mic || "unknown"; m[k] = (m[k] || 0) + 1; return m; }, {}); room.startedAt = this.now(); room.gamePlayers = room.players.filter(function (p) { return !p.sitOut; }).length; room.turnsDone = 0; room.interlude = null; room.interludeDone = false;
  room.players.forEach(function (p) { p.bonus = 0; p.late = false; });
  room.phase = "turn";
  this.advance(room);
};

// --------------------------------------------------------------------- turns
RoomManager.prototype.clearTimers = function (turn) {
  if (!turn || !turn.timers) { return; }
  for (var k in turn.timers) { if (turn.timers[k]) { clearTimeout(turn.timers[k]); } }
  turn.timers = {};
};

RoomManager.prototype.advance = function (room) {
  this.clearTimers(room.turn);
  // The leaderboard is shown once a round, after everyone has had a turn. Once it has been seen,
  // those totals become the baseline for the next leaderboard's rank changes.
  if (room.turn && isRoundEnd(room)) { room.players.forEach(function (p) { p.prev = p.total; }); }
  room.turnPos++;
  this.maybeInterlude(room);
  if (room.turnPos < room.turns.length) { return this.beginTurn(room, room.turns[room.turnPos]); }
  this.afterTurns(room);
};

// Halfway through a game of four or more rounds: a quick scoreboard moment with a few cheeky stats.
RoomManager.prototype.maybeInterlude = function (room) {
  var t = room.turns[room.turnPos], prev = room.turns[room.turnPos - 1];
  if (!t || !prev || t.sd || prev.sd || room.interludeDone || room.rounds < 4) { return; }
  if (t.round !== prev.round + 1 || prev.round !== Math.ceil(room.rounds / 2)) { return; }
  var rows = room.players.filter(function (p) { return !p.sitOut && room.stats && room.stats[p.id] && room.stats[p.id].whistles > 0; })
    .map(function (p) { var st = room.stats[p.id]; return { id: p.id, avg: Math.round(st.whistlePts / st.whistles), guessed: st.guessed, gms: st.guessBestMs }; });
  room.interludeDone = true;
  if (rows.length < 2) { return; }
  var byAvg = rows.slice().sort(function (a, b) { return b.avg - a.avg; });
  var best = byAvg[0], worst = byAvg[byAvg.length - 1];
  var byGuess = rows.slice().sort(function (a, b) { return b.guessed - a.guessed || a.gms - b.gms; });
  var g = byGuess[0];
  var iv = { turnId: room.turnCounter + 1, at: this.now(), seed: Math.floor(this.random() * 1000), performer: null, guesser: null, worst: null };
  if (best.avg > worst.avg) { iv.performer = { id: best.id, avg: best.avg }; }
  if (g.guessed > 0) { iv.guesser = { id: g.id, n: g.guessed }; }
  // Only name a worst performer when they are alone at the bottom and not also the star.
  if (worst.avg < byAvg[byAvg.length - 2].avg) { iv.worst = { id: worst.id, avg: worst.avg }; }
  if (!iv.performer && !iv.guesser && !iv.worst) { return; }
  room.interlude = iv;
};

RoomManager.prototype.beginTurn = function (room, t) {
  room.turnCounter++;
  var turn = {
    id: room.turnCounter, playerId: t.playerId, round: t.round, sd: !!t.sd,
    stage: "choose", difficulty: null, multiplier: null, song: null, shuffles: 0,
    accumulatedMs: 0, runningSince: null, countdownEndsAt: null, pending: null, hints: 0, hintCost: 0, hintsUsed: 0,
    startedAt: this.now(), cooldownUntil: 0, lockUntil: 0, hintAsks: [], options: null, result: null, timers: {}
  };
  room.turn = turn;
  if (t.sd) {
    turn.difficulty = this.opts.sdDifficulty;
    turn.multiplier = this.opts.multipliers[turn.difficulty];
    if (!this.drawSong(room, turn)) { return this.endEarly(room); }
  } else {
    // The whistler is offered one song at each difficulty and picks one.
    // If a difficulty has run out of unplayed songs, a song of another
    // difficulty fills the card, labelled with its own difficulty.
    turn.options = this.dealOptions(room, []);
    if (!turn.options.length) { return this.endEarly(room); }
  }
  this.broadcast(room);
};

// Three song cards, one per difficulty, never the same song twice and never
// one of the titles in `avoid`.
RoomManager.prototype.dealOptions = function (room, avoid) {
  var self = this, taken = avoid.slice(), out = [];
  ["easy", "medium", "hard"].forEach(function (d) {
    var song = self.drawFrom(room, d, taken);
    if (song) { taken.push(song.title); out.push({ difficulty: song.difficulty, song: song }); }
  });
  return out;
};

// Whistler does not know any of the three songs: new cards, once per turn, free.
RoomManager.prototype.refreshOptions = function (room, me) {
  var t = this.currentTurnFor(room, me, ["choose"]);
  if (!t || t.difficulty || !t.options || (t.refreshes || 0) >= 3) { return; }
  t.seen = (t.seen || []).concat(t.options.map(function (o) { return o.song.title; }));
  var fresh = this.dealOptions(room, t.seen);
  if (!fresh.length) { return; }
  t.options = fresh; t.refreshes = (t.refreshes || 0) + 1;
  this.broadcast(room);
};

// Pick a random song of one difficulty from the ticked packs that has not been
// played in this game. A song is never repeated: if the difficulty has run out,
// an unplayed song of another difficulty is used, and if nothing is left it
// returns null. (Marks nothing as used; the caller does that.)
RoomManager.prototype.drawFrom = function (room, difficulty, avoid) {
  var pool = this.poolFor(room).filter(function (s) {
    return !room.used[s.title] && avoid.indexOf(s.title) === -1;
  });
  var same = pool.filter(function (s) { return s.difficulty === difficulty; });
  var from = same.length ? same : pool;
  if (!from.length) { return null; }
  if (room.packMode === "room" && room.packWeight) {
    var w = room.packWeight, tot = 0;
    var ws = from.map(function (s) {
      var x = 0; s.packs.forEach(function (id) { x += w[id] || 0; });
      tot += x; return x;
    });
    if (tot > 0) {
      var r = this.random() * tot;
      for (var i = 0; i < from.length; i++) { r -= ws[i]; if (r < 0) { return from[i]; } }
    }
  }
  return from[Math.floor(this.random() * from.length)];
};

// New song for a turn at the turn's difficulty. Returns false if none are left.
RoomManager.prototype.drawSong = function (room, turn) {
  var pick = this.drawFrom(room, turn.difficulty, turn.song ? [turn.song.title] : []);
  if (!pick) { return false; }
  room.used[pick.title] = true;
  turn.song = pick;
  return true;
};

// The ticked packs ran out of unplayed songs: finish the game with the current standings.
RoomManager.prototype.endEarly = function (room) {
  this.applyEndBonuses(room);
  var top = -Infinity;
  room.players.forEach(function (p) { if (!p.sitOut && p.total > top) { top = p.total; } });
  var ids = room.players.filter(function (p) { return !p.sitOut && p.total === top; }).map(function (p) { return p.id; });
  this.gameOver(room, ids, false);
};

RoomManager.prototype.currentTurnFor = function (room, me, stages) {
  var t = room.turn;
  if (room.phase !== "turn" || !t || t.playerId !== me.id) { return null; }
  if (stages && stages.indexOf(t.stage) === -1) { return null; }
  return t;
};

// The whistler taps one of the offered songs (msg.i is its position; msg.d, a
// difficulty, is also accepted and picks the first card of that difficulty).
RoomManager.prototype.pickDifficulty = function (room, me, msg) {
  var t = this.currentTurnFor(room, me, ["choose"]);
  if (!t || t.difficulty || !t.options) { return; }
  var opt = null, k;
  if (typeof msg.i === "number" && msg.i >= 0 && msg.i < t.options.length && msg.i % 1 === 0) { opt = t.options[msg.i]; }
  else if (typeof msg.d === "string") {
    for (k = 0; k < t.options.length; k++) { if (t.options[k].difficulty === msg.d) { opt = t.options[k]; break; } }
  }
  if (!opt) { return; }
  t.difficulty = opt.difficulty;
  t.multiplier = this.opts.multipliers[opt.difficulty];
  t.song = opt.song;
  room.used[t.song.title] = true;
  // Picking a song starts the countdown straight away, so there is no extra Ready tap.
  if (this.opts.autoReady !== false && !(t.adminDrives)) { return this.ready(room, me); }
  this.broadcast(room);
};

// Shuffle during the round: a new song of the same difficulty. The clock keeps
// running and nothing is locked; the shuffle just costs points.
RoomManager.prototype.shuffle = function (room, me) {
  var t = this.currentTurnFor(room, me, ["whistling"]);
  if (!t || !t.difficulty) { return; }
  if (!this.drawSong(room, t)) { return; } // no unplayed songs left: nothing to shuffle to
  t.shuffles++;
  t.hints = 0;
  t.hintAsks = [];
  this.broadcast(room);
};

// A guesser asks the whistler for a hint. The whistler decides whether to give one.
RoomManager.prototype.askHint = function (room, me) {
  var t = room.turn;
  if (room.phase !== "turn" || !t || t.stage !== "whistling" || t.playerId === me.id || !t.song || t.hints >= 3) { return; }
  if (t.hintAsks.indexOf(me.id) !== -1) { return; }
  t.hintAsks.push(me.id);
  this.broadcast(room);
};

// The lifeline: up to three hints per song, each costing more points than the last.
RoomManager.prototype.hint = function (room, me) {
  var t = this.currentTurnFor(room, me, ["whistling"]);
  if (!t || !t.song || t.hints >= 3) { return; }
  t.hintCost += this.opts.hintPoints[t.hints];
  t.hintAsks = [];
  t.hints++;
  t.hintsUsed++;
  this.broadcast(room);
};

RoomManager.prototype.ready = function (room, me) {
  var t = this.currentTurnFor(room, me, ["choose"]);
  if (!t || !t.difficulty) { return; }
  var self = this, id = t.id;
  t.stage = "countdown";
  t.countdownEndsAt = this.now() + this.opts.countdownMs;
  t.timers.countdown = setTimeout(function () { self.startWhistling(room, id); }, this.opts.countdownMs);
  this.broadcast(room);
};

RoomManager.prototype.startWhistling = function (room, turnId) {
  var t = room.turn;
  if (!t || t.id !== turnId || t.stage !== "countdown") { return; }
  t.stage = "whistling";
  t.runningSince = this.now();
  this.scheduleCap(room, t);
  this.broadcast(room);
};

RoomManager.prototype.scheduleCap = function (room, t) {
  var self = this, id = t.id;
  if (t.timers.cap) { clearTimeout(t.timers.cap); }
  var remaining = Math.max(0, room.limitMs - this.elapsed(t));
  t.timers.cap = setTimeout(function () {
    if (room.turn && room.turn.id === id && room.turn.stage === "whistling") { self.finishTurn(room, "timeout"); }
  }, remaining);
};

RoomManager.prototype.pause = function (t) {
  if (t.runningSince !== null) {
    t.accumulatedMs += this.now() - t.runningSince;
    t.runningSince = null;
  }
  if (t.timers.cap) { clearTimeout(t.timers.cap); t.timers.cap = null; }
};

// A guess arrives from another player's phone (spoken: alts are the speech
// engine's readings; typed: one string). The song is only known here.
RoomManager.prototype.guess = function (room, me, conn, msg) {
  var t = room.turn;
  if (room.phase !== "turn" || !t || t.stage !== "whistling" || t.playerId === me.id) { return; }
  if (this.now() < t.cooldownUntil) { return; }
  var typed = !!msg.typed;
  var alts = (Array.isArray(msg.alts) ? msg.alts : []).slice(0, 8)
    .map(function (a) { return String(a == null ? "" : a).slice(0, 120); })
    .filter(function (a) { return a.length > 0; });
  if (!alts.length) { return; }
  var r = Matcher.matchAny(alts, t.song, { typed: typed });
  if (!r.matched) {
    if (typed) { conn.send({ t: "guessFeedback", ok: false }); }
    return;
  }
  var self = this, id = t.id;
  this.pause(t);
  t.stage = "confirming";
  t.pending = { heard: Matcher.heardPhrase(r.guess, t.song, { typed: typed }) || r.guess, from: me.id, typed: typed };
  t.detected = (t.detected || 0) + 1;
  var arm = function () {
    t.timers.confirm = setTimeout(function () {
      if (!room.turn || room.turn.id !== id || room.turn.stage !== "confirming") { return; }
      // A present human whistler may take as long as they like to pick who got it.
      var w = findPlayer(room, room.turn.playerId);
      if (w && w.connected && !w.bot) { return arm(); }
      self.confirmGuess(room, null, false, true);
    }, self.opts.confirmMs);
  };
  arm();
  this.broadcast(room);
};

RoomManager.prototype.confirmGuess = function (room, me, ok, byTimeout, who) {
  var t = room.turn;
  if (room.phase !== "turn" || !t || t.stage !== "confirming") { return; }
  if (!byTimeout && t.playerId !== me.id) { return; }
  if (t.timers.confirm) { clearTimeout(t.timers.confirm); t.timers.confirm = null; }
  if (ok) {
    var ids = Array.isArray(who) ? who : (t.pending && t.pending.from ? [t.pending.from] : []);
    return this.finishTurn(room, "correct", ids);
  }
  t.rejected = (t.rejected || 0) + 1;
  t.stage = "whistling";
  t.pending = null;
  t.runningSince = this.now();
  t.cooldownUntil = this.now() + this.opts.cooldownMs;
  this.scheduleCap(room, t);
  this.broadcast(room);
};

RoomManager.prototype.gotIt = function (room, me) {
  var t = this.currentTurnFor(room, me, ["whistling", "confirming"]);
  if (!t || t.stage !== "whistling") { return; }
  // Pause the clock and ask the whistler who got it. No timeout: they take their time.
  this.pause(t);
  t.stage = "confirming";
  t.pending = { heard: "", from: null, manual: true };
  this.broadcast(room);
};

RoomManager.prototype.skip = function (room) {
  if (room.phase !== "turn" || !room.turn || room.turn.stage === "reveal") { return; }
  var t = room.turn;
  if (t.stage === "whistling") { this.pause(t); }
  this.finishTurn(room, "skipped");
};

RoomManager.prototype.finishTurn = function (room, outcome, whoIds) {
  var t = room.turn, self = this;
  if (!t || t.stage === "reveal") { return; }
  this.clearTimers(t);
  var limitS = room.limitMs / 1000;
  var timeMs = outcome === "correct" ? Math.min(t.accumulatedMs, room.limitMs) : room.limitMs;
  var mult = t.multiplier || 1;
  var lockedS = 0;
  var shufflePts = this.opts.shufflePoints * t.shuffles;
  var hintPts = t.hintCost || 0;
  var base = 0, afterMult = 0, score = 0;
  if (outcome === "correct") {
    var rawS = Math.max(0, timeMs / 1000 - lockedS);
    base = Math.max(0, Math.round(this.opts.maxPoints * (1 - rawS / limitS)));
    afterMult = Math.round(base * mult);
    score = Math.max(0, afterMult - shufflePts - hintPts);
  }
  // Who gets points: the whistler, plus each person they named (never themselves).
  var awards = [{ id: t.playerId, points: score, role: "whistler" }];
  if (outcome === "correct" && !t.sd) {
    var seen = {};
    (whoIds || []).forEach(function (id) {
      var gp = findPlayer(room, id);
      if (!gp || gp.sitOut || id === t.playerId || seen[id]) { return; }
      seen[id] = true;
      awards.push({ id: id, points: Math.round(score * self.opts.guesserShare), role: "guesser" });
    });
  }
  if (!t.sd) {
    var ws = statFor(room, t.playerId);
    ws.whistles++; ws.whistlePts += score;
    if (t.song && t.song.packs) { t.song.packs.forEach(function (id) { ws.packs[id] = (ws.packs[id] || 0) + 1; }); }
    if (outcome === "correct") {
      ws.solved++; ws.streak++;
      if (ws.streak > ws.bestStreak) { ws.bestStreak = ws.streak; }
      if (timeMs < ws.bestTimeMs) { ws.bestTimeMs = timeMs; }
      if (t.difficulty === "hard") { ws.hardSolved++; }
      awards.forEach(function (a) { if (a.role === "guesser") { var gs = statFor(room, a.id); gs.guessed++; if (timeMs < gs.guessBestMs) { gs.guessBestMs = timeMs; } } });
    } else { ws.streak = 0; }
  }
  var src = !t.pending ? "none" : t.pending.manual ? "manual" : t.pending.typed ? "typed" : "voice";
  t.stage = "reveal";
  t.pending = null;
  if (!t.sd) { room.turnsDone = (room.turnsDone || 0) + 1; }
  if (!room.admin) { analytics.record("turn", { outcome: outcome, difficulty: t.difficulty, limitMs: room.limitMs, performMs: timeMs, sinceStartMs: this.now() - t.startedAt, hints: t.hintsUsed || 0, shuffles: t.shuffles || 0, players: room.gamePlayers, sd: !!t.sd, song: t.song ? t.song.title : null, packs: t.song ? t.song.packs : [], source: outcome === "correct" ? src : "none", detected: t.detected || 0, rejected: t.rejected || 0, refreshes: t.refreshes || 0 }); }
  t.result = {
    outcome: outcome, timeMs: timeMs, limitMs: room.limitMs, multiplier: t.multiplier, difficulty: t.difficulty,
    shuffles: t.shuffles, shufflePts: shufflePts, lockedS: lockedS, hints: t.hintsUsed || 0, hintPts: hintPts, base: base, afterMult: afterMult, score: score, awards: awards,
    revealAt: this.now(),
    song: t.song ? { title: t.song.title, artist: t.song.artist } : null
  };
  room.players.forEach(function (p) { p.last = null; });
  awards.forEach(function (a) {
    var p = findPlayer(room, a.id);
    if (!p) { return; }
    p.last = a.points;
    if (t.sd) { if (a.role === "whistler") { room.sd.scores[p.id] = a.points; } }
    else { p.total += a.points; if (a.role === "whistler") { p.turns++; } }
  });
  if (this.opts.revealMs > 0) {
    var id = t.id;
    t.nextAt = this.now() + this.opts.revealMs;
    t.timers.next = setTimeout(function () {
      if (room.turn && room.turn.id === id && room.turn.stage === "reveal") { self.advance(room); }
    }, this.opts.revealMs);
    if (t.timers.next.unref) { t.timers.next.unref(); }
  }
  this.broadcast(room);
};

RoomManager.prototype.next = function (room) {
  if (room.phase !== "turn" || !room.turn || room.turn.stage !== "reveal") { return; }
  this.advance(room);
};

// ------------------------------------------------------ end-of-game awards
function statFor(room, id) {
  if (!room.stats) { room.stats = {}; }
  if (!room.stats[id]) {
    room.stats[id] = { whistles: 0, solved: 0, streak: 0, bestStreak: 0, bestTimeMs: Infinity, hardSolved: 0, guessed: 0, whistlePts: 0, guessBestMs: Infinity, packs: {} };
  }
  return room.stats[id];
}

// Work out the awards, hand out the bonus points, and keep the bonuses from
// overturning a lead that was clear before they were counted. Runs once a game.
RoomManager.prototype.applyEndBonuses = function (room) {
  if (room.endAwards) { return; }
  var self = this, o = this.opts, pool = room.players.filter(function (p) { return !p.sitOut; });
  var scale = Math.min(1.5, Math.max(0.6, 0.5 + room.rounds / 10));
  function amt(n) { return Math.round(n * scale / 10) * 10; }
  var defs = [];
  function pickBest(key, title, score, detail, min) {
    var best = null, ids = [];
    pool.forEach(function (p) {
      var v = score(statFor(room, p.id));
      if (v === null || v < min) { return; }
      if (best === null || v > best + 1e-9) { best = v; ids = [p.id]; } else if (Math.abs(v - best) < 1e-9) { ids.push(p.id); }
    });
    if (ids.length) { defs.push({ key: key, title: title, bonus: amt(o.awardBonus[key]), winners: ids.map(function (id) { return { id: id, detail: detail(statFor(room, id)) }; }) }); }
  }
  pickBest("whistler", "Best performer", function (st) { return st.whistles ? st.whistlePts / st.whistles : null; },
    function (st) { return "Averaged " + Math.round(st.whistlePts / st.whistles) + " points a turn"; }, 1);
  pickBest("guesser", "Best guesser", function (st) { return st.guessed; },
    function (st) { return "Named " + st.guessed + (st.guessed === 1 ? " song" : " songs"); }, 1);
  pickBest("quickest", "Quickest tune", function (st) { return st.solved ? -st.bestTimeMs : null; },
    function (st) { return "Solved in " + (Math.round(st.bestTimeMs / 100) / 10) + " seconds"; }, -Infinity);
  pickBest("streak", "On a roll", function (st) { return st.bestStreak; },
    function (st) { return st.bestStreak + " solved in a row"; }, 2);
  pickBest("daredevil", "Daredevil", function (st) { return st.hardSolved; },
    function (st) { return st.hardSolved + " hard " + (st.hardSolved === 1 ? "song" : "songs") + " solved"; }, 2);
  // Desired bonus per player, capped.
  var want = {};
  defs.forEach(function (d) { d.winners.forEach(function (w) { want[w.id] = (want[w.id] || 0) + d.bonus; }); });
  var maxB = Math.round(o.maxBonus * scale / 10) * 10, gap = Math.round(o.closeGap * scale);
  Object.keys(want).forEach(function (id) { if (want[id] > maxB) { want[id] = maxB; } });
  // Settle from the top down: nobody may finish above someone who led them by
  // more than the gap, so a big lead survives the bonuses.
  var order = pool.slice().sort(function (a, b) { return b.total - a.total; });
  var final = {}, got = {}, capped = false;
  order.forEach(function (p) {
    var w = want[p.id] || 0, cap = Infinity;
    order.forEach(function (a) {
      if (a === p || final[a.id] === undefined) { return; }
      if (a.total - p.total > gap) { cap = Math.min(cap, final[a.id] - p.total - 1); }
    });
    var b = Math.max(0, Math.min(w, cap));
    if (b < w) { capped = true; }
    got[p.id] = b; final[p.id] = p.total + b;
  });
  // Share each player's allowed bonus across their awards in proportion.
  defs.forEach(function (d) {
    d.winners.forEach(function (w) {
      var wantP = want[w.id] || 0;
      w.bonus = wantP ? Math.round(d.bonus * (got[w.id] || 0) / wantP) : 0;
    });
  });
  pool.forEach(function (p) { p.bonus = got[p.id] || 0; p.total += p.bonus; });
  room.bonusCapped = capped;
  room.endAwards = defs;
};

// ------------------------------------------------------ tie-break and the end
RoomManager.prototype.afterTurns = function (room) {
  var i, ids;
  if (room.sd) {
    var best = -Infinity;
    room.sd.contenders.forEach(function (id) { if (room.sd.scores[id] > best) { best = room.sd.scores[id]; } });
    var winners = room.sd.contenders.filter(function (id) { return room.sd.scores[id] === best; });
    if (winners.length === 1 || room.sd.round >= this.opts.sdMaxRounds) { return this.gameOver(room, winners, true); }
    room.sd.contenders = winners; room.sd.round++; room.sd.scores = {};
    return this.queueSuddenDeath(room);
  }
  this.applyEndBonuses(room);
  var top = -Infinity;
  room.players.forEach(function (p) { if (p.total > top) { top = p.total; } });
  ids = room.players.filter(function (p) { return p.total === top; }).map(function (p) { return p.id; });
  if (ids.length > 1) {
    room.sd = { contenders: ids, round: 1, scores: {} };
    return this.queueSuddenDeath(room);
  }
  this.gameOver(room, ids, false);
};

RoomManager.prototype.queueSuddenDeath = function (room) {
  room.turns = room.sd.contenders.map(function (id) { return { playerId: id, round: 0, sd: true }; });
  room.turnPos = -1;
  this.advance(room);
};

// One player's game, for the lifetime stats kept on their own phone.
RoomManager.prototype.gameSummary = function (room, pid) {
  var p = findPlayer(room, pid), st = room.stats && room.stats[pid];
  if (!p || p.sitOut || !st) { return null; }
  var better = room.players.filter(function (o) { return !o.sitOut && o.total > p.total; }).length;
  var fin = function (n) { return isFinite(n) ? n : null; };
  return {
    key: room.code + ":" + (room.gameNo || 0), points: p.total, rank: better + 1,
    won: (room.winners || []).indexOf(pid) !== -1, players: room.players.filter(function (o) { return !o.sitOut; }).length,
    performed: st.whistles, solved: st.solved, hardSolved: st.hardSolved, guessed: st.guessed, bestStreak: st.bestStreak,
    bestPerformMs: fin(st.bestTimeMs), bestGuessMs: fin(st.guessBestMs), packs: st.packs
  };
};

RoomManager.prototype.logGame = function (room, finished) {
  if (room.admin || !room.startedAt || !room.turnsDone) { return; }
  analytics.record("game", { finished: finished, durationMs: this.now() - room.startedAt, players: room.gamePlayers, rounds: room.rounds, limitMs: room.limitMs, turns: room.turnsDone, packMode: room.packMode, lateJoiners: room.players.filter(function (p) { return p.late; }).length, mics: room.micAtStart || null });
  room.startedAt = null;
};

RoomManager.prototype.gameOver = function (room, winnerIds, viaTieBreak) {
  this.logGame(room, true);
  room.phase = "gameover";
  room.turn = null;
  room.winners = winnerIds;
  room.tieBreakWon = !!viaTieBreak;
  this.broadcast(room);
};

RoomManager.prototype.resetToLobby = function (room) {
  this.clearTimers(room.turn);
  room.players = room.players.filter(function (p) { return p.connected; });
  room.players.forEach(function (p) { p.total = 0; p.prev = 0; p.last = null; p.turns = 0; p.bonus = 0; p.sitOut = false; });
  room.stats = {}; room.endAwards = null; room.bonusCapped = false;
  room.phase = "lobby"; room.turn = null; room.turns = []; room.turnPos = -1;
  room.sd = null; room.winners = null; room.tieBreakWon = false; room.used = {};
  this.promoteHost(room);
  this.broadcast(room);
};

RoomManager.prototype.playAgain = function (room) {
  if (room.phase !== "gameover") { return; }
  this.resetToLobby(room);
};

// Host abandons a game in progress: everyone goes back to the lobby, same code.
RoomManager.prototype.cancelGame = function (room) {
  if (room.phase === "lobby") { return; }
  this.logGame(room, false);
  this.resetToLobby(room);
};

// ------------------------------------------------------- admin: bots play on their own
RoomManager.prototype.setAutoplay = function (room, on) {
  var self = this;
  room.admin.autoplay = on;
  if (room.autoTimer) { clearInterval(room.autoTimer); room.autoTimer = null; }
  if (on) {
    room.autoTimer = setInterval(function () { self.autoTick(room); }, 1500);
    if (room.autoTimer.unref) { room.autoTimer.unref(); }
  }
  this.broadcast(room);
};

RoomManager.prototype.autoTick = function (room) {
  var self = this;
  if (!this.rooms[room.code] || !room.admin || !room.admin.autoplay) {
    if (room.autoTimer) { clearInterval(room.autoTimer); room.autoTimer = null; }
    return;
  }
  var bots = room.players.filter(function (p) { return p.bot && !p.sitOut; });
  var pick = function (arr) { return arr[Math.floor(self.random() * arr.length)]; };
  if (room.phase === "lobby") {
    if (room.packMode === "room") {
      bots.forEach(function (b) {
        if (room.packVotes[b.id] && room.packVotes[b.id].length) { return; }
        var ids = PACK_IDS.slice(), mine = [];
        while (mine.length < 3 + Math.floor(self.random() * 3)) { mine.push(ids.splice(Math.floor(self.random() * ids.length), 1)[0]); }
        self.votePacks(room, b, { packs: mine });
      });
    }
    return;
  }
  var t = room.turn;
  if (room.phase !== "turn" || !t) { return; }
  var w = findPlayer(room, t.playerId), now = this.now();
  if (!w) { return; }
  var dummy = { send: function () {} };
  // If the admin is viewing as the whistler, they are playing that turn themselves.
  var adminDrives = room.admin.as === w.id;
  if (t.stage === "choose") {
    if (!w.bot || adminDrives) { return; }
    if (!t.difficulty) { return this.pickDifficulty(room, w, { i: Math.floor(this.random() * (t.options || []).length) }); }
    return this.ready(room, w);
  }
  if (t.stage === "confirming" && w.bot && !adminDrives) {
    var others = room.players.filter(function (p) { return !p.sitOut && p.id !== w.id; });
    var who = [pick(others)];
    if (others.length > 2 && this.random() < 0.4) { var second = pick(others); if (second !== who[0]) { who.push(second); } }
    return this.confirmGuess(room, w, true, false, who.map(function (p) { return p.id; }));
  }
  if (t.stage === "whistling") {
    if (!t.botAt) { t.botAt = now + 6000 + Math.floor(this.random() * 22000); return; }
    if (now < t.botAt) { return; }
    if (w.bot) { return adminDrives ? undefined : this.gotIt(room, w); }
    var guessers = bots.filter(function (b) { return b.id !== w.id; });
    if (guessers.length) { t.botAt = now + 8000 + Math.floor(this.random() * 15000); return this.guess(room, pick(guessers), dummy, { alts: [t.song.title], typed: true }); }
  }
};

// ------------------------------------------------------------------- cleanup
RoomManager.prototype.sweep = function () {
  var now = this.now();
  for (var code in this.rooms) {
    var room = this.rooms[code];
    var anyone = room.players.some(function (p) { return p.connected && !p.bot; });
    if ((!anyone && now - room.lastActive > this.opts.roomIdleMs) || now - room.createdAt > this.opts.roomMaxAgeMs) {
      this.clearTimers(room.turn);
      if (room.autoTimer) { clearInterval(room.autoTimer); }
      delete this.rooms[code];
    }
  }
};

module.exports = { RoomManager: RoomManager, DEFAULTS: DEFAULTS };
