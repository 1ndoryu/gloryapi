/* SQL y helpers compartidos de los endpoints de analytics.
 * [por que] Extrariamos los queries SQL y el calculo de rango fuera de
 * routes/analytics/index.ts para que el router quede por debajo del limite
 * de lineas (300) y los queries sean reutilizables en tests. */

// SQLite stores these timestamps as UTC `YYYY-MM-DD HH:MM:SS`. Use the same
// representation for lexical comparisons; ISO's `T` would exclude rows from
// the boundary date even when they fall inside the requested range.
export function getSinceTimestamp(range: string): string {
  const now = Date.now();
  let since: Date;
  switch (range) {
    case '24h':
      since = new Date(now - 24 * 60 * 60 * 1000);
      break;
    case '30d':
      since = new Date(now - 30 * 24 * 60 * 60 * 1000);
      break;
    case '7d':
    default:
      since = new Date(now - 7 * 24 * 60 * 60 * 1000);
      break;
  }
  return since.toISOString().replace('T', ' ').slice(0, 19);
}

export const ERROR_CATEGORY_SQL = `
  CASE
    WHEN error LIKE '%400%' OR error LIKE '%invalid request%' OR error LIKE '%invalid json payload%' THEN 'Bad Request (400)'
    WHEN error LIKE '%429%' OR error LIKE '%rate limit%' OR error LIKE '%too many%' OR error LIKE '%quota%' THEN 'Rate Limited (429)'
    WHEN error LIKE '%401%' OR error LIKE '%unauthorized%' OR error LIKE '%invalid key%' THEN 'Auth Error (401)'
    WHEN error LIKE '%402%' OR error LIKE '%payment required%' THEN 'Payment Required (402)'
    WHEN error LIKE '%403%' OR error LIKE '%forbidden%' THEN 'Forbidden (403)'
    WHEN error LIKE '%404%' OR error LIKE '%not found%' THEN 'Not Found (404)'
    WHEN error LIKE '%timeout%' OR error LIKE '%ETIMEDOUT%' OR error LIKE '%ECONNREFUSED%' THEN 'Timeout/Connection'
    WHEN error LIKE '%500%' OR error LIKE '%internal server%' THEN 'Server Error (500)'
    WHEN error LIKE '%503%' OR error LIKE '%unavailable%' THEN 'Unavailable (503)'
    ELSE 'Other'
  END
`;
