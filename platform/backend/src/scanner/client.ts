import { config } from "../config";

export type ScannerMethod = "GET" | "POST" | "PATCH" | "DELETE";

export class ScannerServiceError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function upstreamMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return fallback;
  const value = body as { detail?: unknown; error?: unknown };
  if (typeof value.detail === "string" && value.detail) return value.detail;
  if (typeof value.error === "string" && value.error) return value.error;
  return fallback;
}

/** Service-to-service request. No browser headers or credentials are forwarded. */
export async function scannerRequest<T>(input: {
  method: ScannerMethod;
  path: string;
  body?: unknown;
}, options: {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
} = {}): Promise<T> {
  const baseUrl = options.baseUrl ?? config.scannerServiceUrl;
  if (!baseUrl) {
    throw new ScannerServiceError("Scanner service is not configured", 503);
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}${input.path}`, {
      method: input.method,
      headers: input.body === undefined ? { accept: "application/json" } : {
        accept: "application/json", "content-type": "application/json",
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
  } catch {
    throw new ScannerServiceError("Scanner service is unavailable", 503);
  }

  let payload: unknown = null;
  try { payload = await response.json(); } catch { /* mapped below without upstream internals */ }
  if (!response.ok) {
    const status = response.status >= 400 && response.status < 500 ? response.status : 502;
    const fallback = response.status >= 500
      ? "Scanner service failed to process the request"
      : `Scanner request rejected (${response.status})`;
    throw new ScannerServiceError(upstreamMessage(payload, fallback), status);
  }
  return payload as T;
}
