# Tip of My Tongue

A living-room party game for up to eight people. Everyone uses their own phone. Take turns performing a song by whistling or kazooing it whilst the others guess out loud. Highest score wins.

## How a game works

The host taps Start lobby and shares the link or the QR code. Everyone else opens the link, scans the code, or taps a game in the Join a game list. That list only shows games started on the same wifi, so one household never sees another's game.

Every player performs once per round, and the first performer moves on one place each round. The performer picks one of three songs (easy, medium or hard), sees it on their own phone, and the clock runs until someone guesses it. They have 20 seconds to pick, then the middle card is picked for them. One refresh of the three cards per turn, free.

Guessing: a phone with a working microphone listens from the countdown to the end of the turn, and a likely match stops the clock and asks the performer who got it. A phone that cannot listen gets a Buzz button instead: tap it, say the title out loud, and the performer taps Right or Wrong. A wrong buzz locks that player out for 5 seconds. If someone says it and no phone catches it, the performer taps Someone got it and names them, and the people named tap once to claim it. If nobody claims, the clock carries on.

Scoring: a guess at 0 seconds is worth 1000 points, falling in a straight line to 0 at the round limit. Easy, medium and hard multiply that by 1, 1.5 and 2. Each shuffle costs 100 points and the hints cost 50, 100 and 150. A correct guess never scores under 100. The performer scores the result and the people named split half of it between them. A song nobody guesses scores nothing.

Rounds: until the host chooses their own number, the game suggests rounds for the head count, aiming for about 16 turns in all (2 to 3 players get 5 rounds, 4 get 4, 5 to 6 get 3, 7 to 8 get 2). It updates as people join. Time per turn is 30 seconds to 2 minutes. Games of 4 or more rounds get a halfway scoreboard, and every game ends with awards. Awards are titles only and never change the scores. Ties go to a sudden-death round.

A song that has been shown in a game is held back whilst fresh ones remain, and comes up last if the pack runs low.

Stuck? Tap Help at the top of any screen between turns.

## If phones drop out

A performer whose phone locks or loses signal has 30 seconds to come back before the turn is skipped, and everyone sees "Waiting for" them in the meantime. A host who drops keeps the role for 30 seconds, and gets it back whenever they return. A phone that comes back from the lock screen reconnects and starts listening again by itself.

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

On the home screen, tap the small dot and enter the admin password. The hub has stats tabs (headlines, song difficulty, help usage, devices, funnel, guessing, recent games) and a demo game with bot players. The Guessing tab shows how turns were won (voice, buzzer or Someone got it) and how often each difficulty is guessed.

Set your own password with the `ADMIN_PASSWORD` environment variable on Render. If it is not set, a default is used, so set one before sharing the code publicly.

## Stats and backup

The server records anonymous play stats (no names or room codes) to `data/stats.jsonl`. Render's free tier wipes that file on every deploy, so to keep history add a free Upstash Redis database and set these two environment variables on Render:

    UPSTASH_REDIS_REST_URL
    UPSTASH_REDIS_REST_TOKEN

Use the bare values with no quote marks. The admin hub footer shows whether the backup is working. Other settings: `STATS_FILE` (where the file goes) and `STATS_OFF=1` (turn stats off).

## Changing things

Songs live in `songs-src/*.txt`. After editing, run `node tools/build-songs.js` to rebuild `songs.js`. Packs live in `packs.js`: one line each, with the picker group, card colour and text colour. The picker reads all three from there, so adding a pack is one line.

Rules and defaults are in `DEFAULTS` at the top of `game.js`. The ones most worth knowing:

- `multipliers`, `minScore`, `guesserShare`, `shufflePoints`, `hintPoints`: the scoring.
- `revealMs` and `roundRevealMs`: how long the score screen stays up (8 and 11 seconds).
- `chooseMs`: time to pick a song before the middle card is picked (20 seconds, 0 turns it off).
- `claimMs`: time for a named player to claim after Someone got it (8 seconds, 0 turns the claim step off).
- `buzzLockMs`: lock-out after a wrong buzz (5 seconds).
- `awayMs` and `hostGraceMs`: the grace periods for a performer or host who drops (30 seconds each).
- `maxPlayers`: 8.

To list every game to every visitor again, set the environment variable `OPEN_GAMES_LIST=1` on Render.

Colours, spacing, corner radii and type sizes are tokens at the top of `public/style.css`. Change a token and every screen follows. The QR code uses the MIT-licensed `qrcode-generator` library, copied into `public/qrcode.js`.

## Tests

`npm test` runs the game, review, awards, extras, packs, interlude and stats tests. `test-review.js` covers the rules added in November 2026 (scoring floor, split share, buzzer, claim, auto-pick, turn order, the games list). `test-matcher.js` is run separately and has 3 known failing checks.
