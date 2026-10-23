"use strict";
// Game rules and rooms. No networking in here: server.js hands each message to
// RoomManager.handle(conn, msg), and conn.send(obj) is how replies go back.
//
// Rules in one paragraph: every player whistles once per round. The whistler
// picks easy, medium or hard (score multipliers x1.0, x0.9, x0.8, so a lower
// score is better), sees the song on their own phone, and the clock runs until
// the room guesses it (max 60s). Guesses come from the other phones, by voice
// or typing, and are checked HERE so the song never reaches a guesser's phone.
// A likely match pauses the clock and asks the whistler to confirm, which keeps
// the answer secret if the detection was wrong. Shuffling for a new song costs
// +5s. Lowest total wins; a tie goes to a sudden-death round.

var crypto = require("crypto");
var SONGS = require("./songs.js");
var PACKS = require("./packs.js");
var Matcher = require("./matcher.js");
Matcher.useSongs(SONGS);

var PACK_COUNTS = {};
SONGS.forEach(function (s) { (s.packs || []).forEach(function (id) { PACK_COUNTS[id] = (PACK_COUNTS[id] || 0) + 1; }); });
var PACK_IDS = PACKS.map(function (p) { return p.id; });
var SONG_BUFFER = 5; // spare songs a game needs beyond one per turn (shuffles, tie-breaks)

var DEFAULTS = {
  limitMs: 60000,        // a turn that nobody guesses scores this
  countdownMs: 3000,     // 3, 2, 1 before the clock starts
  confirmMs: 10000,      // whistler has this long to confirm a detected guess
  cooldownMs: 4000,      // ignore guesses this long after the whistler says "no"
  shufflePenaltyS: 5,
  multipliers: { easy: 1, medium: 0.9, hard: 0.8 },
  sdDifficulty: "medium",
  sdMaxRounds: 3,
  minPlayers: 2,
  maxPlayers: 8,
  adminPassword: process.env.ADMIN_PASSWORD || "bean",
  defaultRounds: 5,
  minRounds: 1,
  maxRounds: 10,
  roomIdleMs: 15 * 60 * 1000,
  roomMaxAgeMs: 12 * 60 * 60 * 1000
};

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

