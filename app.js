(function () {
  const TARGET_LEAGUES = [
    { slug: 'all', name: 'Todas (10)' },
    { slug: 'arg.1', name: 'Liga Argentina' },
    { slug: 'arg.copa', name: 'Copa Argentina' },
    { slug: 'esp.1', name: 'LaLiga' },
    { slug: 'ita.1', name: 'Serie A' },
    { slug: 'ger.1', name: 'Bundesliga' },
    { slug: 'ned.1', name: 'Eredivisie' },
    { slug: 'fra.1', name: 'Ligue 1' },
    { slug: 'conmebol.libertadores', name: 'Libertadores' },
    { slug: 'conmebol.sudamericana', name: 'Sudamericana' },
    { slug: 'uefa.champions', name: 'Champions UEFA' },
  ];

  const state = {
    activeTab: 'matches',
    selectedLeague: 'all',
    selectedStatus: 'all',
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

  function setStatus(msg) {
    const el = document.getElementById('live-sync-status');
    if (el) el.textContent = msg;
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
      renderAll();
    } catch {
      // ignore offline error, live ESPN fetch runs next
    }
  }

  async function refreshFromEspnLive() {
    setStatus('Actualizando 10 ligas en vivo...');
    const btn = document.getElementById('refresh-live-btn');
    if (btn) btn.disabled = true;

    const existingById = new Map();
    state.matches.forEach((m) => existingById.set(String(m.id), m));

    const leaguesToFetch = TARGET_LEAGUES.filter((l) => l.slug !== 'all');
    const liveMatches = [];

    await Promise.all(
      leaguesToFetch.map(async (lg) => {
        try {
          const res = await fetch('https://site.api.espn.com/apis/site/v2/sports/soccer/' + lg.slug + '/scoreboard', { cache: 'no-store' });
          if (!res.ok) return;
          const data = await res.json();
          const events = Array.isArray(data.events) ? data.events : [];
          events.forEach((ev) => {
            const comp = (ev.competitions && ev.competitions[0]) || {};
            const comps = comp.competitors || [];
            const hc = comps.find((c) => c.homeAway === 'home') || comps[0];
            const ac = comps.find((c) => c.homeAway === 'away') || comps[1];
            if (!hc || !ac) return;

            const rawState = String((ev.status && ev.status.type && ev.status.type.state) || 'pre').toLowerCase();
            const status = rawState === 'in' ? 'live' : rawState === 'post' ? 'finished' : 'scheduled';
            const prev = existingById.get(String(ev.id));

            if (prev) {
              liveMatches.push(
                Object.assign({}, prev, {
                  status: status,
                  statusText: (ev.status && ev.status.type && ev.status.type.shortDetail) || status,
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
                id: String(ev.id),
                leagueSlug: lg.slug,
                league: lg.name,
                dateUtc: ev.date || '',
                date: formatArgDate(ev.date),
                status: status,
                statusText: (ev.status && ev.status.type && ev.status.type.shortDetail) || status,
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
                prediction: pick1X ? 'Doble Oportunidad: ' + hName + ' o Empate (1X)' : 'Doble Oportunidad: Empate o ' + aName + ' (X2)',
                probability: Math.round(prob * 100) + '%',
                odds: odds,
                goals: mk.probOver25 >= 0.54 ? 'Más de 2.5 Goles (' + Math.round(mk.probOver25 * 100) + '%)' : 'Más de 1.5 Goles (' + Math.round(mk.probOver15 * 100) + '%)',
                corners: 'Más de 8.5 Córners',
                cards: 'Más de 3.5 Tarjetas',
                shots: 'Remates esp.: 8.0+',
                topShooter: 'Ver en alineación en vivo',
                likelyScore: mk.likelyScore,
                markets: mk,
                analysis: 'Actualizado en vivo desde ESPN Public Soccer API.',
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
    setStatus('En vivo · ' + state.matches.length + ' partidos reales');
    if (btn) btn.disabled = false;
    renderAll();
  }

  function renderChips() {
    const lBox = document.getElementById('league-chips');
    if (lBox) {
      lBox.innerHTML = TARGET_LEAGUES.map((lg) => {
        const cls = lg.slug === state.selectedLeague ? 'chip active' : 'chip';
        return '<button class="' + cls + '" data-league="' + escHtml(lg.slug) + '">' + escHtml(lg.name) + '</button>';
      }).join('');
      lBox.querySelectorAll('button').forEach((b) => {
        b.onclick = () => {
          state.selectedLeague = b.getAttribute('data-league');
          renderChips();
          renderMatches();
        };
      });
    }

    const statuses = [
      { id: 'all', label: 'Todos' },
      { id: 'live', label: '🔴 En Vivo' },
      { id: 'scheduled', label: '🕒 Próximos' },
      { id: 'finished', label: '✅ Finalizados' },
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

  function renderMatches() {
    const list = document.getElementById('matches-list');
    const counter = document.getElementById('summary-counter');
    const updatedTag = document.getElementById('last-updated-tag');
    if (!list) return;

    const filtered = state.matches.filter((m) => {
      if (state.selectedLeague !== 'all' && m.leagueSlug !== state.selectedLeague) return false;
      if (state.selectedStatus !== 'all' && m.status !== state.selectedStatus) return false;
      return true;
    });

    if (counter) counter.textContent = filtered.length + ' partidos mostrados · 10 ligas activas';
    if (updatedTag) updatedTag.textContent = state.lastUpdated;

    if (filtered.length === 0) {
      list.innerHTML = '<div class="card"><p style="color:var(--muted);font-size:0.85rem;">No hay partidos para ese filtro en esta ventana.</p></div>';
      return;
    }

    list.innerHTML = filtered.map((m) => {
      const stClass = m.status === 'live' ? 'state-live' : m.status === 'finished' ? 'state-finished' : 'state-scheduled';
      const inParlay = state.parlayLegs.some((l) => l.matchId === m.id);
      return (
        '<article class="card">' +
          '<div class="card-head">' +
            '<span class="league-pill">' + escHtml(m.league) + '</span>' +
            '<span class="state-pill ' + stClass + '">' + escHtml(m.statusText || m.status) + ' · ' + escHtml(m.date) + '</span>' +
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
            '<div style="font-size:0.74rem;margin-top:6px;color:#cbd5e1;">🔥 Top Rematador: <b>' + escHtml(m.topShooter) + '</b></div>' +
          '</div>' +
          '<p class="analysis-note">' + escHtml(m.analysis) + '</p>' +
          '<div class="card-actions">' +
            '<button class="btn btn-sm" data-detail="' + escHtml(m.id) + '" type="button">👥 Alineación y Plantel</button>' +
            '<button class="btn btn-sm ' + (inParlay ? '' : 'btn-primary') + '" data-add-leg="' + escHtml(m.id) + '" type="button">' +
              (inParlay ? '✓ En Combinada' : '+ Combinada') +
            '</button>' +
          '</div>' +
        '</article>'
      );
    }).join('');

    list.querySelectorAll('[data-detail]').forEach((btn) => {
      btn.onclick = () => openMatchDetail(btn.getAttribute('data-detail'));
    });
    list.querySelectorAll('[data-add-leg]').forEach((btn) => {
      btn.onclick = () => toggleParlayLeg(btn.getAttribute('data-add-leg'));
    });
  }

  function toggleParlayLeg(matchId) {
    const idx = state.parlayLegs.findIndex((l) => l.matchId === matchId);
    if (idx >= 0) {
      state.parlayLegs.splice(idx, 1);
    } else {
      const m = state.matches.find((x) => x.id === matchId);
      if (m) {
        const probNum = Math.max(0.25, Math.min(0.95, (parseFloat(m.probability) || 65) / 100));
        state.parlayLegs.push({
          matchId: m.id,
          matchLabel: m.home + ' vs ' + m.away,
          league: m.league,
          pick: m.prediction,
          odds: parseFloat(m.odds) || 1.35,
          prob: probNum,
        });
      }
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
    const ev = state.parlayLegs.length > 0 ? jointProb * totalOdds - 1 : 0;
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

  async function openMatchDetail(matchId) {
    const m = state.matches.find((x) => x.id === matchId);
    if (!m) return;
    const modal = document.getElementById('match-modal');
    const title = document.getElementById('modal-title');
    const body = document.getElementById('modal-body');
    if (title) title.textContent = m.home + ' vs ' + m.away;
    if (body) body.innerHTML = '<p style="color:var(--cyan);font-size:0.82rem;">Cargando alineaciones y planteles actualizados en vivo...</p>';
    if (modal) modal.classList.add('open');

    let homePlayers = m.homeSquad || [];
    let awayPlayers = m.awaySquad || [];
    try {
      const sumRes = await fetch('https://site.api.espn.com/apis/site/v2/sports/soccer/' + m.leagueSlug + '/summary?event=' + encodeURIComponent(m.id), { cache: 'no-store' });
      if (sumRes.ok) {
        const sum = await sumRes.json();
        (sum.rosters || []).forEach((r) => {
          const pl = (r.roster || []).map((p) => ({
            number: String(p.jersey || '-'),
            position: String((p.position && p.position.abbreviation) || ''),
            name: String((p.athlete && (p.athlete.displayName || p.athlete.fullName)) || ''),
            starter: Boolean(p.starter),
          })).filter((x) => x.name);
          if (r.homeAway === 'home' && pl.length > 0) homePlayers = pl;
          if (r.homeAway === 'away' && pl.length > 0) awayPlayers = pl;
        });
      }
      if (homePlayers.length === 0 && m.homeId) {
        const rH = await fetch('https://site.api.espn.com/apis/site/v2/sports/soccer/' + m.leagueSlug + '/teams/' + m.homeId + '/roster', { cache: 'no-store' });
        if (rH.ok) {
          const dH = await rH.json();
          homePlayers = (dH.athletes || []).slice(0, 22).map((a) => ({ number: String(a.jersey || '-'), position: String((a.position && a.position.abbreviation) || ''), name: a.displayName || '' }));
        }
      }
      if (awayPlayers.length === 0 && m.awayId) {
        const rA = await fetch('https://site.api.espn.com/apis/site/v2/sports/soccer/' + m.leagueSlug + '/teams/' + m.awayId + '/roster', { cache: 'no-store' });
        if (rA.ok) {
          const dA = await rA.json();
          awayPlayers = (dA.athletes || []).slice(0, 22).map((a) => ({ number: String(a.jersey || '-'), position: String((a.position && a.position.abbreviation) || ''), name: a.displayName || '' }));
        }
      }
    } catch {
      // keep preloaded squads
    }

    const renderList = (arr) =>
      arr.length === 0
        ? '<p style="font-size:0.75rem;color:var(--muted);">Alineación oficial pendiente de confirmación previa al partido.</p>'
        : arr.slice(0, 18).map((p) => (
            '<div class="player-row"><span><b>' + escHtml(p.number) + '</b> ' + escHtml(p.name) + (p.starter ? ' ★' : '') + '</span><span style="color:var(--cyan);">' + escHtml(p.position) + '</span></div>'
          )).join('');

    if (body) {
      body.innerHTML =
        '<div style="font-size:0.78rem;color:var(--muted);margin-bottom:8px;">' + escHtml(m.league) + ' · ' + escHtml(m.date) + (m.venue ? ' · ' + escHtml(m.venue) : '') + '</div>' +
        '<div class="pick-box" style="margin-bottom:10px;">' +
          '<div class="pick-title">' + escHtml(m.prediction) + ' (Cuota ' + escHtml(m.odds) + ')</div>' +
          '<div style="font-size:0.75rem;color:var(--muted);margin-top:4px;">' + escHtml(m.analysis) + '</div>' +
        '</div>' +
        '<div class="roster-cols">' +
          '<div><h4 style="font-size:0.82rem;margin-bottom:6px;">' + escHtml(m.home) + '</h4>' + renderList(homePlayers) + '</div>' +
          '<div><h4 style="font-size:0.82rem;margin-bottom:6px;">' + escHtml(m.away) + '</h4>' + renderList(awayPlayers) + '</div>' +
        '</div>';
    }
  }

  function renderRosters() {
    const box = document.getElementById('rosters-list');
    const qEl = document.getElementById('roster-search');
    const q = ((qEl && qEl.value) || '').toLowerCase().trim();
    if (!box) return;

    const merged = new Map();
    state.rosters.forEach((r) => merged.set(r.teamName, r));
    state.matches.forEach((m) => {
      if (m.home && !merged.has(m.home)) {
        merged.set(m.home, { teamId: m.homeId, teamName: m.home, leagueSlug: m.leagueSlug, crestUrl: m.homeCrest, players: m.homeSquad || [] });
      }
      if (m.away && !merged.has(m.away)) {
        merged.set(m.away, { teamId: m.awayId, teamName: m.away, leagueSlug: m.leagueSlug, crestUrl: m.awayCrest, players: m.awaySquad || [] });
      }
    });

    const arr = Array.from(merged.values()).filter((t) => {
      if (!q) return true;
      if (t.teamName.toLowerCase().includes(q)) return true;
      return (t.players || []).some((p) => (p.name || '').toLowerCase().includes(q));
    }).slice(0, 36);

    box.innerHTML = arr.map((t) => (
      '<div class="card">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">' +
          '<div style="display:flex;align-items:center;gap:10px;">' +
            '<img src="' + escHtml(t.crestUrl) + '" alt="' + escHtml(t.teamName) + '" style="width:32px;height:32px;object-fit:contain;" referrerpolicy="no-referrer" />' +
            '<div><b>' + escHtml(t.teamName) + '</b><div style="font-size:0.72rem;color:var(--muted);">' + (t.players ? t.players.length : 0) + ' jugadores cargados</div></div>' +
          '</div>' +
          '<button class="btn btn-sm" data-refresh-team="' + escHtml(t.teamId) + '" data-refresh-slug="' + escHtml(t.leagueSlug) + '" data-refresh-name="' + escHtml(t.teamName) + '" type="button">🔄 Actualizar</button>' +
        '</div>' +
        (t.players && t.players.length
          ? '<div style="margin-top:8px;font-size:0.75rem;color:#cbd5e1;">' + t.players.slice(0, 11).map((p) => escHtml(p.name) + ' (' + escHtml(p.position) + ')').join(' · ') + '</div>'
          : '') +
      '</div>'
    )).join('');

    box.querySelectorAll('[data-refresh-team]').forEach((btn) => {
      btn.onclick = async () => {
        const tid = btn.getAttribute('data-refresh-team');
        const slug = btn.getAttribute('data-refresh-slug');
        const tname = btn.getAttribute('data-refresh-name');
        if (!tid || !slug) return;
        btn.textContent = '...';
        try {
          const r = await fetch('https://site.api.espn.com/apis/site/v2/sports/soccer/' + slug + '/teams/' + tid + '/roster', { cache: 'no-store' });
          if (r.ok) {
            const d = await r.json();
            const pl = (d.athletes || []).slice(0, 24).map((a) => ({ number: String(a.jersey || '-'), position: String((a.position && a.position.abbreviation) || ''), name: a.displayName || '' }));
            const existing = state.rosters.find((x) => x.teamName === tname);
            if (existing) existing.players = pl;
            else state.rosters.unshift({ teamId: tid, teamName: tname, leagueSlug: slug, crestUrl: '', players: pl });
            renderRosters();
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
    const s = state.dbStats || { teamsInXgCache: 655, seasonHistoryRows: 1672, liveMatchesLogged: 0, teamRostersCached: 0 };

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
