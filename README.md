# Whistle

A living-room party game. Everyone uses their own phone. Take turns performing (whistling or kazooing) a classic song shown only on your phone; the others guess out loud or by typing. Your time is your score, lowest total wins.

## Run it on your computer (optional)
    npm install
    npm start
Open http://localhost:3000. The microphone only works on https (or localhost), so for phones use the hosted version below.

## Put it online (Render, free)
1. Create a free GitHub account and a new empty repository.
2. Upload every file in this folder to it (not node_modules): Add file > Upload files.
3. Create a free Render account, choose New > Web Service, and connect that repository.
4. Settings: Runtime Node, Build Command `npm install`, Start Command `npm start`, Instance type Free.
5. When it deploys, Render gives you an https address. Open it on every phone.

The free tier sleeps when idle, so the first visit after a quiet spell takes about 30 seconds to wake. Open it a minute before game night.

## Playing
One person taps Host a game and shares the 4 letter code. Everyone else taps Join room. Allow the microphone when asked; typing always works as a backup.

## Changing things
Songs: edit songs.js (title, artist, difficulty). Defaults (rounds, 60s cap, shuffle penalty, multipliers): top of game.js.

## Tests
`npm test` runs the matcher and game rule tests.
