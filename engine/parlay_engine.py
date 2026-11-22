#!/usr/bin/env python3
"""
Football Intelligence Pro — Live Multi-League Quant Engine & Self-Growing SQLite History
Queries ESPN Public Soccer API across Argentina (LPF, Primera Nacional, Copa, Supercopa),
Brazil (Brasileirao Serie A & B), ALL UEFA competitions, ALL National Team competitions
(FIFA World Cup & Qualifiers, Friendlies, Copa America, Concacaf, AFCON, Nations League),
CONMEBOL (Libertadores, Sudamericana, Recopa), and Top European Leagues.
"""

from __future__ import annotations

import json
import math
import os
import sqlite3
import threading
import unicodedata
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.environ.get("QUANT_DB_PATH", os.path.join(REPO_ROOT, "data", "quant_master.db"))
OUTPUT_JSON_PATH = os.environ.get("OUTPUT_JSON_PATH", os.path.join(REPO_ROOT, "data", "parlay_engine_output.json"))
LEGACY_OUTPUT_PATH = os.path.join(REPO_ROOT, "parlay_engine_output.json")
TEAMS_HISTORY_PATH = os.path.join(REPO_ROOT, "data", "teams_history.json")
REPORT_MD_PATH = os.path.join(REPO_ROOT, "REPORT_ACTUAL.md")

ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer"
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36"

TARGET_LEAGUES: List[Dict[str, str]] = [
    # Argentina (incl. Primera Nacional)
    {"slug": "arg.1", "name": "Liga Profesional Argentina", "group": "arg"},
    {"slug": "arg.2", "name": "Primera Nacional (Argentina)", "group": "arg"},
    {"slug": "arg.copa", "name": "Copa Argentina", "group": "arg"},
    {"slug": "arg.supercopa", "name": "Supercopa Argentina", "group": "arg"},
    # Brasil
    {"slug": "bra.1", "name": "Brasileirão Série A", "group": "bra"},
    {"slug": "bra.2", "name": "Brasileirão Série B", "group": "bra"},
    # Todos los campeonatos UEFA
    {"slug": "uefa.champions", "name": "UEFA Champions League", "group": "uefa"},
    {"slug": "uefa.europa", "name": "UEFA Europa League", "group": "uefa"},
    {"slug": "uefa.europa.conf", "name": "UEFA Conference League", "group": "uefa"},
    {"slug": "uefa.nations", "name": "UEFA Nations League", "group": "uefa_nat"},
    {"slug": "uefa.euro", "name": "UEFA Eurocopa", "group": "uefa_nat"},
    {"slug": "uefa.euroq", "name": "UEFA Eliminatorias Euro", "group": "uefa_nat"},
    {"slug": "uefa.super_cup", "name": "UEFA Super Cup", "group": "uefa"},
    {"slug": "uefa.wchampions", "name": "UEFA Champions Femenina", "group": "uefa"},
    # Selecciones Nacionales
    {"slug": "fifa.friendly", "name": "Amistosos Selecciones FIFA", "group": "nat"},
    {"slug": "fifa.world", "name": "Copa del Mundo FIFA", "group": "nat"},
    {"slug": "fifa.worldq.conmebol", "name": "Eliminatorias CONMEBOL", "group": "nat"},
    {"slug": "fifa.worldq.uefa", "name": "Eliminatorias Mundial UEFA", "group": "uefa_nat"},
    {"slug": "fifa.worldq.concacaf", "name": "Eliminatorias Concacaf", "group": "nat"},
    {"slug": "fifa.worldq.afc", "name": "Eliminatorias Asia (AFC)", "group": "nat"},
    {"slug": "fifa.worldq.caf", "name": "Eliminatorias África (CAF)", "group": "nat"},
    {"slug": "fifa.worldq.ofc", "name": "Eliminatorias Oceanía (OFC)", "group": "nat"},
    {"slug": "conmebol.america", "name": "Copa América", "group": "nat"},
    {"slug": "concacaf.nations.league", "name": "Concacaf Nations League", "group": "nat"},
    {"slug": "concacaf.gold", "name": "Concacaf Gold Cup", "group": "nat"},
    {"slug": "caf.nations", "name": "Copa Africana de Naciones", "group": "nat"},
    # Sudamérica Clubes y Top Ligas Europeas
    {"slug": "conmebol.libertadores", "name": "Copa Libertadores", "group": "conmebol"},
    {"slug": "conmebol.sudamericana", "name": "Copa Sudamericana", "group": "conmebol"},
    {"slug": "conmebol.recopa", "name": "Recopa Sudamericana", "group": "conmebol"},
    {"slug": "esp.1", "name": "LaLiga (España)", "group": "euro_dom"},
    {"slug": "ita.1", "name": "Serie A (Italia)", "group": "euro_dom"},
    {"slug": "ger.1", "name": "Bundesliga (Alemania)", "group": "euro_dom"},
    {"slug": "ned.1", "name": "Eredivisie (Países Bajos)", "group": "euro_dom"},
    {"slug": "fra.1", "name": "Ligue 1 (Francia)", "group": "euro_dom"},
    {"slug": "eng.1", "name": "Premier League (Inglaterra)", "group": "euro_dom"},
]

