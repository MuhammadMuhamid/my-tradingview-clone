/**
 * The words the exchange-accounts page uses (kept out of the page module: a
 * Next.js page may export only its component).
 */
import type { EnrollmentStatus, ExchangeAccountView } from "@/lib/botManageApi";

export const SECURITY_NOTICE = "Create the Binance API key with Read and Spot trading only. Leave withdrawals disabled, and restrict "
  + "the key to the Bot server's IP address. You enter the key on the Bot's own page; it never passes through Trading Scene.";

/** What the Bot says happened to an enrollment, in plain words. */
export function enrollmentResult(e: EnrollmentStatus, accounts: ExchangeAccountView[]): { tone: "success" | "warn" | "error"; text: string } {
  const account = e.accountId ? accounts.find((a) => a.id === e.accountId) : undefined;
  const which = account ? `${account.name}${e.keyHint ? ` (key …${e.keyHint.replace(/^…/, "")})` : ""}` : e.keyHint ? `key …${e.keyHint.replace(/^…/, "")}` : "the account";
  if (e.status === "completed") {
    if (e.purpose === "reveal_webhook") return { tone: "success", text: "The exit alert was shown on the Bot's page." };
    return { tone: "success", text: e.purpose === "replace" ? `New keys saved for ${which}.` : `Exchange account added: ${which}.` };
  }
  if (e.status === "failed") {
    const why = e.outcome?.startsWith("refused:") ? e.outcome.slice(8).replaceAll("_", " ") : e.outcome ?? "no reason given";
    return { tone: "error", text: `The Bot did not save the keys (${why}). Nothing was stored; start again.` };
  }
  if (e.status === "expired") return { tone: "warn", text: "The link expired before it was used. Nothing was stored; start again." };
  return { tone: "warn", text: "The Bot has not finished this yet (the page may still be open). Refresh in a moment." };
}

