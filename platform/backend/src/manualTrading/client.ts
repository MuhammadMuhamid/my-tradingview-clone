import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { config } from "../config";

export function canonicalJson(value: unknown): string {
  if (value === undefined) return "";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
  ).join(",")}}`;
}

function canonicalPath(raw: string): string {
  const url = new URL(raw, "http://manual.local");
  const sorted = [...url.searchParams.entries()].sort(([ak, av], [bk, bv]) =>
    ak.localeCompare(bk) || av.localeCompare(bv));
  const query = new URLSearchParams(sorted).toString();
  return `${url.pathname}${query ? `?${query}` : ""}`;
}

export function signManualCommand(input: { method: string; path: string; timestamp: string;
  nonce: string; requestId: string; body?: unknown }, secret = config.manualTradingHmacSecret): string {
  const bodyHash = createHash("sha256").update(canonicalJson(input.body)).digest("hex");
  const canonical = [input.method.toUpperCase(), canonicalPath(input.path), input.timestamp,
    input.nonce, input.requestId, bodyHash].join("\n");
  return `v1=${createHmac("sha256", secret).update(canonical).digest("hex")}`;
}

export class ManualBotError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function manualBotRequest<T>(input: { method: "GET" | "POST" | "PUT" | "PATCH";
  path: string; body?: unknown; requestId?: string }, fetchImpl: typeof fetch = fetch): Promise<T> {
  if (!config.manualTradingEnabled) throw new ManualBotError("manual trading is disabled", 404);
  const timestamp = String(Date.now());
  const nonce = randomBytes(24).toString("base64url");
  const requestId = input.requestId ?? randomUUID();
  const signature = signManualCommand({ ...input, timestamp, nonce, requestId });
  const response = await fetchImpl(`${config.manualTradingBotUrl}${input.path}`, {
    method: input.method,
    headers: { "content-type": "application/json", "x-manual-timestamp": timestamp,
      "x-manual-nonce": nonce, "x-manual-request-id": requestId,
      "x-manual-signature": signature },
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    let message = `execution bot returned ${response.status}`;
    try { message = ((await response.json()) as { error?: string }).error ?? message; } catch { /* status only */ }
    throw new ManualBotError(message, response.status);
  }
  return response.json() as Promise<T>;
}
