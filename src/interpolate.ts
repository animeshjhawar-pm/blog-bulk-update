/**
 * Replace {{var}} tokens in `template` with values from `vars`.
 * Missing keys collapse to the empty string. Kept in sync with the identical
 * helper in the API route so the dialog shows exactly what will be sent.
 */
export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => vars[key] ?? "");
}
