(function () {
  const TARGET_LEAGUES = [
    // Argentina (incl. Primera Nacional)
    { slug: 'arg.1', name: 'Liga Argentina', group: 'arg' },
    { slug: 'arg.2', name: 'Primera Nacional', group: 'arg' },
    { slug: 'arg.copa', name: 'Copa Argentina', group: 'arg' },
    { slug: 'arg.supercopa', name: 'Supercopa Arg.', group: 'arg' },
    // Brasil
    { slug: 'bra.1', name: 'Brasileirão A', group: 'bra' },
    { slug: 'bra.2', name: 'Brasileirão B', group: 'bra' },
    // Todos los campeonatos UEFA
    { slug: 'uefa.champions', name: 'Champions UEFA', group: 'uefa' },
    { slug: 'uefa.europa', name: 'Europa League', group: 'uefa' },
    { slug: 'uefa.europa.conf', name: 'Conference League', group: 'uefa' },
    { slug: 'uefa.nations', name: 'UEFA Nations League', group: 'uefa_nat' },
    { slug: 'uefa.euro', name: 'UEFA Eurocopa', group: 'uefa_nat' },
    { slug: 'uefa.euroq', name: 'Elim. Euro UEFA', group: 'uefa_nat' },
    { slug: 'uefa.super_cup', name: 'UEFA Super Cup', group: 'uefa' },
    { slug: 'uefa.wchampions', name: 'UEFA Champions Fem.', group: 'uefa' },
    // Selecciones Nacionales
    { slug: 'fifa.friendly', name: 'Amistosos FIFA', group: 'nat' },
    { slug: 'fifa.world', name: 'Mundial FIFA', group: 'nat' },
    { slug: 'fifa.worldq.conmebol', name: 'Elim. CONMEBOL', group: 'nat' },
    { slug: 'fifa.worldq.uefa', name: 'Elim. Mundial UEFA', group: 'uefa_nat' },
    { slug: 'fifa.worldq.concacaf', name: 'Elim. Concacaf', group: 'nat' },
    { slug: 'fifa.worldq.afc', name: 'Elim. Asia AFC', group: 'nat' },
    { slug: 'fifa.worldq.caf', name: 'Elim. África CAF', group: 'nat' },
    { slug: 'fifa.worldq.ofc', name: 'Elim. Oceanía OFC', group: 'nat' },
    { slug: 'conmebol.america', name: 'Copa América', group: 'nat' },
    { slug: 'concacaf.nations.league', name: 'Concacaf Nations', group: 'nat' },
    { slug: 'concacaf.gold', name: 'Concacaf Gold Cup', group: 'nat' },
    { slug: 'caf.nations', name: 'Copa Africana', group: 'nat' },
    // Sudamérica Clubes + Europa Doméstica
    { slug: 'conmebol.libertadores', name: 'Libertadores', group: 'conmebol' },
    { slug: 'conmebol.sudamericana', name: 'Sudamericana', group: 'conmebol' },
    { slug: 'conmebol.recopa', name: 'Recopa CONMEBOL', group: 'conmebol' },
    { slug: 'esp.1', name: 'LaLiga', group: 'euro_dom' },
    { slug: 'ita.1', name: 'Serie A', group: 'euro_dom' },
    { slug: 'ger.1', name: 'Bundesliga', group: 'euro_dom' },
    { slug: 'ned.1', name: 'Eredivisie', group: 'euro_dom' },
    { slug: 'fra.1', name: 'Ligue 1', group: 'euro_dom' },
    { slug: 'eng.1', name: 'Premier League', group: 'euro_dom' },
  ];

  const GROUP_BY_SLUG = new Map(TARGET_LEAGUES.map((l) => [l.slug, l.group]));

  const state = {
    activeTab: 'matches',
    selectedLeague: 'all',
    selectedStatus: 'all',
    selectedRosterLeague: 'all',
    rosterShowAll: false,
    matches: [],
    rosters: [],
    historyLog: [],
    dbStats: null,
    lastUpdated: '--',
    parlayLegs: [],
    deferredPrompt: null,
  };

  function escHtml(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normName(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function formatArgDate(iso) {
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return iso || '';
      return (
        new Intl.DateTimeFormat('es-AR', {
          timeZone: 'America/Argentina/Buenos_Aires',
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).format(d) + ' ART'
      );
    } catch {
      return iso || '';
    }
  }

  function factorial(n) {
    let f = 1;
    for (let i = 2; i <= n; i++) f *= i;
    return f;
  }

  function poissonPmf(k, lam) {
    const l = Math.max(0.05, Math.min(lam, 6));
    return (Math.pow(l, k) * Math.exp(-l)) / factorial(k);
  }

  function computeQuickMarkets(lamH, lamA) {
    let pH = 0, pD = 0, pA = 0, pO15 = 0, pO25 = 0;
    let bestScore = '1-1', bestP = -1;
    for (let h = 0; h <= 5; h++) {
      for (let a = 0; a <= 5; a++) {
        const p = poissonPmf(h, lamH) * poissonPmf(a, lamA);
        if (p > bestP) { bestP = p; bestScore = h + '-' + a; }
        if (h > a) pH += p; else if (h === a) pD += p; else pA += p;
        if (h + a >= 2) pO15 += p;
        if (h + a >= 3) pO25 += p;
      }
    }
    const tot = Math.max(1e-9, pH + pD + pA);
    return {
      probHome: pH / tot,
      probDraw: pD / tot,
      probAway: pA / tot,
      prob1X: (pH + pD) / tot,
      probX2: (pD + pA) / tot,
      probOver15: pO15 / tot,
      probOver25: pO25 / tot,
      likelyScore: bestScore,
    };
  }

  function extractEspnAthleteStats(a) {
    const out = { appearances: 0, totalShots: 0, shotsOnTarget: 0, totalGoals: 0, goalAssists: 0 };
    const cats = (a && a.statistics && a.statistics.splits && a.statistics.splits.categories) || [];
    let starts = 0, subs = 0;
    cats.forEach((c) => {
      (c.stats || []).forEach((s) => {
        const nm = s && s.name;
        const val = Number((s && s.value) || 0) || 0;
        if (nm in out) out[nm] = val;
        if (nm === 'starts') starts = val;
        if (nm === 'subIns') subs = val;
      });
    });
    if (out.appearances <= 0 && starts + subs > 0) out.appearances = starts + subs;
    return out;
  }

  function isGoalkeeperPos(pos) {
    const p = String(pos || '').toUpperCase().trim();
    return p === 'G' || p === 'GK' || p === 'ARQ' || p === 'POR' || p.startsWith('GK') || p.includes('GOALKEEP');
  }

  function posWeightBonus(pos) {
    const p = String(pos || '').toUpperCase().trim();
    if (/^(F|FW|ST|CF|LF|RF|LW|RW|SS|DEL|F-|ST-|CF-)/.test(p)) return 0.55;
    if (/^(AM|CAM|LM|RM|W|MF-A)/.test(p)) return 0.22;
    if (/^(D|DF|CD|CB|LB|RB|LWB|RWB|DEF|D-)/.test(p)) return -0.85;
    return 0.0;
  }

  function computeTopShootersJS(squad, teamLabel, teamLam, lineupConfirmed, limit) {
    if (!Array.isArray(squad) || squad.length === 0) return [];
    const scale = Math.max(0.78, Math.min(1.32, (Number(teamLam) || 1.35) / 1.35));
    const scored = [];

    squad.forEach((p) => {
      const pos = String(p.position || '').trim();
      if (isGoalkeeperPos(pos)) return;
      const app = Number(p.appearances || 0);
      const totShots = Number(p.totalShots || 0);
      const sot = Number(p.shotsOnTarget || 0);
      const goals = Number(p.totalGoals || 0);
      const starter = Boolean(p.starter);
      const inMatch = Boolean(p.inMatchSquad);

      const shotsPg = app >= 1 ? Number((totShots / app).toFixed(2)) : 0;
      const sotPg = app >= 1 ? Number((sot / app).toFixed(2)) : 0;

      const adjShotsPg = (totShots + 0.65) / (app + 2.5);
      const adjSotPg = (sot + 0.22) / (app + 2.5);
      const adjGoalsPg = (goals + 0.12) / (app + 3.0);

      let availBonus = 0;
      if (lineupConfirmed) {
        availBonus = starter ? 2.6 : inMatch ? -1.6 : -4.5;
      }
      const roleFactor = starter || !lineupConfirmed ? 1.06 : 0.36;
      const scoreWeight = starter || !lineupConfirmed ? 1.0 : 0.45;
      const score =
        (adjSotPg * 3.4 + adjShotsPg * 1.5 + adjGoalsPg * 1.8) * scoreWeight +
        posWeightBonus(pos) +
        Math.min(0.55, app * 0.04) +
        availBonus;

      const expSot = Math.max(0.08, adjSotPg * scale * roleFactor);
      const prob1PlusSot = Math.min(0.91, Math.max(0.08, 1 - Math.exp(-expSot)));
      const tier = totShots > 0 || starter ? 2 : app > 0 ? 1 : 0;

      scored.push({
        tier,
        score,
        item: {
          name: p.name,
          team: teamLabel,
          position: pos || '-',
          number: String(p.number || '-'),
          starter,
          appearances: Math.round(app),
          totalShots: Math.round(totShots),
          shotsOnTarget: Math.round(sot),
          goals: Math.round(goals),
          shotsPerGame: shotsPg,
          sotPerGame: sotPg,
          prob1PlusSot: Number(prob1PlusSot.toFixed(3)),
          propLabel: '1+ al Arco (' + Math.round(prob1PlusSot * 100) + '%)',
        },
      });
    });

    scored.sort((a, b) => (b.tier - a.tier) || (b.score - a.score));
    return scored.slice(0, limit || 3).map((x) => x.item);
  }

  function setStatus(msg) {
    const el = document.getElementById('live-sync-status');
    if (el) el.textContent = msg;
  }

  function getStatusCounts(list) {
    let live = 0, scheduled = 0, finished = 0;
    (list || []).forEach((m) => {
      if (m.status === 'live') live++;
      else if (m.status === 'scheduled') scheduled++;
      else finished++;
    });
    return { live, scheduled, finished, total: live + scheduled + finished };
  }

  function updateAccurateStatusHeader() {
    const c = getStatusCounts(state.matches);
    setStatus('🔴 ' + c.live + ' en vivo · 🕒 ' + c.scheduled + ' próximos · ✅ ' + c.finished + ' fin.');
  }

  function matchesLeagueFilter(m, filterKey) {
    if (!filterKey || filterKey === 'all') return true;
    const grp = m.leagueGroup || GROUP_BY_SLUG.get(m.leagueSlug) || 'other';
    if (filterKey === 'group:nat') return grp === 'nat' || grp === 'uefa_nat';
    if (filterKey === 'group:uefa') return grp === 'uefa' || grp === 'uefa_nat';
    if (filterKey === 'group:arg') return grp === 'arg';
    if (filterKey === 'group:bra') return grp === 'bra';
    return m.leagueSlug === filterKey;
  }

  async function loadCachedBackendOutputs() {
    try {
      const ts = Date.now();
      const [outRes, histRes] = await Promise.all([
        fetch('./data/parlay_engine_output.json?t=' + ts, { cache: 'no-store' }),
        fetch('./data/teams_history.json?t=' + ts, { cache: 'no-store' }),
      ]);
      if (outRes.ok) {
        const out = await outRes.json();
        if (Array.isArray(out.matches)) state.matches = out.matches;
        if (out.dbStats) state.dbStats = out.dbStats;
        if (out.lastUpdated) state.lastUpdated = out.lastUpdated;
      }
      if (histRes.ok) {
        const hist = await histRes.json();
        if (Array.isArray(hist.rosters)) state.rosters = hist.rosters;
        if (Array.isArray(hist.recentLoggedMatches)) state.historyLog = hist.recentLoggedMatches;
        if (hist.dbStats) state.dbStats = hist.dbStats;
      }
      updateAccurateStatusHeader();
      renderAll();
    } catch {
      // ignore offline error, live ESPN fetch runs next
    }
  }

  async function refreshFromEspnLive() {
    setStatus('Actualizando UEFA, Selecciones y Ligas en tiempo real...');
    const btn = document.getElementById('refresh-live-btn');
    if (btn) btn.disabled = true;

    const existingById = new Map();
    state.matches.forEach((m) => existingById.set(String(m.id), m));

    const nowMs = Date.now();
    const cutoffPastMs = nowMs - 10 * 24 * 60 * 60 * 1000;
    const cutoffFutureMs = nowMs + 28 * 24 * 60 * 60 * 1000;

    const seenIds = new Set();
    const liveMatches = [];

    await Promise.all(
      TARGET_LEAGUES.map(async (lg) => {
        try {
          const res = await fetch('https://site.api.espn.com/apis/site/v2/sports/soccer/' + lg.slug + '/scoreboard', { cache: 'no-store' });
          if (!res.ok) return;
          const data = await res.json();
          const events = Array.isArray(data.events) ? data.events : [];
          events.forEach((ev) => {
            const eid = String(ev.id || '');
            if (!eid || seenIds.has(eid)) return;

            const comp = (ev.competitions && ev.competitions[0]) || {};
            const comps = comp.competitors || [];
            const hc = comps.find((c) => c.homeAway === 'home') || comps[0];
            const ac = comps.find((c) => c.homeAway === 'away') || comps[1];
            if (!hc || !ac) return;

            const stType = (ev.status && ev.status.type) || {};
            const rawState = String(stType.state || 'pre').toLowerCase();
            const completed = Boolean(stType.completed);
            const status = rawState === 'post' || completed ? 'finished' : rawState === 'in' ? 'live' : 'scheduled';

            const evMs = Date.parse(ev.date || '');
            if (status === 'finished' && isFinite(evMs) && evMs < cutoffPastMs) return;
            if (status === 'scheduled' && isFinite(evMs) && evMs > cutoffFutureMs) return;

            seenIds.add(eid);
            const prev = existingById.get(eid);

            if (prev) {
              liveMatches.push(
                Object.assign({}, prev, {
                  leagueSlug: lg.slug,
                  league: lg.name,
                  leagueGroup: lg.group,
                  status: status,
                  statusText: stType.shortDetail || status,
                  homeScore: String(hc.score != null ? hc.score : prev.homeScore || '0'),
                  awayScore: String(ac.score != null ? ac.score : prev.awayScore || '0'),
                  date: formatArgDate(ev.date),
                  dateUtc: ev.date || prev.dateUtc,
                })
              );
            } else {
              const hName = (hc.team && (hc.team.displayName || hc.team.name)) || 'Local';
              const aName = (ac.team && (ac.team.displayName || ac.team.name)) || 'Visitante';
              const mk = computeQuickMarkets(1.42, 1.15);
              const pick1X = mk.prob1X >= mk.probX2;
              const prob = pick1X ? mk.prob1X : mk.probX2;
              const odds = (0.94 / Math.max(0.2, prob)).toFixed(2);
              liveMatches.push({
                id: eid,
                leagueSlug: lg.slug,
                league: lg.name,
                leagueGroup: lg.group,
                dateUtc: ev.date || '',
                date: formatArgDate(ev.date),
                status: status,
                statusText: stType.shortDetail || status,
                venue: (comp.venue && comp.venue.fullName) || '',
                home: hName,
                away: aName,
                homeId: String((hc.team && hc.team.id) || ''),
                awayId: String((ac.team && ac.team.id) || ''),
                homeCrest: (hc.team && hc.team.logo) || '',
                awayCrest: (ac.team && ac.team.logo) || '',
                homeScore: String(hc.score != null ? hc.score : '0'),
                awayScore: String(ac.score != null ? ac.score : '0'),
                homeSquad: [],
                awaySquad: [],
                topShooters: { home: [], away: [] },
                prediction: pick1X ? 'Doble Oportunidad: ' + hName + ' o Empate (1X)' : 'Doble Oportunidad: Empate o ' + aName + ' (X2)',
                probability: Math.round(prob * 100) + '%',
                odds: odds,
                goals: mk.probOver25 >= 0.54 ? 'Más de 2.5 Goles (' + Math.round(mk.probOver25 * 100) + '%)' : 'Más de 1.5 Goles (' + Math.round(mk.probOver15 * 100) + '%)',
                corners: 'Más de 8.5 Córners',
                cards: 'Más de 3.5 Tarjetas',
                shots: 'Remates esp.: 8.0+',
                topShooter: 'Tocá Rematadores y Plantel para ranking en vivo',
                likelyScore: mk.likelyScore,
                markets: mk,
                analysis: 'Actualizado en tiempo real desde ESPN Public Soccer API.',
              });
            }
          });
        } catch {
          // ignore individual league fetch glitch
        }
      })
    );

    if (liveMatches.length > 0) {
      const weight = { live: 0, scheduled: 1, finished: 2 };
      liveMatches.sort((a, b) => (weight[a.status] - weight[b.status]) || String(a.dateUtc).localeCompare(String(b.dateUtc)));
      state.matches = liveMatches;
      state.lastUpdated = formatArgDate(new Date().toISOString());
    }
    updateAccurateStatusHeader();
    if (btn) btn.disabled = false;
    renderAll();
  }

  function renderChips() {
    const countsBySlug = new Map();
    state.matches.forEach((m) => {
      countsBySlug.set(m.leagueSlug, (countsBySlug.get(m.leagueSlug) || 0) + 1);
    });
    const natCount = state.matches.filter((m) => matchesLeagueFilter(m, 'group:nat')).length;
    const uefaCount = state.matches.filter((m) => matchesLeagueFilter(m, 'group:uefa')).length;
    const argCount = state.matches.filter((m) => matchesLeagueFilter(m, 'group:arg')).length;
    const braCount = state.matches.filter((m) => matchesLeagueFilter(m, 'group:bra')).length;

    const leagueChips = [
      { key: 'all', label: 'Todas (' + state.matches.length + ')' },
      { key: 'group:nat', label: '🌍 Selecciones (' + natCount + ')' },
      { key: 'group:uefa', label: '🏆 Toda UEFA (' + uefaCount + ')' },
      { key: 'group:arg', label: '🇦🇷 Arg + Nac. B (' + argCount + ')' },
      { key: 'group:bra', label: '🇧🇷 Brasil A/B (' + braCount + ')' },
    ];

    TARGET_LEAGUES.forEach((lg) => {
      const n = countsBySlug.get(lg.slug) || 0;
      if (n > 0 || lg.slug === state.selectedLeague || lg.slug === 'arg.2' || lg.slug === 'bra.1' || lg.slug === 'uefa.europa') {
        leagueChips.push({ key: lg.slug, label: lg.name + ' (' + n + ')' });
      }
    });

    const lBox = document.getElementById('league-chips');
    if (lBox) {
      lBox.innerHTML = leagueChips.map((item) => {
        const cls = item.key === state.selectedLeague ? 'chip active' : 'chip';
        return '<button class="' + cls + '" data-league="' + escHtml(item.key) + '">' + escHtml(item.label) + '</button>';
      }).join('');
      lBox.querySelectorAll('button').forEach((b) => {
        b.onclick = () => {
          state.selectedLeague = b.getAttribute('data-league');
          renderChips();
          renderMatches();
        };
      });
    }

    const byLeagueList = state.matches.filter((m) => matchesLeagueFilter(m, state.selectedLeague));
    const sc = getStatusCounts(byLeagueList);
    const statuses = [
      { id: 'all', label: 'Todos (' + sc.total + ')' },
      { id: 'live', label: '🔴 En Vivo (' + sc.live + ')' },
      { id: 'scheduled', label: '🕒 Próximos (' + sc.scheduled + ')' },
      { id: 'finished', label: '✅ Finalizados (' + sc.finished + ')' },
    ];
    const sBox = document.getElementById('status-chips');
    if (sBox) {
      sBox.innerHTML = statuses.map((st) => {
        const cls = st.id === state.selectedStatus ? 'chip active' : 'chip';
        return '<button class="' + cls + '" data-status="' + escHtml(st.id) + '">' + escHtml(st.label) + '</button>';
      }).join('');
      sBox.querySelectorAll('button').forEach((b) => {
        b.onclick = () => {
          state.selectedStatus = b.getAttribute('data-status');
          renderChips();
          renderMatches();
        };
      });
    }
  }

  function renderShootersCardHtml(m) {
    const ts = m.topShooters || {};
    const hLead = (ts.home && ts.home[0]) || null;
    const aLead = (ts.away && ts.away[0]) || null;

    if (!hLead && !aLead) {
      return '<div style="font-size:0.74rem;margin-top:8px;color:#cbd5e1;">🔥 Mejores chances de remate: <b>' + escHtml(m.topShooter || 'Ver en Rematadores y Plantel') + '</b></div>';
    }

    const pill = (s) => {
      if (!s) return '';
      const pct = Math.round((s.prob1PlusSot || 0.35) * 100);
      const statsStr = s.appearances > 0
        ? s.shotsPerGame + ' rem/pj · ' + s.sotPerGame + ' al arco/pj'
        : 'Pos. ' + escHtml(s.position || '-');
      return (
        '<div class="shooter-pill">' +
          '<div style="min-width:0;">' +
            '<div class="shooter-name">' + escHtml(s.name) + (s.starter ? ' ★' : '') + '</div>' +
            '<div class="shooter-meta">' + escHtml(s.team) + ' (' + escHtml(s.position) + ') · ' + escHtml(statsStr) + '</div>' +
          '</div>' +
          '<span class="shooter-prob">' + pct + '% 1+ arco</span>' +
        '</div>'
      );
    };

    return (
      '<div class="shooters-box">' +
        '<div class="shooters-hdr"><span>🎯 MEJORES CHANCES DE PATEAR AL ARCO</span><span>Top 1 por equipo</span></div>' +
        '<div class="shooters-grid">' + pill(hLead) + pill(aLead) + '</div>' +
      '</div>'
    );
  }

  function renderMatches() {
    const list = document.getElementById('matches-list');
    const counter = document.getElementById('summary-counter');
    const updatedTag = document.getElementById('last-updated-tag');
    if (!list) return;

    const filtered = state.matches.filter((m) => {
      if (!matchesLeagueFilter(m, state.selectedLeague)) return false;
      if (state.selectedStatus !== 'all' && m.status !== state.selectedStatus) return false;
      return true;
    });

    const fc = getStatusCounts(filtered);
    if (counter) {
      counter.textContent =
        filtered.length + ' partidos (' + fc.live + ' en vivo · ' + fc.scheduled + ' próximos · ' + fc.finished + ' fin.)';
    }
    if (updatedTag) updatedTag.textContent = state.lastUpdated;

    if (filtered.length === 0) {
      list.innerHTML =
        '<div class="card"><p style="color:var(--muted);font-size:0.85rem;">No hay partidos ' +
        (state.selectedStatus === 'live' ? 'en vivo en este instante ' : '') +
        'para ese filtro en la ventana actual.</p></div>';
      return;
    }

    list.innerHTML = filtered.map((m) => {
      const stClass = m.status === 'live' ? 'state-live' : m.status === 'finished' ? 'state-finished' : 'state-scheduled';
      const statePrefix = m.status === 'live' ? '🔴 EN VIVO · ' : '';
      const inParlay = state.parlayLegs.some((l) => l.matchId === m.id);
      return (
        '<article class="card">' +
          '<div class="card-head">' +
            '<span class="league-pill">' + escHtml(m.league) + '</span>' +
            '<span class="state-pill ' + stClass + '">' + statePrefix + escHtml(m.statusText || m.status) + ' · ' + escHtml(m.date) + '</span>' +
          '</div>' +
          '<div class="teams-row">' +
            '<div class="team-side">' +
              '<img src="' + escHtml(m.homeCrest) + '" alt="' + escHtml(m.home) + '" referrerpolicy="no-referrer" />' +
              '<span class="team-name">' + escHtml(m.home) + '</span>' +
            '</div>' +
            '<div class="score-box">' +
              '<div class="score-num">' + (m.status === 'scheduled' ? 'VS' : escHtml(m.homeScore) + ' - ' + escHtml(m.awayScore)) + '</div>' +
              '<div class="score-sub">Est: ' + escHtml(m.likelyScore || '-') + '</div>' +
            '</div>' +
            '<div class="team-side away">' +
              '<img src="' + escHtml(m.awayCrest) + '" alt="' + escHtml(m.away) + '" referrerpolicy="no-referrer" />' +
              '<span class="team-name">' + escHtml(m.away) + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="pick-box">' +
            '<div class="pick-top">' +
              '<span class="pick-title">' + escHtml(m.prediction) + '</span>' +
              '<span class="odds-badge">Cuota ' + escHtml(m.odds) + ' (' + escHtml(m.probability) + ')</span>' +
            '</div>' +
            '<div class="metrics-grid">' +
              '<div>⚽ Goles: <b>' + escHtml(m.goals) + '</b></div>' +
              '<div>🚩 Córners: <b>' + escHtml(m.corners) + '</b></div>' +
              '<div>🟨 Tarjetas: <b>' + escHtml(m.cards || '3.5+') + '</b></div>' +
              '<div>🎯 Remates: <b>' + escHtml(m.shots) + '</b></div>' +
            '</div>' +
            renderShootersCardHtml(m) +
          '</div>' +
          '<p class="analysis-note">' + escHtml(m.analysis) + '</p>' +
          '<div class="card-actions">' +
            '<button class="btn btn-sm" data-detail="' + escHtml(m.id) + '" type="button">🎯 Rematadores y Plantel</button>' +
            '<button class="btn btn-sm ' + (inParlay ? '' : 'btn-primary') + '" data-add-leg="' + escHtml(m.id) + '" type="button">' +
              (inParlay ? '✓ En Combinada' : '+ Combinada') +
            '</button>' +
          '</div>' +
        '</article>'
      );
    }).join('');

    list.querySelectorAll('[data-add-leg]').forEach((btn) => {
      btn.onclick = () => toggleParlayLeg(btn.getAttribute('data-add-leg'));
    });
    list.querySelectorAll('[data-detail]').forEach((btn) => {
      btn.onclick = () => void openMatchDetail(btn.getAttribute('data-detail'));
    });
  }

  function toggleParlayLeg(matchId) {
    const idx = state.parlayLegs.findIndex((l) => l.matchId === matchId);
    if (idx >= 0) {
      state.parlayLegs.splice(idx, 1);
    } else {
      const m = state.matches.find((x) => x.id === matchId);
      if (!m) return;
      state.parlayLegs.push({
        matchId: m.id,
        matchLabel: m.home + ' vs ' + m.away,
        league: m.league,
        pick: m.prediction,
        odds: parseFloat(m.odds) || 1.35,
        prob: Math.max(0.25, Math.min(0.95, (parseFloat(m.probability) || 65) / 100)),
      });
    }
    renderAll();
  }

  function renderParlay() {
    const badge = document.getElementById('parlay-badge');
    if (badge) badge.textContent = String(state.parlayLegs.length);
    const sumBox = document.getElementById('parlay-summary');
    const listBox = document.getElementById('parlay-legs-list');
    const bankrollEl = document.getElementById('bankroll-input');
    const bankroll = Math.max(100, parseFloat(bankrollEl ? bankrollEl.value : '10000') || 10000);

    let totalOdds = 1.0;
    let jointProb = 1.0;
    state.parlayLegs.forEach((l) => {
      totalOdds *= l.odds;
      jointProb *= l.prob;
    });
    const b = Math.max(0.01, totalOdds - 1);
    const fullKelly = state.parlayLegs.length > 0 ? Math.max(0, (b * jointProb - (1 - jointProb)) / b) : 0;
    const quarterKellyPct = Math.min(0.12, fullKelly * 0.25);
    const stake = Math.round(bankroll * quarterKellyPct);

    if (sumBox) {
      sumBox.innerHTML =
        '<div>Cuota Total: <b>' + (state.parlayLegs.length ? totalOdds.toFixed(2) : '0.00') + '</b></div>' +
        '<div>Prob. Conjunta: <b>' + (state.parlayLegs.length ? Math.round(jointProb * 100) + '%' : '0%') + '</b></div>' +
        '<div>Kelly (0.25x): <b>' + (quarterKellyPct * 100).toFixed(1) + '%</b></div>' +
        '<div>Stake Sugerido: <b>$' + stake.toLocaleString('es-AR') + '</b></div>';
    }
    if (listBox) {
      if (state.parlayLegs.length === 0) {
        listBox.innerHTML = '<div class="card"><p style="font-size:0.84rem;color:var(--muted);">Tocá "+ Combinada" en cualquier partido o usá "⚡ Auto-Armar Óptima".</p></div>';
      } else {
        listBox.innerHTML = state.parlayLegs.map((l) => (
          '<div class="card">' +
            '<div class="pick-top">' +
              '<div><div style="font-size:0.72rem;color:var(--cyan);">' + escHtml(l.league) + '</div><b>' + escHtml(l.matchLabel) + '</b></div>' +
              '<button class="btn btn-sm" data-rm-leg="' + escHtml(l.matchId) + '" type="button">Quitar</button>' +
            '</div>' +
            '<div style="margin-top:6px;font-size:0.82rem;color:var(--green);">' + escHtml(l.pick) + ' · Cuota ' + l.odds.toFixed(2) + '</div>' +
          '</div>'
        )).join('');
        listBox.querySelectorAll('[data-rm-leg]').forEach((b) => {
          b.onclick = () => toggleParlayLeg(b.getAttribute('data-rm-leg'));
        });
      }
    }
  }

  function autoBuildParlay() {
    const candidates = state.matches
      .filter((m) => m.status === 'scheduled' || m.status === 'live')
      .slice()
      .sort((a, b) => (parseFloat(b.probability) || 0) - (parseFloat(a.probability) || 0))
      .slice(0, 4);
    state.parlayLegs = candidates.map((m) => ({
      matchId: m.id,
      matchLabel: m.home + ' vs ' + m.away,
      league: m.league,
      pick: m.prediction,
      odds: parseFloat(m.odds) || 1.35,
      prob: Math.max(0.25, Math.min(0.95, (parseFloat(m.probability) || 65) / 100)),
    }));
    renderAll();
  }

  async function fetchFullRosterWithStats(slug, teamId) {
    if (!teamId) return [];
    const loadSlug = async (s) => {
      const r = await fetch('https://site.api.espn.com/apis/site/v2/sports/soccer/' + s + '/teams/' + encodeURIComponent(teamId) + '/roster', { cache: 'no-store' });
      if (!r.ok) return [];
      const d = await r.json();
      return (d.athletes || []).map((a) => {
        const st = extractEspnAthleteStats(a);
        return {
          id: String(a.id || ''),
          number: String(a.jersey || '-'),
          position: String((a.position && a.position.abbreviation) || ''),
          name: String(a.displayName || a.fullName || '').trim(),
          appearances: st.appearances,
          totalShots: st.totalShots,
          shotsOnTarget: st.shotsOnTarget,
          totalGoals: st.totalGoals,
          goalAssists: st.goalAssists,
        };
      }).filter((x) => x.name);
    };
    let list = await loadSlug(slug);
    const totShots = list.reduce((acc, p) => acc + (p.totalShots || 0), 0);
    if (totShots === 0 && (slug === 'arg.copa' || slug === 'arg.supercopa')) {
      const argList = await loadSlug('arg.1');
      if (argList.reduce((acc, p) => acc + (p.totalShots || 0), 0) > 0) list = argList;
    }
    return list;
  }

  async function openMatchDetail(matchId) {
    const m = state.matches.find((x) => x.id === matchId);
    if (!m) return;
    const modal = document.getElementById('match-modal');
    const title = document.getElementById('modal-title');
    const body = document.getElementById('modal-body');
    if (title) title.textContent = m.home + ' vs ' + m.away;
    if (body) body.innerHTML = '<p style="color:var(--cyan);font-size:0.82rem;">Analizando alineaciones, remates por partido y estadísticas en vivo...</p>';
    if (modal) modal.classList.add('open');

    let homePlayers = Array.isArray(m.homeSquad) ? m.homeSquad.slice() : [];
    let awayPlayers = Array.isArray(m.awaySquad) ? m.awaySquad.slice() : [];
    let homeConf = Boolean(m.lineupConfirmed);
    let awayConf = Boolean(m.lineupConfirmed);

    try {
      const [sumRes, seasonHome, seasonAway] = await Promise.all([
        fetch('https://site.api.espn.com/apis/site/v2/sports/soccer/' + m.leagueSlug + '/summary?event=' + encodeURIComponent(m.id), { cache: 'no-store' }),
        homePlayers.some((p) => (p.totalShots || 0) > 0) ? Promise.resolve(null) : fetchFullRosterWithStats(m.leagueSlug, m.homeId),
        awayPlayers.some((p) => (p.totalShots || 0) > 0) ? Promise.resolve(null) : fetchFullRosterWithStats(m.leagueSlug, m.awayId),
      ]);

      const seasonMap = (arr) => {
        const byId = new Map();
        const byName = new Map();
        (arr || []).forEach((p) => {
          if (p.id) byId.set(p.id, p);
          byName.set(normName(p.name), p);
        });
        return { byId, byName };
      };

      const mergeSide = (sumSideRoster, currentSide, freshSeason) => {
        const baseList = freshSeason && freshSeason.length > 0 ? freshSeason : currentSide;
        const { byId, byName } = seasonMap(baseList);
        if (!Array.isArray(sumSideRoster) || sumSideRoster.length === 0) {
          return { list: baseList, confirmed: false };
        }
        let starters = 0;
        const merged = [];
        const seen = new Set();
        sumSideRoster.forEach((p) => {
          const aid = String((p.athlete && p.athlete.id) || '');
          const nm = String((p.athlete && (p.athlete.displayName || p.athlete.fullName)) || '').trim();
          if (!nm) return;
          const base = byId.get(aid) || byName.get(normName(nm)) || {};
          const isStarter = Boolean(p.starter);
          if (isStarter) starters++;
          const rawPos = String((p.position && p.position.abbreviation) || '').trim();
          const pos = !rawPos || rawPos === 'SUB' || rawPos === 'S' ? (base.position || rawPos) : rawPos;
          const key = aid || normName(nm);
          seen.add(key);
          merged.push({
            id: aid || base.id || '',
            number: String(p.jersey || base.number || '-'),
            position: pos,
            name: nm,
            starter: isStarter,
            inMatchSquad: true,
            appearances: base.appearances || 0,
            totalShots: base.totalShots || 0,
            shotsOnTarget: base.shotsOnTarget || 0,
            totalGoals: base.totalGoals || 0,
          });
        });
        baseList.forEach((sp) => {
          const key = sp.id || normName(sp.name);
          if (!seen.has(key)) merged.push(Object.assign({}, sp, { starter: false, inMatchSquad: false }));
        });
        return { list: merged, confirmed: starters >= 7 };
      };

      let sumData = null;
      if (sumRes && sumRes.ok) sumData = await sumRes.json();
      const rostersArr = (sumData && sumData.rosters) || [];
      const hRosterObj = rostersArr.find((r) => r.homeAway === 'home');
      const aRosterObj = rostersArr.find((r) => r.homeAway === 'away');

      const mh = mergeSide(hRosterObj && hRosterObj.roster, homePlayers, seasonHome);
      const ma = mergeSide(aRosterObj && aRosterObj.roster, awayPlayers, seasonAway);
      if (mh.list.length > 0) { homePlayers = mh.list; homeConf = mh.confirmed || homeConf; }
      if (ma.list.length > 0) { awayPlayers = ma.list; awayConf = ma.confirmed || awayConf; }
    } catch {
      // keep preloaded squads
    }

    const lamH = (m.xgModel && m.xgModel.lambdaHome) || 1.4;
    const lamA = (m.xgModel && m.xgModel.lambdaAway) || 1.15;
    const topH = (m.topShooters && m.topShooters.home && m.topShooters.home.length > 0 && homePlayers.length === (m.homeSquad || []).length)
      ? m.topShooters.home
      : computeTopShootersJS(homePlayers, m.home, lamH, homeConf, 3);
    const topA = (m.topShooters && m.topShooters.away && m.topShooters.away.length > 0 && awayPlayers.length === (m.awaySquad || []).length)
      ? m.topShooters.away
      : computeTopShootersJS(awayPlayers, m.away, lamA, awayConf, 3);

    const renderShooterList = (arr) =>
      arr.length === 0
        ? '<p style="font-size:0.74rem;color:var(--muted);">Sin estadísticas de remates cargadas aún.</p>'
        : arr.map((s, idx) => (
            '<div class="shooter-pill" style="margin-bottom:5px;">' +
              '<div>' +
                '<div class="shooter-name">#' + (idx + 1) + ' ' + escHtml(s.name) + (s.starter ? ' ★' : '') + '</div>' +
                '<div class="shooter-meta">' +
                  escHtml(s.position) + ' · ' + s.shotsPerGame + ' rem/pj · ' + s.sotPerGame + ' al arco/pj · ' + s.goals + ' goles (' + s.appearances + ' PJ)' +
                '</div>' +
              '</div>' +
              '<span class="shooter-prob">' + Math.round((s.prob1PlusSot || 0.35) * 100) + '%</span>' +
            '</div>'
          )).join('');

    const renderList = (arr) =>
      arr.length === 0
        ? '<p style="font-size:0.75rem;color:var(--muted);">Alineación oficial pendiente de confirmación previa al partido.</p>'
        : arr.slice(0, 18).map((p) => (
            '<div class="player-row">' +
              '<span><b>' + escHtml(p.number) + '</b> ' + escHtml(p.name) + (p.starter ? ' ★' : '') + '</span>' +
              '<span style="color:var(--cyan);">' + escHtml(p.position) + (p.totalShots > 0 ? ' · ' + p.totalShots + ' rem' : '') + '</span>' +
            '</div>'
          )).join('');

    if (body) {
      body.innerHTML =
        '<div style="font-size:0.78rem;color:var(--muted);margin-bottom:8px;">' + escHtml(m.league) + ' · ' + escHtml(m.date) + (m.venue ? ' · ' + escHtml(m.venue) : '') + '</div>' +
        '<div class="pick-box" style="margin-bottom:10px;">' +
          '<div class="pick-title">' + escHtml(m.prediction) + ' (Cuota ' + escHtml(m.odds) + ')</div>' +
          '<div style="font-size:0.75rem;color:var(--muted);margin-top:4px;">' + escHtml(m.analysis) + '</div>' +
        '</div>' +
        '<div class="shooters-box" style="margin-bottom:12px;">' +
          '<div class="shooters-hdr"><span>🎯 TOP 3 CON MEJORES CHANCES DE PATEAR AL ARCO</span><span>Prob. 1+ al Arco</span></div>' +
          '<div class="roster-cols" style="margin-top:4px;">' +
            '<div><div style="font-size:0.75rem;font-weight:700;color:#fff;margin-bottom:4px;">' + escHtml(m.home) + '</div>' + renderShooterList(topH) + '</div>' +
            '<div><div style="font-size:0.75rem;font-weight:700;color:#fff;margin-bottom:4px;">' + escHtml(m.away) + '</div>' + renderShooterList(topA) + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="roster-cols">' +
          '<div><h4 style="font-size:0.82rem;margin-bottom:6px;">' + escHtml(m.home) + ' (Plantel / XI)</h4>' + renderList(homePlayers) + '</div>' +
          '<div><h4 style="font-size:0.82rem;margin-bottom:6px;">' + escHtml(m.away) + ' (Plantel / XI)</h4>' + renderList(awayPlayers) + '</div>' +
        '</div>';
    }
  }

  function openClubModal(teamObj) {
    const modal = document.getElementById('match-modal');
    const title = document.getElementById('modal-title');
    const body = document.getElementById('modal-body');
    if (!modal || !title || !body || !teamObj) return;
    title.textContent = teamObj.teamName + ' — Plantel Oficial';
    const stadiumStr = teamObj.stadium
      ? escHtml(teamObj.stadium) + (teamObj.stadiumCity ? ' (' + escHtml(teamObj.stadiumCity) + ')' : '')
      : 'Estadio por confirmar';
    const pls = Array.isArray(teamObj.players) ? teamObj.players : [];
    const listHtml = pls.length
      ? pls.map((p) => (
          '<div class="player-row">' +
            '<span><b>#' + escHtml(p.number || '-') + ' ' + escHtml(p.name) + '</b> <span style="color:var(--muted);">(' + escHtml(p.position || '-') + ')</span></span>' +
            '<span style="color:var(--cyan);font-size:0.72rem;">' +
              (p.appearances ? p.appearances + ' PJ · ' : '') +
              (p.totalShots ? p.totalShots + ' rem · ' + (p.shotsOnTarget || 0) + ' arco · ' : '') +
              (p.totalGoals || 0) + ' goles' +
            '</span>' +
          '</div>'
        )).join('')
      : '<p style="font-size:0.8rem;color:var(--muted);">Sin jugadores cargados todavía. Tocá 🔄 para sincronizar desde ESPN.</p>';
    body.innerHTML =
      '<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">' +
        '<img src="' + escHtml(teamObj.crestUrl) + '" alt="' + escHtml(teamObj.teamName) + '" style="width:48px;height:48px;object-fit:contain;" referrerpolicy="no-referrer" />' +
        '<div>' +
          '<div style="font-size:0.78rem;color:var(--cyan);font-weight:700;">' + escHtml(teamObj.leagueName || teamObj.leagueSlug || '') + '</div>' +
          '<div style="font-size:0.84rem;color:#e2e8f0;">🏟️ ' + stadiumStr + '</div>' +
          '<div style="font-size:0.74rem;color:var(--muted);">' + pls.length + ' jugadores en plantel</div>' +
        '</div>' +
      '</div>' +
      listHtml;
    modal.classList.add('open');
  }

  function ensureRosterFilterDom(box) {
    if (!document.getElementById('roster-league-chips')) {
      const chipsDiv = document.createElement('div');
      chipsDiv.id = 'roster-league-chips';
      chipsDiv.className = 'chips-scroll';
      const stripDiv = document.createElement('div');
      stripDiv.id = 'roster-count-bar';
      stripDiv.className = 'status-strip';
      box.parentNode.insertBefore(chipsDiv, box);
      box.parentNode.insertBefore(stripDiv, box);
    }
  }

  function renderRosters() {
    const box = document.getElementById('rosters-list');
    const qEl = document.getElementById('roster-search');
    if (qEl && qEl.placeholder && !qEl.placeholder.includes('estadio')) {
      qEl.placeholder = 'Buscar club, estadio o jugador actual (ej: San Lorenzo, Independiente)...';
    }
    const q = ((qEl && qEl.value) || '').toLowerCase().trim();
    if (!box) return;
    ensureRosterFilterDom(box);

    const merged = new Map();
    state.rosters.forEach((r) => {
      const key = String(r.teamId || normName(r.teamName));
      merged.set(key, r);
    });
    state.matches.forEach((m) => {
      const hKey = String(m.homeId || normName(m.home));
      if (m.home && !merged.has(hKey)) {
        merged.set(hKey, {
          teamId: m.homeId, teamName: m.home, leagueSlug: m.leagueSlug, leagueName: m.league,
          crestUrl: m.homeCrest, stadium: m.venue || '', stadiumCity: '', players: m.homeSquad || [],
        });
      }
      const aKey = String(m.awayId || normName(m.away));
      if (m.away && !merged.has(aKey)) {
        merged.set(aKey, {
          teamId: m.awayId, teamName: m.away, leagueSlug: m.leagueSlug, leagueName: m.league,
          crestUrl: m.awayCrest, stadium: '', stadiumCity: '', players: m.awaySquad || [],
        });
      }
    });

    const allClubs = Array.from(merged.values());
    const ROSTER_CHIPS = [
      { key: 'all', label: 'Todos (' + allClubs.length + ')' },
      { key: 'arg.1', label: '🇦🇷 Liga Prof.' },
      { key: 'arg.2', label: '🇦🇷 Nac. B' },
      { key: 'esp.1', label: '🇪🇸 LaLiga' },
      { key: 'eng.1', label: '🏴 Premier' },
      { key: 'ita.1', label: '🇮🇹 Serie A' },
      { key: 'ger.1', label: '🇩🇪 Bundesliga' },
      { key: 'fra.1', label: '🇫🇷 Ligue 1' },
      { key: 'ned.1', label: '🇳🇱 Eredivisie' },
      { key: 'bra.1', label: '🇧🇷 Brasil A' },
      { key: 'bra.2', label: '🇧🇷 Brasil B' },
      { key: 'cups', label: '🏆 Copas' },
      { key: 'nat', label: '🌍 Selecciones' },
    ];
    const chipsBox = document.getElementById('roster-league-chips');
    if (chipsBox) {
      chipsBox.innerHTML = ROSTER_CHIPS.map((c) => {
        const cnt = c.key === 'all'
          ? allClubs.length
          : c.key === 'cups'
            ? allClubs.filter((t) => /^(uefa\.(champions|europa|wchampions|super_cup)|conmebol\.(libertadores|sudamericana|recopa))/.test(t.leagueSlug || '')).length
            : c.key === 'nat'
              ? allClubs.filter((t) => /^(fifa|concacaf|caf)\.|uefa\.(nations|euro)|conmebol\.america/.test(t.leagueSlug || '')).length
            : allClubs.filter((t) => t.leagueSlug === c.key).length;
        const lbl = c.key === 'all' ? c.label : c.label + ' (' + cnt + ')';
        const cls = state.selectedRosterLeague === c.key ? 'chip active' : 'chip';
        return '<button class="' + cls + '" data-rleague="' + escHtml(c.key) + '">' + escHtml(lbl) + '</button>';
      }).join('');
      chipsBox.querySelectorAll('button').forEach((b) => {
        b.onclick = () => {
          state.selectedRosterLeague = b.getAttribute('data-rleague');
          state.rosterShowAll = false;
          renderRosters();
        };
      });
    }

    const filtered = allClubs.filter((t) => {
      if (state.selectedRosterLeague === 'cups') {
        if (!/^(uefa\.(champions|europa|wchampions|super_cup)|conmebol\.(libertadores|sudamericana|recopa))/.test(t.leagueSlug || '')) return false;
      } else if (state.selectedRosterLeague === 'nat') {
        if (!/^(fifa|concacaf|caf)\.|uefa\.(nations|euro)|conmebol\.america/.test(t.leagueSlug || '')) return false;
      } else if (state.selectedRosterLeague !== 'all' && t.leagueSlug !== state.selectedRosterLeague) {
        return false;
      }
      if (!q) return true;
      if ((t.teamName || '').toLowerCase().includes(q)) return true;
      if ((t.stadium || '').toLowerCase().includes(q)) return true;
      if ((t.leagueName || '').toLowerCase().includes(q)) return true;
      return (t.players || []).some((p) => (p.name || '').toLowerCase().includes(q));
    });

    const showLimit = (q || state.selectedRosterLeague !== 'all' || state.rosterShowAll) ? filtered.length : 90;
    const arr = filtered.slice(0, showLimit);

    const countBar = document.getElementById('roster-count-bar');
    if (countBar) {
      countBar.innerHTML =
        '<span>Mostrando <b>' + arr.length + '</b> de <b>' + filtered.length + '</b> clubes oficiales</span>' +
        '<span>Escudos · Estadios · Planteles</span>';
    }

    const cardsHtml = arr.map((t, idx) => {
      const stadiumTxt = t.stadium
        ? escHtml(t.stadium) + (t.stadiumCity ? ' · ' + escHtml(t.stadiumCity) : '')
        : 'Estadio por confirmar';
      return (
        '<div class="card">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">' +
            '<div style="display:flex;align-items:center;gap:10px;min-width:0;">' +
              '<img src="' + escHtml(t.crestUrl) + '" alt="' + escHtml(t.teamName) + '" loading="lazy" style="width:36px;height:36px;object-fit:contain;flex-shrink:0;" referrerpolicy="no-referrer" />' +
              '<div style="min-width:0;">' +
                '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;"><b>' + escHtml(t.teamName) + '</b><span style="font-size:0.66rem;color:var(--cyan);">' + escHtml(t.leagueName || t.leagueSlug || '') + '</span></div>' +
                '<div style="font-size:0.72rem;color:#cbd5e1;">🏟️ ' + stadiumTxt + '</div>' +
                '<div style="font-size:0.7rem;color:var(--muted);">' + (t.players ? t.players.length : 0) + ' jugadores cargados</div>' +
              '</div>' +
            '</div>' +
            '<div style="display:flex;gap:5px;flex-shrink:0;">' +
              '<button class="btn btn-sm" data-open-club="' + idx + '" type="button">👥 Plantel</button>' +
              '<button class="btn btn-sm" data-refresh-team="' + escHtml(t.teamId) + '" data-refresh-slug="' + escHtml(t.leagueSlug) + '" data-refresh-name="' + escHtml(t.teamName) + '" type="button">🔄</button>' +
            '</div>' +
          '</div>' +
          (t.players && t.players.length
            ? '<div style="margin-top:8px;font-size:0.74rem;color:#cbd5e1;">' + t.players.slice(0, 10).map((p) => escHtml(p.name) + ' (' + escHtml(p.position) + (p.totalShots ? ' · ' + p.totalShots + ' rem' : '') + ')').join(' · ') + '</div>'
            : '') +
        '</div>'
      );
    }).join('');

    const moreBtnHtml = filtered.length > arr.length
      ? '<div class="card" style="text-align:center;"><button id="show-all-clubs-btn" class="btn btn-primary" type="button">Ver todos los ' + filtered.length + ' clubes</button></div>'
      : '';

    box.innerHTML = cardsHtml + moreBtnHtml;

    const showAllBtn = document.getElementById('show-all-clubs-btn');
    if (showAllBtn) {
      showAllBtn.onclick = () => {
        state.rosterShowAll = true;
        renderRosters();
      };
    }

    box.querySelectorAll('[data-open-club]').forEach((btn) => {
      btn.onclick = () => {
        const i = parseInt(btn.getAttribute('data-open-club'), 10);
        if (!isNaN(i) && arr[i]) openClubModal(arr[i]);
      };
    });

    box.querySelectorAll('[data-refresh-team]').forEach((btn) => {
      btn.onclick = async () => {
        const tid = btn.getAttribute('data-refresh-team');
        const slug = btn.getAttribute('data-refresh-slug');
        const tname = btn.getAttribute('data-refresh-name');
        if (!tid || !slug) return;
        btn.textContent = '...';
        try {
          const pl = await fetchFullRosterWithStats(slug, tid);
          if (pl.length > 0) {
            pl.sort((a, b) => (b.shotsOnTarget - a.shotsOnTarget) || (b.totalShots - a.totalShots));
            const existing = state.rosters.find((x) => String(x.teamId) === String(tid) || x.teamName === tname);
            if (existing) existing.players = pl;
            else state.rosters.unshift({ teamId: tid, teamName: tname, leagueSlug: slug, crestUrl: '', stadium: '', stadiumCity: '', players: pl });
            renderRosters();
          } else {
            btn.textContent = 'Sin datos';
          }
        } catch {
          btn.textContent = 'Error';
        }
      };
    });
  }

  function renderHistory() {
    const statsBox = document.getElementById('db-stats-grid');
    const histList = document.getElementById('history-matches-list');
    const s = state.dbStats || { teamsInXgCache: 656, seasonHistoryRows: 1672, liveMatchesLogged: 0, teamRostersCached: 0 };

    if (statsBox) {
      statsBox.innerHTML =
        '<div class="stat-box"><div class="val">' + escHtml(s.teamsInXgCache) + '</div><div class="lbl">Equipos en BD (xG/xGA)</div></div>' +
        '<div class="stat-box"><div class="val">' + escHtml(s.seasonHistoryRows) + '</div><div class="lbl">Registros Históricos</div></div>' +
        '<div class="stat-box"><div class="val">' + escHtml(s.liveMatchesLogged) + '</div><div class="lbl">Partidos Reales Sumados</div></div>' +
        '<div class="stat-box"><div class="val">' + escHtml(s.teamRostersCached) + '</div><div class="lbl">Planteles Actualizados</div></div>';
    }
    if (histList) {
      if (state.historyLog.length === 0) {
        histList.innerHTML = '<div class="card"><p style="font-size:0.82rem;color:var(--muted);">La base quant_master.db crece automáticamente cada 2 hs con cada partido finalizado.</p></div>';
      } else {
        histList.innerHTML = state.historyLog.map((h) => (
          '<div class="card" style="padding:10px 12px;">' +
            '<div style="display:flex;justify-content:space-between;font-size:0.72rem;color:var(--cyan);"><span>' + escHtml(h.league) + '</span><span>' + escHtml(h.date) + '</span></div>' +
            '<div style="font-size:0.86rem;font-weight:700;margin-top:4px;">' + escHtml(h.home) + ' ' + escHtml(h.score) + ' ' + escHtml(h.away) + '</div>' +
          '</div>'
        )).join('');
      }
    }
  }

  function renderAll() {
    renderChips();
    renderMatches();
    renderParlay();
    if (state.activeTab === 'rosters') renderRosters();
    if (state.activeTab === 'history') renderHistory();
  }

  function setupNavigation() {
    document.querySelectorAll('.nav-btn').forEach((btn) => {
      btn.onclick = () => {
        const tab = btn.getAttribute('data-tab');
        state.activeTab = tab;
        document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b === btn));
        ['matches', 'parlay', 'rosters', 'history'].forEach((id) => {
          const sec = document.getElementById('tab-' + id);
          if (sec) sec.classList.toggle('hidden', id !== tab);
        });
        renderAll();
      };
    });

    const closeBtn = document.getElementById('close-modal-btn');
    const modal = document.getElementById('match-modal');
    if (closeBtn && modal) {
      closeBtn.onclick = () => modal.classList.remove('open');
      modal.onclick = (e) => { if (e.target === modal) modal.classList.remove('open'); };
    }

    const refBtn = document.getElementById('refresh-live-btn');
    if (refBtn) refBtn.onclick = () => void refreshFromEspnLive();

    const autoBtn = document.getElementById('auto-parlay-btn');
    if (autoBtn) autoBtn.onclick = autoBuildParlay;

    const bankEl = document.getElementById('bankroll-input');
    if (bankEl) bankEl.oninput = renderParlay;

    const rSearch = document.getElementById('roster-search');
    if (rSearch) rSearch.oninput = renderRosters;

    const saveTokensBtn = document.getElementById('save-tokens-btn');
    const bzzEl = document.getElementById('token-bzzoiro');
    const fdEl = document.getElementById('token-fd');
    try {
      if (bzzEl) bzzEl.value = localStorage.getItem('fip_bzzoiro_token') || '';
      if (fdEl) fdEl.value = localStorage.getItem('fip_fd_token') || '';
    } catch {}
    if (saveTokensBtn) {
      saveTokensBtn.onclick = () => {
        try {
          if (bzzEl) localStorage.setItem('fip_bzzoiro_token', bzzEl.value.trim());
          if (fdEl) localStorage.setItem('fip_fd_token', fdEl.value.trim());
          saveTokensBtn.textContent = '✓ Guardado';
          setTimeout(() => { saveTokensBtn.textContent = 'Guardar'; }, 1500);
        } catch {}
      };
    }

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      state.deferredPrompt = e;
      const pBtn = document.getElementById('install-pwa-btn');
      if (pBtn) {
        pBtn.classList.remove('hidden');
        pBtn.onclick = async () => {
          if (!state.deferredPrompt) return;
          state.deferredPrompt.prompt();
          await state.deferredPrompt.userChoice;
          state.deferredPrompt = null;
          pBtn.classList.add('hidden');
        };
      }
    });

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    setupNavigation();
    await loadCachedBackendOutputs();
    void refreshFromEspnLive();
  });
})();
