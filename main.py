"""Cows and Bulls — Online 2-Player Duel.

A minimal FastAPI backend that serves the static frontend and a single
WebSocket endpoint implementing the game protocol. All state is in-memory.
"""

import random
import secrets
import string
import time
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

app = FastAPI()

# How long a room is kept alive after BOTH players have disconnected, so a
# player who backgrounds their tab / loses Wi-Fi can rejoin where they left off.
ABANDON_GRACE_SECONDS = 3600

# ---------------------------------------------------------------------------
# In-memory room state.
#
# rooms[code] = {
#     "digit_length": int,
#     "players": {                       # role -> player dict
#         "A": {"ws": WebSocket, "secret": str|None, "play_again": bool},
#         "B": {...},
#     },
#     "turn": "A" | "B" | None,
#     "history": [ {player, guess, feedback}, ... ],
#     "started": bool,
#     "over": bool,
# }
# ---------------------------------------------------------------------------
rooms: dict[str, dict] = {}

ROLES = ("A", "B")


def generate_room_code() -> str:
    """Return a short room code not currently in use."""
    alphabet = string.ascii_uppercase + string.digits
    while True:
        code = "".join(random.choices(alphabet, k=4))
        if code not in rooms:
            return code


def new_room(digit_length: int) -> str:
    code = generate_room_code()
    rooms[code] = {
        "code": code,
        "digit_length": digit_length,
        "players": {},
        "turn": None,
        "history": [],
        "started": False,
        "over": False,
        "winner": None,
        "winning_guess": None,
    }
    return code


def new_player(ws: WebSocket) -> dict:
    return {
        "ws": ws,
        "secret": None,
        "play_again": False,
        "token": secrets.token_urlsafe(9),
        "connected": True,
        "disconnected_at": None,
    }


def gc_rooms() -> None:
    """Drop rooms whose players have all been gone past the grace period."""
    now = time.time()
    stale = []
    for code, room in rooms.items():
        players = list(room["players"].values())
        if not players:
            stale.append(code)
            continue
        if all(not p["connected"] for p in players):
            last = max((p["disconnected_at"] or now) for p in players)
            if now - last > ABANDON_GRACE_SECONDS:
                stale.append(code)
    for code in stale:
        rooms.pop(code, None)


def valid_number(value: str, length: int) -> bool:
    """Correct length, ASCII digits only, all digits unique."""
    if not isinstance(value, str) or len(value) != length:
        return False
    if any(c not in string.digits for c in value):
        return False
    return len(set(value)) == length


def compute_score(secret: str, guess: str) -> tuple[int, int]:
    """Classic Bulls and Cows scoring, exposed only as aggregate counts.

    full = digits correct AND in the correct position.
    half = digits present in the secret but in the wrong position
           (never double-counted with a full).

    Per the game's core rule we return ONLY these two totals — never a
    per-position breakdown that would reveal which digits are correct.
    """
    full = 0
    half = 0
    for i in range(len(secret)):
        if guess[i] == secret[i]:
            full += 1
        elif guess[i] in secret:
            half += 1
    return full, half


async def send(ws: WebSocket, message: dict) -> None:
    """Best-effort send; ignore failures from a dropped socket."""
    try:
        await ws.send_json(message)
    except Exception:
        pass


async def broadcast(room: dict, message: dict) -> None:
    for player in room["players"].values():
        if player["ws"] is not None:
            await send(player["ws"], message)


def opponent_role(role: str) -> str:
    return "B" if role == "A" else "A"


def build_state_sync(room: dict, role: str) -> dict:
    """A full snapshot so a reconnecting client can rebuild its UI.

    Never includes any secret — only whether secrets are set.
    """
    me = room["players"][role]
    opp = room["players"].get(opponent_role(role))
    return {
        "type": "state_sync",
        "room_code": room["code"],
        "role": role,
        "digit_length": room["digit_length"],
        "you_secret_set": me["secret"] is not None,
        "opponent_present": opp is not None,
        "opponent_secret_set": bool(opp and opp["secret"] is not None),
        "opponent_connected": bool(opp and opp["connected"]),
        "started": room["started"],
        "over": room["over"],
        "turn": room["turn"],
        "history": room["history"],
        "winner": room["winner"],
        "winning_guess": room["winning_guess"],
    }


