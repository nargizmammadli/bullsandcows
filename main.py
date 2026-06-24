"""Twoplay — a shared 2-player game arcade.

A single FastAPI app that serves the static frontend (home page + one page per
game) and one game-type-aware WebSocket endpoint. All state is in-memory.

The room / connection / reconnect / play-again machinery is generic and lives
here; each game's rules live in its own module (``cows_and_bulls``,
``battleship``) and plug into this dispatcher via a small, uniform interface:

    validate_create(data)      -> (config, error)
    init_state(config)         -> state dict
    join_payload(room)         -> dict of config a client needs
    build_state_sync(room, r)  -> snapshot dict for a reconnecting client
    before_replay(room, data)  -> capture any next-round config
    reset(room, data)          -> reset state, return broadcast message
    handle(ws, room, role, d)  -> process game-specific message types
"""

import random
import secrets
import string
import time
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

import battleship
import cows_and_bulls
from shared import broadcast, opponent_role, send

app = FastAPI()

# Registry of game modules, keyed by game_type. Adding a third game means:
# add a module here, a new HTML page, and a new card on the home page.
GAMES = {
    cows_and_bulls.GAME_TYPE: cows_and_bulls,
    battleship.GAME_TYPE: battleship,
}

# How long a room is kept alive after BOTH players have disconnected, so a
# player who backgrounds their tab / loses Wi-Fi can rejoin where they left off.
ABANDON_GRACE_SECONDS = 3600

# In-memory rooms, scoped per game type: rooms[game_type][code] = room dict.
# A room dict is generic:
#   {code, game_type, players, config, started, over, winner, state}
# where `players[role]` holds the connection bookkeeping and `state` holds the
# game-specific data owned by that game's module.
rooms: dict[str, dict[str, dict]] = {gt: {} for gt in GAMES}


def generate_room_code(game_type: str) -> str:
    alphabet = string.ascii_uppercase + string.digits
    store = rooms[game_type]
    while True:
        code = "".join(random.choices(alphabet, k=4))
        if code not in store:
            return code


def new_room(game_type: str, config: dict) -> str:
    module = GAMES[game_type]
    code = generate_room_code(game_type)
    rooms[game_type][code] = {
        "code": code,
        "game_type": game_type,
        "players": {},
        "config": config,
        "started": False,
        "over": False,
        "winner": None,
        "state": module.init_state(config),
    }
    return code


def new_player(ws: WebSocket) -> dict:
    return {
        "ws": ws,
        "token": secrets.token_urlsafe(9),
        "connected": True,
        "disconnected_at": None,
        "play_again": False,
    }


def gc_rooms() -> None:
    """Drop rooms whose players have all been gone past the grace period."""
    now = time.time()
    for game_type, store in rooms.items():
        stale = []
        for code, room in store.items():
            players = list(room["players"].values())
            if not players:
                stale.append(code)
                continue
            if all(not p["connected"] for p in players):
                last = max((p["disconnected_at"] or now) for p in players)
                if now - last > ABANDON_GRACE_SECONDS:
                    stale.append(code)
        for code in stale:
            store.pop(code, None)


def current_room(conn: dict):
    """Resolve the room + role for a connection, or (None, None)."""
    game_type = conn.get("game_type")
    code = conn.get("room_code")
    role = conn.get("role")
    if game_type not in rooms:
        return None, None
    room = rooms[game_type].get(code) if code else None
    if room is None or role not in room["players"]:
        return None, None
    return room, role


