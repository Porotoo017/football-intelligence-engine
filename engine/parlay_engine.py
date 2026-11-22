import json
import math
import os
import re
import sqlite3
import unicodedata
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

DB_PATH = os.getenv("QUANT_DB_PATH", "data/quant_master.db")
OUTPUT_JSON_PATH = os.getenv("OUTPUT_JSON_PATH", "data/parlay_engine_output.json")
LEGACY_OUTPUT_PATH = "parlay_engine_output.json"
TEAMS_HISTORY_PATH = os.getenv("TEAMS_HISTORY_PATH", "data/teams_history.json")
REPORT_MD_PATH = "REPORT_ACTUAL.md"

ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
    "Accept": "application/json",
}

TARGET_LEAGUES = [
    {"slug": "arg.1", "name": "Liga Profesional Argentina", "country": "Argentina"},
    {"slug": "arg.copa", "name": "Copa Argentina", "country": "Argentina"},
    {"slug": "esp.1", "name": "LaLiga (España)", "country": "España"},
    {"slug": "ita.1", "name": "Serie A (Italia)", "country": "Italia"},
    {"slug": "ger.1", "name": "Bundesliga (Alemania)", "country": "Alemania"},
    {"slug": "ned.1", "name": "Eredivisie (Países Bajos)", "country": "Países Bajos"},
    {"slug": "fra.1", "name": "Ligue 1 (Francia)", "country": "Francia"},
    {"slug": "conmebol.libertadores", "name": "Copa Libertadores", "country": "Sudamérica"},
    {"slug": "conmebol.sudamericana", "name": "Copa Sudamericana", "country": "Sudamérica"},
    {"slug": "uefa.champions", "name": "UEFA Champions League", "country": "Europa"},
]

GENERIC_TOKENS = {"club", "atletico", "racing", "real", "sporting", "inter", "union", "san", "santa", "villa", "deportivo", "olympique", "paris", "dinamo"}


