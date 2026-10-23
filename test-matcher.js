// Run with: node test-matcher.js
var SONGS = require("./songs.js");
var M = require("./matcher.js");
M.useSongs(SONGS);

function song(title) {
  for (var i = 0; i < SONGS.length; i++) {
    if (SONGS[i].title === title) { return SONGS[i]; }
  }
  return { title: title, artist: "", difficulty: "easy" }; // not in the shorter test list
}

// [song title, guess, should it match?]
var cases = [
  // Your example: a near miss must NOT trigger
  ["Let It Be", "let it go", false],
  ["Bad Romance", "she loves you", false],
  ["Take On Me", "take me out", false],
  ["Don't Stop Believin'", "stop", false],
  ["We Will Rock You", "rock", false],
  ["Hey Jude", "hey", false],
  ["Hey Ya!", "hey", false],
  ["Dancing Queen", "dance", false],
  ["Total Eclipse of the Heart", "heart", false],
  ["Girls Just Want to Have Fun", "girls", false],
  ["Sweet Caroline", "sweet", false],
  ["Sweet Caroline", "sweet home alabama", false],
  ["Purple Rain", "rain", false],
  ["Purple Rain", "purple haze", false],
  ["Singin' in the Rain", "purple rain", false],
  ["Happy", "don't worry", false],
  ["Don't Worry Be Happy", "happy", false],
  ["Time After Time", "after", false],
  ["Bad Romance", "bad rom", false],

  // Clear attempts MUST trigger
  ["Bad Romance", "bad romance", true],
  ["Bad Romance", "romance", true],
  ["Sweet Caroline", "caroline", true],
  ["Sweet Caroline", "sweet caroline", true],
  ["Purple Rain", "purple rain", true],
  ["Purple Haze", "purple haze", true],
  ["Don't Worry Be Happy", "don't worry", true],
  ["Time After Time", "time after time", true],
  ["Here Comes the Sun", "here comes the sun", true],
  ["Smoke on the Water", "smoke on the water", true],
  ["Bad Romance", "is it bad romance", true],
  ["Let It Be", "let it be", true],
  ["Let It Be", "is it let it be", true],
  ["Take On Me", "take on me", true],
  ["Don't Stop Believin'", "don't stop believing", true],
  ["Don't Stop Believin'", "believing", true],
  ["Livin' on a Prayer", "living on a prayer", true],
  ["Y.M.C.A.", "ymca", true],
  ["Y.M.C.A.", "y m c a", true],
  ["Hey Ya!", "hey ya", true],
  ["Total Eclipse of the Heart", "total eclipse", true],
  ["Total Eclipse of the Heart", "eclipse of the heart", true],
  ["We Will Rock You", "we will rock you", true],
  ["Girls Just Want to Have Fun", "girls just wanna have fun", true],
  ["Bohemian Rhapsody", "bohemian rhapsody", true],
  ["Bohemian Rhapsody", "bohemian rhapsodie", true],
  ["Smells Like Teen Spirit", "teen spirit", true],
  ["Smells Like Teen Spirit", "smells like teen spirit", true],
  ["Take Me Home, Country Roads", "country roads", true],
  ["Mr. Brightside", "mister brightside", true],
  ["Mr. Brightside", "brightside", true],
  ["Wonderwall", "wonderwall", true],
  ["Africa", "africa", true],
  ["Imagine", "imagine", true],
  ["Happy", "happy", true],
  ["Dancing Queen", "dancing queen", true],
  ["Singin' in the Rain", "singing in the rain", true],
  ["Rolling in the Deep", "rolling in the deep", true],
  ["Paranoid Android", "paranoid android", true],
  ["Whole Lotta Love", "whole lotta love", true],
  ["A Whiter Shade of Pale", "whiter shade of pale", true],

  // Unrelated chatter must NOT trigger
  ["Wonderwall", "what a great song", false],
  ["Bohemian Rhapsody", "I think it's a Queen song", false],
  ["Hotel California", "is it the eagles", false],
  ["Dancing Queen", "is it abba", false],
  ["Let It Be", "I don't know", false],
  ["Take On Me", "a-ha", false]
];

var failed = 0;
cases.forEach(function (c) {
  var r = M.matchTitle(c[1], song(c[0]));
  var ok = r.matched === c[2];
  if (!ok) { failed++; }
  console.log((ok ? "PASS " : "FAIL ") + c[0] + "  <-  \"" + c[1] + "\"  expected " + c[2] + ", got " + r.matched);
});

