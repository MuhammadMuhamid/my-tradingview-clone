"use client";
/**
 * The outcome list every Bot page shows above its content: checking, unknown
 * (with "Check again"), refused (with the right path), succeeded, and the
 * one "Nothing was changed" C8 can give. Moved out of `app/bot/page.tsx` so
 * the bot and account pages say it the same way.
 */
import Link from "next/link";
import { Button, Notice } from "@/components/ui";
import type { Outcome } from "./commandRunner";

export function OutcomeNotices({ outcomes, onRecheck, onDismiss }: {
  outcomes: Outcome[];
  onRecheck: (outcome: Extract<Outcome, { phase: "unknown" }>) => void;
  onDismiss: (id: string) => void;
}) {
  if (outcomes.length === 0) return null;
  return (
    <section aria-label="Command outcomes" aria-live="polite" className="space-y-2">
      {outcomes.map((o) => {
        if (o.phase === "checking") {
          return <Notice key={o.id} tone="warn" role="status"><strong>{o.label}:</strong>{" "}
            {o.pending ? "The Bot sent an order and its result is pending. Checking…" : "Outcome unknown, checking…"}</Notice>;
        }
        if (o.phase === "unknown") {
          return <Notice key={o.id} tone="warn" role="status" onDismiss={() => onDismiss(o.id)}>
            <strong>{o.label}:</strong> {o.message}{" "}
            <Button variant="ghost" onClick={() => onRecheck(o)}>Check again</Button>
          </Notice>;
        }
        if (o.phase === "refused") {
          return <Notice key={o.id} tone="error" role="alert" onDismiss={() => onDismiss(o.id)}>
            <strong>{o.label}:</strong> {o.message}
            {o.chart && <> <Link href={o.chart} className="underline">Open the Trade panel</Link></>}
            {o.profile && <> <Link href="/profile" className="underline">Open your profile</Link></>}
          </Notice>;
        }
        return <Notice key={o.id} tone={o.phase === "succeeded" ? "success" : "info"} role="status" onDismiss={() => onDismiss(o.id)}>
          <strong>{o.label}:</strong> {o.message}
        </Notice>;
      })}
    </section>
  );
}

