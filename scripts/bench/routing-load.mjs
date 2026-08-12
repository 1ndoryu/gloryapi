import { performance } from 'node:perf_hooks';
import { createApp } from '../../server/dist/app.js';
import { getDb, initDb } from '../../server/dist/db/index.js';

const adminToken = 'gloryapi-routing-bench-admin-token';
process.env.GLORYAPI_ADMIN_AUTH_TOKEN = adminToken;
const concurrency = Number.parseInt(process.env.GLORYAPI_BENCH_CONCURRENCY || '32', 10);
const samples = Number.parseInt(process.env.GLORYAPI_BENCH_SAMPLES || '128', 10);
const p95BudgetMs = Number.parseFloat(process.env.GLORYAPI_BENCH_P95_BUDGET_MS || '100');
if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('concurrency must be 1..32');
if (!Number.isSafeInteger(samples) || samples < concurrency || samples > 2000) throw new Error('samples must be concurrency..2000');
if (!Number.isFinite(p95BudgetMs) || p95BudgetMs <= 0 || p95BudgetMs > 5000) throw new Error('p95 budget must be >0 and <=5000ms');

initDb(':memory:', { catalogMode: 'operational' });
const app = createApp();
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const address = server.address();
const url = `http://127.0.0.1:${address.port}/api/fallback`;
const durations = [];
let completed = 0;
let failed = 0;

async function fetchFallback() {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${adminToken}` } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  await response.arrayBuffer();
}

// Warm the local HTTP connection pool before measuring route latency. Without this,
// the first concurrent batch measures Windows socket setup more than routing.
await Promise.all(Array.from({ length: concurrency }, () => fetchFallback()));

async function one() {
  const started = performance.now();
  try {
    await fetchFallback();
    completed += 1;
  } catch {
    failed += 1;
  } finally {
    durations.push(performance.now() - started);
  }
}

for (let offset = 0; offset < samples; offset += concurrency) {
  await Promise.all(Array.from({ length: Math.min(concurrency, samples - offset) }, one));
}
durations.sort((a, b) => a - b);
const percentile = p => durations[Math.min(durations.length - 1, Math.floor(durations.length * p))] ?? null;
const result = {
  schemaVersion: 'glory-routing-load-v1',
  concurrency,
  samples,
  p95BudgetMs,
  completed,
  failed,
  p50Ms: percentile(0.50),
  p95Ms: percentile(0.95),
  p99Ms: percentile(0.99),
  rssBytes: process.memoryUsage().rss,
};
result.budgetPass = failed === 0 && result.p95Ms != null && result.p95Ms <= p95BudgetMs;
server.close();
getDb().close();
process.stdout.write(JSON.stringify(result) + '\n');
if (!result.budgetPass) process.exitCode = 1;
