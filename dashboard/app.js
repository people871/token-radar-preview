// Token Radar dashboard (radar-3-fitted). Reads window.RADAR (bundled beside this
// folder as data.js) and renders the board entirely offline: no fetch, no network.
// RULE: the detail view displays the STORED board values only. Nothing here
// recomputes an implied value — the board's implied value, its P10-P90 range and
// its farm economics are printed exactly as the bundled data carries them.
(function () {
  'use strict';

  var DATA = (typeof window !== 'undefined') ? window.RADAR : null;
  var rows = (DATA && Array.isArray(DATA.rows)) ? DATA.rows : [];
  var live = (DATA && Array.isArray(DATA.live)) ? DATA.live : [];
  var curve = (DATA && Array.isArray(DATA.curve)) ? DATA.curve : [];
  var model = (DATA && DATA.model) || {};
  var backtest = (DATA && DATA.backtest) || {};
  var verdictCounts = (DATA && DATA.verdict_counts) || {};

  var state = { view: 'board', q: '', cat: '', chain: '', verdict: '', mintvl: 0, sort: 'implied', dir: -1 };

  /* ---------- formatting ---------- */
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(n, dflt) { return (typeof n === 'number' && isFinite(n)) ? n : dflt; }
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    var sign = n < 0 ? '-' : '', a = Math.abs(n);
    if (a >= 1e9) return sign + '$' + (a / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return sign + '$' + (a / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return sign + '$' + (a / 1e3).toFixed(1) + 'K';
    return sign + '$' + Math.round(a);
  }
  function fmtMoney(n) { // exact dollars, for costs and nets
    if (n === null || n === undefined || !isFinite(n)) return '—';
    var sign = n < 0 ? '-' : '';
    return sign + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtSigned(n) { // +$x.xx / -$x.xx
    if (n === null || n === undefined || !isFinite(n)) return '—';
    return (n >= 0 ? '+' : '-') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    return (n > 0 ? '+' : '') + Number(n).toFixed(2) + '%';
  }
  function fmtAge(d) {
    if (d === null || d === undefined || !isFinite(d)) return '—';
    if (d >= 365) return (d / 365).toFixed(1) + ' yr';
    return Math.max(0, Math.round(d)) + 'd';
  }
  function fmtMult(n, digits) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    return '×' + Number(n).toFixed(digits === undefined ? 3 : digits);
  }
  function fmtHours(h) {
    if (h === null || h === undefined || !isFinite(h)) return '—';
    return Number(h).toFixed(1) + 'h';
  }

  /* ---------- pure helpers (also used by the Node sanity test) ---------- */
  function farmOf(r) { return (r && r.farm) || {}; }
  function verdictOf(r) { return (farmOf(r).verdict) || '—'; }
  function netOf(r) { return num(farmOf(r).net_usd, null); }
  function keyOf(r, key) {
    if (key === 'name') return String(r.name || '').toLowerCase();
    if (key === 'tvl') return num(r.tvl_usd, 0);
    if (key === 'net') { var n = netOf(r); return n === null ? -Infinity : n; }
    if (key === 'implied') return num(r.implied_value_usd, 0);
    return num(r.rank, 0);
  }
  function sortList(list, key, dir) {
    return list.slice().sort(function (a, b) {
      var av = keyOf(a, key), bv = keyOf(b, key);
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return String(a.slug) < String(b.slug) ? -1 : String(a.slug) > String(b.slug) ? 1 : 0;
    });
  }
  function applyFilters(list, st) {
    var q = String(st.q || '').trim().toLowerCase();
    var minTvl = num(st.mintvl, 0) || 0;
    return list.filter(function (r) {
      if (st.cat && (r.category || '') !== st.cat) return false;
      if (st.chain && (r.chains || []).indexOf(st.chain) < 0) return false;
      if (st.verdict && verdictOf(r) !== st.verdict) return false;
      if ((r.tvl_usd || 0) < minTvl) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  // "Action text. Cost: $4.48 of gas. Time: 10 minutes." -> {action, cost, time}
  function parseFarmStep(s) {
    var m = String(s || '').match(/^(.*)\s+Cost:\s+(.*?)\s+Time:\s+(.*?)\.?$/);
    if (!m) return { action: String(s || ''), cost: '—', time: '—' };
    return { action: m[1].replace(/\.$/, ''), cost: m[2].replace(/\.$/, ''), time: m[3] };
  }
  // Net at a drop and a capital multiple of the $1.0K base plan:
  // slice scales with capital, T-bill forgone scales with capital, gas fees do not.
  function scenarioNet(farm, drop, capMult) {
    var slice = num(farm.slice_usd, 0) * capMult;
    var fees = num(farm.fees_usd, 0);
    var tbill = num(farm.tbill_usd, 0) * capMult;
    return slice * (1 - drop) - fees - tbill;
  }
  // 3 traded tokens nearest this row by TVL (log distance).
  function nearestPeers(row, pts, n) {
    var t = num(row.tvl_usd, 0);
    if (!t || !pts.length) return [];
    var lt = Math.log10(t);
    return pts.map(function (p) {
      return { slug: p.slug, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, d: Math.abs(Math.log10(num(p.tvl_usd, 1)) - lt) };
    }).sort(function (a, b) { return a.d - b.d; }).slice(0, n || 3);
  }
  // Position of the point value inside its P10-P90 band, on a log scale (0..1).
  function rangePos(p10, v, p90) {
    if (!p10 || !v || !p90 || p90 <= p10) return null;
    var pos = (Math.log10(v) - Math.log10(p10)) / (Math.log10(p90) - Math.log10(p10));
    return Math.max(0, Math.min(1, pos));
  }

  /* ---------- scatter chart (inline SVG, log-log) ---------- */
  function scatterSVG(opts) {
    var W = 720, H = 340, L = 56, R = 14, T = 12, B = 34;
    var pts = [];
    curve.forEach(function (p) {
      if (p.tvl_usd > 0 && p.mcap_usd > 0) pts.push({ x: Math.log10(p.tvl_usd), y: Math.log10(p.mcap_usd), kind: 'trade' });
    });
    (opts.board || []).forEach(function (r) {
      if (r.tvl_usd > 0 && r.implied_value_usd > 0) pts.push({ x: Math.log10(r.tvl_usd), y: Math.log10(r.implied_value_usd), kind: 'board', slug: r.slug });
    });
    if (!pts.length) return '<p class="fine">No curve points in the bundled data.</p>';
    var xs = pts.map(function (p) { return p.x; }), ys = pts.map(function (p) { return p.y; });
    var x0 = Math.floor(Math.min.apply(null, xs)) - 0.3, x1 = Math.ceil(Math.max.apply(null, xs)) + 0.3;
    var y0 = Math.floor(Math.min.apply(null, ys)) - 0.3, y1 = Math.ceil(Math.max.apply(null, ys)) + 0.3;
    function X(v) { return L + (v - x0) / (x1 - x0) * (W - L - R); }
    function Y(v) { return T + (y1 - v) / (y1 - y0) * (H - T - B); }
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Log-log scatter of market cap against TVL">';
    var t;
    for (t = Math.ceil(x0); t <= Math.floor(x1); t++) {
      s += '<line class="grid" x1="' + X(t).toFixed(1) + '" y1="' + Y(y1).toFixed(1) + '" x2="' + X(t).toFixed(1) + '" y2="' + Y(y0).toFixed(1) + '"/>';
      s += '<text class="tick" x="' + X(t).toFixed(1) + '" y="' + (H - 12) + '" text-anchor="middle">' + fmtUsd(Math.pow(10, t)) + '</text>';
    }
    for (t = Math.ceil(y0); t <= Math.floor(y1); t++) {
      s += '<line class="grid" x1="' + X(x0).toFixed(1) + '" y1="' + Y(t).toFixed(1) + '" x2="' + X(x1).toFixed(1) + '" y2="' + Y(t).toFixed(1) + '"/>';
      s += '<text class="tick" x="' + (L - 6) + '" y="' + (Y(t) + 3).toFixed(1) + '" text-anchor="end">' + fmtUsd(Math.pow(10, t)) + '</text>';
    }
    s += '<text class="tick" x="' + ((W + L) / 2).toFixed(1) + '" y="' + (H - 1) + '" text-anchor="middle">TVL</text>';
    s += '<text class="tick" x="10" y="' + ((H + T) / 2).toFixed(1) + '" text-anchor="middle" transform="rotate(-90 10 ' + ((H + T) / 2).toFixed(1) + ')">value</text>';
    var inter = num(model.intercept, null), slope = num(model.slope, null);
    if (inter !== null && slope !== null) {
      // Fitted line: log10(mcap) = intercept + slope * log10(TVL / $100M).
      var ya = inter + slope * (x0 - 8), yb = inter + slope * (x1 - 8);
      s += '<line class="fit" x1="' + X(x0).toFixed(1) + '" y1="' + Y(ya).toFixed(1) + '" x2="' + X(x1).toFixed(1) + '" y2="' + Y(yb).toFixed(1) + '"/>';
    }
    pts.forEach(function (p) {
      var cls = p.kind === 'board' ? 'amber' : 'dot';
      if (opts.highlight && p.slug === opts.highlight) cls = 'hl';
      s += '<circle class="' + cls + '" cx="' + X(p.x).toFixed(1) + '" cy="' + Y(p.y).toFixed(1) + '" r="' + (cls === 'hl' ? 6 : 3.5) + '"><title>' + esc(p.slug || '') + '</title></circle>';
    });
    s += '<line class="axis" x1="' + L + '" y1="' + Y(y0).toFixed(1) + '" x2="' + (W - R) + '" y2="' + Y(y0).toFixed(1) + '"/>';
    s += '<line class="axis" x1="' + L + '" y1="' + Y(y1).toFixed(1) + '" x2="' + L + '" y2="' + Y(y0).toFixed(1) + '"/>';
    return s + '</svg>';
  }

  /* ---------- DOM rendering (browser only) ---------- */
  function $(id) { return document.getElementById(id); }
  function pill(v) { return v === '—' ? '<span class="sub">—</span>' : '<span class="pill ' + esc(v) + '">' + esc(v) + '</span>'; }
  function verdictSub(r) {
    var f = farmOf(r), v = verdictOf(r), net = netOf(r);
    if (v === 'SKIP') return '<span class="sub">never beats a T-bill</span>';
    if (v === 'THIN') return '<span class="sub">about break-even</span>';
    if (v === 'FARM') {
      var wh = num(f.work_hours, 0);
      return '<span class="sub">' + (wh > 0 && net !== null ? fmtSigned(net / wh) + '/hr' : 'clears all costs') + '</span>';
    }
    return '';
  }
  function rangeBar(r) {
    var pos = rangePos(r.implied_p10_usd, r.implied_value_usd, r.implied_p90_usd);
    if (pos === null) return '<span class="range-lbl">—</span>';
    return '<div class="range" aria-hidden="true"><i style="left:0%;width:100%"></i><b style="left:' + (pos * 100).toFixed(1) + '%"></b></div>'
      + '<span class="range-lbl">' + fmtUsd(r.implied_p10_usd) + ' – ' + fmtUsd(r.implied_p90_usd) + '</span>';
  }

  function renderSummary() {
    var boardN = num(DATA.board_size, rows.length);
    $('headline-n').textContent = boardN;
    $('asof').textContent = DATA.as_of || '—';
    $('mver').textContent = DATA.model_version || '—';
    $('watch-n').textContent = num(DATA.watchlist_size, rows.length);
    $('floor').textContent = fmtUsd(DATA.floor_usd);
    $('source').textContent = DATA.source || '—';
    var fc = verdictCounts.farm, tc = verdictCounts.thin, sc = verdictCounts.skip;
    var chips = [
      '<span class="chip" role="listitem"><b>' + boardN + '</b> ranked, no token yet</span>',
      '<span class="chip" role="listitem"><b>' + num(DATA.live_size, live.length) + '</b> traded tokens kept apart at market cap</span>',
      '<span class="chip" role="listitem"><b>' + num(DATA.set_aside_size, 0) + '</b> set aside by the house rule</span>',
      '<span class="chip farm" role="listitem"><b>' + (fc === undefined ? '—' : fc) + '</b> FARM at $1.0K</span>',
      '<span class="chip thin" role="listitem"><b>' + (tc === undefined ? '—' : tc) + '</b> THIN</span>',
      '<span class="chip skip" role="listitem"><b>' + (sc === undefined ? '—' : sc) + '</b> SKIP</span>'
    ];
    $('chips').innerHTML = chips.join('');
    $('formula').textContent = model.formula || '—';
    var coefs = [
      ['Intercept', num(model.intercept, null) === null ? '—' : Number(model.intercept).toFixed(3)],
      ['Slope', num(model.slope, null) === null ? '—' : Number(model.slope).toFixed(3)],
      ['Growth coef', num(model.growth_coef, null) === null ? '—' : Number(model.growth_coef).toFixed(3)],
      ['Age coef', num(model.age_coef, null) === null ? '—' : Number(model.age_coef).toFixed(3)]
    ];
    $('coefs').innerHTML = coefs.map(function (c) {
      return '<div><dt>' + c[0] + '</dt><dd>' + c[1] + '</dd></div>';
    }).join('');
    var bt = backtest;
    function mult(x) { return (x === null || x === undefined || !isFinite(x)) ? '—' : '×' + Math.pow(10, x).toFixed(2); }
    function pct(x) { return (x === null || x === undefined || !isFinite(x)) ? '—' : Number(x).toFixed(1) + '%'; }
    var looWin = num(bt.loo_within3x_pct, 0) > num(bt.flat_within3x_pct, 0);
    var timeWin = num(bt.time_within3x_pct, 0) > num(bt.time_flat_within3x_pct, 0);
    $('backtest-body').innerHTML = [
      '<tr class="' + (looWin ? 'win' : '') + '"><td>Blind miss, each token left out (n=' + (bt.n_traded === undefined ? '—' : bt.n_traded) + ')</td><td class="num">' + pct(bt.loo_within3x_pct) + ' within 3×</td><td class="num">' + pct(bt.flat_within3x_pct) + ' within 3×</td></tr>',
      '<tr class="' + (timeWin ? 'win' : '') + '"><td>Time split, fit pre-2024, test newer (n=' + (bt.time_n_test === undefined ? '—' : bt.time_n_test) + ')</td><td class="num">' + pct(bt.time_within3x_pct) + ' within 3×</td><td class="num">' + pct(bt.time_flat_within3x_pct) + ' within 3×</td></tr>',
      '<tr><td>Inside the blind 50% / 80% band</td><td class="num">' + pct(bt.band50_cov_pct) + ' / ' + pct(bt.band80_cov_pct) + '</td><td class="num">—</td></tr>',
      '<tr><td>Median blind error</td><td class="num">' + mult(bt.loo_med_abs_log10) + '</td><td class="num">' + mult(bt.flat_med_abs_log10) + '</td></tr>'
    ].join('');
    $('backtest-note').textContent = 'Leave-one-out refits the curve once per traded token and predicts the held-out token blind; the time split fits only pre-2024 listings and tests later ones. The flat baseline is one median market-cap/TVL multiple for every token.';
    $('scatter').innerHTML = scatterSVG({ board: rows });
    $('scatter-cap').textContent = 'Grey: ' + curve.length + ' traded tokens, market cap on TVL. Amber: the board at its implied value. Line: the size curve before family offsets.';
    var top = rows.filter(function (r) { return netOf(r) !== null; })
      .sort(function (a, b) { return netOf(b) - netOf(a); }).slice(0, 3);
    $('bestnet').innerHTML = top.length ? top.map(function (r) {
      var f = farmOf(r), wh = num(f.work_hours, 0);
      return '<li><span class="bn-rank">#' + (r.rank || '—') + ' · ' + esc(r.category || '') + '</span>'
        + '<div class="bn-name">' + esc(r.name) + '</div>'
        + '<div class="bn-net">' + fmtSigned(netOf(r)) + ' net</div>'
        + '<div class="bn-sub">' + (wh > 0 ? fmtSigned(netOf(r) / wh) + ' per hour · ' + fmtHours(wh) + ' work' : 'work ' + fmtHours(wh)) + ' · slice ' + fmtUsd(f.slice_usd) + '</div></li>';
    }).join('') : '<li>No farm economics in the bundled data.</li>';
    $('method-nums').textContent = 'Intercept ' + (num(model.intercept, null) === null ? '—' : Number(model.intercept).toFixed(3))
      + ', slope ' + (num(model.slope, null) === null ? '—' : Number(model.slope).toFixed(3))
      + '; LOO within 3× ' + pct(bt.loo_within3x_pct) + ' vs flat ' + pct(bt.flat_within3x_pct)
      + '; time split ' + pct(bt.time_within3x_pct) + ' vs flat ' + pct(bt.time_flat_within3x_pct)
      + '; median blind error ' + mult(bt.loo_med_abs_log10) + ' vs flat ' + mult(bt.flat_med_abs_log10) + '.';
  }

  var COLS = {
    board: [
      { k: 'rank', label: 'Rank' }, { k: 'name', label: 'Protocol' }, { k: 'tvl', label: 'TVL' },
      { k: 'change', label: '7d' }, { k: 'age', label: 'No token for' }, { k: 'implied', label: 'Implied value' },
      { k: 'slice', label: '$1.0K slice' }, { k: 'net', label: 'Net of all costs' }, { k: 'farm', label: 'Farm' }
    ],
    live: [
      { k: 'name', label: 'Protocol' }, { k: 'tvl', label: 'TVL' },
      { k: 'change', label: '7d' }, { k: 'mcap', label: 'Market cap' }
    ]
  };
  var SORTABLE = { rank: 1, tvl: 1, implied: 1, net: 1 };

  function renderHead() {
    var cols = COLS[state.view];
    if (!cols) return; // set-aside / method views have no table
    $('thead').innerHTML = '<tr>' + cols.map(function (c) {
      var arrow = state.sort === c.k ? (state.dir < 0 ? ' ▼' : ' ▲') : '';
      var sort = state.sort === c.k ? (state.dir < 0 ? ' aria-sort="descending"' : ' aria-sort="ascending"') : '';
      var inner = SORTABLE[c.k]
        ? '<button type="button" data-sort="' + c.k + '">' + esc(c.label) + esc(arrow) + '</button>'
        : esc(c.label);
      return '<th scope="col"' + sort + '>' + inner + '</th>';
    }).join('') + '</tr>';
  }
  function currentList() {
    var src = state.view === 'board' ? rows : live;
    var filtered = state.view === 'board' ? applyFilters(src, state) : applyFilters(src, { q: state.q, cat: state.cat, chain: state.chain, verdict: '', mintvl: state.mintvl });
    return sortList(filtered, state.sort, state.dir);
  }
  function setView(v) {
    state.view = v;
    ['board', 'live', 'setaside', 'method'].forEach(function (name) {
      var btn = $('tab-' + name);
      if (btn) btn.setAttribute('aria-pressed', name === v ? 'true' : 'false');
    });
    $('board-wrap').hidden = (v === 'setaside' || v === 'method');
    $('setaside-view').hidden = v !== 'setaside';
    $('method-view').hidden = v !== 'method';
    if (v === 'board' && state.sort !== 'rank' && state.sort !== 'implied' && state.sort !== 'tvl' && state.sort !== 'net') { state.sort = 'implied'; state.dir = -1; }
    if (v === 'live' && state.sort !== 'tvl' && state.sort !== 'mcap') { state.sort = 'mcap'; state.dir = -1; }
    if (v === 'board' || v === 'live') renderTable(); // set-aside/method hide the table; nothing to render
  }
  function renderTable() {
    renderHead();
    var list = currentList();
    var total = state.view === 'board' ? rows.length : live.length;
    $('count').textContent = list.length + ' of ' + total + ' ' + (state.view === 'board' ? 'rows' : 'live protocols') + ' shown'
      + (state.view === 'board' ? ' · capital $1.0K · airdrop share 10%' : '');
    $('caption').textContent = state.view === 'board'
      ? 'Pre-token protocols, strongest implied value first. Select a row for its value breakdown, traded peers and costed farm plan.'
      : 'Live-token protocols: each already trades, so the figure shown is the market\u2019s own market cap — a market value, never a model implied value.';
    $('empty').hidden = list.length > 0;
    if (!list.length) { $('rows').innerHTML = ''; return; }
    if (state.view === 'board') {
      $('rows').innerHTML = list.map(function (r) {
        var f = farmOf(r), net = netOf(r);
        var early = (typeof r.age_days === 'number' && r.age_days < 180) ? '<span class="badge early">EARLY</span>' : '';
        var chg = (r.change_7d === null || r.change_7d === undefined) ? '' : r.change_7d >= 0 ? 'netpos' : 'netneg';
        return '<tr tabindex="0" data-slug="' + esc(r.slug) + '">'
          + '<td class="num">' + (r.rank || '—') + '</td>'
          + '<td><span class="nm">' + esc(r.name) + '</span>' + early + '<span class="sub">' + esc(r.slug) + ' · ' + esc(r.category || 'Other') + '</span></td>'
          + '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>'
          + '<td class="num ' + chg + '">' + fmtPct(r.change_7d) + '</td>'
          + '<td class="num">' + fmtAge(r.age_days) + '</td>'
          + '<td><span class="num">' + fmtUsd(r.implied_value_usd) + '</span>' + rangeBar(r) + '</td>'
          + '<td class="num">' + fmtUsd(f.slice_usd) + '</td>'
          + '<td>' + pill(verdictOf(r)) + ' <span class="num ' + (net !== null && net < 0 ? 'netneg' : 'netpos') + '">' + fmtSigned(net) + '</span><br>' + verdictSub(r) + '</td>'
          + '<td><span class="sub">' + fmtMoney(f.fees_usd) + ' fees · ' + (f.hold_days === undefined ? '—' : f.hold_days + 'd hold') + ' · ' + fmtHours(f.work_hours) + ' work</span></td>'
          + '</tr>';
      }).join('');
    } else {
      $('rows').innerHTML = list.map(function (r) {
        var chg = (r.change_7d === null || r.change_7d === undefined) ? '' : r.change_7d >= 0 ? 'netpos' : 'netneg';
        return '<tr tabindex="0" data-slug="' + esc(r.slug) + '" data-live="1">'
          + '<td><span class="nm">' + esc(r.name) + '</span><span class="sub">' + esc(r.slug) + ' · ' + esc(r.category || 'Other') + '</span></td>'
          + '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>'
          + '<td class="num ' + chg + '">' + fmtPct(r.change_7d) + '</td>'
          + '<td class="num">' + fmtUsd(r.mcap_usd) + '</td>'
          + '</tr>';
      }).join('');
    }
  }

  function fillSelects() {
    var cats = {}, chs = {};
    rows.concat(live).forEach(function (r) {
      cats[r.category || 'Other'] = 1;
      (r.chains || []).forEach(function (c) { chs[c] = 1; });
    });
    $('cat').innerHTML = '<option value="">All categories</option>' + Object.keys(cats).sort().map(function (c) {
      return '<option value="' + esc(c) + '">' + esc(c) + '</option>';
    }).join('');
    $('chain').innerHTML = '<option value="">All chains</option>' + Object.keys(chs).sort().map(function (c) {
      return '<option value="' + esc(c) + '">' + esc(c) + '</option>';
    }).join('');
  }

  function openDetail(slug, isLive) {
    var src = isLive ? live : rows, r = null, i;
    for (i = 0; i < src.length; i++) if (src[i].slug === slug) { r = src[i]; break; }
    if (!r) return;
    var dlg = $('detail'), body = $('detail-body');
    var chains = (r.chains || []).join(', ') || 'no chain listed';
    var h = '<p class="d-kicker">' + (isLive ? 'Live token' : 'Rank ' + (r.rank || '—') + ' of ' + num(DATA.board_size, rows.length) + ' · Pre-token') + '</p>'
      + '<h2 id="detail-title">' + esc(r.name) + '</h2>'
      + '<p class="lede">' + (isLive
        ? esc(r.name) + ' already trades: the market cap below is the market\u2019s own value, not a model estimate.'
        : 'DefiLlama records no token for ' + esc(r.name) + ' (no CoinGecko id, ticker or market cap) as of ' + esc(DATA.as_of || '—') + '. A record is not proof: check its own channels before farming.') + '</p>';
    if (isLive) {
      h += '<dl class="statcards">'
        + '<div><dt>Market cap</dt><dd>' + fmtUsd(r.mcap_usd) + '</dd></div>'
        + '<div><dt>TVL</dt><dd>' + fmtUsd(r.tvl_usd) + '</dd></div>'
        + '<div><dt>7-day change</dt><dd>' + fmtPct(r.change_7d) + '</dd></div>'
        + '<div><dt>Category</dt><dd>' + esc(r.category || 'Other') + '</dd></div>'
        + '<div><dt>Chains</dt><dd>' + esc(chains) + '</dd></div></dl>'
        + '<p class="fine">Traded tokens are kept apart at market cap and never given an implied value or a farm plan.</p>';
      body.innerHTML = h;
      if (typeof dlg.showModal === 'function') { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute('open', '');
      return;
    }
    var f = farmOf(r), net = netOf(r);
    var wh = num(f.work_hours, 0);
    h += '<dl class="statcards">'
      + '<div><dt>Implied value</dt><dd>' + fmtUsd(r.implied_value_usd) + '<small>P10 to P90 ' + fmtUsd(r.implied_p10_usd) + ' – ' + fmtUsd(r.implied_p90_usd) + '</small></dd></div>'
      + '<div><dt>TVL</dt><dd>' + fmtUsd(r.tvl_usd) + '<small>7d ' + fmtPct(r.change_7d) + '</small></dd></div>'
      + '<div><dt>No token for</dt><dd>' + fmtAge(r.age_days) + '<small>listed ' + esc(r.listed_at || '—') + '</small></dd></div>'
      + '<div><dt>$1.0K slice</dt><dd>' + fmtUsd(f.slice_usd) + '<small>10% of implied value, pro-rata</small></dd></div>'
      + '<div><dt>Net of all costs</dt><dd>' + pill(verdictOf(r)) + ' ' + fmtSigned(net) + '<small>' + (wh > 0 && net !== null ? fmtSigned(net / wh) + ' per hour' : '') + '</small></dd></div></dl>';

    // Decomposition — STORED values only. The board carries these numbers; the
    // page prints them, it does not recompute them from TVL.
    var size = r.size_value_usd, fam = r.family_mult, gro = r.growth_mult, sea = r.seasoning_mult;
    var sizeLbl = (model.formula || '').replace(/\$100M/g, '$100M');
    h += '<section><h3>How ' + fmtUsd(r.implied_value_usd) + ' is built</h3>'
      + '<table class="decomp"><thead><tr><th scope="col">Part</th><th scope="col">Figure</th><th scope="col" class="num">Value</th></tr></thead><tbody>'
      + '<tr><td>Size curve</td><td>' + esc(sizeLbl) + ' at TVL ' + fmtUsd(r.tvl_usd) + '</td><td class="num">' + fmtUsd(size) + '</td></tr>'
      + '<tr><td>Family</td><td>' + esc(r.category || 'Other') + ' mean residual, shrunk</td><td class="num">' + fmtMult(fam) + '</td></tr>'
      + '<tr><td>Growth</td><td>7-day change ' + fmtPct(r.change_7d) + '</td><td class="num">' + fmtMult(gro) + '</td></tr>'
      + '<tr><td>Seasoning</td><td>' + fmtAge(r.age_days) + ' with no token</td><td class="num">' + fmtMult(sea) + '</td></tr>'
      + '<tr class="total"><td>Implied value</td><td>size × family × growth × seasoning</td><td class="num">' + fmtUsd(r.implied_value_usd) + '</td></tr>'
      + '<tr><td>P10 to P90</td><td>the blind residual range</td><td class="num">' + fmtUsd(r.implied_p10_usd) + ' – ' + fmtUsd(r.implied_p90_usd) + '</td></tr>'
      + '</tbody></table>'
      + '<p class="fine">Board.json carries the same ' + fmtUsd(r.implied_value_usd) + ' at rank ' + (r.rank || '—') + '. The numbers above are the stored decomposition for this row.</p></section>';

    // Peers
    var peers = nearestPeers(r, curve, 3);
    h += '<section><h3>Against traded peers</h3>'
      + '<div class="peer-scatter">' + scatterSVG({ board: [r], highlight: r.slug }) + '</div>'
      + (peers.length ? '<table class="peers"><thead><tr><th scope="col">Nearest traded token</th><th scope="col" class="num">TVL</th><th scope="col" class="num">Market cap</th><th scope="col" class="num">Mcap / TVL</th></tr></thead><tbody>'
        + peers.map(function (p) {
          return '<tr><td>' + esc(p.slug) + '</td><td class="num">' + fmtUsd(p.tvl_usd) + '</td><td class="num">' + fmtUsd(p.mcap_usd) + '</td><td class="num">' + (p.tvl_usd ? (p.mcap_usd / p.tvl_usd).toFixed(2) + '×' : '—') + '</td></tr>';
        }).join('') + '</tbody></table>' : '<p class="fine">No traded peers in the bundled data.</p>')
      + '<p class="fine">Peers are the traded tokens closest in TVL on a log scale. The amber dot is ' + esc(r.name) + ' at its implied value; grey dots are traded tokens at market cap.</p></section>';

    // Farm plan
    var steps = (Array.isArray(r.farm_steps) && r.farm_steps.length) ? r.farm_steps : [];
    var firstChain = (r.chains && r.chains.length) ? r.chains[0] : 'its main chain';
    h += '<section><h3>Farm plan · ' + esc(r.category || 'Other') + ' on ' + esc(firstChain) + ' · $1.0K for ' + (f.hold_days === undefined ? '—' : f.hold_days + ' days') + '</h3>';
    if (steps.length) {
      h += '<table class="plan"><thead><tr><th scope="col">#</th><th scope="col">Step</th><th scope="col">Cost</th><th scope="col">Time</th></tr></thead><tbody>'
        + steps.map(function (s, idx) {
          var p = parseFarmStep(s);
          return '<tr><td class="num">' + (idx + 1) + '</td><td>' + esc(p.action) + '</td><td>' + esc(p.cost) + '</td><td>' + esc(p.time) + '</td></tr>';
        }).join('') + '</tbody></table>';
    } else {
      h += '<p class="fine">No farm steps in the bundled data for this row.</p>';
    }
    h += '<p class="fine">Slice ' + fmtMoney(f.slice_usd) + ' · Fees −' + fmtMoney(f.fees_usd) + ' · T-bill forgone −' + fmtMoney(f.tbill_usd)
      + ' · Net ' + fmtSigned(net) + ' · Work ' + fmtHours(wh) + ' · Per hour ' + (wh > 0 && net !== null ? fmtSigned(net / wh) : '—') + '</p>';

    // Scenario table: net at 5% / 10% / 20% drop, capital $1.0K / $10.0K / $100K.
    var drops = [0.05, 0.10, 0.20], caps = [1, 10, 100];
    h += '<h3>If the token drops after launch</h3>'
      + '<table class="scen"><thead><tr><th scope="col">Drop</th>' + caps.map(function (c) { return '<th scope="col" class="num">Net at $' + (c === 1 ? '1.0K' : c === 10 ? '10.0K' : '100K') + '</th>'; }).join('') + '</tr></thead><tbody>'
      + drops.map(function (d) {
        return '<tr><td>−' + Math.round(d * 100) + '%</td>' + caps.map(function (c) {
          var v = scenarioNet(f, d, c);
          return '<td class="num ' + (v < 0 ? 'netneg' : 'netpos') + '">' + fmtSigned(v) + '</td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody></table>'
      + '<p class="fine">Net = slice at the drop × capital − gas fees − T-bill forgone. Fees are gas and do not scale with capital; the slice and the forgone T-bill return do.</p></section>';
    body.innerHTML = h;
    if (typeof dlg.showModal === 'function') { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute('open', '');
  }

  function resetFilters() {
    state.q = ''; state.cat = ''; state.chain = ''; state.verdict = ''; state.mintvl = 0;
    state.sort = 'implied'; state.dir = -1;
    $('q').value = ''; $('cat').value = ''; $('chain').value = ''; $('verdict').value = ''; $('mintvl').value = '';
    setView('board');
  }

  function boot() {
    renderSummary();
    fillSelects();
    $('tab-board-n').textContent = num(DATA.board_size, rows.length);
    $('tab-live-n').textContent = num(DATA.live_size, live.length);
    $('tab-setaside-n').textContent = num(DATA.set_aside_size, 0);
    $('setaside-n2').textContent = num(DATA.set_aside_size, 0);
    $('setaside-count').textContent = num(DATA.set_aside_size, 0);
    $('setaside-board').textContent = num(DATA.board_size, rows.length);
    $('setaside-live').textContent = num(DATA.live_size, live.length);
    renderTable();
    $('q').addEventListener('input', function (e) { state.q = e.target.value; renderTable(); });
    $('cat').addEventListener('change', function (e) { state.cat = e.target.value; renderTable(); });
    $('chain').addEventListener('change', function (e) { state.chain = e.target.value; renderTable(); });
    $('verdict').addEventListener('change', function (e) { state.verdict = e.target.value; renderTable(); });
    $('mintvl').addEventListener('input', function (e) { state.mintvl = parseFloat(e.target.value) || 0; renderTable(); });
    $('tab-board').addEventListener('click', function () { setView('board'); });
    $('tab-live').addEventListener('click', function () { setView('live'); });
    $('tab-setaside').addEventListener('click', function () { setView('setaside'); });
    $('tab-method').addEventListener('click', function () { setView('method'); });
    $('hide-summary').addEventListener('click', function (e) {
      var hidden = document.body.classList.toggle('hide-summary');
      e.target.setAttribute('aria-pressed', hidden ? 'true' : 'false');
      e.target.textContent = hidden ? 'Show summary' : 'Hide summary';
    });
    $('reset').addEventListener('click', resetFilters);
    $('clear').addEventListener('click', resetFilters);
    $('thead').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-sort]') : null;
      if (!b) return;
      var k = b.getAttribute('data-sort');
      if (state.sort === k) state.dir = -state.dir;
      else { state.sort = k; state.dir = -1; }
      renderTable();
    });
    $('rows').addEventListener('click', function (e) {
      var tr = e.target.closest ? e.target.closest('tr[data-slug]') : null;
      if (tr) openDetail(tr.getAttribute('data-slug'), tr.getAttribute('data-live') === '1');
    });
    $('rows').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var tr = e.target.closest ? e.target.closest('tr[data-slug]') : null;
      if (tr) { e.preventDefault(); openDetail(tr.getAttribute('data-slug'), tr.getAttribute('data-live') === '1'); }
    });
    $('detail').addEventListener('click', function (e) {
      var d = $('detail');
      if (e.target === d) d.close();
    });
    // Deep links: ?detail=<slug> ?category=<name> ?verdict=<FARM|THIN|SKIP>
    var params = new URLSearchParams(window.location.search || '');
    var cat = params.get('category'), ver = params.get('verdict'), det = params.get('detail');
    if (cat) { state.cat = cat; $('cat').value = cat; }
    if (ver && (ver === 'FARM' || ver === 'THIN' || ver === 'SKIP')) { state.verdict = ver; $('verdict').value = ver; }
    if (cat || ver) renderTable();
    if (det) openDetail(det, false);
  }

  if (typeof document !== 'undefined' && DATA) boot();
  else if (typeof document !== 'undefined') {
    var main = document.getElementById('main');
    if (main) main.insertAdjacentHTML('afterbegin', '<p class="empty">No snapshot data found: data.js did not set window.RADAR.</p>');
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { fmtUsd: fmtUsd, fmtMoney: fmtMoney, fmtSigned: fmtSigned, fmtPct: fmtPct, fmtAge: fmtAge,
      sortList: sortList, applyFilters: applyFilters, parseFarmStep: parseFarmStep, scenarioNet: scenarioNet,
      nearestPeers: nearestPeers, rangePos: rangePos };
  }
})();
