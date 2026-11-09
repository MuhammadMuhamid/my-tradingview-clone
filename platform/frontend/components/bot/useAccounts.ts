"use client";
/**
 * The Bot's exchange accounts (C15) and one account's balance (C19), for the
 * bot form and the accounts page. Reads only; a failure is reported as such,
 * never as an empty list or a zero balance.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { botManageApi, type AccountBalance, type ExchangeAccountView } from "@/lib/botManageApi";

export type Loaded<T> =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ok"; data: T }
  | { state: "error"; code: string; message: string };

export function useExchangeAccounts(enabled: boolean): [Loaded<ExchangeAccountView[]>, () => Promise<void>] {
  const [accounts, setAccounts] = useState<Loaded<ExchangeAccountView[]>>({ state: "idle" });
  const load = useCallback(async () => {
    if (!enabled) { setAccounts({ state: "idle" }); return; }
    setAccounts((prev) => (prev.state === "ok" ? prev : { state: "loading" }));
    const result = await botManageApi.accounts();
    setAccounts(result.ok ? { state: "ok", data: result.data.accounts }
      : { state: "error", code: result.code, message: result.message });
  }, [enabled]);
  useEffect(() => { void load(); }, [load]);
  return [accounts, load];
}

const BALANCE_TTL_MS = 60_000;

/** The free USDT of one account, cached for a minute (the Classic widget's 60 s). */
export function useAccountBalance(accountId: string, enabled: boolean): Loaded<AccountBalance> {
  const [balance, setBalance] = useState<Loaded<AccountBalance>>({ state: "idle" });
  const cache = useRef(new Map<string, { at: number; data: AccountBalance }>());
  useEffect(() => {
    if (!enabled || !accountId) { setBalance({ state: "idle" }); return; }
    const hit = cache.current.get(accountId);
    if (hit && Date.now() - hit.at < BALANCE_TTL_MS) { setBalance({ state: "ok", data: hit.data }); return; }
    let live = true;
    setBalance({ state: "loading" });
    void botManageApi.balance(accountId).then((result) => {
      if (!live) return;
      if (result.ok) {
        cache.current.set(accountId, { at: Date.now(), data: result.data });
        setBalance({ state: "ok", data: result.data });
      } else {
        setBalance({ state: "error", code: result.code, message: result.message });
      }
    });
    return () => { live = false; };
  }, [accountId, enabled]);
  return balance;
}
