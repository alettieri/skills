const TEMPLATE_PATTERN = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

export function renderTemplate(source: string, values: Record<string, string>): string {
  return source.replace(TEMPLATE_PATTERN, (_match, key: string) => values[key] ?? '');
}
