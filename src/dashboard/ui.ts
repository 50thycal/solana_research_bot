export function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pump.fun Token Tracker</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0f;
      color: #e0e0e0;
      min-height: 100vh;
    }
    .header {
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      padding: 20px 30px;
      border-bottom: 1px solid #2a2a4a;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .header h1 {
      font-size: 22px;
      color: #00d4ff;
      font-weight: 600;
    }
    .stats-bar {
      display: flex;
      gap: 24px;
      font-size: 13px;
      color: #8888aa;
      align-items: center;
    }
    .stats-bar .stat-val { color: #00d4ff; font-weight: 600; }
    .container { max-width: 1400px; margin: 0 auto; padding: 20px 30px; }

    /* Status banner */
    .status-banner {
      padding: 12px 30px;
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 13px;
      border-bottom: 1px solid #1e1e3a;
    }
    .status-banner.active { background: linear-gradient(90deg, rgba(0, 230, 118, 0.08) 0%, rgba(0, 230, 118, 0) 100%); }
    .status-banner.idle { background: linear-gradient(90deg, rgba(136, 136, 170, 0.05) 0%, rgba(136, 136, 170, 0) 100%); }
    .status-dot {
      width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0;
    }
    .status-dot.active { background: #00e676; box-shadow: 0 0 8px rgba(0, 230, 118, 0.6); animation: pulse 2s infinite; }
    .status-dot.idle { background: #555577; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    .status-text { color: #ccc; }
    .status-detail { color: #6666aa; margin-left: auto; }

    /* Stats overview panel */
    .stats-panel {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 12px;
      margin-bottom: 20px;
    }
    .stat-card {
      background: #12121f;
      border: 1px solid #1e1e3a;
      border-radius: 8px;
      padding: 14px 16px;
    }
    .stat-card .stat-label { font-size: 11px; color: #6666aa; text-transform: uppercase; margin-bottom: 4px; }
    .stat-card .stat-value { font-size: 22px; font-weight: 700; color: #fff; }
    .stat-card .stat-sub { font-size: 11px; color: #555577; margin-top: 2px; }

    /* Sort controls */
    .sort-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
      font-size: 13px;
      color: #6666aa;
    }
    .sort-bar span { margin-right: 4px; }
    .sort-btn {
      background: #1e1e3a;
      color: #8888aa;
      border: 1px solid #2a2a4a;
      padding: 5px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      transition: all 0.2s;
    }
    .sort-btn:hover { border-color: #00d4ff; color: #ccc; }
    .sort-btn.active { background: #00d4ff22; border-color: #00d4ff; color: #00d4ff; }
    .sort-btn .arrow { font-size: 10px; margin-left: 3px; }

    /* Token list */
    .token-list { margin-top: 10px; }
    .token-card {
      background: #12121f;
      border: 1px solid #1e1e3a;
      border-radius: 8px;
      padding: 16px 20px;
      margin-bottom: 10px;
      cursor: pointer;
      transition: border-color 0.2s, background 0.2s;
      display: grid;
      grid-template-columns: 1fr 130px 100px 120px 140px 140px;
      align-items: center;
      gap: 16px;
    }
    .token-card:hover { border-color: #00d4ff; background: #161630; }
    .token-name { font-weight: 600; font-size: 15px; }
    .token-symbol { color: #8888aa; font-size: 13px; margin-left: 8px; }
    .token-mint { font-size: 11px; color: #555577; font-family: monospace; margin-top: 4px; }
    .token-metric { text-align: right; }
    .token-metric .label { font-size: 11px; color: #6666aa; text-transform: uppercase; }
    .token-metric .value { font-size: 14px; font-weight: 600; margin-top: 2px; }
    .price-up { color: #00e676; }
    .price-down { color: #ff5252; }
    .price-flat { color: #8888aa; }

    .pagination {
      display: flex;
      justify-content: center;
      gap: 8px;
      margin-top: 16px;
    }
    .pagination button {
      background: #1e1e3a;
      color: #ccc;
      border: 1px solid #2a2a4a;
      padding: 6px 14px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
    }
    .pagination button:hover { border-color: #00d4ff; }
    .pagination button:disabled { opacity: 0.3; cursor: default; }
    .pagination .current { color: #00d4ff; font-weight: 600; padding: 6px 8px; font-size: 13px; }

    /* Detail view */
    .detail-view { display: none; }
    .detail-view.active { display: block; }
    .back-btn {
      background: none;
      border: 1px solid #2a2a4a;
      color: #8888aa;
      padding: 6px 16px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      margin-bottom: 16px;
    }
    .back-btn:hover { border-color: #00d4ff; color: #00d4ff; }
    .detail-header {
      display: flex;
      align-items: baseline;
      gap: 12px;
      margin-bottom: 20px;
    }
    .detail-header h2 { font-size: 24px; color: #fff; }
    .detail-header .symbol { color: #00d4ff; font-size: 18px; }
    .detail-header .mint { font-size: 12px; color: #555577; font-family: monospace; }

    .summary-cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin-bottom: 24px;
    }
    .summary-card {
      background: #12121f;
      border: 1px solid #1e1e3a;
      border-radius: 8px;
      padding: 14px 18px;
    }
    .summary-card .label { font-size: 11px; color: #6666aa; text-transform: uppercase; margin-bottom: 4px; }
    .summary-card .value { font-size: 20px; font-weight: 700; }

    .charts-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }
    @media (max-width: 900px) { .charts-grid { grid-template-columns: 1fr; } }
    .chart-box {
      background: #12121f;
      border: 1px solid #1e1e3a;
      border-radius: 8px;
      padding: 16px;
    }
    .chart-box h3 { font-size: 14px; color: #8888aa; margin-bottom: 12px; }
    .chart-box canvas { width: 100% !important; height: 250px !important; }

    .loading { text-align: center; padding: 60px; color: #555577; font-size: 16px; }
    .empty-state { text-align: center; padding: 80px; color: #555577; }
    .empty-state h3 { font-size: 20px; color: #8888aa; margin-bottom: 8px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Pump.fun Token Tracker</h1>
    <div class="stats-bar" id="statsBar">Loading...</div>
  </div>

  <div class="status-banner idle" id="statusBanner">
    <div class="status-dot idle" id="statusDot"></div>
    <span class="status-text" id="statusText">Checking bot status...</span>
    <span class="status-detail" id="statusDetail"></span>
  </div>

  <div class="container">
    <!-- Stats Overview -->
    <div class="stats-panel" id="statsPanel"></div>

    <!-- List View -->
    <div class="list-view" id="listView">
      <div class="sort-bar" id="sortBar"></div>
      <div class="token-list" id="tokenList">
        <div class="loading">Loading tokens...</div>
      </div>
      <div class="pagination" id="pagination"></div>
    </div>

    <!-- Detail View -->
    <div class="detail-view" id="detailView">
      <button class="back-btn" onclick="showList()">&larr; Back to list</button>
      <div id="detailContent"></div>
    </div>
  </div>

  <script>
    let currentPage = 1;
    const pageSize = 20;
    let charts = [];
    let currentSort = 'analysis_ended';
    let currentOrder = 'desc';

    async function fetchJson(url) {
      const res = await fetch(url);
      return res.json();
    }

    function formatPrice(price) {
      if (price == null) return '-';
      if (price === 0) return '0';
      if (price >= 1) return price.toFixed(4);
      if (price >= 0.001) return price.toFixed(6);
      // For very small prices, use subscript-zero notation: 0.0₄1234
      var s = price.toFixed(20);
      var match = s.match(/^0\\.0*/)
      if (match) {
        var zeroCount = match[0].length - 2; // subtract "0."
        var sigDigits = price.toFixed(20).slice(match[0].length, match[0].length + 4).replace(/0+$/, '');
        if (!sigDigits) sigDigits = '0';
        return '0.0<sub>' + zeroCount + '</sub>' + sigDigits;
      }
      return price.toFixed(8);
    }

    function formatMarketCap(mc) {
      if (mc == null) return '-';
      if (mc >= 1000) return (mc / 1000).toFixed(1) + 'K SOL';
      return mc.toFixed(2) + ' SOL';
    }

    function formatTime(ts) {
      if (!ts) return '-';
      // created_at is in Unix seconds, other timestamps in ms
      // If ts < 1e12, it's seconds; convert to ms
      var ms = ts < 1e12 ? ts * 1000 : ts;
      var d = new Date(ms);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Chicago' }) + ' ' +
             d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Chicago' }) + ' CST';
    }

    function timeAgo(ts) {
      if (!ts) return '-';
      var ms = ts < 1e12 ? ts * 1000 : ts;
      var diff = Date.now() - ms;
      var mins = Math.floor(diff / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return mins + 'm ago';
      var hrs = Math.floor(mins / 60);
      if (hrs < 24) return hrs + 'h ago';
      var days = Math.floor(hrs / 24);
      return days + 'd ago';
    }

    function priceChangeClass(first, last) {
      if (first == null || last == null) return 'price-flat';
      if (last > first) return 'price-up';
      if (last < first) return 'price-down';
      return 'price-flat';
    }

    function priceChangePct(first, last) {
      if (!first || !last) return '-';
      const pct = ((last - first) / first) * 100;
      const sign = pct >= 0 ? '+' : '';
      return sign + pct.toFixed(1) + '%';
    }

    async function loadStats() {
      try {
        const data = await fetchJson('/api/stats');
        const s = data.stats;
        const ar = data.activeRun;
        const rr = data.recentRun;

        // Header stats bar (compact)
        document.getElementById('statsBar').innerHTML =
          '<span>Tokens: <span class="stat-val">' + s.total_tokens + '</span></span>' +
          '<span>Runs: <span class="stat-val">' + s.completed_runs + '</span></span>' +
          '<span>Snapshots: <span class="stat-val">' + s.total_snapshots.toLocaleString() + '</span></span>';

        // Status banner
        var banner = document.getElementById('statusBanner');
        var dot = document.getElementById('statusDot');
        var statusText = document.getElementById('statusText');
        var statusDetail = document.getElementById('statusDetail');

        if (ar) {
          banner.className = 'status-banner active';
          dot.className = 'status-dot active';
          var elapsed = Math.round((Date.now() - ar.started_at) / 60000);
          statusText.textContent = 'Bot is actively collecting data';
          statusDetail.textContent = 'Tracking ' + (ar.tokens_tracking || 0) + ' tokens | Running for ' + elapsed + ' min | ' + (ar.entries_triggered || 0) + ' entries triggered';
        } else {
          banner.className = 'status-banner idle';
          dot.className = 'status-dot idle';
          statusText.textContent = 'Bot is idle — no active collection run';
          if (rr) {
            statusDetail.textContent = 'Last run completed ' + timeAgo(rr.completed_at) + ' | ' + (rr.tokens_observed || 0) + ' tokens observed';
          } else {
            statusDetail.textContent = '';
          }
        }

        // Stats panel cards
        var avgSnaps = s.avg_snapshots_per_token ? Math.round(s.avg_snapshots_per_token) : 0;
        document.getElementById('statsPanel').innerHTML =
          '<div class="stat-card"><div class="stat-label">Total Tokens</div><div class="stat-value">' + s.total_tokens + '</div><div class="stat-sub">analyzed across all runs</div></div>' +
          '<div class="stat-card"><div class="stat-label">Completed Runs</div><div class="stat-value">' + s.completed_runs + '</div><div class="stat-sub">' + (s.failed_runs || 0) + ' failed</div></div>' +
          '<div class="stat-card"><div class="stat-label">Total Snapshots</div><div class="stat-value">' + s.total_snapshots.toLocaleString() + '</div><div class="stat-sub">~' + avgSnaps + ' per token avg</div></div>' +
          '<div class="stat-card"><div class="stat-label">Unique Creators</div><div class="stat-value">' + (s.unique_creators || 0) + '</div></div>' +
          (rr ? '<div class="stat-card"><div class="stat-label">Last Run</div><div class="stat-value" style="font-size:14px">' + formatTime(rr.completed_at) + '</div><div class="stat-sub">' + (rr.tokens_observed || 0) + ' tokens observed</div></div>' : '');
      } catch (e) {
        document.getElementById('statsBar').textContent = 'Error loading stats';
      }
    }

    function renderSortBar() {
      var sorts = [
        { key: 'analysis_ended', label: 'Recent' },
        { key: 'last_price', label: 'Price' },
        { key: 'change', label: 'Change %' },
        { key: 'market_cap', label: 'Mkt Cap' },
        { key: 'created', label: 'Created' },
        { key: 'snapshots', label: 'Snapshots' },
      ];
      var html = '<span>Sort by:</span>';
      sorts.forEach(function(s) {
        var isActive = currentSort === s.key;
        var arrow = isActive ? (currentOrder === 'desc' ? '\\u25BC' : '\\u25B2') : '';
        html += '<button class="sort-btn' + (isActive ? ' active' : '') + '" onclick="toggleSort(\\'' + s.key + '\\')">' + s.label + (arrow ? '<span class="arrow"> ' + arrow + '</span>' : '') + '</button>';
      });
      document.getElementById('sortBar').innerHTML = html;
    }

    function toggleSort(key) {
      if (currentSort === key) {
        currentOrder = currentOrder === 'desc' ? 'asc' : 'desc';
      } else {
        currentSort = key;
        currentOrder = 'desc';
      }
      loadTokens(1);
    }

    async function loadTokens(page) {
      currentPage = page;
      const el = document.getElementById('tokenList');
      el.innerHTML = '<div class="loading">Loading...</div>';
      renderSortBar();

      try {
        const data = await fetchJson('/api/tokens?page=' + page + '&limit=' + pageSize + '&sort=' + currentSort + '&order=' + currentOrder);
        if (data.tokens.length === 0) {
          el.innerHTML = '<div class="empty-state"><h3>No tokens tracked yet</h3><p>Start the collector to begin tracking tokens.</p></div>';
          document.getElementById('pagination').innerHTML = '';
          return;
        }

        el.innerHTML = data.tokens.map(function(t) {
          const cls = priceChangeClass(t.first_price, t.last_price);
          return '<div class="token-card" onclick="showDetail(\\'' + t.mint + '\\', \\'' + t.run_id + '\\')">' +
            '<div>' +
              '<span class="token-name">' + esc(t.name || 'Unknown') + '</span>' +
              '<span class="token-symbol">' + esc(t.symbol || '') + '</span>' +
              '<div class="token-mint">' + t.mint.slice(0, 8) + '...' + t.mint.slice(-6) + '</div>' +
            '</div>' +
            '<div class="token-metric"><div class="label">Price</div><div class="value">' + formatPrice(t.last_price) + '</div></div>' +
            '<div class="token-metric"><div class="label">Change</div><div class="value ' + cls + '">' + priceChangePct(t.first_price, t.last_price) + '</div></div>' +
            '<div class="token-metric"><div class="label">Mkt Cap</div><div class="value">' + formatMarketCap(t.last_market_cap) + '</div></div>' +
            '<div class="token-metric"><div class="label">Created</div><div class="value" style="font-size:12px">' + formatTime(t.created_at) + '</div></div>' +
            '<div class="token-metric"><div class="label">Analysis Ended</div><div class="value" style="font-size:12px">' + formatTime(t.analysis_ended_at || t.last_snapshot_at) + '</div></div>' +
          '</div>';
        }).join('');

        // Pagination
        const p = data.pagination;
        let pHtml = '';
        pHtml += '<button ' + (p.page <= 1 ? 'disabled' : '') + ' onclick="loadTokens(' + (p.page - 1) + ')">Prev</button>';
        pHtml += '<span class="current">Page ' + p.page + ' / ' + p.totalPages + '</span>';
        pHtml += '<button ' + (p.page >= p.totalPages ? 'disabled' : '') + ' onclick="loadTokens(' + (p.page + 1) + ')">Next</button>';
        document.getElementById('pagination').innerHTML = pHtml;
      } catch (e) {
        el.innerHTML = '<div class="loading">Error loading tokens</div>';
      }
    }

    async function showDetail(mint, runId) {
      document.getElementById('listView').style.display = 'none';
      document.getElementById('statsPanel').style.display = 'none';
      const dv = document.getElementById('detailView');
      dv.classList.add('active');
      document.getElementById('detailContent').innerHTML = '<div class="loading">Loading token data...</div>';

      // Destroy old charts
      charts.forEach(function(c) { c.destroy(); });
      charts = [];

      try {
        const data = await fetchJson('/api/token?mint=' + mint + '&run_id=' + runId);
        const t = data.token;
        const snaps = data.snapshots;

        if (snaps.length === 0) {
          document.getElementById('detailContent').innerHTML = '<div class="empty-state"><h3>No snapshot data</h3></div>';
          return;
        }

        const firstSnap = snaps[0];
        const lastSnap = snaps[snaps.length - 1];
        const maxPrice = Math.max(...snaps.map(function(s) { return s.price_sol || 0; }));
        const minPrice = Math.min(...snaps.filter(function(s) { return s.price_sol != null; }).map(function(s) { return s.price_sol; }));
        const cls = priceChangeClass(firstSnap.price_sol, lastSnap.price_sol);

        let html = '<div class="detail-header">' +
          '<h2>' + esc(t.name || 'Unknown') + '</h2>' +
          '<span class="symbol">' + esc(t.symbol || '') + '</span>' +
          '<span class="mint">' + t.mint + '</span>' +
        '</div>';

        html += '<div class="summary-cards">' +
          '<div class="summary-card"><div class="label">First Price</div><div class="value">' + formatPrice(firstSnap.price_sol) + '</div></div>' +
          '<div class="summary-card"><div class="label">Last Price</div><div class="value ' + cls + '">' + formatPrice(lastSnap.price_sol) + '</div></div>' +
          '<div class="summary-card"><div class="label">Change</div><div class="value ' + cls + '">' + priceChangePct(firstSnap.price_sol, lastSnap.price_sol) + '</div></div>' +
          '<div class="summary-card"><div class="label">Max Price</div><div class="value">' + formatPrice(maxPrice) + '</div></div>' +
          '<div class="summary-card"><div class="label">Market Cap</div><div class="value">' + formatMarketCap(lastSnap.market_cap_sol) + '</div></div>' +
          '<div class="summary-card"><div class="label">Total Txns</div><div class="value">' + (lastSnap.total_tx_count || 0) + '</div></div>' +
          '<div class="summary-card"><div class="label">Snapshots</div><div class="value">' + snaps.length + '</div></div>' +
          '<div class="summary-card"><div class="label">Duration</div><div class="value">' + Math.round(lastSnap.seconds_since_creation - firstSnap.seconds_since_creation) + 's</div></div>' +
          '<div class="summary-card"><div class="label">Token Created</div><div class="value" style="font-size:14px">' + formatTime(t.created_at) + '</div></div>' +
          '<div class="summary-card"><div class="label">Analysis Ended</div><div class="value" style="font-size:14px">' + formatTime(data.run ? data.run.completed_at : lastSnap.snapshot_at) + '</div></div>' +
        '</div>';

        html += '<div class="charts-grid">' +
          '<div class="chart-box"><h3>Price (SOL)</h3><canvas id="priceChart"></canvas></div>' +
          '<div class="chart-box"><h3>Market Cap (SOL)</h3><canvas id="mcapChart"></canvas></div>' +
          '<div class="chart-box"><h3>Transaction Count</h3><canvas id="txChart"></canvas></div>' +
          '<div class="chart-box"><h3>Volume Velocity (SOL/s)</h3><canvas id="volChart"></canvas></div>' +
        '</div>';

        document.getElementById('detailContent').innerHTML = html;

        // Build chart data
        var labels = snaps.map(function(s) { return Math.round(s.seconds_since_creation) + 's'; });
        function formatChartPrice(val) {
          if (val == null || val === 0) return '0';
          if (val >= 1) return val.toFixed(2);
          if (val >= 0.001) return val.toFixed(4);
          var s = val.toFixed(20);
          var m = s.match(/^0\\.0*/);
          if (m) {
            var zeros = m[0].length - 2;
            var sig = val.toFixed(20).slice(m[0].length, m[0].length + 3).replace(/0+$/, '');
            return '0.0{' + zeros + '}' + (sig || '0');
          }
          return val.toFixed(8);
        }

        var chartOpts = {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { color: '#555577', maxTicksLimit: 10 }, grid: { color: '#1e1e3a' } },
            y: { ticks: { color: '#555577', callback: function(v) { return formatChartPrice(v); } }, grid: { color: '#1e1e3a' } }
          }
        };

        var chartOptsPlain = {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { color: '#555577', maxTicksLimit: 10 }, grid: { color: '#1e1e3a' } },
            y: { ticks: { color: '#555577' }, grid: { color: '#1e1e3a' } }
          }
        };

        // Price chart
        charts.push(new Chart(document.getElementById('priceChart'), {
          type: 'line',
          data: {
            labels: labels,
            datasets: [{
              data: snaps.map(function(s) { return s.price_sol; }),
              borderColor: '#00d4ff',
              backgroundColor: 'rgba(0, 212, 255, 0.1)',
              fill: true,
              tension: 0.3,
              pointRadius: 1,
              borderWidth: 2,
            }]
          },
          options: chartOpts
        }));

        // Market cap chart
        charts.push(new Chart(document.getElementById('mcapChart'), {
          type: 'line',
          data: {
            labels: labels,
            datasets: [{
              data: snaps.map(function(s) { return s.market_cap_sol; }),
              borderColor: '#7c4dff',
              backgroundColor: 'rgba(124, 77, 255, 0.1)',
              fill: true,
              tension: 0.3,
              pointRadius: 1,
              borderWidth: 2,
            }]
          },
          options: chartOpts
        }));

        // Transaction count chart
        charts.push(new Chart(document.getElementById('txChart'), {
          type: 'line',
          data: {
            labels: labels,
            datasets: [{
              data: snaps.map(function(s) { return s.total_tx_count; }),
              borderColor: '#00e676',
              backgroundColor: 'rgba(0, 230, 118, 0.1)',
              fill: true,
              tension: 0.3,
              pointRadius: 1,
              borderWidth: 2,
            }]
          },
          options: chartOptsPlain
        }));

        // Volume velocity chart
        charts.push(new Chart(document.getElementById('volChart'), {
          type: 'bar',
          data: {
            labels: labels,
            datasets: [{
              data: snaps.map(function(s) { return s.volume_velocity_sol; }),
              backgroundColor: 'rgba(255, 152, 0, 0.6)',
              borderColor: '#ff9800',
              borderWidth: 1,
            }]
          },
          options: chartOpts
        }));

      } catch (e) {
        document.getElementById('detailContent').innerHTML = '<div class="loading">Error loading token data</div>';
      }
    }

    function showList() {
      document.getElementById('detailView').classList.remove('active');
      document.getElementById('listView').style.display = 'block';
      document.getElementById('statsPanel').style.display = '';
      charts.forEach(function(c) { c.destroy(); });
      charts = [];
    }

    function esc(s) {
      var d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }

    // Initial load
    loadStats();
    loadTokens(1);

    // Auto-refresh stats every 30s
    setInterval(loadStats, 30000);
  </script>
</body>
</html>`;
}
