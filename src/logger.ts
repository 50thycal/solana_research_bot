/**
 * Simple plain-text logger.
 *
 * Outputs human-readable lines instead of JSON so that Railway log copy
 * actually includes the content (Railway strips JSON fields on copy).
 *
 * Format: "event=<event>  key=value  key=value"
 */

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

function formatLine(fields: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) continue;
    parts.push(`${k}=${formatValue(v)}`);
  }
  return parts.join('  ');
}

export function log(fields: Record<string, unknown>): void {
  console.log(formatLine(fields));
}

export function logError(fields: Record<string, unknown>): void {
  console.error(formatLine(fields));
}
