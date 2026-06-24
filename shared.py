"""Shared room/connection infrastructure for the Twoplay arcade.

Generic helpers used by both the WebSocket dispatcher (main.py) and the
individual game modules (cows_and_bulls.py, battleship.py). Anything that is
*not* specific to a single game's rules lives here so each game module only
implements its own validation and message handling.
"""

ROLES = ("A", "B")


def opponent_role(role: str) -> str:
    return "B" if role == "A" else "A"


async def send(ws, message: dict) -> None:
    """Best-effort JSON send; silently ignore a dropped socket."""
    if ws is None:
        return
    try:
        await ws.send_json(message)
    except Exception:
        pass


async def broadcast(room: dict, message: dict) -> None:
    """Send a message to every connected player in a room."""
    for player in room["players"].values():
        await send(player["ws"], message)


async def send_to(room: dict, role: str, message: dict) -> None:
    """Send a message to a single role's socket, if present."""
    player = room["players"].get(role)
    if player:
        await send(player["ws"], message)
