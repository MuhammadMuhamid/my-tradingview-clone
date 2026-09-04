import type { Calibration, Snapshot } from "./types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body !== undefined && init.body !== null;
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(hasBody ? { "content-type": "application/json" } : {}), ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch { /* retain safe status */ }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

function symbolPath(symbol: string): string {
  return symbol.split("/").map((asset) => encodeURIComponent(asset)).join("/");
}

export const api = {
  screener: () => request<Snapshot>("/api/scanner"),
  health: () => request<Record<string, unknown>>("/api/scanner/health"),
  patchConfig: (patch: unknown) => request<{ config: unknown; refresh: unknown }>(
    "/api/scanner/config", { method: "PATCH", body: JSON.stringify(patch) }),
  refresh: (force = false) => request<Record<string, unknown>>(
    `/api/scanner/refresh?force=${force}`, { method: "POST" }),
  addSymbol: (symbol: string) => request<{ symbol: string }>("/api/scanner/symbols", {
    method: "POST", body: JSON.stringify({ symbol }),
  }),
  removeSymbol: (symbol: string) => request<{ symbol: string }>(
    `/api/scanner/symbols/${symbolPath(symbol)}`, { method: "DELETE" }),
  calibrate: (symbol: string) => request<Calibration>(
    `/api/scanner/calibrate/${symbolPath(symbol)}`, { method: "POST" }),
  calibration: (symbol: string) => request<Calibration>(`/api/scanner/calibration/${symbolPath(symbol)}`),
  presets: () => request<{ presets: Record<string, unknown> }>("/api/scanner/presets"),
  savePreset: (name: string) => request<{ name: string }>("/api/scanner/presets", {
    method: "POST", body: JSON.stringify({ name }),
  }),
  loadPreset: (name: string) => request<{ name: string }>(
    `/api/scanner/presets/${encodeURIComponent(name)}/load`, { method: "POST" }),
  deletePreset: (name: string) => request<{ name: string }>(
    `/api/scanner/presets/${encodeURIComponent(name)}`, { method: "DELETE" }),
};
