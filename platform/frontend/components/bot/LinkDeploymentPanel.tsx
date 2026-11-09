"use client";
/**
 * "Link to deployment": the bot's webhook secret goes from this Platform's
 * encrypted store into a deployment, server-side. The browser never sees it,
 * and nothing is copied or pasted (it replaces the Classic dashboard's
 * one-time secret screen, P-57).
 *
 * Only a custom-webhook deployment sends to the Bot, so only those can be
 * linked; a 3Commas, paper or off deployment is listed as not linkable. A
 * Platform-only command: there is no Bot record to ask, so an answer that did
 * not arrive is said to be unknown and the list is re-read.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Card, CardHeader, Empty, Notice } from "@/components/ui";
import { api } from "@/lib/api";
import { botManageApi } from "@/lib/botManageApi";
import type { Deployment } from "@/lib/types";
import { StepUpDialog } from "./StepUpDialog";
import { OpenIntents, type DialogResult } from "./commandRunner";
import { STEP_UP_CODES, explainRefusal } from "./botCopy";

export function LinkDeploymentPanel({ botId, botName, webhookPath, secretStored, canCommand, disabledReason, onLinked }: {
  botId: string;
  botName: string;
  webhookPath: string;
  /** Whether this Platform holds the bot's secret (C11 `platform.secret.stored`); null = unknown. */
  secretStored: boolean | null;
  canCommand: boolean;
  disabledReason?: string;
  onLinked?: () => void;
}) {
  const [deployments, setDeployments] = useState<Deployment[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [target, setTarget] = useState<Deployment | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error" | "warn"; text: string } | null>(null);
  const intents = useRef(new OpenIntents());

  const load = useCallback(async () => {
    try {
      setDeployments(await api.listDeployments());
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const confirm = async (credential: { code?: string; password?: string }): Promise<DialogResult> => {
    const deployment = target!;
    const intent = `link:${deployment.id}:${botId}`;
    const requestId = intents.current.idFor(intent);
    const answer = await botManageApi.linkBot(requestId, deployment.id, botId, credential);
    if (answer.kind === "refused") {
      if (STEP_UP_CODES.has(answer.code)) return { close: false, error: answer.message, ...(answer.method ? { method: answer.method } : {}) };
      intents.current.close(intent);
      setMessage({ tone: "error", text: explainRefusal(answer.code, answer.message).text });
      return { close: true };
    }
    if (answer.kind === "succeeded") {
      intents.current.close(intent);
      setMessage({ tone: "success", text: `${deployment.symbol} ${deployment.timeframe} now signs its signals with ${botName}'s secret`
        + `${answer.result.replacedSecret === true ? " (its previous secret was replaced)" : ""}.` });
    } else {
      intents.current.keepOpen(intent, requestId);
      setMessage({ tone: "warn", text: "The answer did not arrive. The list below is re-read; link again if it does not show as linked." });
    }
    void load();
    onLinked?.();
    return { close: true };
  };

  const linkable = (d: Deployment) => d.delivery === "custom";
  const pathOk = (d: Deployment) => !d.webhookUrl || d.webhookUrl.endsWith(webhookPath);

  return (
    <Card>
      <CardHeader title="Link to deployment" />
      <div className="space-y-3 px-4 py-3">
        <p className="text-sm text-ink">
          A linked deployment signs its signals with this bot&apos;s webhook secret. The secret is copied inside Trading Scene,
          never shown or pasted. Rotating the secret updates linked deployments.
        </p>
        {secretStored === false && <Notice tone="warn">
          Trading Scene does not hold this bot&apos;s webhook secret (it was created elsewhere, or the answer that carried it was lost).
          Rotate the secret below to store one here, then link.
        </Notice>}
        {message && <Notice tone={message.tone} role={message.tone === "error" ? "alert" : "status"} onDismiss={() => setMessage(null)}>{message.text}</Notice>}
        {loadError && <Notice tone="error" role="alert">The deployments could not be read. Reload to try again.</Notice>}
        {deployments && deployments.length === 0 && <Empty>No deployments yet. Create one from a strategy first.</Empty>}
        {deployments && deployments.length > 0 && <ul className="divide-y divide-border rounded-md border border-border" aria-label="Deployments">
          {deployments.map((d) => {
            const linked = d.botId === botId;
            return (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2" data-deployment={d.id}>
                <span className="min-w-0 text-sm">
                  <span className="font-medium text-ink">{d.symbol} · {d.timeframe}</span>{" "}
                  <span className="text-xs text-ink-muted">{d.delivery} · {d.status}</span>
                  {linkable(d) && !pathOk(d) && <span className="block text-xs text-warn">Its webhook URL does not end in {webhookPath}.</span>}
                  {d.botId && !linked && <span className="block text-xs text-ink-faint">Linked to another bot.</span>}
                </span>
                {linked ? <span className="text-xs font-medium text-up">Linked</span>
                  : linkable(d) ? <Button disabled={!canCommand || secretStored !== true}
                    title={!canCommand ? disabledReason : secretStored !== true ? "The secret is not held here yet." : undefined}
                    label={`Link ${d.symbol} ${d.timeframe}`} onClick={() => setTarget(d)}>Link…</Button>
                    : <span className="text-xs text-ink-faint">Not a Bot webhook</span>}
              </li>
            );
          })}
        </ul>}
      </div>
      <StepUpDialog open={target !== null} title={target ? `Link ${target.symbol} ${target.timeframe}` : "Link"} confirmLabel="Link"
        tier="grant" autoSubmit onCancel={() => setTarget(null)} onConfirm={confirm}
        intro={<p>The deployment&apos;s webhook secret is replaced by {botName}&apos;s, inside Trading Scene. Its next signal is signed with it.</p>} />
    </Card>
  );
}
