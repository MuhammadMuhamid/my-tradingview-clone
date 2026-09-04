/**
 * Shariah Mode — the persistent operator switch that turns the exposure gate on.
 *
 * Stored SERVER-SIDE in `app_settings` (007_ma_alerts.sql), not in the browser.
 * That is the whole point: the gate in `gate.ts` runs inside the Platform
 * backend before any new-exposure intent proceeds, so the mode it reads must be
 * a fact the backend owns. A localStorage flag would make disabling the gate a
 * client-side action, which is exactly the bypass this must not have — the
 * frontend toggle writes here through the API and then reflects what the server
 * says.
 *
 * Default is OFF: an existing Trading Scene install behaves exactly as before
 * until the operator deliberately enables enforcement.
 */
import { getSetting, setSetting } from "../repositories/appSettings";

export const SHARIAH_MODE_SETTING_KEY = "shariah.mode";

/** "off" leaves behaviour unchanged; "enforce" gates new exposure to ELIGIBLE. */
export const SHARIAH_MODES = ["off", "enforce"] as const;
export type ShariahMode = (typeof SHARIAH_MODES)[number];

export const DEFAULT_SHARIAH_MODE: ShariahMode = "off";

export function isShariahMode(value: unknown): value is ShariahMode {
  return typeof value === "string" && (SHARIAH_MODES as readonly string[]).includes(value);
}

/**
 * Anything unrecognised — a missing row, a hand-edited value, a future mode
 * this build does not know — reads as the stored default rather than throwing.
 * Note this direction is deliberate: an unreadable setting must not silently
 * start blocking trades on an install that never enabled the feature.
 */
export function coerceShariahMode(value: unknown): ShariahMode {
  if (isShariahMode(value)) return value;
  if (value && typeof value === "object" && "mode" in value) {
    const inner = (value as { mode?: unknown }).mode;
    if (isShariahMode(inner)) return inner;
  }
  return DEFAULT_SHARIAH_MODE;
}

/**
 * Read fresh on every call. There is deliberately NO in-process cache: a
 * cached mode (or a cached classification) is precisely how a gate keeps
 * allowing exposure after the operator turned enforcement on or after an asset
 * was re-screened.
 */
export async function getShariahMode(): Promise<ShariahMode> {
  return coerceShariahMode(await getSetting<unknown>(SHARIAH_MODE_SETTING_KEY));
}

export async function setShariahMode(mode: ShariahMode): Promise<ShariahMode> {
  if (!isShariahMode(mode)) throw new Error(`invalid Shariah mode: ${JSON.stringify(mode)}`);
  await setSetting(SHARIAH_MODE_SETTING_KEY, { mode });
  return mode;
}
