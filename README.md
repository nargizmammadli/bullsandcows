# 🐂 Cows & Bulls — Online 2-Player Duel

A tiny, free-to-run web app for the **Bulls and Cows** number-guessing game.
Two people play in real time over WebSockets. No database, no accounts, no build
step — a FastAPI backend serves a single static page.

## Rules

- Each player privately picks a secret of **3–9 digits** (length chosen at room
  creation) with **all digits unique**. Leading zeros are allowed.
- Players alternate guessing the opponent's secret. Each guess returns **two
  aggregate counts only** — never which specific digits or positions were right:
  - **full** — count of digits that are correct *and* in the correct position.
  - **half** — count of digits that are in the secret but in the *wrong*
    position (a digit counted as full is never also counted as half).
- A guess shows e.g. `3 full, 2 half`. The guessed digits are displayed, but
  they are **never colored** — the feedback deliberately doesn't reveal which
  digits earned a full or a half. (This is classic Bulls and Cows scoring.)
- First player to score `full == length` (an exact match) wins. Then either
  player can hit **Play Again** to reset the room with new secrets.

## Run locally

Requires Python 3.10+.

```bash
pip install -r requirements.txt
uvicorn main:app --reload
```

Open <http://localhost:8000> in **two** browser tabs (or two devices on the same
network). In tab 1, click **Create Room** and share the 4-character code. In tab
2, enter the code and **Join Room**. Both pick a secret, then take turns guessing.

> Tip: the join screen also accepts a deep link — `http://localhost:8000/?room=AB12`
> prefills the code.

## Project layout

```
main.py             FastAPI app: /ws WebSocket endpoint + static file serving
static/index.html   Single-page UI (Home, Lobby, Secret, Game, Game Over)
static/style.css     Styling
static/app.js        WebSocket client + UI state machine
requirements.txt    Pinned dependencies
render.yaml         Render.com deployment config
```

State is a plain in-memory dict keyed by room code. Rooms are garbage-collected
when both players disconnect. Restarting the server clears all rooms — fine for a
casual two-friend app.

## Deploy free on Render.com

1. Push this folder to a GitHub repo.
2. In Render, **New → Blueprint** and point it at the repo. `render.yaml` is
   detected automatically (free web service, Python runtime).
   - Or **New → Web Service** manually with:
     - Build command: `pip install -r requirements.txt`
     - Start command: `uvicorn main:app --host 0.0.0.0 --port $PORT`
3. Deploy. Render gives you an `https://…onrender.com` URL that serves the page
   and upgrades `/ws` to `wss://` automatically (the frontend picks `wss` on
   HTTPS).

**Environment notes**
- Bind to `0.0.0.0` and Render's `$PORT` (handled in `render.yaml`).
- `uvicorn[standard]` bundles the `websockets` implementation, so no extra WS
  config is needed.
- The free tier sleeps after inactivity; the first request after idle takes a
  few seconds to wake. Casual play is unaffected once both players are connected.

Fly.io works too, but Render's Blueprint is the simplest path for a single
WebSocket Python service, so it's the recommended option here.