def fetch_json(url: str, headers: Optional[Dict[str, str]] = None, timeout: int = 10) -> Optional[Dict[str, Any]]:
    req = urllib.request.Request(url, headers=headers or HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if resp.status != 200:
                return None
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None


def norm_name(name: str) -> str:
    s = unicodedata.normalize("NFD", (name or "").lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = re.sub(r"\b(c\.a\.|f\.c\.|c\.f\.|club|ca|cf|fc|sc|ac|cd|ud|rcd|sd|de|la|el|los|las|del)\b", " ", s)
    s = re.sub(r"\b[cd]\b$", "", s)
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


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


def fetch_espn_scoreboard(league: Dict[str, str]) -> List[Dict[str, Any]]:
    url = f"{ESPN_BASE}/{league['slug']}/scoreboard"
    data = fetch_json(url)
    if not data:
        return []
    out: List[Dict[str, Any]] = []
    for ev in data.get("events") or []:
        comp = (ev.get("competitions") or [{}])[0]
        competitors = comp.get("competitors") or []
        home_c = next((c for c in competitors if c.get("homeAway") == "home"), competitors[0] if len(competitors) > 0 else None)
        away_c = next((c for c in competitors if c.get("homeAway") == "away"), competitors[1] if len(competitors) > 1 else None)
        if not home_c or not away_c:
            continue
        state = str((ev.get("status") or {}).get("type", {}).get("state", "pre")).lower()
        status = "live" if state == "in" else "finished" if state == "post" else "scheduled"
        out.append({"league": league, "event": ev, "comp": comp, "home_c": home_c, "away_c": away_c, "status": status})
    return out


def fetch_espn_summary_and_roster(slug: str, event_id: str, home_id: str, away_id: str) -> Dict[str, Any]:
    sum_url = f"{ESPN_BASE}/{slug}/summary?event={urllib.parse.quote(event_id)}"
    sum_data = fetch_json(sum_url, timeout=8) or {}

    home_starters: List[Dict[str, str]] = []
    away_starters: List[Dict[str, str]] = []
    for r in sum_data.get("rosters") or []:
        is_home = str(r.get("homeAway", "")).lower() == "home"
        players = []
        for p in r.get("roster") or []:
            if p.get("starter"):
                ath = p.get("athlete") or {}
                name = str(ath.get("displayName") or ath.get("fullName") or "").strip()
                if name:
                    players.append({
                        "number": str(p.get("jersey") or "-"),
                        "position": str((p.get("position") or {}).get("abbreviation") or ""),
                        "name": name,
                    })
        if is_home:
            home_starters = players
        else:
            away_starters = players

    def fetch_squad_list(tid: str) -> List[Dict[str, str]]:
        if not tid:
            return []
        rdata = fetch_json(f"{ESPN_BASE}/{slug}/teams/{urllib.parse.quote(tid)}/roster", timeout=7)
        athletes = (rdata or {}).get("athletes") or []
        squad = []
        for a in athletes[:25]:
            nm = str(a.get("displayName") or a.get("fullName") or "").strip()
            if nm:
                squad.append({
                    "number": str(a.get("jersey") or "-"),
                    "position": str((a.get("position") or {}).get("abbreviation") or ""),
                    "name": nm,
                })
        return squad

    home_squad = home_starters if len(home_starters) >= 7 else fetch_squad_list(home_id)
    away_squad = away_starters if len(away_starters) >= 7 else fetch_squad_list(away_id)

    home_stats = None
    away_stats = None
    for bt in (sum_data.get("boxscore") or {}).get("teams") or []:
        if str(bt.get("homeAway", "")).lower() == "home":
            home_stats = bt.get("statistics") or []
        else:
            away_stats = bt.get("statistics") or []

    first_odds = ((sum_data.get("odds") or [None])[0]) or {}
    return {
        "home_starters": home_starters,
        "away_starters": away_starters,
        "home_squad": home_squad,
        "away_squad": away_squad,
        "lineup_confirmed": len(home_starters) >= 7 and len(away_starters) >= 7,
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

    raw_items: List[Dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=6) as pool:
        futs = [pool.submit(fetch_espn_scoreboard, lg) for lg in TARGET_LEAGUES]
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
    enrich_targets = items[:40]

    details_by_eid: Dict[str, Dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=6) as pool:
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

            def pick_shooters(squad: List[Dict[str, str]], team_lbl: str) -> List[str]:
                if not squad:
                    return []
                fw = [p["name"] for p in squad if p.get("position", "").upper() in ("F", "FW", "ST", "CF", "LW", "RW", "DEL")]
                mf = [p["name"] for p in squad if p.get("position", "").upper() in ("M", "MF", "AM", "CM", "LM", "RM", "MED")]
                chosen = (fw[:2] + mf[:1]) or [p["name"] for p in squad[:2]]
                return [f"{name} ({team_lbl})" for name in chosen[:2]]

            shooters = pick_shooters(det.get("home_squad") or [], h_name)[:1] + pick_shooters(det.get("away_squad") or [], a_name)[:1]
            top_shooter_text = " / ".join(shooters) if shooters else "Titulares confirmados al publicar planilla"

            matches_out.append(
                {
                    "id": eid,
                    "leagueSlug": lg["slug"],
                    "league": lg["name"],
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
                "FROM match_history_log ORDER BY match_date_utc DESC LIMIT 40"
            )
        ]

        roster_export = []
        for r in conn.execute(
            "SELECT team_id, team_name, league_slug, crest_url, roster_json, updated_at FROM team_rosters ORDER BY updated_at DESC LIMIT 80"
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

    payload = {
        "engineVersion": "3.0.0-LIVE-10LEAGUES",
        "lastUpdated": datetime.now(timezone(timedelta(hours=-3))).strftime("%d/%m/%Y %H:%M ART"),
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
        "# Football Intelligence Pro — Reporte en Vivo (10 Ligas)",
        "",
        f"- **Última ejecución:** {payload['lastUpdated']}",
        f"- **Equipos en BD histórica (`quant_master.db`):** {total_cache_teams}",
        f"- **Registros por temporada:** {total_hist_rows}",
        f"- **Partidos reales acumulados:** {total_logged_matches} (+{new_history_rows} nuevos en esta ejecución)",
        f"- **Planteles actualizados en caché:** {total_rosters}",
        f"- **Partidos activos/próximos/recientes cargados:** {len(matches_out)}",
        "",
        "| Liga | Fecha (ART) | Partido | Estado | Pick Doble Oportunidad | Prob | Cuota |",
        "|---|---|---|---|---|---|---|",
    ]
    for m in matches_out[:25]:
        lines.append(
            f"| {m['league']} | {m['date']} | {m['home']} ({m['homeScore']}) vs ({m['awayScore']}) {m['away']} | {m['statusText']} | {m['prediction']} | {m['probability']} | {m['odds']} |"
        )
    with open(REPORT_MD_PATH, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    print(
        f"[OK] {len(matches_out)} matches exported across {len(TARGET_LEAGUES)} leagues. "
        f"DB: teams={total_cache_teams}, hist={total_hist_rows}, liveLogged={total_logged_matches} (+{new_history_rows}), rosters={total_rosters}"
    )


if __name__ == "__main__":
    main()
