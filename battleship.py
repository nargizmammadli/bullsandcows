"""Battleship game module for Twoplay.

Variable grid size (8x8 .. 15x15) chosen at room creation, with a fleet that
scales by grid size. Manual placement, two turn rules ("strict" alternation or
"hit_again"). Firing reveals only hit/miss/sunk for the targeted cell.

Operates on a generic room's ``state`` / ``config`` dicts; the shared layer
(main.py) owns rooms, connections, reconnect and play-again bookkeeping.
"""

import random

from shared import ROLES, broadcast, opponent_role, send

GAME_TYPE = "battleship"

MIN_GRID = 8
MAX_GRID = 15
TURN_RULES = ("strict", "hit_again")

# Fleet table keyed by grid size N. Each entry: (ship name, length). Ship
# density stays roughly constant (~13-19%) as the board grows. Easy to tweak.
FLEETS: dict[int, list[tuple[str, int]]] = {
    8:  [("Battleship", 4), ("Cruiser", 3), ("Submarine", 3), ("Destroyer", 2)],
    9:  [("Battleship", 4), ("Cruiser", 3), ("Submarine", 3), ("Destroyer", 2), ("Destroyer", 2)],
    10: [("Carrier", 5), ("Battleship", 4), ("Cruiser", 3), ("Submarine", 3), ("Destroyer", 2)],
    11: [("Carrier", 5), ("Battleship", 4), ("Cruiser", 3), ("Submarine", 3), ("Destroyer", 2), ("Destroyer", 2)],
    12: [("Carrier", 5), ("Battleship", 4), ("Battleship", 4), ("Cruiser", 3), ("Submarine", 3), ("Destroyer", 2)],
    13: [("Carrier", 5), ("Battleship", 4), ("Battleship", 4), ("Cruiser", 3), ("Cruiser", 3), ("Submarine", 3), ("Destroyer", 2)],
    14: [("Carrier", 5), ("Carrier", 5), ("Battleship", 4), ("Battleship", 4), ("Cruiser", 3), ("Cruiser", 3), ("Destroyer", 2)],
    15: [("Carrier", 5), ("Carrier", 5), ("Battleship", 4), ("Battleship", 4), ("Cruiser", 3), ("Cruiser", 3), ("Submarine", 3), ("Destroyer", 2)],
}


def fleet_spec(grid_size: int) -> list[dict]:
    """Return the fleet as a list of {id, name, label, length}.

    When a ship name appears more than once it is numbered ("Destroyer 1",
    "Destroyer 2") so placement and sunk announcements stay unambiguous.
    """
    raw = FLEETS[grid_size]
    name_counts: dict[str, int] = {}
    for name, _ in raw:
        name_counts[name] = name_counts.get(name, 0) + 1
    seen: dict[str, int] = {}
    spec = []
    for idx, (name, length) in enumerate(raw):
        if name_counts[name] > 1:
            seen[name] = seen.get(name, 0) + 1
            label = f"{name} {seen[name]}"
        else:
            label = name
        spec.append({"id": f"ship{idx}", "name": name, "label": label, "length": length})
    return spec


# ---------------------------------------------------------------------------
# Room lifecycle hooks
# ---------------------------------------------------------------------------
def validate_create(data: dict):
    grid_size = data.get("grid_size")
    turn_rule = data.get("turn_rule")
    if not isinstance(grid_size, int) or not (MIN_GRID <= grid_size <= MAX_GRID):
        return None, f"Grid size must be {MIN_GRID}-{MAX_GRID}"
    if turn_rule not in TURN_RULES:
        return None, "Invalid turn rule"
    return {"grid_size": grid_size, "turn_rule": turn_rule}, None


def init_state(config: dict) -> dict:
    return {
        "fleet": fleet_spec(config["grid_size"]),
        "ships": {},            # role -> list of {id,label,length,cells:[[r,c]],hits:[[r,c]]}
        "ready": {},            # role -> bool (placement locked in)
        "shots": {"A": [], "B": []},  # role -> shots THAT role has fired
        "turn": None,
    }


