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
    }
    .stats-bar .stat-val { color: #00d4ff; font-weight: 600; }
    .container { max-width: 1400px; margin: 0 auto; padding: 20px 30px; }

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
      grid-template-columns: 1fr 120px 120px 120px 100px;
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

  <div class="container">
    <!-- List View -->
    <div class="list-view" id="listView">
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

    async function fetchJson(url) {
      const res = await fetch(url);
      return res.json();
    }

    function formatPrice(price) {
      if (price == null) return '-';
      if (price < 0.000001) return price.toExponential(2);
      if (price < 0.001) return price.toFixed(8);
      if (price < 1) return price.toFixed(6);
      return price.toFixed(4);
    }

    function formatMarketCap(mc) {
      if (mc == null) return '-';
      if (mc >= 1000) return (mc / 1000).toFixed(1) + 'K SOL';
      return mc.toFixed(2) + ' SOL';
    }

    function formatTime(ts) {
      return new Date(ts).toLocaleString();
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
        document.getElementById('statsBar').innerHTML =
          '<span>Tokens: <span class="stat-val">' + s.total_tokens + '</span></span>' +
          '<span>Runs: <span class="stat-val">' + s.completed_runs + '</span></span>' +
          '<span>Snapshots: <span class="stat-val">' + s.total_snapshots.toLocaleString() + '</span></span>' +
          (s.active_runs > 0 ? '<span>Active: <span class="stat-val" style="color:#00e676">' + s.active_runs + '</span></span>' : '');
      } catch (e) {
        document.getElementById('statsBar').textContent = 'Error loading stats';
      }
    }

    async function loadTokens(page) {
      currentPage = page;
      const el = document.getElementById('tokenList');
      el.innerHTML = '<div class="loading">Loading...</div>';

      try {
        const data = await fetchJson('/api/tokens?page=' + page + '&limit=' + pageSize);
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
            '<div class="token-metric"><div class="label">Snapshots</div><div class="value">' + t.snapshot_count + '</div></div>' +
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
        var chartOpts = {
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
          options: chartOpts
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
