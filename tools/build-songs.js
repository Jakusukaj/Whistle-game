"use strict";
// Builds songs.js from the text files in songs-src/.
// Run: node tools/build-songs.js
// Line format:  Title | Artist | e/m/h | year or - | flags | aliases (separated by ;)
// Flags: B all-time bangers, V Pop Off Diva (artists in the DIVA list join automatically), P party, S soul/Motown, F film, D Disney/musicals, X Christmas, T TV,
//        H Halloween, L Beatles, O Bowie, G Lady Gaga, K Talking Heads, ABBA (picked up from the artist name; no flag needed) (artist packs are also picked up from the artist name),
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
fs.readdirSync(dir).filter(function (f) { return /\.txt$/.test(f) && f[0] !== "_" && !/^hints/.test(f); }).sort().forEach(function (f) {
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

// Pop Off Diva: these artists are in the pack automatically. Other songs join with the V flag.
var DIVA_GAGA_SKIP = ["disease","joanne","perfect illusion","dance in the dark","speechless","gypsy","bloody mary","eh eh nothing else i can say","911","do what u want","i ll never love again","always remember us this way"];
var DIVA = new RegExp("\\b(" + [
  "lady gaga", "dua lipa", "billie eilish", "sabrina carpenter", "miley cyrus", "ariana grande", "little mix", "lizzo", "charli xcx", "taylor swift", "beyonce",
  "olivia rodrigo", "doja cat", "chappell roan", "raye", "addison rae", "zara larsson"
].join("|") + ")\\b");

// Big Hair 80s is British only: a song from 1980 to 1989 joins it if its artist matches or it has the U flag.
var UK80 = new RegExp("\\b(" + [
  "queen", "david bowie", "wham", "george michael", "tears for fears", "eurythmics", "culture club", "boy george", "duran duran", "spandau ballet",
  "human league", "soft cell", "new order", "joy division", "depeche mode", "dexys", "madness", "specials", "clash", "frankie goes", "adam ant", "adam and the ants",
  "smiths", "cure", "simple minds", "police", "sting", "kate bush", "dire straits", "band aid", "cliff richard", "shakin stevens", "chris rea", "aled jones",
  "jona lewie", "pogues", "pretenders", "soul ii soul", "def leppard", "iron maiden", "motorhead", "whitesnake", "sheena easton", "andrew lloyd webber", "phil collins",
  "genesis", "elton john", "bananarama", "pet shop boys", "erasure", "yazoo", "alison moyet", "ultravox", "visage", "heaven 17", "abc", "orchestral manoeuvres",
  "thompson twins", "kajagoogoo", "howard jones", "nik kershaw", "paul young", "go west", "level 42", "simply red", "wet wet wet", "ub40", "housemartins", "beat",
  "selecter", "bad manners", "squeeze", "ian dury", "stranglers", "buzzcocks", "siouxsie", "talk talk", "waterboys", "king", "blancmange", "peter gabriel",
  "bucks fizz", "kim wilde", "toyah", "bow wow wow", "t pau", "bros", "rick astley", "dead or alive", "gary numan", "spandau", "the jam", "paul weller", "style council",
  "elvis costello", "billy bragg", "echo and the bunnymen", "teardrop explodes", "big country", "aztec camera", "orange juice", "sade", "freddie mercury", "lisa stansfield",
  "sparks", "sinitta", "belinda carlisle", "bronski beat", "communards", "jimmy somerville", "pet shop", "ultravox", "japan", "david sylvian", "roxy music", "bryan ferry",
  "the passions", "slade", "shakatak", "imagination", "central line", "linx", "odyssey", "five star", "loose ends", "sade", "cutting crew",
  "johnny hates jazz", "curiosity killed the cat", "climie fisher", "living in a box", "fine young cannibals", "eighth wonder", "swing out sister", "mel and kim", "mel kim",
  "samantha fox", "sonia", "bros", "brother beyond", "pepsi and shirlie", "the christians", "the proclaimers", "proclaimers", "deacon blue", "hue and cry", "texas", "altered images",
  "associates", "bluebells", "wang chung", "tight fit", "dollar", "hazell dean", 
].join("|") + ")\\b");

// Hints (songs-src/hints-*.txt): Title | hint 1 | hint 2 | hint 3, from a gentle nudge to nearly obvious.
var hintsByTitle = {};
fs.readdirSync(dir).filter(function (f) { return /^hints.*\.txt$/.test(f); }).sort().forEach(function (f) {
  fs.readFileSync(path.join(dir, f), "utf8").split("\n").forEach(function (l, i) {
    if (!l.trim() || l[0] === "#") { return; }
    var q = l.split(" | ");
    if (q.length !== 4) { warnings.push(f + ":" + (i + 1) + " hint line needs 4 parts: " + l.slice(0, 60)); return; }
    var k = M.normalise(q[0]);
    if (!hintsByTitle[k]) { hintsByTitle[k] = [q[1].trim(), q[2].trim(), q[3].trim()]; }
  });
});

function packsFor(s) {
  var out = [], y = s.year, f = s.flags;
  if (f.indexOf("B") !== -1) { out.push("bangers"); }
  var isGaga = /gaga/.test(M.normalise(s.artist));
  var divaArtist = (DIVA.test(M.normalise(s.artist)) || M.normalise(s.artist) === "pink") && !(isGaga && DIVA_GAGA_SKIP.indexOf(M.normalise(s.title)) !== -1);
  if (divaArtist && (isGaga || y === null || y >= 2010)) { out.push("diva"); }
  if (y !== null && f.indexOf("A") === -1) {
    if (y >= 1960 && y <= 1969) { out.push("sixties"); }
    if (y >= 1970 && y <= 1979) { out.push("seventies"); }
    if (y >= 1980 && y <= 1989 && (f.indexOf("U") !== -1 || UK80.test(M.normalise(s.artist)))) { out.push("eighties"); }
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
  if (/\babba\b/.test(a)) { out.push("abba"); }
  return out;
}

var list = order.map(function (k) { return songs[k]; }).filter(function (s) { return packsFor(s).length > 0; });
var missingHints = [];
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
  var hk = M.normalise(s.title);
  if (hintsByTitle[hk]) { o += ', hints: ' + JSON.stringify(hintsByTitle[hk]); }
  else { missingHints.push(s.title + " | " + s.artist + " | " + (s.year || "-") + " | " + packsFor(s).join(",")); }
  out.push(o + " }" + (i < list.length - 1 ? "," : ""));
});
out.push("];", "", 'if (typeof module !== "undefined" && module.exports) { module.exports = SONGS; }', "");
fs.writeFileSync(path.join(__dirname, "..", "songs.js"), out.join("\n"));

var counts = {};
list.forEach(function (s) { packsFor(s).forEach(function (p) { counts[p] = counts[p] || { easy: 0, medium: 0, hard: 0, all: 0 }; counts[p][s.difficulty]++; counts[p].all++; }); });
console.log("songs:", list.length);
Object.keys(counts).forEach(function (p) { console.log(p.padEnd(10), JSON.stringify(counts[p])); });
warnings.forEach(function (w) { console.log("WARN", w); });
console.log("songs without hints:", missingHints.length);
fs.writeFileSync(path.join(__dirname, "..", "songs-src", "_missing-hints.txt"), missingHints.join("\n"));
