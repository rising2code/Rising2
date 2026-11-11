"""Sake storage (/SakeStorageServer/StorageServer.asmx).

PlayerStats_v1 rows come from player_stats (filled by Competition reports) of the
CURRENT SEASON - one row per registered account, zeros if the player has not
played this season.
PersonalInfo rows are built from the login DB plus whatever the game wrote.
Any other table is stored generically.
Filters / sorts from the game ("ownerid = 100000001", "TotalSkill desc",
"PlayerUnickName != ''") are evaluated by SQLite on an in-memory table.
"""
from __future__ import annotations

import datetime
import re
import sqlite3

from . import log
from .db import PROFILE_ID_OFFSET
from .soap import E, Node, envelope
from .stats import column_type, player_row

NS = "http://gamespy.net/sake"
VALUE_TYPES = ("byteValue", "shortValue", "intValue", "floatValue", "asciiStringValue", "unicodeStringValue",
               "booleanValue", "dateAndTimeValue", "binaryDataValue", "int64Value")

PERSONALINFO_TYPES = {
    "ownerid": "intValue", "recordid": "intValue", "NickName": "asciiStringValue",
    "EmailAddress": "asciiStringValue", "AccountCreationDate": "dateAndTimeValue",
    "LastGameDate": "dateAndTimeValue", "ViewMyProfile": "intValue", "ViewMyEmail": "intValue",
    "CampaignsCompleted": "byteValue",
}

_IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_STRINGS = re.compile(r"'[^']*'|\"[^\"]*\"")
_SQL_WORDS = {"and", "or", "not", "like", "null", "is", "in", "between", "asc", "desc", "glob", "escape"}


def _iso(ts: int | None) -> str:
    if not ts:
        return "2018-01-01T00:00:00Z"
    return datetime.datetime.utcfromtimestamp(ts).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------- rows ------
# A row is {field: (type, value)}

def _typed(row: dict, types: dict | None = None) -> dict:
    if types is None:  # PlayerStats_v1: known columns + any column invented in rules.py
        return {k: (column_type(k, v), v) for k, v in row.items()}
    return {k: (types.get(k, "intValue" if isinstance(v, int) else "asciiStringValue"), v) for k, v in row.items()}


def rows_for_table(ctx, table: str) -> list[dict]:
    st = ctx.db.stats
    if table == "PlayerStats_v1":
        # current season only: a player who has not played this season gets the new-player row
        season = ctx.rules.current_season()
        out = []
        seen = set()
        for u in ctx.db.login.all_users():
            out.append(_typed(player_row(ctx, u["profileid"], u["name"], season)))
            seen.add(u["profileid"])
        for pid in st.all_stats(season):
            if pid not in seen:
                out.append(_typed(player_row(ctx, pid, None, season)))
        return out
    if table == "PersonalInfo":
        out = []
        for u in ctx.db.login.all_users():
            base = {
                "ownerid": u["profileid"], "recordid": u["id"], "NickName": u["name"], "EmailAddress": u["email"],
                "AccountCreationDate": _iso(None), "LastGameDate": _iso(u.get("lasttime")),
                "ViewMyProfile": 1, "ViewMyEmail": 1, "CampaignsCompleted": 0,
            }
            row = _typed(base, PERSONALINFO_TYPES)
            ov = st.sake_get_by_owner("PersonalInfo", u["profileid"])
            if ov:
                row.update({k: tuple(v) for k, v in ov["data"].items()})
            out.append(row)
        return out
    out = []
    for r in st.sake_records(table):
        row = {k: tuple(v) for k, v in r["data"].items()}
        row["recordid"] = ("intValue", r["recordid"])
        if r["ownerid"] is not None:
            row["ownerid"] = ("intValue", r["ownerid"])
        out.append(row)
    return out


def _sql_value(tv):
    t, v = tv
    if t in ("intValue", "byteValue", "shortValue", "int64Value"):
        try:
            return int(v)
        except (TypeError, ValueError):
            return v
    if t == "floatValue":
        try:
            return float(v)
        except (TypeError, ValueError):
            return v
    return v


