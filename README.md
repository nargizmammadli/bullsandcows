# ▶▶ Twoplay — 2-Player Game Arcade

A tiny, free-to-run web app that hosts multiple small **2-player online games**.
Players land on one home page, pick a game, then create or join a room with a
shareable code — the same flow for every game. No database, no accounts, no build
step: a single FastAPI backend serves the static frontend and one game-type-aware
WebSocket endpoint, with all state held in memory.

Currently included:

- **🐂 Cows & Bulls** — crack your opponent's secret number before they crack yours.
- **🚢 Battleship** — hide your fleet on a variable-size grid, then sink the opponent's.

## Games

### Cows & Bulls
- Each player privately picks a secret of **3–9 digits** (length chosen at room
  creation) with **all digits unique**. Leading zeros allowed.
- Players alternate guessing the opponent's secret. Each guess returns **two
  aggregate counts only** — never which specific digits/positions matched:
  - **full** — digits correct *and* in the correct position.
  - **half** — digits present in the secret but in the *wrong* position (never
    double-counted with a full).
- Guessed digits are shown but **never colored**. First to `full == length` wins.
- Also playable solo **vs Computer** (one-directional puzzle, all client-side).

### Battleship
- Room creator chooses a **grid size 8×8 … 15×15** and a **turn rule**:
  - **strict** — players always alternate.
  - **hit again** — a hit keeps your turn; a miss passes it.
- The **fleet scales with grid size** (lookup table in `battleship.py`); duplicate
  ship names are numbered (e.g. *Destroyer 1*, *Destroyer 2*).
- Manual placement (select ship → rotate → click → Ready). Firing reveals only
  hit / miss / sunk for the targeted cell. Win by sinking the whole fleet; both
  fleets are revealed at game end.

## Run locally

Requires Python 3.10+.

```bash
pip install -r requirements.txt
uvicorn main:app --reload
```

Open <http://localhost:8000>, pick a game, click **Create Room**, and share the
4-character code. In a second tab/device, open the same game, enter the code, and
**Join Room**. A `?room=CODE` deep link on a game page prefills the code.

## Architecture

The room / connection / reconnect / play-again machinery is **generic and written
once**; each game's rules live in its own module that plugs into the shared
dispatcher via a small uniform interface.

```
main.py                     Shared FastAPI app: /ws dispatcher + static serving
shared.py                   Generic helpers (broadcast/send, roles)
cows_and_bulls.py           Cows & Bulls rules + message handlers
battleship.py               Battleship rules, fleet table + message handlers
static/index.html           Twoplay home page (game cards)
static/common.js            Shared client: WebSocket, session, reconnect, UI helpers
static/style.css            Shared branding + per-game styles
static/cows-and-bulls.*     Cows & Bulls page + controller
static/battleship.*         Battleship page + controller
requirements.txt            Pinned dependencies
render.yaml                 Render.com deployment config
```

Rooms are scoped per game (`rooms[game_type][code]`) so codes never collide
across games. State is in-memory and cleared on restart — fine for casual play.
Rooms are garbage-collected after both players have been gone past a grace period.

**Adding a third game** mainly means: add a game module with its own handlers,
add an HTML page + controller, and add a card to the home page.

## Deploy free on Render.com

1. Push this folder to a GitHub repo.
2. In Render, **New → Blueprint** and point it at the repo. `render.yaml` is
   detected automatically (free web service, Python runtime).
   - Or **New → Web Service** manually with:
     - Build command: `pip install -r requirements.txt`
     - Start command: `uvicorn main:app --host 0.0.0.0 --port $PORT`
3. Deploy. Render gives you an `https://…onrender.com` URL that serves the site
   and upgrades `/ws` to `wss://` automatically (the frontend picks `wss` on HTTPS).

**Environment notes**
- Bind to `0.0.0.0` and Render's `$PORT` (handled in `render.yaml`).
- `uvicorn[standard]` bundles the `websockets` implementation, so no extra WS
  config is needed.
- The free tier sleeps after inactivity; the first request after idle takes a few
  seconds to wake. Casual play is unaffected once both players are connected.

Fly.io works too, but Render's Blueprint is the simplest path for a single
WebSocket Python service, so it's the recommended option here.
