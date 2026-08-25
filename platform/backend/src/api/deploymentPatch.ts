/**
 * Validation for editing an alert/deployment (PATCH /api/deployments/:id).
 * Rules mirror deployment creation, but every field is optional and the
 * merged (existing + patch) configuration must stay valid — e.g. switching
 * delivery to "custom" is rejected unless a webhook URL is already stored or
 * supplied in the same patch.
 */
import { deliversLiveOrders, type DeliveryMode, DeploymentRow } from "../types/deployments";
import { validateWebhookUrl } from "../alerts/dispatcher";

const DELIVERY_MODES: DeliveryMode[] = ["3commas", "custom", "off", "paper"];

export interface DeploymentPatchInput {
  delivery?: string;
  webhookUrl?: string;
  secret?: string;
  botUuid?: string;
  buyQuoteQty?: number;
}

export interface DeploymentPatch {
  delivery?: DeliveryMode;
  webhookUrl?: string;
  secret?: string;
  botUuid?: string;
  buyQuoteQty?: number;
}

export type PatchResult =
  | { ok: true; patch: DeploymentPatch }
  | { ok: false; error: string };

export function validateDeploymentPatch(
  existing: Pick<DeploymentRow, "delivery" | "webhookUrl" | "secret" | "botUuid" | "buyQuoteQty">,
  input: DeploymentPatchInput
): PatchResult {
  const patch: DeploymentPatch = {};

  if (input.delivery !== undefined) {
    if (!DELIVERY_MODES.includes(input.delivery as DeliveryMode)) {
      return { ok: false, error: `delivery must be one of ${DELIVERY_MODES.join(", ")}` };
    }
    patch.delivery = input.delivery as DeliveryMode;
  }

  if (input.webhookUrl !== undefined) {
    try {
      patch.webhookUrl = validateWebhookUrl(input.webhookUrl);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  if (input.secret !== undefined) {
    if (input.secret.length < 32) {
      return { ok: false, error: "a webhook secret of at least 32 characters is required" };
    }
    patch.secret = input.secret;
  }

  if (input.botUuid !== undefined) {
    if (!input.botUuid.trim()) return { ok: false, error: "botUuid must not be empty" };
    patch.botUuid = input.botUuid.trim();
  }

  if (input.buyQuoteQty !== undefined) {
    if (!Number.isFinite(input.buyQuoteQty) || input.buyQuoteQty <= 0 || input.buyQuoteQty > 10_000) {
      return { ok: false, error: "buyQuoteQty must be greater than 0 and at most 10000" };
    }
    patch.buyQuoteQty = input.buyQuoteQty;
  }

  // Cross-field rules on the merged configuration.
  const delivery = patch.delivery ?? existing.delivery;
  const webhookUrl = patch.webhookUrl ?? existing.webhookUrl;
  const secret = patch.secret ?? existing.secret;
  const botUuid = patch.botUuid ?? existing.botUuid;
  const buyQuoteQty = patch.buyQuoteQty ?? existing.buyQuoteQty;

  if (delivery === "custom" && !webhookUrl) {
    return { ok: false, error: "custom delivery requires webhookUrl" };
  }
  // `off` and `paper` make no outbound call, so they need no credential.
  if (deliversLiveOrders(delivery) && !secret) {
    return { ok: false, error: "a webhook secret of at least 32 characters is required" };
  }
  if (delivery === "paper" && (!Number.isFinite(buyQuoteQty ?? NaN) || (buyQuoteQty ?? 0) <= 0)) {
    return { ok: false, error: "paper delivery requires buyQuoteQty, the size to simulate" };
  }
  if (delivery === "3commas" && !botUuid) {
    return { ok: false, error: "3commas delivery requires botUuid" };
  }
  if (delivery === "custom" && (!Number.isFinite(buyQuoteQty ?? NaN) || (buyQuoteQty ?? 0) <= 0 || (buyQuoteQty ?? 0) > 10_000)) {
    return { ok: false, error: "buyQuoteQty must be greater than 0 and at most 10000" };
  }

  return { ok: true, patch };
}