GENERIC_TOKENS = {
    "fc", "cf", "ca", "cd", "ac", "sc", "rc", "ud", "sd", "fk", "sk",
    "club", "atletico", "deportivo", "real", "sporting", "racing",
    "independiente", "central", "united", "city", "de", "la", "el", "del",
}

GOALKEEPER_CODES = {"G", "GK", "ARQ", "POR", "GOALKEEPER", "ARQUERO", "PORTERO"}
FORWARD_CODES = {"F", "FW", "ST", "CF", "LF", "RF", "LW", "RW", "SS", "ST-L", "ST-R", "F-L", "F-R", "F-C", "DEL"}
ATT_MID_CODES = {"AM", "CAM", "AM-L", "AM-R", "AM-C", "LM", "RM", "W", "MF-A"}
DEFENDER_CODES = {"D", "DF", "CD", "CD-L", "CD-R", "CD-C", "CB", "LB", "RB", "LWB", "RWB", "DEF"}

_ROSTER_CACHE: Dict[Tuple[str, str], List[Dict[str, Any]]] = {}
_ROSTER_LOCK = threading.Lock()


def norm_name(s: str) -> str:
    txt = unicodedata.normalize("NFD", (s or "").lower())
    txt = "".join(ch for ch in txt if unicodedata.category(ch) != "Mn")
    out = []
    for ch in txt:
        out.append(ch if ch.isalnum() else " ")
    return " ".join("".join(out).split())


def fetch_json(url: str, timeout: int = 8) -> Optional[Dict[str, Any]]:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if resp.status != 200:
                return None
            return json.loads(resp.read().decode("utf-8", errors="replace"))
    except Exception:
        return None


