// Song packs: the decks the host can tick in the lobby.
// A song can belong to several packs (see songs.js "packs"), but it is only one
// entry in the library, so it can never come up twice in a game.
//
// This file is the one place a pack is described. The picker reads group, colour
// and ink from here, so adding a pack means adding one line.
// group  = which section of the picker it sits in, in the order they first appear.
// colour = card background. ink = text colour on it.
// Colour goes by group, not by pack: each group alternates two hues from the
// design tokens, so neighbouring cards always differ and every pair of colours
// has already been checked for contrast (5.5 to 1 or better at 12px).
var INK = "#111111", LIGHT = "#ECEAE4";
var PINK = "#FF4FA3", YELLOW = "#FFD21F", BLUE = "#2640EC", ORANGE = "#FF4B14", GREEN = "#00B86B";

module.exports = [
  { id: "bangers",      group: "Vibe",           name: "All Time Bangers",     blurb: "Songs everyone knows",                 colour: PINK,   ink: INK },
  { id: "diva",         group: "Vibe",           name: "Pop Off Diva",         blurb: "Pop girlie central",                   colour: YELLOW, ink: INK },
  { id: "party",        group: "Vibe",           name: "Floor Fillers",        blurb: "Wedding disco and party classics",     colour: PINK,   ink: INK },
  { id: "soul",         group: "Vibe",           name: "Motown Magic",         blurb: "Soul, funk and R&B classics",          colour: YELLOW, ink: INK },
  { id: "tv",           group: "Vibe",           name: "Telly Tunes",          blurb: "UK telly themes, plus a few US icons", colour: PINK,   ink: INK },
  { id: "film",         group: "Vibe",           name: "Popcorn Soundtracks",  blurb: "Big songs from the big screen",        colour: YELLOW, ink: INK },
  { id: "disney",       group: "Vibe",           name: "Happily Ever After",   blurb: "Disney and sing-along musicals",       colour: PINK,   ink: INK },

  { id: "sixties",      group: "Eras",           name: "The Swinging 60s",     blurb: "Beatles, Stones and Motown",           colour: BLUE,   ink: LIGHT },
  { id: "seventies",    group: "Eras",           name: "Glitter Ball 70s",     blurb: "Disco, glam and stadium rock",         colour: ORANGE, ink: INK },
  { id: "eighties",     group: "Eras",           name: "Big Hair 80s",         blurb: "British synths, shoulder pads, hits",  colour: BLUE,   ink: LIGHT },
  { id: "nineties",     group: "Eras",           name: "Rewind to the 90s",    blurb: "Britpop, boybands, dance floors",      colour: ORANGE, ink: INK },
  { id: "noughties",    group: "Eras",           name: "Noughties Nostalgia",  blurb: "iPod-era pop and indie",               colour: BLUE,   ink: LIGHT },
  { id: "tens",         group: "Eras",           name: "Streaming Era 2010s",  blurb: "Chart-toppers of the 2010s",           colour: ORANGE, ink: INK },
  { id: "today",        group: "Eras",           name: "Fresh Off the Charts", blurb: "Hits from the last few years",         colour: BLUE,   ink: LIGHT },

  { id: "beatles",      group: "Artists",        name: "The Beatles",          blurb: "Beatlemania, start to finish",         colour: GREEN,  ink: INK },
  { id: "bowie",        group: "Artists",        name: "David Bowie",          blurb: "Starman, Heroes and more",             colour: YELLOW, ink: INK },
  { id: "gaga",         group: "Artists",        name: "Lady Gaga",            blurb: "Just Dance to now",                    colour: GREEN,  ink: INK },
  { id: "talkingheads", group: "Artists",        name: "Talking Heads",        blurb: "Psycho Killer and friends",            colour: YELLOW, ink: INK },
  { id: "abba",         group: "Artists",        name: "ABBA",                 blurb: "Waterloo to The Winner Takes It All",  colour: GREEN,  ink: INK },

  { id: "halloween",    group: "Special events", name: "Spooky Season",        blurb: "Creepy classics and monster hits",     colour: ORANGE, ink: INK },
  { id: "xmas",         group: "Special events", name: "Christmas Cracker",    blurb: "Pop hits, UK favourites and carols",   colour: INK,    ink: LIGHT }
];
