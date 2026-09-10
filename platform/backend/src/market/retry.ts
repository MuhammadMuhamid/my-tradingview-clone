export class ProviderHttpError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterMs: number | null = null) {
    super(message);
  }
}

export async function withProviderRetry<T>(
  operation: (attempt: number) => Promise<T>,
  policy: { maxAttempts: number; baseDelayMs: number; maximumDelayMs: number; retryableStatuses: readonly number[] },
  sleep: (delayMs: number) => Promise<void> = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try { return await operation(attempt); }
    catch (error) {
      last = error;
      const status = error instanceof ProviderHttpError ? error.status : null;
      const retryable = status !== null && policy.retryableStatuses.includes(status);
      if (!retryable || attempt === policy.maxAttempts) throw error;
      const exponential = Math.min(policy.maximumDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
      const retryAfter = error instanceof ProviderHttpError ? error.retryAfterMs : null;
      await sleep(Math.min(policy.maximumDelayMs, Math.max(exponential, retryAfter ?? 0)));
    }
  }
  throw last;
}
