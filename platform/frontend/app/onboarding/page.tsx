"use client";
/**
 * First run: a name, and the coins for a first watchlist.
 *
 * Two short steps and a way to skip either. What it creates is ordinary data
 * — a display name and a watchlist the user can edit or delete like any other.
 */
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { safeNextPath } from "@/lib/safeRedirect";
import { refreshSession, useSession } from "@/lib/session";
import { AUTH_FIELD, AuthShell, PRIMARY_BUTTON } from "@/components/AuthShell";
import { PRODUCT_NAME } from "@/lib/navigation";

/** Liquid Binance spot pairs a new watchlist commonly starts from. */
const POPULAR = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT", "AVAXUSDT",
  "LINKUSDT", "DOTUSDT", "NEARUSDT", "LTCUSDT", "TRXUSDT", "ATOMUSDT", "APTUSDT", "SUIUSDT",
];
const DEFAULT_PICKS = new Set(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);

function Onboarding() {
  const params = useSearchParams();
  const next = safeNextPath(params.get("next"));
  const session = useSession();
  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState("");
  const [picks, setPicks] = useState<Set<string>>(new Set(DEFAULT_PICKS));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (session?.user && !name) setName(session.user.displayName);
    // Seeded once from the account, then the field is the user's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user?.id]);

  const toggle = (s: string): void => setPicks((cur) => {
    const n = new Set(cur);
    if (n.has(s)) n.delete(s); else n.add(s);
    return n;
  });

  const finish = async (withList: boolean): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/auth/onboarding", {
        method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(name.trim() ? { displayName: name.trim() } : {}),
          ...(withList ? { symbols: [...picks], watchlistName: "My watchlist" } : {}),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not finish setup");
      }
      await refreshSession();
      window.location.href = next;
    } catch (error) {
      setErr((error as Error).message);
      setBusy(false);
    }
  };

  return (
    <AuthShell width={520}>
      <div className="mb-5 flex items-center gap-2 text-[12px] text-ink-faint">
        {/* accent-is-meaning: progress through setup, not a selected item. */}
        <span className={`h-1 flex-1 rounded-full ${step >= 1 ? "bg-accent" : "bg-border"}`} />
        {/* accent-is-meaning: progress through setup, not a selected item. */}
        <span className={`h-1 flex-1 rounded-full ${step >= 2 ? "bg-accent" : "bg-border"}`} />
        <span className="ml-1 tabular">Step {step} of 2</span>
      </div>

      {step === 1 ? (
        <>
          <h1 className="text-[22px] font-semibold text-ink">Welcome to {PRODUCT_NAME}</h1>
          <p className="mt-1.5 text-[14px] text-ink-muted">What should we call you?</p>
          <label className="mt-6 block text-[13px] text-ink-muted" htmlFor="name">Display name</label>
          <input id="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus
            className={`mt-1.5 ${AUTH_FIELD}`} />
          <button type="button" disabled={!name.trim()} onClick={() => setStep(2)}
            className={`mt-6 ${PRIMARY_BUTTON}`}>Continue</button>
        </>
      ) : (
        <>
          <h1 className="text-[22px] font-semibold text-ink">Start a watchlist</h1>
          <p className="mt-1.5 text-[14px] text-ink-muted">
            Pick the coins you follow. You can change this any time from the chart.
          </p>
          <div className="mt-5 grid grid-cols-3 gap-2 sm:grid-cols-4">
            {POPULAR.map((s) => {
              const on = picks.has(s);
              return (
                <button key={s} type="button" aria-pressed={on} onClick={() => toggle(s)}
                  className={`h-9 rounded-md border text-[13px] font-medium transition-colors ${
                    on ? "border-ink-muted bg-state-active text-ink" : "border-control-border text-ink-muted hover:bg-state-hover"
                  }`}>
                  {s.replace(/USDT$/, "")}
                </button>
              );
            })}
          </div>
          {err && <p role="alert" title={err} className="mt-4 text-[13px] text-down">{err}</p>}
          <button type="button" disabled={busy || picks.size === 0} onClick={() => void finish(true)}
            className={`mt-6 ${PRIMARY_BUTTON}`}>
            {busy ? "Setting up…" : `Create watchlist with ${picks.size} coin${picks.size === 1 ? "" : "s"}`}
          </button>
          <div className="mt-4 flex items-center justify-between text-[13px]">
            <button type="button" onClick={() => setStep(1)} className="text-ink-muted hover:text-ink">Back</button>
            <button type="button" disabled={busy} onClick={() => void finish(false)}
              className="text-ink-muted hover:text-ink">Skip for now</button>
          </div>
        </>
      )}
    </AuthShell>
  );
}

export default function OnboardingPage() {
  return (
    <Suspense fallback={null}>
      <Onboarding />
    </Suspense>
  );
}