def join_payload(room: dict) -> dict:
    return {
        "grid_size": room["config"]["grid_size"],
        "turn_rule": room["config"]["turn_rule"],
        "fleet": room["state"]["fleet"],
    }


def build_state_sync(room: dict, role: str) -> dict:
    state = room["state"]
    opp = opponent_role(role)
    opp_player = room["players"].get(opp)
    snapshot = {
        "type": "state_sync",
        "game_type": GAME_TYPE,
        "room_code": room["code"],
        "role": role,
        "grid_size": room["config"]["grid_size"],
        "turn_rule": room["config"]["turn_rule"],
        "fleet": state["fleet"],
        "your_ships": state["ships"].get(role, []),
        "you_ready": bool(state["ready"].get(role)),
        "opponent_present": opp_player is not None,
        "opponent_ready": bool(state["ready"].get(opp)),
        "opponent_connected": bool(opp_player and opp_player["connected"]),
        "started": room["started"],
        "over": room["over"],
        "turn": state["turn"],
        "your_shots": state["shots"].get(role, []),      # shots you fired
        "incoming_shots": state["shots"].get(opp, []),   # shots fired at you
        "winner": room["winner"],
    }
    if room["over"]:
        # Reveal both fleets so the boards can be shown in full.
        snapshot["boards"] = {r: state["ships"].get(r, []) for r in ROLES}
    return snapshot


def reset(room: dict, data: dict) -> dict:
    """Reset for another round. Players re-place their fleets."""
    config = room["config"]
    room["state"] = init_state(config)
    return {
        "type": "room_reset",
        "grid_size": config["grid_size"],
        "turn_rule": config["turn_rule"],
        "fleet": room["state"]["fleet"],
    }


def before_replay(room: dict, data: dict) -> None:
    # No per-round config changes for Battleship.
    return None


# ---------------------------------------------------------------------------
# Placement validation
# ---------------------------------------------------------------------------
def _cells_are_line(cells: list, length: int, grid_size: int) -> bool:
    """A valid ship: `length` distinct, in-bounds cells forming one straight,
    contiguous horizontal or vertical line."""
    if len(cells) != length:
        return False
    for r, c in cells:
        if not (isinstance(r, int) and isinstance(c, int)):
            return False
        if not (0 <= r < grid_size and 0 <= c < grid_size):
            return False
    rows = {r for r, c in cells}
    cols = {c for r, c in cells}
    if len(rows) == 1:  # horizontal
        cs = sorted(c for r, c in cells)
        return cs == list(range(cs[0], cs[0] + length))
    if len(cols) == 1:  # vertical
        rs = sorted(r for r, c in cells)
        return rs == list(range(rs[0], rs[0] + length))
    return False


def validate_placement(fleet: list, placed: list, grid_size: int):
    """Validate a full fleet placement. Returns (ships, error).

    `placed` is the client payload: a list of {id, cells:[[r,c],...]}. Each
    fleet ship must be placed exactly once, as a contiguous line of the right
    length, with no overlap between ships.
    """
    if not isinstance(placed, list) or len(placed) != len(fleet):
        return None, "Place your whole fleet."
    by_id = {}
    for item in placed:
        if not isinstance(item, dict):
            return None, "Bad placement data."
        by_id[item.get("id")] = item.get("cells")

    occupied = set()
    ships = []
    for spec in fleet:
        cells = by_id.get(spec["id"])
        if cells is None or not isinstance(cells, list):
            return None, f"Missing placement for {spec['label']}."
        cells = [[int(r), int(c)] for r, c in cells] if _all_pairs(cells) else None
        if cells is None or not _cells_are_line(cells, spec["length"], grid_size):
            return None, f"{spec['label']} is placed incorrectly."
        for cell in cells:
            key = (cell[0], cell[1])
            if key in occupied:
                return None, "Ships may not overlap."
            occupied.add(key)
        ships.append(
            {
                "id": spec["id"],
                "label": spec["label"],
                "length": spec["length"],
                "cells": cells,
                "hits": [],
            }
        )
    return ships, None


