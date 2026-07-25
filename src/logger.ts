/** Minimal timestamped logger. */
const ts = () => new Date().toISOString();

export const log = {
  info: (...a: unknown[]) => console.log(`[${ts()}]`, ...a),
  warn: (...a: unknown[]) => console.warn(`[${ts()}] WARN`, ...a),
  error: (...a: unknown[]) => console.error(`[${ts()}] ERROR`, ...a),
};
