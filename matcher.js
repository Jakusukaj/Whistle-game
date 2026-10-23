// Title matcher for the whistling game.
//
// Question it answers: "did this guess (spoken or typed) look like a clear
// attempt at this song title?" It is used for both the microphone and typed
// guesses. A match never reveals anything by itself: the game only sends the
// guess to the whistler, who confirms or rejects it.
//
// How it decides:
//   1. Both sides are lower-cased and stripped of punctuation.
//   2. Each word of the title is classed as:
//        stop   = filler ("the", "it", "me", "you", "let"...)
//        weak   = common words that appear in lots of titles and in normal
//                 chatter ("love", "baby", "hey", "stop", "rock"...)
//        strong = anything else that is 4+ letters: the distinctive words
//   3. If the title has strong words, the guess must contain enough of them
//      ("Romance" is enough for "Bad Romance"; "Eclipse" for "Total Eclipse
//      of the Heart"). Words are matched allowing small spelling or speech
//      recognition slips ("believing" for "believin'"). A word that appears in
//      several titles in the song list ("sweet", "rain") counts as weak, so
//      "Sweet Caroline" is never triggered by "Sweet Home Alabama". Call
//      Matcher.useSongs(SONGS) once after loading the list.
//   4. If the title has NO strong words (e.g. "Let It Be", "Take On Me",
//      "Let Me Love You") the guess has to contain about three quarters of
//      the whole title, so "She Loves You" can never trigger "Let Me Love You".
//   5. Typed guesses (options.typed) forgive one typo in any word of two or
//      more letters, and swapped letters, so "lit it be" or "let it bs" count
//      for "Let It Be" whilst "let it go" still does not.