async def handle_message(ws: WebSocket, conn: dict, data: dict) -> None:
    msg_type = data.get("type")

    # ----- Generic: create a room -----------------------------------------
    if msg_type == "create_room":
        game_type = data.get("game_type")
        module = GAMES.get(game_type)
        if module is None:
            await send(ws, {"type": "error", "message": "Unknown game"})
            return
        config, err = module.validate_create(data)
        if err:
            await send(ws, {"type": "error", "message": err})
            return
        gc_rooms()
        code = new_room(game_type, config)
        room = rooms[game_type][code]
        player = new_player(ws)
        room["players"]["A"] = player
        conn.update(game_type=game_type, room_code=code, role="A")
        await send(
            ws,
            {
                "type": "room_created",
                "game_type": game_type,
                "room_code": code,
                "player_role": "A",
                "token": player["token"],
                **module.join_payload(room),
            },
        )
        await send(ws, {"type": "waiting_for_opponent"})

    # ----- Generic: join a room -------------------------------------------
    elif msg_type == "join_room":
        game_type = data.get("game_type")
        module = GAMES.get(game_type)
        if module is None:
            await send(ws, {"type": "error", "message": "Unknown game"})
            return
        code = (data.get("room_code") or "").strip().upper()
        room = rooms[game_type].get(code)
        if room is None:
            await send(ws, {"type": "error", "message": "Room not found"})
            return
        if len(room["players"]) >= 2:
            await send(ws, {"type": "error", "message": "Room is full"})
            return
        player = new_player(ws)
        room["players"]["B"] = player
        conn.update(game_type=game_type, room_code=code, role="B")
        await send(
            ws,
            {
                "type": "joined_room",
                "game_type": game_type,
                "room_code": code,
                "player_role": "B",
                "token": player["token"],
                **module.join_payload(room),
            },
        )
        a = room["players"].get("A")
        if a and a["ws"]:
            await send(a["ws"], {"type": "opponent_joined"})

    # ----- Generic: reconnect ---------------------------------------------
    elif msg_type == "rejoin":
        game_type = data.get("game_type")
        module = GAMES.get(game_type)
        code = (data.get("room_code") or "").strip().upper()
        role = data.get("role")
        token = data.get("token")
        room = rooms.get(game_type, {}).get(code) if module else None
        if room is None or role not in room["players"]:
            await send(ws, {"type": "rejoin_failed"})
            return
        player = room["players"][role]
        if not token or token != player["token"]:
            await send(ws, {"type": "rejoin_failed"})
            return
        player["ws"] = ws
        player["connected"] = True
        player["disconnected_at"] = None
        conn.update(game_type=game_type, room_code=code, role=role)
        await send(ws, module.build_state_sync(room, role))
        opp = room["players"].get(opponent_role(role))
        if opp and opp["ws"]:
            await send(opp["ws"], {"type": "opponent_reconnected"})

    # ----- Generic: play again --------------------------------------------
    elif msg_type == "play_again":
        room, role = current_room(conn)
        if room is None or not room["over"]:
            return
        module = GAMES[room["game_type"]]
        module.before_replay(room, data)
        room["players"][role]["play_again"] = True
        both_ready = (
            len(room["players"]) == 2
            and all(p["play_again"] for p in room["players"].values())
        )
        if both_ready:
            room["started"] = False
            room["over"] = False
            room["winner"] = None
            for p in room["players"].values():
                p["play_again"] = False
            message = module.reset(room, data)
            await broadcast(room, message)

    # ----- Generic: deliberately leave ------------------------------------
    elif msg_type == "leave_room":
        room, role = current_room(conn)
        if room is None:
            return
        opp = room["players"].get(opponent_role(role))
        if opp and opp["ws"]:
            await send(opp["ws"], {"type": "opponent_left"})
        rooms[room["game_type"]].pop(room["code"], None)
        conn.update(game_type=None, room_code=None, role=None)

    # ----- Game-specific: delegate to the module --------------------------
    else:
        room, role = current_room(conn)
        if room is None:
            await send(ws, {"type": "error", "message": "Not in a room"})
            return
        module = GAMES[room["game_type"]]
        await module.handle(ws, room, role, data)


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
    player["ws"] = None
    player["connected"] = False
    player["disconnected_at"] = time.time()
    opp = room["players"].get(opponent_role(role))
    if opp and opp["ws"]:
        await send(opp["ws"], {"type": "opponent_disconnected"})


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    conn: dict = {"game_type": None, "room_code": None, "role": None, "ws": ws}
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
        await handle_disconnect(conn)


# Serve the static frontend (home page + per-game pages). Mounted last so it
# doesn't shadow /ws.
static_dir = Path(__file__).parent / "static"
app.mount("/", StaticFiles(directory=str(static_dir), html=True), name="static")