def query_rows(rows: list[dict], where: str, order: str) -> tuple[list[int], str]:
    """Indices of rows matching `where`, ordered by `order` (SQL fragments from the game)."""
    texts = [where or "", order or ""]
    idents = set()
    for t in texts:
        idents |= {m.group(0) for m in _IDENT.finditer(_STRINGS.sub("''", t))}
    cols = sorted(({k for r in rows for k in r} | {i for i in idents if i.lower() not in _SQL_WORDS}))
    cols = [c for c in cols if _IDENT.fullmatch(c)]
    con = sqlite3.connect(":memory:")
    try:
        con.execute("CREATE TABLE t (_i INTEGER" + "".join(f', "{c}"' for c in cols) + ")")
        for i, r in enumerate(rows):
            con.execute(f"INSERT INTO t VALUES (?{', ?' * len(cols)})", [i] + [_sql_value(r[c]) if c in r else None for c in cols])

        def authorizer(action, arg1, arg2, dbname, source):
            if action in (sqlite3.SQLITE_SELECT, sqlite3.SQLITE_FUNCTION):
                return sqlite3.SQLITE_OK
            if action == sqlite3.SQLITE_READ and arg1 == "t":
                return sqlite3.SQLITE_OK
            return sqlite3.SQLITE_DENY

        con.set_authorizer(authorizer)
        sql = "SELECT _i FROM t"
        if where.strip():
            sql += f" WHERE {where}"
        sql += f" ORDER BY {order}, _i" if order.strip() else " ORDER BY _i"
        return [r[0] for r in con.execute(sql)], ""
    except sqlite3.Error as e:
        note = f"could not evaluate where={where!r} order={order!r} ({e})"
        try:
            con.set_authorizer(None)
        except Exception:
            pass
        return list(range(len(rows))), note
    finally:
        con.close()


def record_values(row: dict, fields: list[str]) -> E:
    vals = []
    for f in fields:
        if f in row:
            t, v = row[f]
            if t == "booleanValue":
                v = "true" if v in (True, 1, "1", "true") else "false"
            vals.append(E("RecordValue", E(t, E("value", v))))
        else:
            vals.append(E("RecordValue"))
    return E("ArrayOfRecordValue", *vals)


BUILT_IN_TABLES = ("PlayerStats_v1", "PersonalInfo")


def report_missing_columns(ctx, opname: str, table: str, fields: list[str], rows: list[dict], op: Node,
                           ip: str, nick: str | None) -> None:
    """Write config/missing/ entries for columns/tables the client wants but we never have."""
    common = dict(op=opname, requested_by=nick, ip=ip, filter=repr(op.get("filter")), sort=op.get("sort"))
    if not rows and table not in BUILT_IN_TABLES:
        ctx.missing.note("sake_table", table, "the client reads this table but nothing has ever been stored in it "
                         "- it gets an empty answer", fields=",".join(fields), **common)
        return
    have = {k for r in rows for k in r} | {"row"}
    for f in fields:
        if f not in have:
            ctx.missing.note("sake_column", f"{table}.{f}", "the client asks for this column but no row has it - "
                             "it gets an empty value (set it in rules.py to fill it)", table=table, **common)


def parse_fields(op: Node) -> list[str]:
    f = op.child("fields")
    return [c.text for c in f.children()] if f is not None else []


def parse_record_fields(op: Node) -> dict:
    """<values><RecordField><name>X</name><value><intValue><value>5</value></intValue></value></RecordField>..."""
    out = {}
    vals = op.child("values")
    if vals is None:
        return out
    for rf in vals.children():
        name = rf.get("name")
        val = rf.child("value")
        if not name or val is None:
            continue
        kids = val.children()
        if not kids:
            continue
        t = kids[0].name
        out[name] = [t, kids[0].get("value")]
    return out


def owner_from_ticket(ctx, op: Node) -> tuple[int | None, str | None]:
    t = op.get("loginTicket")
    if not t:
        return None, None
    lg = ctx.db.stats.login_by_ticket(t)
    if lg:
        return lg["profileid"], lg["nick"]
    return None, None


