# Chopsticks Arena

A real-time multiplayer Chopsticks website with login, persistent win/loss records, friends, private rooms, friend challenges and quick matchmaking.

## Rules

- Each player begins with **1 finger on each hand**.
- On a turn, **tap** an opponent's living hand using one of your living hands, **or** redistribute your fingers between your own two hands.
- **Exactly 5 knocks out a hand**; sums over five wrap: **6 → 1, 7 → 2, 8 → 3**. Because hands hold at most four fingers, 8 is the maximum attack sum.
- You may redistribute to a 0 hand to bring it back into the game; sums must stay equal, each hand must have 0–4 fingers, and you can't skip your turn or merely swap hands.
- **Knock out both opponent hands to win.** A forfeit gives the other player the win.

## Features

- ✅ Accounts using usernames and passwords, with salted `scrypt` password hashes and HttpOnly session cookies.
- ✅ Persistent wins, losses, recent games and friendships saved in SQLite.
- ✅ Challenge friends directly and accept/decline friend requests.
- ✅ Join a private game by seven-character code or shared link.
- ✅ Find an opponent using a quick-match queue.
- ✅ Live gameplay and invitations using server-sent events (SSE).
- ✅ The server validates moves, turns, and all changes to saved records.
- ✅ No external npm dependencies, no tracking scripts, no email collection, no chat.

## Run it locally

Requires **Node.js 22.16+** (Node 24 recommended).

```bash
npm start
```

Open **http://localhost:3000**. To test multiplayer, open another browser or private window, register a second account, then join a room code from the first account.

Run the built-in tests with:

```bash
npm test
```

SQLite is saved at `./data/arena.sqlite` by default. Set `DATA_DIR` to change the storage directory or `DB_PATH` for a precise filename.

## Deploy with a custom domain

The included `render.yaml` is a **paid-hosting** blueprint with one Node web service and a **persistent disk**. That disk is essential: deploying SQLite without persistent storage would lose accounts, wins, friends, and matches on a redeploy. A free Render web service does not support a persistent disk. Check prices before deploying. This app expects **exactly one server instance**; it is not built for multiple replicas.

1. Put this folder in a GitHub repository. You can also keep the source private.
2. Have an eligible adult manage the hosting and domain registration accounts, including any billing or provider age requirements.
3. In [Render](https://dashboard.render.com/), create a **Blueprint** from that repository using `render.yaml`. Confirm the paid web service and disk configuration before creating it. Render will provide an `onrender.com` testing URL.
4. Once the website works, register or use a domain you own (for example, `your-game-name.com`). In the Render web service, choose **Settings → Custom Domains**, add the domain, and copy Render's DNS values into your domain registrar's DNS settings. Verify the domain in Render. Do not assume any example name is available for purchase.
5. Visit the domain using HTTPS and create your first account. Render handles TLS for verified domains.

See Render's official [web services](https://render.com/docs/web-services), [persistent disks](https://render.com/docs/disks), and [custom domains](https://render.com/docs/custom-domains) documentation.

> The project has **not** been published or assigned a domain by this ZIP. A hosting account and a domain must be connected to put it on the public internet.

## Important operator notes

This is a working small-scale game, not a fully audited large-scale public platform. Before a wider public launch:

- Establish a privacy policy, acceptable-use policy, contact/abuse-response process and backup procedure. Consider requirements for minors under applicable laws.
- Use an actual automated backup for `arena.sqlite`; the persistent disk is not a backup. Backup SQLite using its supported backup method rather than copying a live WAL database incorrectly.
- Add email or another vetted recovery method before promising password recovery. **There is currently no password-reset feature** (no email is collected).
- Add administrative tools for suspending abusive accounts and removing harmful usernames.
- If you need thousands of simultaneous players or multi-server reliability, move persistence to a managed database and coordinate presence/matchmaking across instances.
- Always use HTTPS in production. Production cookie settings enforce `Secure`.

## Repository structure

- `server.js` — HTTP API, account sessions, friend requests, matchmaking, and live events
- `db.js` — persistent SQLite schema
- `game.js` — tested Chopsticks rules and move validator
- `public/` — responsive website (HTML/CSS/JS)
- `tests/` — game rules and two-account integration tests
- `render.yaml` — one-instance persistent Render hosting configuration
