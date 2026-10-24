"use strict";
// Builds songs.js from the text files in songs-src/.
// Run: node tools/build-songs.js
// Line format:  Title | Artist | e/m/h | year or - | flags | aliases (separated by ;)
// Flags: B all-time bangers, R rock, P party, S soul/Motown, F film, D Disney/musicals, X Christmas, T TV,
//        H Halloween, L Beatles, O Bowie, G Lady Gaga, K Talking Heads (artist packs are also picked up from the artist name),
//        A artist/special-pack only: keeps a deeper cut out of the decade and "today" packs (ignored if the song is also listed without A)
// Decade and "today" packs come from the year. A song is listed ONCE however many packs it is in.
var fs = require("fs"), path = require("path");
var M = require("../matcher.js");
var dir = path.join(__dirname, "..", "songs-src");
var DIFF = { e: "easy", m: "medium", h: "hard" };

var removeRaw = fs.readFileSync(path.join(dir, "_remove.txt"), "utf8").split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
var removeTitles = {}, removePairs = {};
removeRaw.forEach(function (l) {
  var p = l.split("|").map(function (x) { return x.trim(); });
  if (p.length > 1) { removePairs[M.normalise(p[0]) + "|" + M.normalise(p[1])] = true; } else { removeTitles[M.normalise(p[0])] = true; }
});

var songs = {}, order = [], warnings = [];
fs.readdirSync(dir).filter(function (f) { return /\.txt$/.test(f) && f[0] !== "_"; }).sort().forEach(function (f) {
  fs.readFileSync(path.join(dir, f), "utf8").split("\n").forEach(function (line, i) {
    if (!line.trim() || line[0] === "#") { return; }
    var p = line.split("|").map(function (x) { return x.trim(); });
    if (p.length < 4 || !DIFF[p[2]]) { warnings.push(f + ":" + (i + 1) + " bad line: " + line); return; }
    var key = M.normalise(p[0]);
    if (!key || removeTitles[key] || removePairs[key + "|" + M.normalise(p[1])]) { return; }
    var year = p[3] === "-" ? null : parseInt(p[3], 10);
    var flags = (p[4] || "").replace(/\s/g, "");
    var aliases = p[5] ? p[5].split(";").map(function (a) { return a.trim(); }).filter(Boolean) : [];
    var artist = p[1];
    if (year === null && flags.indexOf("T") !== -1 && flags.indexOf("F") === -1 && flags.indexOf("D") === -1) { artist = "TV theme"; }
    var s = songs[key];
    if (s) {
      if (M.normalise(s.artist) !== M.normalise(artist) && artist !== "TV theme" && s.artist !== "TV theme") {
        warnings.push("SAME TITLE, DIFFERENT ARTIST: " + p[0] + " (" + s.artist + " / " + artist + ") in " + f);
      }
      if (s.flags.indexOf("A") !== -1 && flags.indexOf("A") === -1) { s.flags = s.flags.replace("A", ""); }
      flags.split("").forEach(function (c) { if (c !== "A" && s.flags.indexOf(c) === -1) { s.flags += c; } });
      if (s.year === null && year !== null) { s.year = year; }
      aliases.forEach(function (a) { if (s.aliases.indexOf(a) === -1) { s.aliases.push(a); } });
      return;
    }
    songs[key] = { title: p[0], artist: artist, difficulty: DIFF[p[2]], year: year, flags: flags, aliases: aliases };
    order.push(key);
  });
});

// Difficulty overrides (songs-src/_regrade.txt): e: easy list, h: hard list, titles separated by " ; ".
fs.readFileSync(path.join(dir, "_regrade.txt"), "utf8").split("\n").forEach(function (line) {
  var m = /^([ehm]):\s*(.*)$/.exec(line.trim());
  if (!m) { return; }
  m[2].split(" ; ").forEach(function (t) {
    var k = M.normalise(t.trim());
    if (songs[k]) { songs[k].difficulty = { e: "easy", m: "medium", h: "hard" }[m[1]]; }
    else { warnings.push("regrade title not found: " + t.trim()); }
  });
});

// Songs whose aliases are dropped because they made other songs fire by accident.
fs.readFileSync(path.join(dir, "_noalias.txt"), "utf8").split("\n").forEach(function (t) {
  var k = M.normalise(t.trim());
  if (k && songs[k]) { songs[k].aliases = []; }
});