async def handle_message(ws: WebSocket, conn: dict, data: dict) -> None:
    msg_type = data.get("type")

    if msg_type == "create_room":
        digit_length = data.get("digit_length")
        if not isinstance(digit_length, int) or not (3 <= digit_length <= 9):
            await send(ws, {"type": "error", "message": "Digit length must be 3-9"})
            return
        gc_rooms()
        code = new_room(digit_length)
        room = rooms[code]
        player = new_player(ws)
        room["players"]["A"] = player
        conn["room_code"] = code
        conn["role"] = "A"
        await send(
            ws,
            {
                "type": "room_created",
                "room_code": code,
                "player_role": "A",
                "token": player["token"],
            },
        )
        await send(ws, {"type": "waiting_for_opponent"})

    elif msg_type == "join_room":
        code = (data.get("room_code") or "").strip().upper()
        room = rooms.get(code)
        if room is None:
            await send(ws, {"type": "error", "message": "Room not found"})
            return
        if len(room["players"]) >= 2:
            await send(ws, {"type": "error", "message": "Room is full"})
            return
        player = new_player(ws)
        room["players"]["B"] = player
        conn["room_code"] = code
        conn["role"] = "B"
        await send(
            ws,
            {
                "type": "joined_room",
                "room_code": code,
                "digit_length": room["digit_length"],
                "player_role": "B",
                "token": player["token"],
            },
        )
        # Tell the waiting creator that an opponent has arrived.
        a = room["players"].get("A")
        if a and a["ws"]:
            await send(a["ws"], {"type": "opponent_joined"})

    elif msg_type == "rejoin":
        code = (data.get("room_code") or "").strip().upper()
        role = data.get("role")
        token = data.get("token")
        room = rooms.get(code)
        if room is None or role not in room["players"]:
            await send(ws, {"type": "rejoin_failed"})
            return
        player = room["players"][role]
        if not token or token != player["token"]:
            await send(ws, {"type": "rejoin_failed"})
            return
        # Re-attach this socket to the existing player slot.
        player["ws"] = ws
        player["connected"] = True
        player["disconnected_at"] = None
        conn["room_code"] = code
        conn["role"] = role
        await send(ws, build_state_sync(room, role))
        opp = room["players"].get(opponent_role(role))
        if opp and opp["ws"]:
            await send(opp["ws"], {"type": "opponent_reconnected"})

    elif msg_type == "set_secret":
        room, role = current_room(conn)
        if room is None:
            await send(ws, {"type": "error", "message": "Not in a room"})
            return
        if room["started"]:
            await send(ws, {"type": "error", "message": "Game already started"})
            return
        secret = data.get("secret")
        if not valid_number(secret, room["digit_length"]):
            await send(
                ws,
                {
                    "type": "error",
                    "message": f"Secret must be {room['digit_length']} unique digits",
                },
            )
            return
        room["players"][role]["secret"] = secret
        # Start once both players have locked in a secret.
        both_set = (
            len(room["players"]) == 2
            and all(p["secret"] is not None for p in room["players"].values())
        )
        if both_set:
            room["started"] = True
            room["over"] = False
            room["turn"] = random.choice(ROLES)
            await broadcast(room, {"type": "game_start", "first_turn": room["turn"]})

    elif msg_type == "make_guess":
        room, role = current_room(conn)
        if room is None or not room["started"] or room["over"]:
            await send(ws, {"type": "error", "message": "Not your turn"})
            return
        if room["turn"] != role:
            await send(ws, {"type": "error", "message": "Not your turn"})
            return
        guess = data.get("guess")
        if not valid_number(guess, room["digit_length"]):
            await send(
                ws,
                {
                    "type": "error",
                    "message": f"Guess must be {room['digit_length']} unique digits",
                },
            )
            return
        opp = opponent_role(role)
        secret = room["players"][opp]["secret"]
        full, half = compute_score(secret, guess)
        room["history"].append(
            {"player": role, "guess": guess, "full": full, "half": half}
        )

        if full == room["digit_length"]:
            room["over"] = True
            room["turn"] = None
            room["winner"] = role
            room["winning_guess"] = guess
            await broadcast(
                room,
                {"type": "game_over", "winner": role, "winning_guess": guess},
            )
        else:
            room["turn"] = opp
            await broadcast(
                room,
                {
                    "type": "guess_result",
                    "player": role,
                    "guess": guess,
                    "full": full,
                    "half": half,
                    "next_turn": opp,
                },
            )

    elif msg_type == "play_again":
        room, role = current_room(conn)
        if room is None or not room["over"]:
            return
        # A player may optionally choose a new digit length for the next round.
        dl = data.get("digit_length")
        if isinstance(dl, int) and 3 <= dl <= 9:
            room["pending_length"] = dl
        room["players"][role]["play_again"] = True
        both_ready = (
            len(room["players"]) == 2
            and all(p["play_again"] for p in room["players"].values())
        )
        if both_ready:
            if room.get("pending_length"):
                room["digit_length"] = room["pending_length"]
            room["pending_length"] = None
            room["history"] = []
            room["started"] = False
            room["over"] = False
            room["turn"] = None
            room["winner"] = None
            room["winning_guess"] = None
            for p in room["players"].values():
                p["secret"] = None
                p["play_again"] = False
            await broadcast(
                room,
                {"type": "room_reset", "digit_length": room["digit_length"]},
            )

    elif msg_type == "leave_room":
        # Player deliberately left via "New Game" — send the other player home
        # too, then drop the room so neither can rejoin it.
        room, role = current_room(conn)
        if room is None:
            return
        opp = room["players"].get(opponent_role(role))
        if opp and opp["ws"]:
            await send(opp["ws"], {"type": "opponent_left"})
        rooms.pop(room["code"], None)
        conn["room_code"] = None
        conn["role"] = None

    else:
        await send(ws, {"type": "error", "message": "Unknown message type"})


