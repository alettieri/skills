import { isRecord } from './validation.ts';

export function normalizeCapture(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }

  const capture: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof key !== 'string') {
      return null;
    }
    capture[key] = entry;
  }

  return capture;
}

export function mergeCaptureIntoContext(
  context: Record<string, unknown>,
  capture: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!capture) {
    return context;
  }

  return {
    ...context,
    ...capture,
  };
}
