'use strict';

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function createMetrics({ maxSeries = 64, maxSamples = 256 } = {}) {
  const series = new Map();
  function observe(name, value) {
    if (!/^[a-z0-9_.-]{1,64}$/i.test(name) || !Number.isFinite(value)) return;
    if (!series.has(name) && series.size >= maxSeries) return;
    const values = series.get(name) || [];
    values.push(Math.max(0, value));
    if (values.length > maxSamples) values.splice(0, values.length - maxSamples);
    series.set(name, values);
  }
  function snapshot() {
    const result = {};
    for (const [name, values] of series) {
      const sum = values.reduce((total, value) => total + value, 0);
      result[name] = {
        count: values.length,
        min: Math.min(...values),
        max: Math.max(...values),
        mean: Number((sum / values.length).toFixed(3)),
        p50: Number(percentile(values, 0.5).toFixed(3)),
        p95: Number(percentile(values, 0.95).toFixed(3)),
      };
    }
    return result;
  }
  return { observe, snapshot };
}

module.exports = { createMetrics };
