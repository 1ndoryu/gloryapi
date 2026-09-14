/**
 * Coerce integral floats inside serialized tool-call arguments.
 *
 * Some models (observed: Muse Spark via OpenCode Go) emit `15000.0` where a
 * downstream tool schema declares an integer (`u64`). Strict parsers reject
 * the call, the model retries byte-identical, and the session burns turns in
 * a loop that no amount of reasoning replay can fix.
 *
 * `JSON.parse` already collapses `15000.0` to the number `15000`, so a
 * parse/restringify round-trip normalizes exactly the integral floats while
 * leaving genuine fractions (`15.5`), strings and structure untouched. The
 * input is returned byte-identical when it already serializes to itself or
 * when it is not valid JSON (fail-open: never break an argument we cannot
 * understand).
 */
export function coerceIntegralFloatArgs(argsJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson);
  } catch {
    return argsJson;
  }
  if (parsed === null || typeof parsed !== 'object') return argsJson;
  let normalized: string;
  try {
    normalized = JSON.stringify(parsed);
  } catch {
    return argsJson;
  }
  return normalized === argsJson ? argsJson : normalized;
}