// Typed guesses: typos must be forgiven, near misses must still be rejected
var typedCases = [
  // the ones reported from the phone
  ["Let It Be", "let it be", true],
  ["Let It Be", "lit it be", true],
  ["Let It Be", "let it ba", true],
  ["Let It Be", "let it bs", true],
  // other kinds of slip
  ["Let It Be", "Let it bee", true],
  ["Let It Be", "let ti be", true],
  ["Let It Be", "letit be", false],
  ["Let It Be", "LET IT BE!!", true],
  ["Take On Me", "take on mw", true],
  ["Take On Me", "tkae on me", true],
  ["Bad Romance", "bad romamce", true],
  ["Bad Romance", "romnace", true],
  ["Bohemian Rhapsody", "bohemain rapsody", true],
  ["Bohemian Rhapsody", "bohemian rhapsodie", true],
  ["Dancing Queen", "dancin queen", true],
  ["Hey Ya!", "hey yaa", true],
  ["Wonderwall", "wonderwal", true],
  ["Don't Stop Believin'", "dont stop beleiving", true],
  ["Total Eclipse of the Heart", "total eclispe of the hart", true],
  ["Hey Jude", "hey jued", true],
  // still rejected
  ["Walk on the Wild Side", "we will rock you", false],
  ["Lean on Me", "billie jean", false],
  ["Brown Eyed Girl", "eye of the tiger", false],
  ["Life on Mars?", "mrs robinson", false],
  ["Wish You Were Here", "here comes the sun", false],
  ["Let It Be", "let it go", false],
  ["Let It Be", "let it", false],
  ["Let It Be", "be", false],
  ["Take On Me", "take me out", false],
  ["Bad Romance", "she loves you", false],
  ["Bad Romance", "bad", false],
  ["Hey Jude", "hey", false],
  ["Wonderwall", "wonder", false],
  ["Sweet Caroline", "sweet", false],
  ["Sweet Caroline", "sweet home alabama", false],
  ["Purple Rain", "rain", false],
  ["We Will Rock You", "we will", false],
  ["Dancing Queen", "dance", false]
];
var typedFailed = 0;
typedCases.forEach(function (c) {
  var r = M.matchTitle(c[1], song(c[0]), { typed: true });
  var ok = r.matched === c[2];
  if (!ok) { typedFailed++; }
  console.log((ok ? "PASS " : "FAIL ") + "[typed] " + c[0] + "  <-  \"" + c[1] + "\"  expected " + c[2] + ", got " + r.matched);
});
failed += typedFailed;

// Cross-check: no song's own title should match a DIFFERENT song.
// Skipped when one title is simply contained in the other (e.g. "Happy" and
// "Don't Worry Be Happy"): saying the longer title does contain the shorter.
function contains(longer, shorter) {
  return (" " + M.normalise(longer) + " ").indexOf(" " + M.normalise(shorter) + " ") !== -1;
}
var cross = 0;
[false, true].forEach(function (typed) {
  SONGS.forEach(function (a) {
    SONGS.forEach(function (b) {
      if (a === b) { return; }
      if (contains(a.title, b.title) || contains(b.title, a.title)) { return; }
      if (M.matchTitle(a.title, b, { typed: typed }).matched) {
        cross++;
        console.log("CROSS-MATCH" + (typed ? " (typed)" : "") + ": guessing \"" + a.title + "\" would trigger \"" + b.title + "\"");
      }
    });
  });
});

// Every song's own title must match itself
var self = 0;
SONGS.forEach(function (s) {
  if (!M.matchTitle(s.title, s).matched) { self++; console.log("SELF-MISS: " + s.title); }
});

var counts = { easy: 0, medium: 0, hard: 0 };
var seen = {}, dupes = 0;
SONGS.forEach(function (s) {
  counts[s.difficulty]++;
  if (seen[s.title]) { dupes++; console.log("DUPLICATE: " + s.title); }
  seen[s.title] = true;
});

console.log("\nCases: " + cases.length + ", failed: " + failed);
console.log("Cross-matches between different songs: " + cross);
console.log("Songs that fail to match their own title: " + self);
console.log("Counts: " + JSON.stringify(counts) + ", duplicates: " + dupes);
process.exit(failed || cross || self || dupes ? 1 : 0);
