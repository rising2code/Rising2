"""Competition / ATLAS service (/CompetitionService/CompetitionService.asmx).

Flow (official dedicated server + every client):
  server  CreateSession          -> csid + ccid
  server  SetReportIntention     (csid, its ccid)
  client  SetReportIntention     (csid, empty ccid) -> new ccid per client
  server  SubmitReport (DIME)    binary report whose roster lists the ccids
The report is saved raw, parsed, stored, and turned into PlayerStats_v1 rows.
"""
from __future__ import annotations

import json
import os
import time
import uuid

from . import log
from .config import Config
from .report import ReportError, parse_dime, parse_report
from .soap import E, Node, envelope, parse_envelope
from .rules_engine import apply_report

NS = "http://gamespy.net/competition/"


def _resp(op: str, result: int = 0, message: str | None = None, csid: str | None = None, ccid: str | None = None) -> bytes:
    return envelope(NS, E(f"{op}Response", E(f"{op}Result", E("result", result), E("message", message),
                                             E("csid", csid), E("ccid", ccid))))


def _cert(op: Node) -> tuple[int | None, str | None]:
    c = op.child("certificate")
    if c is None:
        return None, None
    try:
        pid = int(c.get("profileid", "0")) or None
    except ValueError:
        pid = None
    return pid, c.get("uniquenick") or c.get("profilenick") or None


def resolve_player(ctx, cert_pid: int | None, cert_nick: str | None, ip: str) -> tuple[int | None, str | None, str]:
    """Return (profileid, nick, how). Players are matched only by the profileid in the
    certificate AuthService gave them - never by IP (several players may share one)."""
    if not cert_pid:
        return None, None, "unresolved(no profileid in certificate)"
    u = ctx.db.login.get_by_profileid(cert_pid)
    if not u:
        return None, None, f"unresolved(certificate profileid {cert_pid} not in login DB)"
    return cert_pid, u["name"], "certificate"


def handle(op: Node, ctx, ip: str, raw_body: bytes, content_type: str) -> bytes:
    name = op.name
    st = ctx.db.stats
    cert_pid, cert_nick = _cert(op)
    gameid = op.get("gameid")

    if name in ("CreateSession", "CreateMatchlessSession"):
        csid, ccid = str(uuid.uuid4()), str(uuid.uuid4())
        season = ctx.rules.current_season()  # the match counts for the season it started in
        st.x("INSERT INTO comp_sessions (csid, host_ccid, created, host_ip, host_profileid, host_nick, gameid, matchless, "
             "season) VALUES (?,?,?,?,?,?,?,?,?)",
             (csid, ccid, int(time.time()), ip, cert_pid, cert_nick, gameid, int(name == "CreateMatchlessSession"),
              season))
        log.event("COMP", name.upper(), "INFO", "stats session created (game server passed the stats gate)",
                  user=cert_nick, ip=ip, csid=csid, ccid=ccid, season=season, gameid=gameid,
                  platformid=op.get("platformid"), cert_profileid=cert_pid)
        tracker = getattr(ctx, "maptrack", None)
        if tracker and tracker.enabled:
            m, gt = tracker.current(cert_pid, cert_nick)
            log.event("MAP", "MATCH", "INFO", f"match starts on map {m!r}" if m else
                      "no heartbeat known for this server yet (map decided at SubmitReport)",
                      user=cert_nick, ip=ip, csid=csid, gametype=gt or None)
        return _resp(name, 0, None, csid, ccid)

    if name == "SetReportIntention":
        csid = op.get("csid")
        ccid = op.get("ccid") or str(uuid.uuid4())
        auth = op.get("authoritative")
        pid, nick, how = resolve_player(ctx, cert_pid, cert_nick, ip)
        sess = st.q1("SELECT * FROM comp_sessions WHERE csid=?", (csid,))
        is_host = bool(sess and sess["host_ip"] == ip and sess["host_ccid"] == ccid)
        st.x("INSERT INTO comp_intentions (csid, ccid, profileid, nick, ip, authoritative, resolved_by, created) "
             "VALUES (?,?,?,?,?,?,?,?)",
             (csid, ccid, pid, nick, ip, 1 if auth in ("1", "true") else 0, how, int(time.time())))
        level = "INFO" if pid else "WARN"
        log.event("COMP", "SETREPORTINTENTION", level,
                  ("game server" if is_host else "player") + f" will report; player matched by {how}"
                  + ("" if sess else " (csid unknown to this server!)"),
                  user=nick or cert_nick, ip=ip, csid=csid, ccid=ccid, profileid=pid, authoritative=auth,
                  cert_profileid=cert_pid)
        return _resp(name, 0, None, csid, ccid)

    if name == "SubmitReport":
        return submit_report(op, ctx, ip, raw_body, content_type, cert_pid, cert_nick)

    log.event("COMP", name.upper(), "WARN", "Competition operation not implemented - answering result=0",
              user=cert_nick, ip=ip, request=op.to_dict())
    return _resp(name, 0)


