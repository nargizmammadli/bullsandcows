"""Cows and Bulls game module for Twoplay.

Implements the game-specific rules and message handlers, operating on a generic
room's ``state`` / ``config`` dicts. The shared layer (main.py) takes care of
rooms, connections, reconnect and play-again bookkeeping.

Scoring is exposed only as aggregate "full"/"half" counts (never "bulls"/"cows"
in code or on the wire, and never a per-position breakdown).
"""

import random
import string

from shared import ROLES, broadcast, opponent_role, send

GAME_TYPE = "cows_and_bulls"

MIN_DIGITS = 3
MAX_DIGITS = 9


# ---------------------------------------------------------------------------
# Room lifecycle hooks
# ---------------------------------------------------------------------------
def validate_create(data: dict):
    """Return (config, error). config is stored on the room."""
    digit_length = data.get("digit_length")
    if not isinstance(digit_length, int) or not (MIN_DIGITS <= digit_length <= MAX_DIGITS):
        return None, f"Digit length must be {MIN_DIGITS}-{MAX_DIGITS}"
    return {"digit_length": digit_length}, None


def init_state(config: dict) -> dict:
    return {
        "secrets": {},          # role -> secret string
        "turn": None,           # "A" | "B" | None
        "history": [],          # list of {player, guess, full, half}
        "winning_guess": None,
        "pending_length": None,  # chosen next-round length during play_again
    }


def join_payload(room: dict) -> dict:
    """Extra fields a joining/created player needs to configure their UI."""
    return {"digit_length": room["config"]["digit_length"]}


def build_state_sync(room: dict, role: str) -> dict:
    """A full snapshot so a reconnecting client can rebuild its UI.

    Never includes a live secret — only whether secrets are set (until the
    game is over, when both secrets are revealed).
    """
    state = room["state"]
    me = room["players"][role]
    opp_role = opponent_role(role)
    opp = room["players"].get(opp_role)
    snapshot = {
        "type": "state_sync",
        "game_type": GAME_TYPE,
        "room_code": room["code"],
        "role": role,
        "digit_length": room["config"]["digit_length"],
        "you_secret_set": state["secrets"].get(role) is not None,
        "opponent_present": opp is not None,
        "opponent_secret_set": state["secrets"].get(opp_role) is not None,
        "opponent_connected": bool(opp and opp["connected"]),
        "started": room["started"],
        "over": room["over"],
        "turn": state["turn"],
        "history": state["history"],
        "winner": room["winner"],
        "winning_guess": state["winning_guess"],
    }
    if room["over"]:
        snapshot["secrets"] = dict(state["secrets"])
    return snapshot


def reset(room: dict, data: dict) -> dict:
    """Reset the room for another round. Returns the broadcast message."""
    state = room["state"]
    if state.get("pending_length"):
        room["config"]["digit_length"] = state["pending_length"]
    state["secrets"] = {}
    state["turn"] = None
    state["history"] = []
    state["winning_guess"] = None
    state["pending_length"] = None
    return {"type": "room_reset", "digit_length": room["config"]["digit_length"]}


def before_replay(room: dict, data: dict) -> None:
    """A player may optionally choose a new digit length for the next round."""
    dl = data.get("digit_length")
    if isinstance(dl, int) and MIN_DIGITS <= dl <= MAX_DIGITS:
        room["state"]["pending_length"] = dl


# ---------------------------------------------------------------------------
# Rules
# ---------------------------------------------------------------------------
def valid_number(value, length: int) -> bool:
    """Correct length, ASCII digits only, all digits unique."""
    if not isinstance(value, str) or len(value) != length:
        return False
    if any(c not in string.digits for c in value):
        return False
    return len(set(value)) == length


def compute_score(secret: str, guess: str) -> tuple[int, int]:
    """Classic scoring, exposed only as aggregate counts.

    full = digit correct AND in the correct position.
    half = digit present in the secret but wrong position (never double-counted
           with a full). Only these two totals are ever returned.
    """
    full = 0
    half = 0
    for i in range(len(secret)):
        if guess[i] == secret[i]:
            full += 1
        elif guess[i] in secret:
            half += 1
    return full, half


# ---------------------------------------------------------------------------
# Message handler
# ---------------------------------------------------------------------------
async def handle(ws, room: dict, role: str, data: dict) -> None:
    msg_type = data.get("type")
    state = room["state"]
    digit_length = room["config"]["digit_length"]

    if msg_type == "set_secret":
        if room["started"]:
            await send(ws, {"type": "error", "message": "Game already started"})
            return
        secret = data.get("secret")
        if not valid_number(secret, digit_length):
            await send(
                ws,
                {"type": "error", "message": f"Secret must be {digit_length} unique digits"},
            )
            return
        state["secrets"][role] = secret
        both_set = (
            len(room["players"]) == 2
            and all(state["secrets"].get(r) is not None for r in room["players"])
        )
        if both_set:
            room["started"] = True
            room["over"] = False
            state["turn"] = random.choice(ROLES)
            await broadcast(room, {"type": "game_start", "first_turn": state["turn"]})

    elif msg_type == "make_guess":
        if not room["started"] or room["over"] or state["turn"] != role:
            await send(ws, {"type": "error", "message": "Not your turn"})
            return
        guess = data.get("guess")
        if not valid_number(guess, digit_length):
            await send(
                ws,
                {"type": "error", "message": f"Guess must be {digit_length} unique digits"},
            )
            return
        opp = opponent_role(role)
        secret = state["secrets"][opp]
        full, half = compute_score(secret, guess)
        state["history"].append(
            {"player": role, "guess": guess, "full": full, "half": half}
        )

        if full == digit_length:
            room["over"] = True
            state["turn"] = None
            room["winner"] = role
            state["winning_guess"] = guess
            await broadcast(
                room,
                {
                    "type": "game_over",
                    "winner": role,
                    "winning_guess": guess,
                    "secrets": dict(state["secrets"]),
                },
            )
        else:
            state["turn"] = opp
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

    else:
        await send(ws, {"type": "error", "message": "Unknown message type"})
