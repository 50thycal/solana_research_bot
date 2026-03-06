import http from 'http';
import Database from 'better-sqlite3';
import { config } from '../config';
import { handleApiRequest } from './api';
import { getDashboardHtml } from './ui';

export async function runDashboard(db: Database.Database): Promise<void> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // API routes
    if (url.pathname.startsWith('/api/')) {
      handleApiRequest(db, url, res);
      return;
    }

    // Dashboard UI
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getDashboardHtml());
  });

  return new Promise((resolve, reject) => {
    server.listen(config.dashboardPort, '0.0.0.0', () => {
      console.log(JSON.stringify({
        event: 'dashboard_started',
        port: config.dashboardPort,
        host: '0.0.0.0',
      }));
    });

    process.on('SIGTERM', () => {
      console.log(JSON.stringify({ event: 'dashboard_stopping' }));
      server.close(() => resolve());
    });

    server.on('error', reject);
  });
}