def submit_report(op: Node, ctx, ip: str, raw_body: bytes, content_type: str, cert_pid, cert_nick) -> bytes:
    st = ctx.db.stats
    csid, ccid, auth = op.get("csid"), op.get("ccid"), op.get("authoritative")
    report_bytes = getattr(op, "attachment", None)
    os.makedirs(Config.REPORTS_DIR, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    raw_name = os.path.join(Config.REPORTS_DIR, f"{stamp}_{csid or 'nocsid'}_{ccid or 'noccid'}")
    with open(raw_name + ".http_body.bin", "wb") as f:
        f.write(raw_body)
    if report_bytes is not None:
        with open(raw_name + ".report.bin", "wb") as f:
            f.write(report_bytes)
    # the report belongs to the season its session started in (a season switch mid-match doesn't move it)
    sess = st.q1("SELECT season, created FROM comp_sessions WHERE csid=?", (csid,)) if csid else None
    season = sess["season"] if sess else ctx.rules.current_season()
    rid = st.x("INSERT INTO comp_reports (csid, ccid, received, submitter_ip, authoritative, raw_file, raw_size, season) "
               "VALUES (?,?,?,?,?,?,?,?)",
               (csid, ccid, int(time.time()), ip, 1 if auth in ("1", "true") else 0,
                raw_name + (".report.bin" if report_bytes is not None else ".http_body.bin"),
                len(report_bytes) if report_bytes is not None else None, season))
    log.event("COMP", "SUBMITREPORT", "INFO", "report received" + ("" if sess else " (unknown session: current season)"),
              user=cert_nick, ip=ip, report=rid, season=season, csid=csid, ccid=ccid, authoritative=auth,
              size=len(report_bytes) if report_bytes is not None else None, content_type=content_type,
              saved=raw_name + ".*.bin")
    if report_bytes is None:
        st.x("UPDATE comp_reports SET parse_error=? WHERE id=?", ("no DIME attachment", rid))
        log.event("COMP", "SUBMITREPORT", "ERROR", "no report attachment found in the request", ip=ip, report=rid)
        return _resp("SubmitReport", 0)
    log.event("COMP", "REPORT-HEX", "DEBUG", "\n" + log.hexdump(report_bytes), report=rid)

    try:
        parsed = parse_report(report_bytes)
    except (ReportError, IndexError, ValueError) as e:
        st.x("UPDATE comp_reports SET parse_error=? WHERE id=?", (str(e), rid))
        log.event("COMP", "PARSE", "ERROR", f"report could not be parsed: {e} (raw file kept)", ip=ip, report=rid)
        return _resp("SubmitReport", 0)

    h = parsed["header"]
    log.event("COMP", "PARSE", "INFO", "report parsed", ip=ip, report=rid, status=h["game_status_name"],
              flags="|".join(h["flag_names"]) or h["flags"], players=h["players"], teams=h["teams"],
              devver=h["developer_version"], checksum_ok=h["checksum_ok"])
    for w in parsed["warnings"]:
        log.event("COMP", "PARSE", "WARN", w, report=rid)
    log.event("COMP", "GAMEKEYS", "INFO", " ".join(f"{d['key']}({d['type']})={d['value']!r}" for d in parsed["game_details"]) or "-",
              report=rid)
    for t in parsed["teams"]:
        log.event("COMP", "TEAM", "INFO", f"team {t['idx']} result={t.get('result_name')}", report=rid,
                  keys=" ".join(f"{d['key']}({d['type']})={d['value']!r}" for d in t.get("key_details", [])))

    players = []
    for p in parsed["players"]:
        it = st.q1("SELECT * FROM comp_intentions WHERE ccid=? ORDER BY id DESC LIMIT 1", (p["ccid"],))
        pid = it["profileid"] if it else None
        nick = it["nick"] if it else None
        how = it["resolved_by"] if it else "unresolved(ccid never sent SetReportIntention)"
        pkey = getattr(ctx.rules.get(season), "PROFILE_ID_KEY", None)
        if pkey is not None and isinstance(p["keys"].get(int(pkey)), int):
            pid = p["keys"][int(pkey)]
            u = ctx.db.login.get_by_profileid(pid)
            nick, how = (u["name"] if u else nick), f"report key {pkey}"
        entry = {"idx": p["idx"], "ccid": p["ccid"], "profileid": pid, "nick": nick, "team": p["team"],
                 "result": p.get("result"), "keys": p.get("keys", {})}
        players.append(entry)
        st.x("INSERT OR REPLACE INTO comp_report_players (report_id, idx, ccid, profileid, nick, team, result, keys_json, "
             "season) VALUES (?,?,?,?,?,?,?,?,?)",
             (rid, p["idx"], p["ccid"], pid, nick, p["team"], p.get("result"), json.dumps(p.get("key_details", [])),
              season))
        log.event("COMP", "PLAYER", "INFO" if pid else "WARN",
                  f"#{p['idx']} team={p['team']} result={p.get('result_name')} matched_by={how}",
                  user=nick, report=rid, ccid=p["ccid"], profileid=pid,
                  keys=" ".join(f"{d['key']}({d['type']})={d['value']!r}" for d in p.get("key_details", [])))
        if pid:
            for d in p.get("key_details", []):
                v = d["value"]
                num = float(v) if isinstance(v, (int, float)) else 0.0
                st.x("INSERT INTO player_key_totals (season, profileid, key_id, sum_value, max_value, last_value, count) "
                     "VALUES (?,?,?,?,?,?,1) ON CONFLICT(season, profileid, key_id) DO UPDATE SET "
                     "sum_value=sum_value+excluded.sum_value, max_value=MAX(COALESCE(max_value, excluded.max_value), excluded.max_value), "
                     "last_value=excluded.last_value, count=count+1",
                     (season, pid, d["key"], num, num, json.dumps(v)))

    def _json_safe(o):
        if isinstance(o, dict):
            return {str(k): _json_safe(v) for k, v in o.items()}
        if isinstance(o, list):
            return [_json_safe(x) for x in o]
        return o

    st.x("UPDATE comp_reports SET parse_ok=1, game_status=?, flags=?, player_count=?, team_count=?, parsed_json=? WHERE id=?",
         (h["game_status"], h["flags"], h["players"], h["teams"], json.dumps(_json_safe(parsed)), rid))

    if is_profile_report(players):
        apply_profile_report(ctx, rid, players, cert_pid, ip)
    else:
        map_, gametype = "", ""
        tracker = getattr(ctx, "maptrack", None)
        if tracker:
            map_, gametype = tracker.for_report(cert_pid, cert_nick, sess["created"] if sess else None,
                                                {p["nick"] for p in players if p["nick"]}, report=rid, csid=csid)
        st.x("UPDATE comp_reports SET map=?, gametype=? WHERE id=?", (map_, gametype, rid))
        apply_report(ctx, rid, parsed, players, season, map_=map_, gametype=gametype)
    st.x("UPDATE comp_reports SET applied=1 WHERE id=?", (rid,))
    return _resp("SubmitReport", 0)


# The profile page's "Update" button: the CLIENT opens its own session and reports itself with
# key 44 = ViewMyProfile, 43 = its nick, 46 = clan tag. Match reports from the game server always
# carry key 8 (constant 1) and never 43/46. A profile report is not a played session.
PROFILE_NICK_KEY, PROFILE_CLAN_KEY, PROFILE_VIEW_KEY, MATCH_MARKER_KEY = 43, 46, 44, 8


def is_profile_report(players: list[dict]) -> bool:
    return bool(players) and all(MATCH_MARKER_KEY not in p["keys"] and
                                 (PROFILE_CLAN_KEY in p["keys"] or PROFILE_NICK_KEY in p["keys"]) for p in players)


def apply_profile_report(ctx, rid: int, players: list[dict], cert_pid: int | None, ip: str) -> None:
    from .stats import CLAN_TAG_MAX, save_profile_fields
    for p in players:
        pid = p["profileid"]
        if not pid or pid != cert_pid:  # a player may only change their own profile
            log.event("COMP", "PROFILE", "WARN", "profile update ignored: not the submitter's own profile",
                      user=p["nick"], ip=ip, report=rid, profileid=pid, cert_profileid=cert_pid)
            continue
        values = {}
        clan = p["keys"].get(PROFILE_CLAN_KEY)
        if isinstance(clan, str):
            values["PlayerClanNameTag"] = clan.strip()[:CLAN_TAG_MAX]
        view = p["keys"].get(PROFILE_VIEW_KEY)
        if isinstance(view, int):
            values["ViewMyProfile"] = 1 if view else 0
        if values:
            save_profile_fields(ctx, pid, **values)
        log.event("COMP", "PROFILE", "INFO", "profile settings saved (not counted as a session)",
                  user=p["nick"], ip=ip, report=rid, profileid=pid,
                  **{k: repr(v) for k, v in values.items()})


def parse_request(body: bytes, content_type: str) -> tuple[Node, bytes | None]:
    """Competition requests may be plain XML or DIME (SubmitReport)."""
    attachment = None
    if "dime" in content_type.lower() or (body[:1] and (body[0] & 0xF8) == 0x08 and not body.lstrip().startswith(b"<")):
        recs = parse_dime(body)
        log.event("COMP", "DIME", "DEBUG", "records: " + "; ".join(
            f"id={r['id']!r} type={r['type']!r} {len(r['data'])}B" for r in recs))
        xml = next((r["data"] for r in recs if b"Envelope" in r["data"][:400]), recs[0]["data"] if recs else b"")
        others = [r for r in recs if r["data"] is not xml]
        if others:
            attachment = others[0]["data"]
        body = xml
    op = parse_envelope(body)
    return op, attachment
