"""Objects and helpers handed to config/rules.py."""
from __future__ import annotations

RESULT_NAMES = {0: "WIN", 1: "LOSS", 2: "DRAW", 3: "DISCONNECT", 4: "DESYNC", 5: "NONE"}
STATUS_NAMES = {0: "COMPLETE", 1: "PARTIAL", 2: "BROKEN"}


class TrackedKeys(dict):
    """dict of report key -> value that remembers which keys the rules looked at."""

    def __init__(self, data: dict, seen: set) -> None:
        super().__init__(data)
        self._seen = seen

    def __getitem__(self, k):
        self._seen.add(int(k))
        return super().__getitem__(int(k))

    def get(self, k, default=None):
        self._seen.add(int(k))
        return super().get(int(k), default)

    def __contains__(self, k):
        try:
            self._seen.add(int(k))
        except (TypeError, ValueError):
            pass
        return super().__contains__(k)

    # looping over all keys counts as handling all of them
    def __iter__(self):
        self._seen.update(super().keys())
        return super().__iter__()

    def items(self):
        self._seen.update(super().keys())
        return super().items()

    def values(self):
        self._seen.update(super().keys())
        return super().values()


class PlayerView:
    def __init__(self, p: dict, seen: set) -> None:
        self.idx = p["idx"]
        self.ccid = p.get("ccid")
        self.nick = p.get("nick")
        self.profileid = p.get("profileid")
        self.team = p.get("team")
        self.result_code = p.get("result")
        self.result = RESULT_NAMES.get(self.result_code, "NONE")
        self.keys = TrackedKeys(p.get("keys", {}), seen)

    def key(self, k: int, default=0):
        v = self.keys.get(k)
        return default if v is None else v

    def __repr__(self) -> str:
        return f"<Player #{self.idx} {self.nick} {self.result}>"


class TeamView:
    def __init__(self, t: dict, seen: set) -> None:
        self.idx = t.get("idx")
        self.result_code = t.get("result")
        self.result = RESULT_NAMES.get(self.result_code, "NONE")
        self.keys = TrackedKeys({int(k): v for k, v in (t.get("keys") or {}).items()}, seen)

    def key(self, k: int, default=0):
        v = self.keys.get(k)
        return default if v is None else v


class ReportView:
    def __init__(self, report_id: int, parsed: dict, players: list[dict]) -> None:
        self.seen_player_keys: set = set()
        self.seen_game_keys: set = set()
        self.seen_team_keys: set = set()
        h = parsed.get("header", {})
        self.id = report_id
        self.status_code = h.get("game_status")
        self.status = STATUS_NAMES.get(self.status_code, "?")
        self.flags = h.get("flags")
        self.game = TrackedKeys({int(k): v for k, v in (parsed.get("game") or {}).items()}, self.seen_game_keys)
        self.teams = [TeamView(t, self.seen_team_keys) for t in parsed.get("teams", [])]
        self.players = [PlayerView(p, self.seen_player_keys) for p in players]


# ------------------------------------------------------------ helpers ------

def _num(v):
    if isinstance(v, (int, float)):
        return v
    try:
        return int(v)
    except (TypeError, ValueError):
        try:
            return float(v)
        except (TypeError, ValueError):
            return 0


def add(row: dict, col: str, n) -> None:
    row[col] = _num(row.get(col, 0)) + _num(n)


def keep_max(row: dict, col: str, n) -> None:
    row[col] = max(_num(row.get(col, 0)), _num(n))


def keep_min(row: dict, col: str, n) -> None:
    cur = row.get(col)
    row[col] = _num(n) if cur in (None, "", 0) else min(_num(cur), _num(n))


def rank_from_xp(xp, thresholds) -> int:
    rank = thresholds[0][1] if thresholds else 1
    for need, r in thresholds:
        if _num(xp) >= need:
            rank = r
    return rank
