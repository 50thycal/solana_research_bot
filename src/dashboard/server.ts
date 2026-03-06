import http from 'http';
import Database from 'better-sqlite3';
import { config } from '../config';
import { handleApiRequest } from './api';
import { getDashboardHtml } from './ui';

/**
 * Start the dashboard HTTP server in the background.
 * Returns immediately after the server is listening.
 */
export function startDashboard(db: Database.Database): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      handleApiRequest(db, url, res);
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getDashboardHtml());
  });

  return new Promise((resolve, reject) => {
    server.listen(config.dashboardPort, '0.0.0.0', () => {
      console.log(JSON.stringify({
        event: 'dashboard_started',
        port: config.dashboardPort,
      }));
      resolve(server);
    });
    server.on('error', reject);
  });
}
