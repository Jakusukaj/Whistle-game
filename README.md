# Tip of My Tongue

A living-room party game. Everyone uses their own phone. Take turns performing a song by whistling or kazooing it while the others guess out loud or by typing. Highest score wins.

## How a game works

The host taps Start lobby and shares the link, the 4 letter code, or the QR code (Scan to join, host only). Everyone else opens the link or taps Join a game.

Every player performs once per round. The performer picks easy, medium or hard, sees the song on their own phone, and the clock runs until someone guesses it. The performer then taps who got it first (more than one only if two people shouted together).

Scoring: a guess at 0 seconds is worth 1000 points, falling in a straight line to 0 at the round limit. Easy, medium and hard multiply that by 1.0, 1.1 and 1.2. Each shuffle costs 100 points and each hint costs 50, 100 and 150. The performer scores the result and each person named scores half of it. A song nobody guesses scores nothing.

Rounds: until the host chooses their own number, the game suggests rounds for the head count, aiming for about 16 turns in all (2 to 3 players get 5 rounds, 4 get 4, 5 to 6 get 3, 7 to 10 get 2, 11 or more get 1). It updates as people join. Max round length is 30 seconds to 2 minutes. Games of 4 or more rounds get a halfway scoreboard, and every game ends with awards for bonus points. Ties go to a sudden-death round.

Stuck? Press the ? button on any screen.

## Run it on your computer (optional)

    npm install
    npm start

Open http://localhost:3000. The microphone only works on https (or localhost), so for phones use the hosted version.

## Put it online (Render, free)

1. Put the project in a GitHub repository (not node_modules).
2. On Render choose New > Web Service and connect the repository.
3. Settings: Runtime Node, Build Command `npm install`, Start Command `npm start`, Instance type Free.
4. Render gives you an https address. Open it on every phone.

The free tier sleeps when idle, so the first visit after a quiet spell takes about 30 seconds. Open it a minute before game night.

## Admin mode

On the home screen, tap the small dot and enter the admin password. The hub has stats tabs (headlines, song difficulty, help usage, devices, funnel, voice, recent games) and a demo game with bot players.

Set your own password with the `ADMIN_PASSWORD` environment variable on Render. If it is not set, a default is used, so set one before sharing the code publicly.

## Stats and backup

The server records anonymous play stats (no names or room codes) to `data/stats.jsonl`. Render's free tier wipes that file on every deploy, so to keep history add a free Upstash Redis database and set these two environment variables on Render:

    UPSTASH_REDIS_REST_URL
    UPSTASH_REDIS_REST_TOKEN

Use the bare values with no quote marks. The admin hub footer shows whether the backup is working. Other settings: `STATS_FILE` (where the file goes) and `STATS_OFF=1` (turn stats off).

## Changing things

Songs live in `songs-src/*.txt`. After editing, run `node tools/build-songs.js` to rebuild `songs.js` and the pack list. Rules and defaults (limits, point values, multipliers, suggested rounds, awards) are at the top of `game.js`. The QR code uses the MIT-licensed `qrcode-generator` library, copied into `public/qrcode.js`.

## Tests

`npm test` runs the game, extras, packs, interlude and stats tests. `test-matcher.js` is run separately and has 3 known failing checks.