(function (root) {
  function toSet(words) {
    var o = {};
    for (var i = 0; i < words.length; i++) { o[words[i]] = true; }
    return o;
  }

  var STOP = toSet([
    "the", "a", "an", "of", "to", "in", "on", "at", "and", "or", "it", "its",
    "is", "be", "i", "me", "my", "you", "your", "we", "us", "am", "are", "do",
    "dont", "let", "lets", "for", "with", "from", "by", "as", "so", "if"
  ]);

  var WEAK = toSet([
    "love", "loves", "baby", "girl", "girls", "boy", "night", "day", "time",
    "world", "life", "heart", "dance", "song", "man", "woman", "little", "big",
    "good", "bad", "rock", "roll", "home", "road", "way", "back", "down",
    "never", "always", "ever", "like", "want", "need", "gonna", "wanna", "hey",
    "oh", "yeah", "stop", "will", "would", "just", "take", "have", "get", "got",
    "come", "comes", "go", "going", "one", "another", "now", "all", "here",
    "there", "this", "that", "what", "when", "where", "why", "how", "say",
    "tell", "see", "look", "make", "feel", "know", "give", "walk", "run",
    "after", "over", "under", "again", "away", "around", "still", "only"
  ]);

  // Words that appear in more than one title in the song list ("sweet",
  // "rain", "purple"...). They cannot identify a song on their own, so they are
  // treated like weak words. Filled in by useSongs().
  var SHARED = {};

  function useSongs(songs) {
    var seen = {}, shared = {};
    for (var i = 0; i < songs.length; i++) {
      var tt = tokens(songs[i].title), once = {};
      for (var j = 0; j < tt.length; j++) {
        if (once[tt[j]]) { continue; }
        once[tt[j]] = true;
        if (seen[tt[j]]) { shared[tt[j]] = true; }
        seen[tt[j]] = true;
      }
    }
    SHARED = shared;
  }

  function normalise(s) {
    return String(s == null ? "" : s)
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/['’`]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/^\s+|\s+$/g, "");
  }

  function tokens(s) {
    var n = normalise(s)
      .replace(/\bwanna\b/g, "want to")
      .replace(/\bgonna\b/g, "going to")
      .replace(/\bgotta\b/g, "got to")
      .replace(/\blemme\b/g, "let me")
      .replace(/\bgimme\b/g, "give me");
    return n ? n.split(" ") : [];
  }

  // Edit distance where swapping two neighbouring letters counts as one slip.
  function levenshtein(a, b) {
    if (a === b) { return 0; }
    var m = a.length, n = b.length, d = [], i, j;
    if (!m) { return n; }
    if (!n) { return m; }
    for (i = 0; i <= m; i++) { d[i] = [i]; }
    for (j = 0; j <= n; j++) { d[0][j] = j; }
    for (i = 1; i <= m; i++) {
      for (j = 1; j <= n; j++) {
        var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a.charAt(i - 1) === b.charAt(j - 2) && a.charAt(i - 2) === b.charAt(j - 1)) {
          d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
      }
    }
    return d[m][n];
  }

  // Does a word the player said or typed count as the title word?
  // Spoken words get a small allowance (speech engines rarely garble short
  // words). Typed words are more forgiving: one slip is fine even in a
  // two-letter word, because typos are common and the whistler still has the
  // final say.
  //
  // The extra typed forgiveness only applies to filler and common title words
  // ("it", "be", "let"). Distinctive words stay strict, otherwise "will" would
  // pass for "wild" and "jean" for "lean" and different songs would set each
  // other off. The one exception is two swapped letters in a distinctive
  // four-letter word ("jued" for "jude").
  function isStrong(t) {
    return !STOP[t] && !WEAK[t] && !SHARED[t] && t.length >= 4;
  }

  function wordMatches(g, t, typed) {
    if (g === t) { return true; }
    var min = Math.min(g.length, t.length);
    var tol = min >= 9 ? 2 : (min >= 5 ? 1 : 0);
    if (typed && !isStrong(t)) { tol = min >= 9 ? 2 : (min >= 2 ? 1 : 0); }
    if (tol > 0) { return levenshtein(g, t) <= tol; }
    return !!typed && isStrong(t) && g.length === 4 && t.length === 4 &&
      g.split("").sort().join("") === t.split("").sort().join("") &&
      levenshtein(g, t) <= 1;
  }

  function evaluate(guessTokens, titleTokens, typed) {
    var hit = [], strongIdx = [], i;
    for (i = 0; i < titleTokens.length; i++) {
      var t = titleTokens[i], found = false;
      for (var j = 0; j < guessTokens.length; j++) {
        if (wordMatches(guessTokens[j], t, typed)) { found = true; break; }
      }
      hit.push(found);
      if (isStrong(t)) { strongIdx.push(i); }
    }
    var matchedWords = [];
    for (i = 0; i < titleTokens.length; i++) {
      if (hit[i]) { matchedWords.push(titleTokens[i]); }
    }
    var ok, score;
    if (strongIdx.length > 0) {
      var mStrong = 0;
      for (i = 0; i < strongIdx.length; i++) { if (hit[strongIdx[i]]) { mStrong++; } }
      var need = strongIdx.length === 1 ? 1 : Math.ceil(strongIdx.length * 0.5);
      ok = mStrong >= need;
      score = mStrong / strongIdx.length;
    } else {
      var m = matchedWords.length;
      ok = m >= Math.ceil(titleTokens.length * 0.75);
      score = titleTokens.length ? m / titleTokens.length : 0;
    }
    return { matched: ok, score: score, matchedWords: matchedWords };
  }

  // guess: string. song: song object ({title, aliases}) or a plain title string.
  // options.typed: true for typed guesses (more forgiving of typos).
  function matchTitle(guess, song, options) {
    var typed = !!(options && options.typed);
    var gt = tokens(guess);
    var empty = { matched: false, score: 0, matchedWords: [] };
    if (!gt.length || !song) { return empty; }
    var titles = typeof song === "string" ? [song] : [song.title].concat(song.aliases || []);
    var best = empty;
    for (var i = 0; i < titles.length; i++) {
      var tt = tokens(titles[i]);
      if (!tt.length) { continue; }
      var r = evaluate(gt, tt, typed);
      if ((r.matched && !best.matched) || (r.matched === best.matched && r.score > best.score)) {
        best = r;
      }
    }
    return best;
  }

  // Speech recognisers give several possible readings of what was heard.
  // Returns the first reading that matches, or a non-match.
  function matchAny(guesses, song, options) {
    var last = { matched: false, score: 0, matchedWords: [] };
    for (var i = 0; i < guesses.length; i++) {
      var r = matchTitle(guesses[i], song, options);
      if (r.matched) { r.guess = guesses[i]; return r; }
      if (r.score > last.score) { last = r; }
    }
    return last;
  }

  // The part of what was said that matched the title, e.g.
  // "blah talking blinding rights beans" -> "Blinding Rights".
  // Finds the shortest run of words that covers the most title words.
  function heardPhrase(guess, song, options) {
    var typed = !!(options && options.typed);
    var gt = tokens(guess);
    if (!gt.length || !song) { return ""; }
    var titles = typeof song === "string" ? [song] : [song.title].concat(song.aliases || []);
    var best = { score: 0, len: 999, s: 0, e: -1 };
    function hitsAny(g, tt) {
      for (var k = 0; k < tt.length; k++) { if (wordMatches(g, tt[k], typed)) { return true; } }
      return false;
    }
    for (var ti = 0; ti < titles.length; ti++) {
      var tt = tokens(titles[ti]);
      if (!tt.length) { continue; }
      for (var i = 0; i < gt.length; i++) {
        if (!hitsAny(gt[i], tt)) { continue; }
        for (var j = i; j < gt.length && j - i < tt.length + 2; j++) {
          if (!hitsAny(gt[j], tt)) { continue; }
          var score = 0;
          for (var k = 0; k < tt.length; k++) {
            for (var w = i; w <= j; w++) {
              if (wordMatches(gt[w], tt[k], typed)) { score++; break; }
            }
          }
          var len = j - i + 1;
          if (score > best.score || (score === best.score && len < best.len)) {
            best = { score: score, len: len, s: i, e: j };
          }
        }
      }
    }
    if (best.e < best.s) { return ""; }
    return gt.slice(best.s, best.e + 1).map(function (w) {
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(" ");
  }

  var api = {
    heardPhrase: heardPhrase,
    matchTitle: matchTitle, matchAny: matchAny, useSongs: useSongs,
    normalise: normalise, tokens: tokens
  };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  root.Matcher = api;
})(typeof window !== "undefined" ? window : this);
