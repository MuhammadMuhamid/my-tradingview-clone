/**
 * One parse rule for AUTH_ENABLED, matching
 * `platform/backend/src/config.ts:parseAuthEnabled` exactly.
 *
 * The two halves used to disagree: the backend read `!== "false"` (opt-out) and
 * this app read `=== "true"` (opt-in), so `AUTH_ENABLED=1`, `AUTH_ENABLED=yes`,
 * or simply leaving it unset produced a gated API behind an ungated UI. Only
 * the exact string `false` disables the gate, on both sides.
 *
 * Note the deployment constraint this does not remove: the value is read at
 * build time in the container image (see `Dockerfile`), so it is baked in.
 * Changing it requires a rebuild, not a restart.
 */
export function parseAuthEnabled(raw: string | null | undefined): boolean {
  return (raw ?? "true").trim().toLowerCase() !== "false";
}

export function authEnabled(): boolean {
  return parseAuthEnabled(process.env.AUTH_ENABLED);
}