def handle(op: Node, ctx, ip: str) -> bytes:
    name = op.name
    table = op.get("tableid")
    owner, nick = owner_from_ticket(ctx, op)
    common = dict(user=nick, ip=ip, table=table, owner=owner, gameid=op.get("gameid"))
    st = ctx.db.stats

    if name in ("SearchForRecords", "GetMyRecords", "GetSpecificRecords", "GetRandomRecords"):
        fields = parse_fields(op)
        rows = rows_for_table(ctx, table)
        where = op.get("filter")
        if name == "GetMyRecords":
            where = f"ownerid = {owner}" if owner else "0"
        elif name == "GetSpecificRecords":
            ids = [c.text for c in (op.child("recordids").children() if op.child("recordids") is not None else [])]
            where = "recordid IN (" + ",".join(str(int(i)) for i in ids if i.lstrip("-").isdigit()) + ")" if ids else "0"
        owners = op.child("ownerids")
        if owners is not None and owners.children():
            ids = ",".join(str(int(c.text)) for c in owners.children() if c.text.lstrip("-").isdigit())
            if ids:
                where = f"({where or '1'}) AND ownerid IN ({ids})"
        order = op.get("sort")
        idx, note = query_rows(rows, where or "", order or "")
        if note:
            log.event("SAKE", name.upper(), "WARN", note, **common)
        # positions ("row") = rank in sort order over the whole table (leaderboards)
        all_sorted, _ = query_rows(rows, "", order or "")
        position = {ri: n + 1 for n, ri in enumerate(all_sorted)}
        target = op.get("targetfilter")
        surrounding = op.get_int("surrounding", 0)
        offset, mx = op.get_int("offset", 0), op.get_int("max", 0) or 1000
        if target:
            tidx, tnote = query_rows(rows, target, order or "")
            if tnote:
                log.event("SAKE", name.upper(), "WARN", "targetfilter: " + tnote, **common)
            tset = set(tidx)
            chosen = []
            for n, ri in enumerate(all_sorted):
                if ri in tset:
                    chosen.extend(all_sorted[max(0, n - surrounding): n + surrounding + 1])
            seen = set()
            result = [i for i in chosen if not (i in seen or seen.add(i))][:mx]
        elif name == "GetRandomRecords":
            import random
            result = random.sample(idx, min(len(idx), mx))
        else:
            result = idx[offset: offset + mx]
        out_rows = []
        for ri in result:
            r = dict(rows[ri])
            r["row"] = ("intValue", position.get(ri, 0))
            out_rows.append(r)
        log.event("SAKE", name.upper(), "INFO", f"{len(out_rows)} record(s) returned of {len(rows)}",
                  filter=repr(op.get("filter")), sort=order, targetfilter=repr(target), surrounding=surrounding,
                  offset=offset, max=op.get("max"), fields=",".join(fields), **common)
        report_missing_columns(ctx, name, table, fields, rows, op, ip, nick)
        for r in out_rows:
            log.event("SAKE", "RECORD", "DEBUG", " ".join(f"{f}={r[f][1]!r}" for f in fields if f in r), table=table)
        resp = E(f"{name}Response", E(f"{name}Result", "Success"),
                 E("values", *[record_values(r, fields) for r in out_rows]) if out_rows else E("values"))
        return envelope(NS, resp)

    if name == "GetRecordCount":
        rows = rows_for_table(ctx, table)
        idx, note = query_rows(rows, op.get("filter"), "")
        log.event("SAKE", "GETRECORDCOUNT", "INFO", f"count={len(idx)}" + (f" ({note})" if note else ""),
                  filter=repr(op.get("filter")), **common)
        return envelope(NS, E("GetRecordCountResponse", E("GetRecordCountResult", "Success"), E("count", len(idx))))

    if name in ("CreateRecord", "UpdateRecord"):
        values = parse_record_fields(op)
        rid = op.get_int("recordid", -1) if name == "UpdateRecord" else None
        if table == "PlayerStats_v1":
            pid = owner or (rid + PROFILE_ID_OFFSET if rid and rid > 0 else None)
            log.event("SAKE", name.upper(), "WARN",
                      "the GAME wrote PlayerStats_v1 directly (unexpected) - merged into player_stats",
                      values=values, **common)
            if pid:
                season = ctx.rules.current_season()
                row = player_row(ctx, pid, None, season)
                row.update({k: v[1] for k, v in values.items()})
                st.put_stats(season, pid, row.get("PlayerUnickName"), row)
            return envelope(NS, E(f"{name}Response", E(f"{name}Result", "Success"),
                                  E("recordid", pid - PROFILE_ID_OFFSET) if (name == "CreateRecord" and pid) else None))
        if table == "PersonalInfo":
            pid = owner or (rid + PROFILE_ID_OFFSET if rid and rid > 0 else None)
            existing = st.sake_get_by_owner("PersonalInfo", pid) if pid else None
            data = existing["data"] if existing else {}
            data.update(values)
            rec = st.sake_put("PersonalInfo", pid - PROFILE_ID_OFFSET if pid else None, pid, data)
        else:
            existing = st.sake_get(table, rid) if rid and rid > 0 else None
            data = existing["data"] if existing else {}
            data.update(values)
            rec = st.sake_put(table, rid if rid and rid > 0 else None, owner, data)
        log.event("SAKE", name.upper(), "INFO", f"record {rec} saved",
                  values=" ".join(f"{k}={v[1]!r}({v[0]})" for k, v in values.items()), **common)
        if name == "CreateRecord":
            return envelope(NS, E("CreateRecordResponse", E("CreateRecordResult", "Success"), E("recordid", rec)))
        return envelope(NS, E("UpdateRecordResponse", E("UpdateRecordResult", "Success")))

    if name == "DeleteRecord":
        rid = op.get_int("recordid", -1)
        st.sake_delete(table, rid)
        log.event("SAKE", "DELETERECORD", "INFO", f"record {rid} deleted", **common)
        return envelope(NS, E("DeleteRecordResponse", E("DeleteRecordResult", "Success")))

    if name == "GetRecordLimit":
        log.event("SAKE", "GETRECORDLIMIT", "INFO", "limit 1000 returned", **common)
        return envelope(NS, E("GetRecordLimitResponse", E("GetRecordLimitResult", "Success"),
                              E("limitPerOwner", 1000), E("limitPerTable", 100000)))

    log.event("SAKE", name.upper(), "WARN", "Sake operation not implemented - returning Success with no data",
              request=op.to_dict(), **common)
    return envelope(NS, E(f"{name}Response", E(f"{name}Result", "Success")))