// Years for the hint lifeline only (never used for decade packs).
var hintYears = {};
fs.readFileSync(path.join(dir, "_years.txt"), "utf8").split("\n").forEach(function (l) {
  if (!l.trim() || l[0] === "#") { return; }
  var q = l.split("|"); if (q.length === 2) { hintYears[M.normalise(q[0].trim())] = parseInt(q[1], 10); }
});
Object.keys(songs).forEach(function (k) { if (songs[k].year === null && hintYears[k]) { songs[k].hintYear = hintYears[k]; } });

function packsFor(s) {
  var out = [], y = s.year, f = s.flags;
  if (f.indexOf("B") !== -1) { out.push("bangers"); }
  if (f.indexOf("R") !== -1) { out.push("rock"); }
  if (y !== null && f.indexOf("A") === -1) {
    if (y >= 1960 && y <= 1969) { out.push("sixties"); }
    if (y >= 1970 && y <= 1979) { out.push("seventies"); }
    if (y >= 1980 && y <= 1989) { out.push("eighties"); }
    if (y >= 1990 && y <= 1999) { out.push("nineties"); }
    if (y >= 2000 && y <= 2009) { out.push("noughties"); }
    if (y >= 2010 && y <= 2019) { out.push("tens"); }
    if (y >= 2019) { out.push("today"); }
  }
  if (f.indexOf("T") !== -1) { out.push("tv"); }
  if (f.indexOf("F") !== -1) { out.push("film"); }
  if (f.indexOf("D") !== -1) { out.push("disney"); }
  if (f.indexOf("X") !== -1) { out.push("xmas"); }
  if (f.indexOf("P") !== -1) { out.push("party"); }
  if (f.indexOf("S") !== -1) { out.push("soul"); }
  if (f.indexOf("H") !== -1) { out.push("halloween"); }
  var a = M.normalise(s.artist);
  if (f.indexOf("L") !== -1 || /\bthe beatles\b/.test(a)) { out.push("beatles"); }
  if (f.indexOf("O") !== -1 || /\bdavid bowie\b/.test(a)) { out.push("bowie"); }
  if (f.indexOf("G") !== -1 || /\blady gaga\b/.test(a)) { out.push("gaga"); }
  if (f.indexOf("K") !== -1 || /\btalking heads\b/.test(a)) { out.push("talkingheads"); }
  return out;
}

var list = order.map(function (k) { return songs[k]; }).filter(function (s) { return packsFor(s).length > 0; });
var out = ["// Song library. Generated by tools/build-songs.js from songs-src/. Edit the text files there, then rebuild.",
  "//",
  "// Every song appears ONCE here. The packs it belongs to are listed in `packs`, so a song that",
  "// sits in several packs can never be drawn twice in one game.",
  "// difficulty is how hard the tune is to WHISTLE, not how obscure the song is.",
  "", "var SONGS = ["];
list.forEach(function (s, i) {
  var o = '  { title: ' + JSON.stringify(s.title) + ', artist: ' + JSON.stringify(s.artist) + ', difficulty: "' + s.difficulty + '", packs: ' + JSON.stringify(packsFor(s));
  if (s.year !== null) { o += ", year: " + s.year; }
  else if (s.hintYear) { o += ", year: " + s.hintYear; }
  if (s.aliases.length) { o += ', aliases: ' + JSON.stringify(s.aliases); }
  out.push(o + " }" + (i < list.length - 1 ? "," : ""));
});
out.push("];", "", 'if (typeof module !== "undefined" && module.exports) { module.exports = SONGS; }', "");
fs.writeFileSync(path.join(__dirname, "..", "songs.js"), out.join("\n"));

var counts = {};
list.forEach(function (s) { packsFor(s).forEach(function (p) { counts[p] = counts[p] || { easy: 0, medium: 0, hard: 0, all: 0 }; counts[p][s.difficulty]++; counts[p].all++; }); });
console.log("songs:", list.length);
Object.keys(counts).forEach(function (p) { console.log(p.padEnd(10), JSON.stringify(counts[p])); });
warnings.forEach(function (w) { console.log("WARN", w); });