def _all_pairs(cells) -> bool:
    return all(
        isinstance(p, (list, tuple)) and len(p) == 2 and all(isinstance(x, int) for x in p)
        for p in cells
    )


# ---------------------------------------------------------------------------
# Firing
# ---------------------------------------------------------------------------
def _next_turn(shooter: str, result: str, turn_rule: str) -> str:
    if result in ("hit", "sunk") and turn_rule == "hit_again":
        return shooter
    return opponent_role(shooter)


# ---------------------------------------------------------------------------
# Message handler
# ---------------------------------------------------------------------------
async def handle(ws, room: dict, role: str, data: dict) -> None:
    msg_type = data.get("type")
    state = room["state"]
    config = room["config"]
    grid_size = config["grid_size"]

    if msg_type == "place_ships":
        if room["started"]:
            await send(ws, {"type": "error", "message": "Game already started"})
            return
        ships, err = validate_placement(state["fleet"], data.get("ships"), grid_size)
        if err:
            await send(ws, {"type": "error", "message": err})
            return
        state["ships"][role] = ships
        state["ready"][role] = True
        await send(ws, {"type": "placement_accepted"})
        opp = opponent_role(role)
        opp_player = room["players"].get(opp)
        if opp_player and opp_player["ws"]:
            await send(opp_player["ws"], {"type": "opponent_ready"})

        both_ready = (
            len(room["players"]) == 2
            and all(state["ready"].get(r) for r in room["players"])
        )
        if both_ready:
            room["started"] = True
            room["over"] = False
            state["turn"] = random.choice(ROLES)
            await broadcast(room, {"type": "game_start", "first_turn": state["turn"]})

    elif msg_type == "fire":
        if not room["started"] or room["over"] or state["turn"] != role:
            await send(ws, {"type": "error", "message": "Not your turn"})
            return
        row = data.get("row")
        col = data.get("col")
        if not (isinstance(row, int) and isinstance(col, int)):
            await send(ws, {"type": "error", "message": "Invalid target"})
            return
        if not (0 <= row < grid_size and 0 <= col < grid_size):
            await send(ws, {"type": "error", "message": "Target off the board"})
            return
        if any(s["row"] == row and s["col"] == col for s in state["shots"][role]):
            await send(ws, {"type": "error", "message": "Already fired there"})
            return

        defender = opponent_role(role)
        result = "miss"
        sunk_ship = None
        for ship in state["ships"][defender]:
            if [row, col] in ship["cells"]:
                result = "hit"
                if [row, col] not in ship["hits"]:
                    ship["hits"].append([row, col])
                if len(ship["hits"]) == ship["length"]:
                    result = "sunk"
                    sunk_ship = ship["label"]
                break

        state["shots"][role].append(
            {"row": row, "col": col, "result": result, "sunk_ship": sunk_ship}
        )

        all_sunk = all(
            len(s["hits"]) == s["length"] for s in state["ships"][defender]
        )
        if all_sunk:
            room["over"] = True
            state["turn"] = None
            room["winner"] = role
            await broadcast(
                room,
                {
                    "type": "fire_result",
                    "shooter": role,
                    "row": row,
                    "col": col,
                    "result": result,
                    "sunk_ship": sunk_ship,
                    "next_turn": None,
                },
            )
            await broadcast(
                room,
                {
                    "type": "game_over",
                    "winner": role,
                    "boards": {r: state["ships"].get(r, []) for r in ROLES},
                },
            )
        else:
            nxt = _next_turn(role, result, config["turn_rule"])
            state["turn"] = nxt
            await broadcast(
                room,
                {
                    "type": "fire_result",
                    "shooter": role,
                    "row": row,
                    "col": col,
                    "result": result,
                    "sunk_ship": sunk_ship,
                    "next_turn": nxt,
                },
            )

    else:
        await send(ws, {"type": "error", "message": "Unknown message type"})
