// Song packs: the decks the host can tick in the lobby.
// A song can belong to several packs (see songs.js "packs"), but it is only one
// entry in the library, so it can never come up twice in a game.
// colour = card background, ink = text colour on it (kept dark for legibility),
// group = which section of the picker it sits in.
module.exports = [
  { id: "bangers",      group: "Start here",    name: "All Time Bangers",     blurb: "Songs everyone knows",       colour: "#ffd84d", ink: "#3a2a00" },

  { id: "sixties",      group: "Decades",       name: "The Swinging 60s",     blurb: "Beatles, Stones and Motown",           colour: "#ffc2d6", ink: "#5a1030" },
  { id: "seventies",    group: "Decades",       name: "Glitter Ball 70s",     blurb: "Disco, glam and stadium rock",         colour: "#ffd1a1", ink: "#5a2a00" },
  { id: "eighties",     group: "Decades",       name: "Big Hair 80s",         blurb: "British synths, shoulder pads, hits",          colour: "#e0c8ff", ink: "#3b1670" },
  { id: "nineties",     group: "Decades",       name: "Rewind to the 90s",    blurb: "Britpop, boybands, dance floors",      colour: "#b8efd9", ink: "#0b4a34" },
  { id: "noughties",    group: "Decades",       name: "Noughties Nostalgia",  blurb: "iPod-era pop and indie",               colour: "#bfe0ff", ink: "#0d3c6b" },
  { id: "tens",         group: "Decades",       name: "Streaming Era 2010s",  blurb: "Chart-toppers of the 2010s",           colour: "#ffc9b8", ink: "#6a2410" },
  { id: "today",        group: "Decades",       name: "Fresh Off the Charts", blurb: "Hits from the last few years",         colour: "#c9f0a8", ink: "#2d4f0a" },

  { id: "diva",         group: "Genres",        name: "Pop Off Diva",         blurb: "Pop girlie central",                   colour: "#ffb8f0", ink: "#5c1050" },
  { id: "party",        group: "Genres",        name: "Floor Fillers",        blurb: "Wedding disco and party classics",     colour: "#ffb8f0", ink: "#5c1050" },
  { id: "soul",         group: "Genres",        name: "Motown Magic",         blurb: "Soul, funk and R&B classics",          colour: "#f6d0a0", ink: "#573300" },

  { id: "tv",           group: "Screen",        name: "Telly Tunes",          blurb: "UK telly themes, plus a few US icons", colour: "#a8e6ee", ink: "#0b4650" },
  { id: "film",         group: "Screen",        name: "Popcorn Soundtracks",  blurb: "Big songs from the big screen",        colour: "#f2b8b8", ink: "#591515" },
  { id: "disney",       group: "Screen",        name: "Happily Ever After",   blurb: "Disney and sing-along musicals",       colour: "#c4cffc", ink: "#1f2a6b" },

  { id: "halloween",    group: "Seasonal",      name: "Spooky Season",        blurb: "Creepy classics and monster hits",     colour: "#ffb866", ink: "#3d1d00" },
  { id: "xmas",         group: "Seasonal",      name: "Christmas Cracker",    blurb: "Pop hits, UK favourites and carols",   colour: "#b9e8b0", ink: "#14501a" },

  { id: "beatles",      group: "Artists",       name: "The Beatles",          blurb: "Beatlemania, start to finish",      colour: "#f7e08a", ink: "#4a3a00" },
  { id: "bowie",        group: "Artists",       name: "David Bowie",          blurb: "Starman, Heroes and more",  colour: "#c6b5f5", ink: "#2a1a63" },
  { id: "gaga",         group: "Artists",       name: "Lady Gaga",             blurb: "Just Dance to now",         colour: "#ffa8c8", ink: "#5a0a33" },
  { id: "talkingheads", group: "Artists",       name: "Talking Heads",         blurb: "Psycho Killer and friends",       colour: "#9fe3d0", ink: "#08443a" },
  { id: "abba",         group: "Artists",       name: "ABBA",                  blurb: "Waterloo to The Winner Takes It All", colour: "#a9c7ff", ink: "#14306b" }
];