// ------------------------------------------------------------------- views
RoomManager.prototype.viewFor = function (room, pid) {
  var self = this, t = room.turn, tv = null;
  if (t) {
    var isW = t.playerId === pid;
    tv = {
      id: t.id, playerId: t.playerId, stage: t.stage, difficulty: t.difficulty,
      multiplier: t.multiplier, shuffles: t.shuffles, sd: t.sd, round: t.round,
      countdownEndsAt: t.countdownEndsAt, accumulatedMs: t.accumulatedMs,
      runningSince: t.runningSince, limitMs: room.limitMs,
      penalty: this.opts.shufflePenaltyS
    };
    var locked = t.lockUntil && t.lockUntil > this.now();
    if (locked) { tv.lockUntil = t.lockUntil; }
    if (isW && t.options && t.stage === "choose" && !t.difficulty) {
      tv.canRefresh = !t.refreshed;
      tv.options = t.options.map(function (o) {
        return { difficulty: o.difficulty, multiplier: self.opts.multipliers[o.difficulty], title: o.song.title, artist: o.song.artist };
      });
    }
    if (isW && t.song && t.stage !== "reveal" && !locked) { tv.song = { title: t.song.title, artist: t.song.artist }; }
    if (isW && t.stage === "confirming" && t.pending) { tv.pending = { heard: t.pending.heard }; }
    if (t.stage === "reveal") { tv.result = t.result; }
  }
  return {
    code: room.code, phase: room.phase, hostId: room.hostId, me: pid,
    rounds: room.rounds, limitMs: room.limitMs, limitOptions: LIMIT_OPTIONS_MS, minPlayers: this.opts.minPlayers, maxPlayers: this.opts.maxPlayers,
    serverNow: this.now(),
    turnNumber: room.turnPos + 1, totalTurns: room.turns.length,
    suddenDeath: !!room.sd, sdRound: room.sd ? room.sd.round : 0,
    players: room.players.filter(function (p) { return !p.sitOut; }).map(function (p) {
      return { id: p.id, name: p.name, connected: p.connected, total: round1(p.total), last: p.last, turns: p.turns };
    }),
    packs: PACKS.map(function (p) {
      return { id: p.id, group: p.group, name: p.name, blurb: p.blurb, colour: p.colour, ink: p.ink, count: PACK_COUNTS[p.id] || 0 };
    }),
    selectedPacks: room.packs.slice(),
    songsInPlay: this.poolFor(room).length,
    turn: tv,
    winners: room.winners || null,
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
      // with host controls, so one person can walk through every screen.
      var as = findPlayer(room, room.admin.as) ? room.admin.as : p.id;
      var v = this.viewFor(room, as);
      v.hostId = as;
      v.admin = {
        as: as,
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
    out.push({ code: r.code, host: host.name, players: count, inProgress: r.phase === "turn" });
  }
  return out;
};

// Admin / test mode: a room with test players, driven by one person.
RoomManager.prototype.createAdmin = function (conn, msg) {
  var pw = String(msg.password == null ? "" : msg.password).trim().toLowerCase();
  if (pw !== String(this.opts.adminPassword).toLowerCase()) { return err(conn, "bad_password", "Wrong password."); }
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
  p.bot = true; p.connected = true;
  return p;
};

// ---------------------------------------------------------------- entry point
RoomManager.prototype.handle = function (conn, msg) {
  if (!msg || typeof msg.t !== "string") { return; }
  if (msg.t === "ping") { return conn.send({ t: "pong" }); }
  if (msg.t === "create") { return this.create(conn, msg); }
  if (msg.t === "createAdmin") { return this.createAdmin(conn, msg); }
  if (msg.t === "listRooms") { return conn.send({ t: "rooms", rooms: this.listRooms() }); }
  if (msg.t === "join") { return this.join(conn, msg); }

  var room = conn.roomCode ? this.rooms[conn.roomCode] : null;
  if (!room) { return err(conn, "room_not_found", "You are not in a room."); }
  var me = findPlayer(room, conn.playerId);
  if (!me) { return err(conn, "room_not_found", "You are not in this room."); }
  var isHost = room.hostId === me.id;

  if (room.admin && me.id === room.admin.pid) {
    if (msg.t === "leave") { return this.closeAdmin(room, conn); }
    if (msg.t === "adminAs") {
      if (findPlayer(room, msg.id)) { room.admin.as = msg.id; this.broadcast(room); }
      return;
    }
    if (msg.t === "adminAddBot") {
      if (room.phase === "lobby") { this.addBot(room); this.broadcast(room); }
      return;
    }
    // Everything else is done as the test player being viewed.
    var as = findPlayer(room, room.admin.as);
    if (as) { me = as; }
    isHost = true;
  }

  switch (msg.t) {
    case "setRounds":  return isHost ? this.setRounds(room, msg) : err(conn, "not_host", "Only the host can do that.");
    case "start":      return isHost ? this.start(room, conn) : err(conn, "not_host", "Only the host can do that.");
    case "next":       return isHost ? this.next(room) : err(conn, "not_host", "Only the host can do that.");
    case "skip":       return isHost ? this.skip(room) : err(conn, "not_host", "Only the host can do that.");
    case "playAgain":  return isHost ? this.playAgain(room) : err(conn, "not_host", "Only the host can do that.");
    case "setLimit":   return isHost ? this.setLimit(room, msg) : err(conn, "not_host", "Only the host can do that.");
    case "setPacks":   return isHost ? this.setPacks(room, msg) : err(conn, "not_host", "Only the host can do that.");
    case "addRound":   return isHost ? this.addRound(room, conn) : err(conn, "not_host", "Only the host can do that.");
    case "cancelGame": return isHost ? this.cancelGame(room) : err(conn, "not_host", "Only the host can do that.");
    case "refreshOptions": return this.refreshOptions(room, me);
    case "pickDifficulty": return this.pickDifficulty(room, me, msg);
    case "shuffle":    return this.shuffle(room, me);
    case "ready":      return this.ready(room, me);
    case "gotIt":      return this.gotIt(room, me);
    case "confirm":    return this.confirmGuess(room, me, !!msg.ok);
    case "guess":      return this.guess(room, me, conn, msg);
    case "leave":      return this.leave(room, me, conn);
    default: return;
  }
};

// -------------------------------------------------------- create / join / leave
RoomManager.prototype.attach = function (room, player, conn) {
  if (player.conn && player.conn !== conn) { player.conn.roomCode = null; player.conn.playerId = null; }
  player.conn = conn; player.connected = true;
  conn.roomCode = room.code; conn.playerId = player.id;
};

RoomManager.prototype.addPlayer = function (room, name) {
  var p = { id: newId(), name: name, conn: null, connected: false, total: 0, last: null, turns: 0 };
  room.players.push(p);
  return p;
};

RoomManager.prototype.create = function (conn, msg) {
  var name = cleanName(msg.name);
  if (!name) { return err(conn, "bad_name", "Enter a name first."); }
  var room = {
    code: this.makeCode(), hostId: null, players: [], phase: "lobby",
    rounds: this.opts.defaultRounds, limitMs: this.opts.limitMs, turns: [], turnPos: -1, turn: null, turnCounter: 0,
    packs: (this.opts.defaultPacks || []).slice(), used: {}, sd: null, winners: null, tieBreakWon: false,
    createdAt: this.now(), lastActive: this.now()
  };
  var p = this.addPlayer(room, name);
  room.hostId = p.id;
  this.rooms[room.code] = room;
  this.attach(room, p, conn);
  conn.send({ t: "joined", code: room.code, playerId: p.id });
  this.broadcast(room);
};

RoomManager.prototype.join = function (conn, msg) {
  var code = String(msg.code || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
  var room = this.rooms[code];
  if (!room) { return err(conn, "room_not_found", "No room with that code."); }

  if (msg.playerId) {
    var existing = findPlayer(room, msg.playerId);
    if (existing) {
      this.attach(room, existing, conn);
      conn.send({ t: "joined", code: room.code, playerId: existing.id });
      return this.broadcast(room);
    }
  }
  if (room.phase === "turn" && room.sd) {
    return err(conn, "game_started", "That game is in its final tie-break. Try again once it has finished.");
  }
  var name = cleanName(msg.name);
  if (!name) { return err(conn, "bad_name", "Enter a name first."); }
  for (var i = 0; i < room.players.length; i++) {
    if (room.players[i].name.toLowerCase() === name.toLowerCase()) { return err(conn, "name_taken", "That name is taken in this room."); }
  }
  if (room.players.length >= this.opts.maxPlayers) { return err(conn, "full", "That room is full."); }
  var p = this.addPlayer(room, name);
  if (room.phase === "turn") { this.scheduleLatePlayer(room, p); }
  if (room.phase === "gameover") { p.sitOut = true; }
  this.attach(room, p, conn);
  conn.send({ t: "joined", code: room.code, playerId: p.id });
  this.broadcast(room);
};

// Someone joining mid-game plays the rest of this round and every later round.
// The rounds they missed are added to the very end so everyone gets the same
// number of turns.
RoomManager.prototype.scheduleLatePlayer = function (room, p) {
  var cur = room.turns[room.turnPos] ? room.turns[room.turnPos].round : room.rounds;
  var r, i, last;
  for (r = cur; r <= room.rounds; r++) {
    last = -1;
    for (i = 0; i < room.turns.length; i++) { if (room.turns[i].round === r && !room.turns[i].sd) { last = i; } }
    if (last < 0) { continue; }
    room.turns.splice(last + 1, 0, { playerId: p.id, round: r, sd: false });
  }
  for (r = 1; r < cur; r++) { room.turns.push({ playerId: p.id, round: room.rounds, sd: false }); }
};

RoomManager.prototype.closeAdmin = function (room, conn) {
  conn.roomCode = null; conn.playerId = null;
  room.players.forEach(function (p) { if (p.conn) { p.conn.roomCode = null; p.conn.playerId = null; p.conn = null; } });
  if (room.turn) { this.clearTimers(room.turn); }
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
  this.broadcast(room);
};

RoomManager.prototype.leave = function (room, me, conn) {
  var wasWhistler = room.turn && room.turn.playerId === me.id && room.turn.stage !== "reveal";
  conn.roomCode = null; conn.playerId = null;
  me.conn = null; me.connected = false;
  if (room.phase === "lobby") {
    room.players = room.players.filter(function (p) { return p.id !== me.id; });
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
  if (room.phase !== "lobby" || !Array.isArray(msg.packs)) { return; }
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
    return err(conn, "too_few_songs", "Not enough unplayed songs left in the chosen packs for another round.");
  }
  room.rounds++;
  for (var i = 0; i < room.players.length; i++) {
    if (!room.players[i].sitOut) { room.turns.push({ playerId: room.players[i].id, round: room.rounds, sd: false }); }
  }
  this.broadcast(room);
};

RoomManager.prototype.start = function (room, conn) {
  if (room.phase !== "lobby") { return; }
  if (room.players.length < this.opts.minPlayers) {
    return err(conn, "too_few", "You need at least " + this.opts.minPlayers + " players.");
  }
  if (!room.packs.length) { return err(conn, "no_packs", "Pick at least one song pack first."); }
  var need = room.players.length * room.rounds + SONG_BUFFER;
  if (this.poolFor(room).length < need) {
    return err(conn, "too_few_songs", "These packs only have " + this.poolFor(room).length + " songs, and this game needs about " + need + ". Tick more packs or lower the rounds.");
  }
  room.players.forEach(function (p) { p.total = 0; p.last = null; p.turns = 0; });
  room.turns = [];
  for (var r = 1; r <= room.rounds; r++) {
    for (var i = 0; i < room.players.length; i++) {
      room.turns.push({ playerId: room.players[i].id, round: r, sd: false });
    }
  }
  room.turnPos = -1; room.sd = null; room.winners = null; room.tieBreakWon = false; room.used = {};
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
  room.turnPos++;
  if (room.turnPos < room.turns.length) { return this.beginTurn(room, room.turns[room.turnPos]); }
  this.afterTurns(room);
};

RoomManager.prototype.beginTurn = function (room, t) {
  room.turnCounter++;
  var turn = {
    id: room.turnCounter, playerId: t.playerId, round: t.round, sd: !!t.sd,
    stage: "choose", difficulty: null, multiplier: null, song: null, shuffles: 0,
    accumulatedMs: 0, runningSince: null, countdownEndsAt: null, pending: null,
    cooldownUntil: 0, lockUntil: 0, options: null, result: null, timers: {}
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
  if (!t || t.difficulty || !t.options || t.refreshed) { return; }
  var fresh = this.dealOptions(room, t.options.map(function (o) { return o.song.title; }));
  if (!fresh.length) { return; }
  t.options = fresh; t.refreshed = true;
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
  var min = Infinity;
  room.players.forEach(function (p) { if (!p.sitOut && p.total < min) { min = p.total; } });
  var ids = room.players.filter(function (p) { return !p.sitOut && round1(p.total) === round1(min); }).map(function (p) { return p.id; });
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
  this.broadcast(room);
};

// Shuffle during the round: new song of the same difficulty, and the whistler's
// screen locks for the penalty time. The clock keeps running through the lock.
RoomManager.prototype.shuffle = function (room, me) {
  var t = this.currentTurnFor(room, me, ["whistling"]);
  if (!t || !t.difficulty || (t.lockUntil && t.lockUntil > this.now())) { return; }
  var self = this, id = t.id, ms = this.opts.shufflePenaltyS * 1000;
  if (!this.drawSong(room, t)) { return; } // no unplayed songs left: nothing to shuffle to
  t.shuffles++;
  t.lockUntil = this.now() + ms;
  if (t.timers.lock) { clearTimeout(t.timers.lock); }
  t.timers.lock = setTimeout(function () {
    if (room.turn && room.turn.id === id) { self.broadcast(room); }
  }, ms + 20);
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
  if (this.now() < t.cooldownUntil || this.now() < t.lockUntil) { return; }
  var typed = !!msg.typed;
  var alts = (Array.isArray(msg.alts) ? msg.alts : []).slice(0, 5)
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
  t.pending = { heard: Matcher.heardPhrase(r.guess, t.song, { typed: typed }) || r.guess, from: me.id };
  t.timers.confirm = setTimeout(function () {
    if (room.turn && room.turn.id === id && room.turn.stage === "confirming") { self.confirmGuess(room, null, false, true); }
  }, this.opts.confirmMs);
  this.broadcast(room);
};

RoomManager.prototype.confirmGuess = function (room, me, ok, byTimeout) {
  var t = room.turn;
  if (room.phase !== "turn" || !t || t.stage !== "confirming") { return; }
  if (!byTimeout && t.playerId !== me.id) { return; }
  if (t.timers.confirm) { clearTimeout(t.timers.confirm); t.timers.confirm = null; }
  if (ok) { return this.finishTurn(room, "correct"); }
  t.stage = "whistling";
  t.pending = null;
  t.runningSince = this.now();
  t.cooldownUntil = this.now() + this.opts.cooldownMs;
  this.scheduleCap(room, t);
  this.broadcast(room);
};

RoomManager.prototype.gotIt = function (room, me) {
  var t = this.currentTurnFor(room, me, ["whistling", "confirming"]);
  if (!t || this.now() < t.lockUntil) { return; }
  if (t.stage === "whistling") { this.pause(t); }
  this.finishTurn(room, "correct");
};

RoomManager.prototype.skip = function (room) {
  if (room.phase !== "turn" || !room.turn || room.turn.stage === "reveal") { return; }
  var t = room.turn;
  if (t.stage === "whistling") { this.pause(t); }
  this.finishTurn(room, "skipped");
};

RoomManager.prototype.finishTurn = function (room, outcome) {
  var t = room.turn;
  if (!t || t.stage === "reveal") { return; }
  this.clearTimers(t);
  var limitS = room.limitMs / 1000;
  var timeMs = outcome === "correct" ? Math.min(t.accumulatedMs, room.limitMs) : room.limitMs;
  var mult = t.multiplier || 1;
  var score;
  if (outcome === "correct") {
    // The shuffle lock time is part of the clock but is not discounted by the multiplier.
    var lockedS = this.opts.shufflePenaltyS * t.shuffles;
    score = round1(Math.min(limitS, Math.max(0, timeMs / 1000 - lockedS) * mult + lockedS));
  } else {
    score = limitS;
  }
  t.stage = "reveal";
  t.pending = null;
  t.result = {
    outcome: outcome, timeMs: timeMs, multiplier: t.multiplier, difficulty: t.difficulty,
    shuffles: t.shuffles, score: score,
    song: t.song ? { title: t.song.title, artist: t.song.artist } : null
  };
  var p = findPlayer(room, t.playerId);
  if (p) {
    p.last = score;
    if (t.sd) { room.sd.scores[p.id] = score; }
    else { p.total = round1(p.total + score); p.turns++; }
  }
  this.broadcast(room);
};

RoomManager.prototype.next = function (room) {
  if (room.phase !== "turn" || !room.turn || room.turn.stage !== "reveal") { return; }
  this.advance(room);
};

// ------------------------------------------------------ tie-break and the end
RoomManager.prototype.afterTurns = function (room) {
  var i, ids;
  if (room.sd) {
    var best = Infinity;
    room.sd.contenders.forEach(function (id) { if (room.sd.scores[id] < best) { best = room.sd.scores[id]; } });
    var winners = room.sd.contenders.filter(function (id) { return room.sd.scores[id] === best; });
    if (winners.length === 1 || room.sd.round >= this.opts.sdMaxRounds) { return this.gameOver(room, winners, true); }
    room.sd.contenders = winners; room.sd.round++; room.sd.scores = {};
    return this.queueSuddenDeath(room);
  }
  var min = Infinity;
  room.players.forEach(function (p) { if (p.total < min) { min = p.total; } });
  ids = room.players.filter(function (p) { return round1(p.total) === round1(min); }).map(function (p) { return p.id; });
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

RoomManager.prototype.gameOver = function (room, winnerIds, viaTieBreak) {
  room.phase = "gameover";
  room.turn = null;
  room.winners = winnerIds;
  room.tieBreakWon = !!viaTieBreak;
  this.broadcast(room);
};

RoomManager.prototype.resetToLobby = function (room) {
  this.clearTimers(room.turn);
  room.players = room.players.filter(function (p) { return p.connected; });
  room.players.forEach(function (p) { p.total = 0; p.last = null; p.turns = 0; p.sitOut = false; });
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
  this.resetToLobby(room);
};

// ------------------------------------------------------------------- cleanup
RoomManager.prototype.sweep = function () {
  var now = this.now();
  for (var code in this.rooms) {
    var room = this.rooms[code];
    var anyone = room.players.some(function (p) { return p.connected && !p.bot; });
    if ((!anyone && now - room.lastActive > this.opts.roomIdleMs) || now - room.createdAt > this.opts.roomMaxAgeMs) {
      this.clearTimers(room.turn);
      delete this.rooms[code];
    }
  }
};

module.exports = { RoomManager: RoomManager, DEFAULTS: DEFAULTS };
