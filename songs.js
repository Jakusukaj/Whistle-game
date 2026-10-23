// Test-round song list: only very famous songs everyone knows.
//
// difficulty: how easy the tune is to whistle.
//   easy   = instantly recognisable, simple melody
//   medium = very well known, needs a decent attempt
//   hard   = very well known, but a trickier tune to whistle
//
// aliases: other ways people might say the title (spoken or typed).
// Edit freely: add, remove or move songs between difficulties.
// Keep at least 4 songs per difficulty so Shuffle always has a new one.

var SONGS = [
  // ------------------------------------------------------------------- EASY
  { title: "Happy Birthday", artist: "Traditional", difficulty: "easy", aliases: ["Happy Birthday To You"] },
  { title: "Let It Be", artist: "The Beatles", difficulty: "easy" },
  { title: "Hey Jude", artist: "The Beatles", difficulty: "easy" },
  { title: "Yellow Submarine", artist: "The Beatles", difficulty: "easy" },
  { title: "We Will Rock You", artist: "Queen", difficulty: "easy" },
  { title: "Seven Nation Army", artist: "The White Stripes", difficulty: "easy" },
  { title: "Eye of the Tiger", artist: "Survivor", difficulty: "easy" },
  { title: "Sweet Caroline", artist: "Neil Diamond", difficulty: "easy" },
  { title: "Twinkle Twinkle Little Star", artist: "Traditional", difficulty: "easy", aliases: ["Twinkle Twinkle"] },

  // ----------------------------------------------------------------- MEDIUM
  { title: "Don't Stop Believin'", artist: "Journey", difficulty: "medium", aliases: ["Don't Stop Believing"] },
  { title: "Wonderwall", artist: "Oasis", difficulty: "medium" },
  { title: "Billie Jean", artist: "Michael Jackson", difficulty: "medium" },
  { title: "Dancing Queen", artist: "ABBA", difficulty: "medium" },
  { title: "Smoke on the Water", artist: "Deep Purple", difficulty: "medium" },
  { title: "Imagine", artist: "John Lennon", difficulty: "medium" },
  { title: "Yesterday", artist: "The Beatles", difficulty: "medium" },
  { title: "Livin' on a Prayer", artist: "Bon Jovi", difficulty: "medium", aliases: ["Living on a Prayer"] },
  { title: "Mamma Mia", artist: "ABBA", difficulty: "medium" },

  // ------------------------------------------------------------------- HARD
  { title: "Bohemian Rhapsody", artist: "Queen", difficulty: "hard" },
  { title: "Hotel California", artist: "Eagles", difficulty: "hard" },
  { title: "Stayin' Alive", artist: "Bee Gees", difficulty: "hard", aliases: ["Staying Alive"] },
  { title: "Africa", artist: "Toto", difficulty: "hard" },
  { title: "Take On Me", artist: "a-ha", difficulty: "hard" },
  { title: "Girls Just Want to Have Fun", artist: "Cyndi Lauper", difficulty: "hard" },
  { title: "Sweet Dreams", artist: "Eurythmics", difficulty: "hard" },
  { title: "Total Eclipse of the Heart", artist: "Bonnie Tyler", difficulty: "hard" },
  { title: "Uptown Funk", artist: "Mark Ronson", difficulty: "hard" }
];

if (typeof module !== "undefined" && module.exports) { module.exports = SONGS; }
