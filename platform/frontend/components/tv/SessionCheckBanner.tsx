"use client";
/**
 * Why the chart's trading controls are missing, while the account cannot be read.
 *
 * An unreadable session is offered nothing of the administrator's
 * (`lib/session` `roleOf`), so an administrator's Trade ticket and Positions &
 * Orders disappear from the chart. Without this the only trace was a row inside
 * the product menu, and missing positions read as having no positions. The read
 * retries by itself; the button is for not waiting.
 */
import { Button, Notice } from "@/components/ui";
import { refreshSession, useSession } from "@/lib/session";

export const CHART_SESSION_NOTICE =
  "Your account could not be checked, so trading controls and positions are hidden. "
  + "Retrying automatically. Hiding them changes nothing on your account.";

export function SessionCheckBanner() {
  const session = useSession();
  if (!session?.readFailed) return null;
  return (
    <div className="shrink-0 px-1 pt-1">
      <Notice tone="warn" role="alert">
        <span className="mr-2">{CHART_SESSION_NOTICE}</span>
        <Button onClick={() => void refreshSession()}>Retry now</Button>
      </Notice>
    </div>
  );
}