def current_room(conn: dict):
    code = conn.get("room_code")
    role = conn.get("role")
    room = rooms.get(code) if code else None
    if room is None or role not in room["players"]:
        return None, None
    return room, role


async def handle_disconnect(conn: dict) -> None:
    room, role = current_room(conn)
    if room is None:
        return
    player = room["players"].get(role)
    if player is None:
        return
    # If a newer socket has already reconnected to this slot, this is a stale
    # close event (common on mobile app-switching) — ignore it.
    if player["ws"] is not conn.get("ws"):
        return
    # Mark offline but keep the slot so the player can rejoin with their token.
    player["ws"] = None
    player["connected"] = False
    player["disconnected_at"] = time.time()
    opp = room["players"].get(opponent_role(role))
    if opp and opp["ws"]:
        await send(opp["ws"], {"type": "opponent_disconnected"})


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    conn: dict = {"room_code": None, "role": None, "ws": ws}
    try:
        while True:
            data = await ws.receive_json()
            if not isinstance(data, dict):
                await send(ws, {"type": "error", "message": "Invalid message"})
                continue
            await handle_message(ws, conn, data)
    except WebSocketDisconnect:
        await handle_disconnect(conn)
    except Exception:
        # Any unexpected error: treat as a disconnect for cleanup.
        await handle_disconnect(conn)


# Serve the static single-page frontend. Mounted last so it doesn't shadow /ws.
static_dir = Path(__file__).parent / "static"
app.mount("/", StaticFiles(directory=str(static_dir), html=True), name="static")
