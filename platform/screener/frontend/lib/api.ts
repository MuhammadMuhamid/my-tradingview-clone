import type { Calibration, Snapshot } from "./types";

const BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://127.0.0.1:8000";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

export const api = {
  screener: () => request<Snapshot>("/api/screener"),
  health: () => request<Record<string, unknown>>("/api/health"),

  /** Changing one indicator's timeframe refetches only the newly-required pairs. */
  patchConfig: (patch: unknown) =>
    request<{ config: unknown; refresh: unknown }>("/api/config", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  refresh: (force = false) =>
    request<Record<string, unknown>>(`/api/refresh?force=${force}`, { method: "POST" }),

  addSymbol: (symbol: string) =>
    request<{ symbol: string }>("/api/symbols", {
      method: "POST",
      body: JSON.stringify({ symbol }),
    }),

  removeSymbol: (symbol: string) =>
    request<{ symbol: string }>(`/api/symbols/${symbol}`, { method: "DELETE" }),

  /** Slow (seconds) and per-symbol on purpose — §6.2 is opt-in. */
  calibrate: (symbol: string, withSr = true) =>
    request<Calibration>(`/api/calibrate/${symbol}?with_sr=${withSr}`, { method: "POST" }),
  calibration: (symbol: string) => request<Calibration>(`/api/calibration/${symbol}`),

  presets: () => request<{ presets: Record<string, unknown> }>("/api/presets"),
  savePreset: (name: string) =>
    request<{ name: string }>("/api/presets", { method: "POST", body: JSON.stringify({ name }) }),
  loadPreset: (name: string) =>
    request<{ name: string }>(`/api/presets/${encodeURIComponent(name)}/load`, { method: "POST" }),
  deletePreset: (name: string) =>
    request<{ name: string }>(`/api/presets/${encodeURIComponent(name)}`, { method: "DELETE" }),
};