def init_and_migrate_db(db_path: str) -> None:
    os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)
    with sqlite3.connect(db_path) as conn:
        conn.execute("PRAGMA journal_mode = WAL;")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS historial_equipos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                equipo TEXT NOT NULL,
                liga TEXT NOT NULL,
                temporada TEXT NOT NULL,
                gf INTEGER,
                gc INTEGER,
                xg REAL,
                xga REAL,
                possession REAL,
                fuente TEXT,
                UNIQUE(equipo, liga, temporada)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS cache_xg (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                equipo TEXT UNIQUE NOT NULL,
                xg REAL NOT NULL,
                xga REAL NOT NULL,
                actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS match_history_log (
                event_id TEXT PRIMARY KEY,
                league_slug TEXT NOT NULL,
                league_name TEXT NOT NULL,
                match_date_utc TEXT NOT NULL,
                home_team TEXT NOT NULL,
                away_team TEXT NOT NULL,
                home_score INTEGER NOT NULL,
                away_score INTEGER NOT NULL,
                home_corners REAL,
                away_corners REAL,
                home_shots_on_target REAL,
                away_shots_on_target REAL,
                home_yellow_cards REAL,
                away_yellow_cards REAL,
                venue TEXT,
                recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS team_rosters (
                team_id TEXT NOT NULL,
                team_name TEXT NOT NULL,
                league_slug TEXT NOT NULL,
                crest_url TEXT,
                roster_json TEXT NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (team_id, league_slug)
            )
            """
        )
        conn.commit()


def load_xg_index(conn: sqlite3.Connection) -> Dict[str, Tuple[float, float, str]]:
    idx: Dict[str, Tuple[float, float, str]] = {}
    for row in conn.execute("SELECT equipo, xg, xga FROM cache_xg"):
        raw_name, xg, xga = str(row[0]), float(row[1]), float(row[2])
        idx[raw_name.lower().strip()] = (xg, xga, raw_name)
        n = norm_name(raw_name)
        if n and n not in idx:
            idx[n] = (xg, xga, raw_name)
    return idx


def lookup_team_xg(team_name: str, xg_index: Dict[str, Tuple[float, float, str]]) -> Tuple[float, float, str]:
    lower = (team_name or "").lower().strip()
    if lower in xg_index:
        xg, xga, src = xg_index[lower]
        return xg, xga, f"quant_master.db ({src})"
    n = norm_name(team_name)
    if n in xg_index:
        xg, xga, src = xg_index[n]
        return xg, xga, f"quant_master.db ({src})"

    n_tokens = [t for t in n.split() if len(t) >= 4 and t not in GENERIC_TOKENS]
    for k, val in xg_index.items():
        k_tokens = [t for t in norm_name(k).split() if len(t) >= 4 and t not in GENERIC_TOKENS]
        if n_tokens and k_tokens and (all(t in k_tokens for t in n_tokens) or all(t in n_tokens for t in k_tokens)):
            return val[0], val[1], f"quant_master.db ({val[2]})"
    return 1.35, 1.25, "baseline_league_prior"


def poisson_pmf(k: int, lam: float) -> float:
    lam = max(0.05, min(lam, 6.0))
    return (lam ** k * math.exp(-lam)) / math.factorial(k)


def compute_poisson_markets(lam_home: float, lam_away: float) -> Dict[str, Any]:
    p_home, p_draw, p_away = 0.0, 0.0, 0.0
    p_o15, p_o25, p_btts = 0.0, 0.0, 0.0
    best_score = (1, 1)
    best_score_p = -1.0

    for h in range(7):
        ph = poisson_pmf(h, lam_home)
        for a in range(7):
            p = ph * poisson_pmf(a, lam_away)
            if p > best_score_p:
                best_score_p = p
                best_score = (h, a)
            if h > a:
                p_home += p
            elif h == a:
                p_draw += p
            else:
                p_away += p
            if h + a >= 2:
                p_o15 += p
            if h + a >= 3:
                p_o25 += p
            if h >= 1 and a >= 1:
                p_btts += p

    total = max(1e-9, p_home + p_draw + p_away)
    p_home /= total
    p_draw /= total
    p_away /= total
    p_o15 /= total
    p_o25 /= total
    p_btts /= total

    return {
        "probHome": round(p_home, 4),
        "probDraw": round(p_draw, 4),
        "probAway": round(p_away, 4),
        "prob1X": round(p_home + p_draw, 4),
        "probX2": round(p_draw + p_away, 4),
        "prob12": round(p_home + p_away, 4),
        "probOver15": round(p_o15, 4),
        "probOver25": round(p_o25, 4),
        "probBtts": round(p_btts, 4),
        "likelyScore": f"{best_score[0]}-{best_score[1]}",
    }


def extract_boxscore_stat(stats_list: List[Dict[str, Any]], keys: List[str]) -> Optional[float]:
    for s in stats_list or []:
        name = str(s.get("name") or s.get("label") or "").lower()
        if any(k in name for k in keys):
            try:
                return float(str(s.get("displayValue", "")).replace("%", "").strip())
            except Exception:
                pass
    return None


def to_arg_time(iso_utc: str) -> str:
    try:
        dt = datetime.fromisoformat(iso_utc.replace("Z", "+00:00"))
        art = dt.astimezone(timezone(timedelta(hours=-3)))
        return art.strftime("%d/%m/%Y %H:%M ART")
    except Exception:
        return iso_utc


def parse_utc_dt(iso_utc: str) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(iso_utc.replace("Z", "+00:00"))
    except Exception:
        return None


def extract_athlete_stats(athlete: Dict[str, Any]) -> Dict[str, float]:
    out = {"appearances": 0.0, "totalShots": 0.0, "shotsOnTarget": 0.0, "totalGoals": 0.0, "goalAssists": 0.0}
    cats = ((athlete.get("statistics") or {}).get("splits") or {}).get("categories") or []
    for c in cats:
        for s in c.get("stats") or []:
            nm = s.get("name")
            if nm in out:
                try:
                    out[nm] = float(s.get("value") or 0.0)
                except Exception:
                    pass
    if out["appearances"] <= 0.0:
        starts = 0.0
        subs = 0.0
        for c in cats:
            for s in c.get("stats") or []:
                if s.get("name") == "starts":
                    starts = float(s.get("value") or 0.0)
                elif s.get("name") == "subIns":
                    subs = float(s.get("value") or 0.0)
        if starts + subs > 0:
            out["appearances"] = starts + subs
    return out


def fetch_team_roster_cached(slug: str, tid: str) -> List[Dict[str, Any]]:
    if not tid:
        return []
    key = (slug, tid)
    with _ROSTER_LOCK:
        if key in _ROSTER_CACHE:
            return _ROSTER_CACHE[key]

    def parse_roster(target_slug: str) -> List[Dict[str, Any]]:
        rdata = fetch_json(f"{ESPN_BASE}/{target_slug}/teams/{urllib.parse.quote(tid)}/roster", timeout=7)
        athletes = (rdata or {}).get("athletes") or []
        squad: List[Dict[str, Any]] = []
        for a in athletes:
            nm = str(a.get("displayName") or a.get("fullName") or "").strip()
            if not nm:
                continue
            pos = str((a.get("position") or {}).get("abbreviation") or "").strip()
            st = extract_athlete_stats(a)
            squad.append(
                {
                    "id": str(a.get("id") or ""),
                    "number": str(a.get("jersey") or "-"),
                    "position": pos,
                    "name": nm,
                    "appearances": int(round(st["appearances"])),
                    "totalShots": int(round(st["totalShots"])),
                    "shotsOnTarget": int(round(st["shotsOnTarget"])),
                    "totalGoals": int(round(st["totalGoals"])),
                    "goalAssists": int(round(st["goalAssists"])),
                }
            )
        return squad

    squad = parse_roster(slug)
    total_shots_sum = sum(p.get("totalShots", 0) for p in squad)

    if total_shots_sum == 0 and slug in ("arg.copa", "arg.supercopa"):
        fallback = parse_roster("arg.1")
        if sum(p.get("totalShots", 0) for p in fallback) > 0:
            squad = fallback

    with _ROSTER_LOCK:
        _ROSTER_CACHE[key] = squad
    return squad


def is_goalkeeper(pos: str) -> bool:
    p = (pos or "").upper().strip()
    if p in GOALKEEPER_CODES:
        return True
    return p.startswith("GK") or "GOALKEEP" in p or "ARQUERO" in p


def position_bonus(pos: str) -> float:
    p = (pos or "").upper().strip()
    if p in FORWARD_CODES or p.startswith(("ST", "CF", "LW", "RW", "LF", "RF", "F-")):
        return 0.55
    if p in ATT_MID_CODES or p.startswith(("AM", "CAM")):
        return 0.22
    if p in DEFENDER_CODES or p.startswith(("CD", "CB", "LB", "RB", "D-")):
        return -0.85
    return 0.0


def compute_top_shooters(
    squad: List[Dict[str, Any]],
    team_label: str,
    team_lam: float,
    lineup_confirmed: bool,
    limit: int = 3,
) -> List[Dict[str, Any]]:
    if not squad:
        return []

    candidates: List[Tuple[int, float, Dict[str, Any]]] = []
    scale = max(0.78, min(1.32, team_lam / 1.35))

    for p in squad:
        pos = str(p.get("position") or "").strip()
        if is_goalkeeper(pos):
            continue

        app = float(p.get("appearances") or 0.0)
        tot_shots = float(p.get("totalShots") or 0.0)
        sot = float(p.get("shotsOnTarget") or 0.0)
        goals = float(p.get("totalGoals") or 0.0)
        starter = bool(p.get("starter"))
        in_match_squad = bool(p.get("inMatchSquad"))

        shots_pg = round(tot_shots / app, 2) if app >= 1.0 else 0.0
        sot_pg = round(sot / app, 2) if app >= 1.0 else 0.0

        adj_shots_pg = (tot_shots + 0.65) / (app + 2.5)
        adj_sot_pg = (sot + 0.22) / (app + 2.5)
        adj_goals_pg = (goals + 0.12) / (app + 3.0)

        p_bonus = position_bonus(pos)
        reg_bonus = min(0.55, app * 0.04)

        avail_bonus = 0.0
        if lineup_confirmed:
            if starter:
                avail_bonus = 2.6
            elif in_match_squad:
                avail_bonus = -1.6
            else:
                avail_bonus = -4.5

        role_factor = 1.06 if (starter or not lineup_confirmed) else 0.36
        score = (
            (adj_sot_pg * 3.4 + adj_shots_pg * 1.5 + adj_goals_pg * 1.8) * (1.0 if (starter or not lineup_confirmed) else 0.45)
            + p_bonus
            + reg_bonus
            + avail_bonus
        )

        exp_sot = max(0.08, adj_sot_pg * scale * role_factor)
        exp_shots = max(0.20, adj_shots_pg * scale * role_factor)
        prob_1plus_sot = min(0.91, max(0.08, 1.0 - math.exp(-exp_sot)))
        prob_2plus_shots = min(0.92, max(0.08, 1.0 - math.exp(-exp_shots) * (1.0 + exp_shots)))

        tier = 2 if (tot_shots > 0 or starter) else 1 if app > 0 else 0
        candidates.append(
            (
                tier,
                score,
                {
                    "name": p["name"],
                    "team": team_label,
                    "position": pos or "-",
                    "number": str(p.get("number") or "-"),
                    "starter": starter,
                    "appearances": int(app),
                    "totalShots": int(tot_shots),
                    "shotsOnTarget": int(sot),
                    "goals": int(goals),
                    "shotsPerGame": shots_pg,
                    "sotPerGame": sot_pg,
                    "prob1PlusSot": round(prob_1plus_sot, 3),
                    "prob2PlusShots": round(prob_2plus_shots, 3),
                    "shotScore": round(score, 2),
                    "propLabel": f"1+ al Arco ({round(prob_1plus_sot * 100)}%)",
                },
            )
        )

    candidates.sort(key=lambda item: (item[0], item[1]), reverse=True)
    return [c[2] for c in candidates[:limit]]


def fetch_espn_scoreboard(league: Dict[str, str], now_utc: datetime) -> List[Dict[str, Any]]:
    url = f"{ESPN_BASE}/{league['slug']}/scoreboard"
    data = fetch_json(url, timeout=7)
    if not data:
        return []
    out: List[Dict[str, Any]] = []
    cutoff_past = now_utc - timedelta(days=10)
    cutoff_future = now_utc + timedelta(days=28)

    for ev in data.get("events") or []:
        comp = (ev.get("competitions") or [{}])[0]
        competitors = comp.get("competitors") or []
        home_c = next((c for c in competitors if c.get("homeAway") == "home"), competitors[0] if len(competitors) > 0 else None)
        away_c = next((c for c in competitors if c.get("homeAway") == "away"), competitors[1] if len(competitors) > 1 else None)
        if not home_c or not away_c:
            continue

        st_type = (ev.get("status") or {}).get("type") or {}
        state = str(st_type.get("state") or "pre").lower()
        completed = bool(st_type.get("completed"))
        if state == "post" or completed:
            status = "finished"
        elif state == "in":
            status = "live"
        else:
            status = "scheduled"

        ev_dt = parse_utc_dt(str(ev.get("date") or ""))
        # Exclude stale off-season finals (>10 days old) from tournaments not currently in season
        if status == "finished" and ev_dt is not None and ev_dt < cutoff_past:
            continue
        if status == "scheduled" and ev_dt is not None and ev_dt > cutoff_future:
            continue

        out.append({"league": league, "event": ev, "comp": comp, "home_c": home_c, "away_c": away_c, "status": status})
    return out


def fetch_espn_summary_and_roster(slug: str, event_id: str, home_id: str, away_id: str) -> Dict[str, Any]:
    sum_url = f"{ESPN_BASE}/{slug}/summary?event={urllib.parse.quote(event_id)}"
    sum_data = fetch_json(sum_url, timeout=7) or {}

    home_season = fetch_team_roster_cached(slug, home_id)
    away_season = fetch_team_roster_cached(slug, away_id)

    def build_merged_squad(side: str, season_list: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], bool]:
        by_id = {p["id"]: dict(p) for p in season_list if p.get("id")}
        by_name = {norm_name(p["name"]): dict(p) for p in season_list if p.get("name")}

        match_roster: List[Dict[str, Any]] = []
        starter_count = 0
        for r in sum_data.get("rosters") or []:
            if str(r.get("homeAway", "")).lower() != side:
                continue
            for p in r.get("roster") or []:
                ath = p.get("athlete") or {}
                aid = str(ath.get("id") or "")
                nm = str(ath.get("displayName") or ath.get("fullName") or "").strip()
                if not nm:
                    continue
                is_starter = bool(p.get("starter"))
                if is_starter:
                    starter_count += 1
                base = by_id.get(aid) or by_name.get(norm_name(nm)) or {}
                raw_pos = str((p.get("position") or {}).get("abbreviation") or "").strip()
                pos = str(base.get("position") or raw_pos) if raw_pos.upper() in ("", "SUB", "S") else raw_pos
                match_roster.append(
                    {
                        "id": aid or base.get("id") or "",
                        "number": str(p.get("jersey") or base.get("number") or "-"),
                        "position": pos,
                        "name": nm,
                        "starter": is_starter,
                        "inMatchSquad": True,
                        "appearances": base.get("appearances", 0),
                        "totalShots": base.get("totalShots", 0),
                        "shotsOnTarget": base.get("shotsOnTarget", 0),
                        "totalGoals": base.get("totalGoals", 0),
                        "goalAssists": base.get("goalAssists", 0),
                    }
                )

        if starter_count >= 7:
            seen_keys = {p.get("id") or norm_name(p["name"]) for p in match_roster}
            for sp in season_list:
                k = sp.get("id") or norm_name(sp["name"])
                if k not in seen_keys:
                    match_roster.append({**sp, "starter": False, "inMatchSquad": False})
            return match_roster[:36], True

        ranked_season = sorted(
            season_list,
            key=lambda x: (
                0 if is_goalkeeper(x.get("position", "")) else 1,
                x.get("shotsOnTarget", 0),
                x.get("totalShots", 0),
                x.get("appearances", 0),
            ),
            reverse=True,
        )
        return ranked_season[:36], False

    home_squad, home_confirmed = build_merged_squad("home", home_season)
    away_squad, away_confirmed = build_merged_squad("away", away_season)

    home_stats = None
    away_stats = None
    for bt in (sum_data.get("boxscore") or {}).get("teams") or []:
        if str(bt.get("homeAway", "")).lower() == "home":
            home_stats = bt.get("statistics") or []
        else:
            away_stats = bt.get("statistics") or []

    first_odds = ((sum_data.get("odds") or [None])[0]) or {}
    return {
        "home_squad": home_squad,
        "away_squad": away_squad,
        "home_confirmed": home_confirmed,
        "away_confirmed": away_confirmed,
        "lineup_confirmed": home_confirmed and away_confirmed,
        "home_corners": extract_boxscore_stat(home_stats, ["corner"]),
        "away_corners": extract_boxscore_stat(away_stats, ["corner"]),
        "home_sot": extract_boxscore_stat(home_stats, ["shots on target", "shotson"]),
        "away_sot": extract_boxscore_stat(away_stats, ["shots on target", "shotson"]),
        "home_yellow": extract_boxscore_stat(home_stats, ["yellow"]),
        "away_yellow": extract_boxscore_stat(away_stats, ["yellow"]),
        "odds_details": first_odds.get("details"),
        "over_under": first_odds.get("overUnder"),
    }


def main() -> None:
    init_and_migrate_db(DB_PATH)
    now_utc = datetime.now(timezone.utc)

    raw_items: List[Dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=10) as pool:
        futs = [pool.submit(fetch_espn_scoreboard, lg, now_utc) for lg in TARGET_LEAGUES]
        for fut in as_completed(futs):
            raw_items.extend(fut.result())

    by_id: Dict[str, Dict[str, Any]] = {}
    for item in raw_items:
        eid = str(item["event"].get("id") or "")
        if eid and eid not in by_id:
            by_id[eid] = item
    items = list(by_id.values())

    prio = {"live": 0, "scheduled": 1, "finished": 2}
    items.sort(key=lambda x: (prio[x["status"]], x["event"].get("date", "")))
    enrich_targets = items[:85]

    details_by_eid: Dict[str, Dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=10) as pool:
        fut_map = {}
        for it in enrich_targets:
            eid = str(it["event"].get("id"))
            slug = it["league"]["slug"]
            hid = str((it["home_c"].get("team") or {}).get("id") or "")
            aid = str((it["away_c"].get("team") or {}).get("id") or "")
            fut_map[pool.submit(fetch_espn_summary_and_roster, slug, eid, hid, aid)] = eid
        for fut in as_completed(fut_map):
            eid = fut_map[fut]
            try:
                details_by_eid[eid] = fut.result()
            except Exception:
                pass

    new_history_rows = 0
    matches_out: List[Dict[str, Any]] = []

    with sqlite3.connect(DB_PATH) as conn:
        xg_index = load_xg_index(conn)

        for it in items:
            ev = it["event"]
            comp = it["comp"]
            lg = it["league"]
            hc = it["home_c"]
            ac = it["away_c"]
            eid = str(ev.get("id") or "")
            ht = hc.get("team") or {}
            at = ac.get("team") or {}
            h_name = str(ht.get("displayName") or ht.get("name") or "Local")
            a_name = str(at.get("displayName") or at.get("name") or "Visitante")
            h_short = str(ht.get("shortDisplayName") or ht.get("abbreviation") or h_name[:12])
            a_short = str(at.get("shortDisplayName") or at.get("abbreviation") or a_name[:12])
            h_id = str(ht.get("id") or "")
            a_id = str(at.get("id") or "")
            h_crest = str(ht.get("logo") or "")
            a_crest = str(at.get("logo") or "")
            h_score_str = str(hc.get("score") or "0")
            a_score_str = str(ac.get("score") or "0")
            det = details_by_eid.get(eid, {})

            if it["status"] == "finished":
                try:
                    hs = int(float(h_score_str))
                    aws = int(float(a_score_str))
                except Exception:
                    hs, aws = 0, 0
                exists = conn.execute("SELECT 1 FROM match_history_log WHERE event_id = ?", (eid,)).fetchone()
                if not exists:
                    conn.execute(
                        """
                        INSERT OR IGNORE INTO match_history_log
                        (event_id, league_slug, league_name, match_date_utc, home_team, away_team, home_score, away_score,
                         home_corners, away_corners, home_shots_on_target, away_shots_on_target, home_yellow_cards, away_yellow_cards, venue)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            eid,
                            lg["slug"],
                            lg["name"],
                            str(ev.get("date") or ""),
                            h_name,
                            a_name,
                            hs,
                            aws,
                            det.get("home_corners"),
                            det.get("away_corners"),
                            det.get("home_sot"),
                            det.get("away_sot"),
                            det.get("home_yellow"),
                            det.get("away_yellow"),
                            str((comp.get("venue") or {}).get("fullName") or ""),
                        ),
                    )
                    new_history_rows += 1
                    for t_name, gf, ga in [(h_name, hs, aws), (a_name, aws, hs)]:
                        cur_xg, cur_xga, _ = lookup_team_xg(t_name, xg_index)
                        new_xg = round(0.85 * cur_xg + 0.15 * float(gf), 2)
                        new_xga = round(0.85 * cur_xga + 0.15 * float(ga), 2)
                        key_db = t_name.lower().strip()
                        conn.execute(
                            """
                            INSERT INTO cache_xg (equipo, xg, xga, actualizado_en)
                            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                            ON CONFLICT(equipo) DO UPDATE SET xg = excluded.xg, xga = excluded.xga, actualizado_en = CURRENT_TIMESTAMP
                            """,
                            (key_db, new_xg, new_xga),
                        )

            for tid, tname, tcrest, tsquad in [
                (h_id, h_name, h_crest, det.get("home_squad")),
                (a_id, a_name, a_crest, det.get("away_squad")),
            ]:
                if tid and tsquad:
                    conn.execute(
                        """
                        INSERT INTO team_rosters (team_id, team_name, league_slug, crest_url, roster_json, updated_at)
                        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                        ON CONFLICT(team_id, league_slug) DO UPDATE SET
                            team_name = excluded.team_name,
                            crest_url = excluded.crest_url,
                            roster_json = excluded.roster_json,
                            updated_at = CURRENT_TIMESTAMP
                        """,
                        (tid, tname, lg["slug"], tcrest, json.dumps(tsquad, ensure_ascii=False)),
                    )

            h_xg, h_xga, h_src = lookup_team_xg(h_name, xg_index)
            a_xg, a_xga, a_src = lookup_team_xg(a_name, xg_index)
            lam_home = round(max(0.45, min(3.4, (h_xg * 0.58 + a_xga * 0.42) * 1.08)), 2)
            lam_away = round(max(0.35, min(3.1, (a_xg * 0.58 + h_xga * 0.42) * 0.94)), 2)
            markets = compute_poisson_markets(lam_home, lam_away)

            if markets["prob1X"] >= markets["probX2"]:
                dc_pick = f"Doble Oportunidad: {h_name} o Empate (1X)"
                dc_prob = markets["prob1X"]
            else:
                dc_pick = f"Doble Oportunidad: Empate o {a_name} (X2)"
                dc_prob = markets["probX2"]
            dc_odds = round(max(1.12, min(3.2, 0.94 / max(0.2, dc_prob))), 2)

            expected_corners = round(7.2 + 1.15 * (lam_home + lam_away), 1)
            corners_pick = "Más de 8.5 Córners" if expected_corners >= 9.6 else "Más de 7.5 Córners"
            expected_cards = round(3.4 + 0.55 * abs(lam_home - lam_away) + 0.45 * (lam_home + lam_away), 1)
            cards_pick = "Más de 3.5 Tarjetas" if expected_cards >= 4.4 else "Menos de 5.5 Tarjetas"
            goals_pick = (
                f"Más de 2.5 Goles ({round(markets['probOver25']*100)}%)"
                if markets["probOver25"] >= 0.54
                else f"Más de 1.5 Goles ({round(markets['probOver15']*100)}%)"
            )

            home_top_shooters = compute_top_shooters(
                det.get("home_squad") or [], h_short, lam_home, bool(det.get("home_confirmed")), limit=3
            )
            away_top_shooters = compute_top_shooters(
                det.get("away_squad") or [], a_short, lam_away, bool(det.get("away_confirmed")), limit=3
            )

            def fmt_shooter_lead(s: Dict[str, Any]) -> str:
                if s.get("totalShots", 0) > 0 and s.get("appearances", 0) > 0:
                    return f"{s['name']} ({s['team']}, {s['shotsPerGame']} rem/pj · {round(s['prob1PlusSot']*100)}% prob. 1+ arco)"
                return f"{s['name']} ({s['team']}, {s['position']} · {round(s['prob1PlusSot']*100)}% prob. 1+ arco)"

            lead_parts = []
            if home_top_shooters:
                lead_parts.append(fmt_shooter_lead(home_top_shooters[0]))
            if away_top_shooters:
                lead_parts.append(fmt_shooter_lead(away_top_shooters[0]))
            top_shooter_text = " / ".join(lead_parts) if lead_parts else "Ver rematadores en Alineación y Plantel"

            matches_out.append(
                {
                    "id": eid,
                    "leagueSlug": lg["slug"],
                    "league": lg["name"],
                    "leagueGroup": lg.get("group", "other"),
                    "dateUtc": str(ev.get("date") or ""),
                    "date": to_arg_time(str(ev.get("date") or "")),
                    "status": it["status"],
                    "statusText": str((ev.get("status") or {}).get("type", {}).get("shortDetail") or it["status"]),
                    "venue": str((comp.get("venue") or {}).get("fullName") or ""),
                    "home": h_name,
                    "away": a_name,
                    "homeId": h_id,
                    "awayId": a_id,
                    "homeCrest": h_crest,
                    "awayCrest": a_crest,
                    "homeScore": h_score_str,
                    "awayScore": a_score_str,
                    "homeForm": str(hc.get("form") or ""),
                    "awayForm": str(ac.get("form") or ""),
                    "lineupConfirmed": bool(det.get("lineup_confirmed")),
                    "homeSquad": det.get("home_squad") or [],
                    "awaySquad": det.get("away_squad") or [],
                    "topShooters": {
                        "home": home_top_shooters,
                        "away": away_top_shooters,
                    },
                    "xgModel": {
                        "homeXg": h_xg,
                        "awayXg": a_xg,
                        "lambdaHome": lam_home,
                        "lambdaAway": lam_away,
                        "sources": [h_src, a_src],
                    },
                    "prediction": dc_pick,
                    "probability": f"{round(dc_prob * 100)}%",
                    "odds": str(dc_odds),
                    "goals": goals_pick,
                    "corners": f"{corners_pick} (esp. {expected_corners})",
                    "cards": f"{cards_pick} (esp. {expected_cards})",
                    "shots": f"Remates al arco esp.: {round(3.1 * (lam_home + lam_away), 1)}",
                    "topShooter": top_shooter_text,
                    "likelyScore": markets["likelyScore"],
                    "markets": markets,
                    "marketOdds": det.get("odds_details"),
                    "overUnderLine": det.get("over_under"),
                    "analysis": f"Modelo Poisson + historial ({h_src} / {a_src}). Marcador probable {markets['likelyScore']}.",
                }
            )

        conn.commit()
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE);")
        total_cache_teams = conn.execute("SELECT COUNT(*) FROM cache_xg").fetchone()[0]
        total_hist_rows = conn.execute("SELECT COUNT(*) FROM historial_equipos").fetchone()[0]
        total_logged_matches = conn.execute("SELECT COUNT(*) FROM match_history_log").fetchone()[0]
        total_rosters = conn.execute("SELECT COUNT(*) FROM team_rosters").fetchone()[0]

        hist_sample = [
            {
                "event_id": r[0],
                "league": r[1],
                "date": to_arg_time(r[2]),
                "home": r[3],
                "away": r[4],
                "score": f"{r[5]} - {r[6]}",
                "corners": f"{r[7] or '-'} / {r[8] or '-'}",
            }
            for r in conn.execute(
                "SELECT event_id, league_name, match_date_utc, home_team, away_team, home_score, away_score, home_corners, away_corners "
                "FROM match_history_log ORDER BY match_date_utc DESC LIMIT 60"
            )
        ]

        roster_export = []
        for r in conn.execute(
            "SELECT team_id, team_name, league_slug, crest_url, roster_json, updated_at FROM team_rosters ORDER BY updated_at DESC LIMIT 120"
        ):
            try:
                roster_export.append(
                    {
                        "teamId": r[0],
                        "teamName": r[1],
                        "leagueSlug": r[2],
                        "crestUrl": r[3],
                        "players": json.loads(r[4]),
                        "updatedAt": r[5],
                    }
                )
            except Exception:
                pass

    status_counts = {
        "live": sum(1 for m in matches_out if m["status"] == "live"),
        "scheduled": sum(1 for m in matches_out if m["status"] == "scheduled"),
        "finished": sum(1 for m in matches_out if m["status"] == "finished"),
    }

    payload = {
        "engineVersion": "3.3.0-ALL-UEFA-NAT-ARG2-BRA",
        "lastUpdated": datetime.now(timezone(timedelta(hours=-3))).strftime("%d/%m/%Y %H:%M ART"),
        "statusCounts": status_counts,
        "dbStats": {
            "teamsInXgCache": total_cache_teams,
            "seasonHistoryRows": total_hist_rows,
            "liveMatchesLogged": total_logged_matches,
            "newMatchesIngestedThisRun": new_history_rows,
            "teamRostersCached": total_rosters,
        },
        "leagues": TARGET_LEAGUES,
        "matches": matches_out,
    }

    os.makedirs(os.path.dirname(OUTPUT_JSON_PATH) or ".", exist_ok=True)
    for target_path in [OUTPUT_JSON_PATH, LEGACY_OUTPUT_PATH]:
        with open(target_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, ensure_ascii=False)

    with open(TEAMS_HISTORY_PATH, "w", encoding="utf-8") as f:
        json.dump(
            {
                "lastUpdated": payload["lastUpdated"],
                "dbStats": payload["dbStats"],
                "recentLoggedMatches": hist_sample,
                "rosters": roster_export,
            },
            f,
            indent=2,
            ensure_ascii=False,
        )

    lines = [
        "# Football Intelligence Pro — Reporte en Vivo (UEFA, Selecciones, Primera Nacional, Brasil y Ligas)",
        "",
        f"- **Última ejecución:** {payload['lastUpdated']}",
        f"- **En vivo ahora:** {status_counts['live']} | **Próximos:** {status_counts['scheduled']} | **Recién finalizados:** {status_counts['finished']}",
        f"- **Equipos en BD histórica (`quant_master.db`):** {total_cache_teams}",
        f"- **Partidos reales acumulados:** {total_logged_matches} (+{new_history_rows} nuevos en esta ejecución)",
        f"- **Planteles actualizados en caché:** {total_rosters}",
        "",
        "| Liga | Fecha (ART) | Partido | Estado | Pick Doble Oportunidad | Prob | Top Rematadores |",
        "|---|---|---|---|---|---|---|",
    ]
    for m in matches_out[:35]:
        lines.append(
            f"| {m['league']} | {m['date']} | {m['home']} ({m['homeScore']}) vs ({m['awayScore']}) {m['away']} | {m['statusText']} | {m['prediction']} | {m['probability']} | {m['topShooter']} |"
        )
    with open(REPORT_MD_PATH, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    print(
        json.dumps(
            {
                "ok": True,
                "matches": len(matches_out),
                "statusCounts": status_counts,
                "newHistoryRows": new_history_rows,
                "totalLoggedMatches": total_logged_matches,
                "totalRosters": total_rosters,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
