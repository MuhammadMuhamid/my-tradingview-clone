/** Installation-wide terminal capability learned from the backend. */
let disabled = false;

export function manualTradingPollingAllowed(): boolean {
  return !disabled;
}

/** Returns true when this failure means retrying cannot change the answer. */
export function noteManualTradingFailure(message: string): boolean {
  if (/manual trading is disabled/i.test(message)) disabled = true;
  return disabled;
}

export function resetManualTradingPollingCapability(): void {
  disabled = false;
}
