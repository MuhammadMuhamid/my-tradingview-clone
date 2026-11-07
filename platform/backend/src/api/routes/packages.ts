/**
 * Investor packages: the administrator's routes under /api/admin, and the three
 * an ordinary account may use.
 *
 * Recording money and changing a package's status ask the administrator to
 * re-enter a credential (`confirmIdentity`): the code from their app when
 * two-factor is on, otherwise their password. Joining a package asks the member
 * for a verified email and two-factor sign-in.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as packages from "../../repositories/packages";
import * as users from "../../repositories/users";
import { TERMS, type Term } from "../../packages/calendar";
import { userIdOf } from "../../security/requestUser";
import { confirmIdentity } from "./accountSecurity";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AMOUNT = /^\d{1,20}(\.\d{1,8})?$/;
const KEY = /^[A-Za-z0-9_-]{8,128}$/;

class BadInput extends Error {}

const text = (raw: unknown, name: string, max: number, required = true): string => {
  if (raw === undefined && !required) return "";
  if (typeof raw !== "string" || raw.length > max || (required && !raw.trim())) {
    throw new BadInput(`${name} is required and must be at most ${max} characters.`);
  }
  return raw.trim();
};
const amount = (raw: unknown, name: string): string => {
  if (typeof raw !== "string" || !AMOUNT.test(raw.trim())) throw new BadInput(`${name} must be a plain number, like 250 or 250.5.`);
  return raw.trim();
};
const id = (raw: unknown, name = "id"): string => {
  if (typeof raw !== "string" || !UUID.test(raw)) throw new BadInput(`${name} is not valid.`);
  return raw;
};
const idempotencyKey = (raw: unknown): string => {
  if (typeof raw !== "string" || !KEY.test(raw)) throw new BadInput("idempotencyKey must be 8 to 128 letters, digits, - or _.");
  return raw;
};

async function send<T>(reply: FastifyReply, action: () => Promise<T>) {
  try { return await action(); }
  catch (error) {
    if (error instanceof BadInput) return reply.code(400).send({ error: error.message });
    if (error instanceof packages.PackageRuleError) return reply.code(error.status).send({ error: error.message });
    const code = (error as { code?: string; constraint?: string }).code;
    const constraint = (error as { constraint?: string }).constraint ?? "";
    if (code === "23505" && /packages_name/.test(constraint)) return reply.code(409).send({ error: "A package with this name already exists." });
    if (code === "23505" && /deployment/.test(constraint)) return reply.code(409).send({ error: "That deployment already trades for a package." });
    if (code === "23P01") return reply.code(409).send({ error: "That cohort would overlap one this package already has." });
    if (code === "23503") return reply.code(400).send({ error: "Something this refers to doesn't exist." });
    throw error;
  }
}

/** The administrator re-enters a credential, or the action stops here. */
async function confirmed(req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
  const actor = userIdOf(req);
  const account = await users.getUser(actor);
  if (!account) { reply.code(401).send({ error: "not authenticated" }); return null; }
  const result = await confirmIdentity(account, (req.body ?? {}) as { password?: unknown; code?: unknown });
  if (result === "ok") return actor;
  if (result === "busy") { reply.code(429).send({ error: "Busy. Try again shortly." }); return null; }
  if (result === "wrong") {
    reply.code(400).send({ error: account.twoFactorEnabled ? "That code isn't correct." : "Your password isn't correct." });
    return null;
  }
  reply.header("retry-after", String(result.retryAfterSec));
  reply.code(429).send({ error: "Too many attempts. Try again in a few minutes." });
  return null;
}

export async function packageRoutes(app: FastifyInstance): Promise<void> {
  // ── the administrator ────────────────────────────────────────────────────

  app.get("/api/admin/packages", async (_req, reply) => send(reply, async () => ({ packages: await packages.listPackages() })));

  app.post("/api/admin/packages", async (req, reply) => send(reply, async () => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.term !== "string" || !TERMS.includes(body.term as Term)) throw new BadInput(`term must be one of ${TERMS.join(", ")}.`);
    const tradePercent = amount(body.tradePercent, "tradePercent");
    if (Number(tradePercent) <= 0 || Number(tradePercent) > 100) throw new BadInput("tradePercent must be above 0 and at most 100.");
    const packageId = await packages.createPackage({
      name: text(body.name, "name", 80), description: text(body.description, "description", 4000, false),
      term: body.term as Term, minAmount: amount(body.minAmount ?? "0", "minAmount"), tradePercent,
      joinInstructions: text(body.joinInstructions, "joinInstructions", 4000, false), actor: userIdOf(req),
    });
    return reply.code(201).send({ id: packageId });
  }));

  app.post("/api/admin/packages/:id/status", async (req, reply) => send(reply, async () => {
    const packageId = id((req.params as { id: string }).id);
    const status = (req.body as { status?: unknown } | null)?.status;
    if (status !== "active" && status !== "paused" && status !== "closed") throw new BadInput("status must be active, paused or closed.");
    const actor = await confirmed(req, reply);
    if (!actor) return reply;
    await packages.setPackageStatus(packageId, status, actor);
    return { ok: true };
  }));

  app.post("/api/admin/packages/:id/deployments", async (req, reply) => send(reply, async () => {
    const packageId = id((req.params as { id: string }).id);
    await packages.attachDeployment(packageId, id((req.body as { deploymentId?: unknown } | null)?.deploymentId, "deploymentId"), userIdOf(req));
    return reply.code(201).send({ ok: true });
  }));

  app.post("/api/admin/packages/:id/cohorts", async (req, reply) => send(reply, async () => {
    const cohortId = await packages.scheduleNextCohort(id((req.params as { id: string }).id), new Date());
    return reply.code(201).send({ id: cohortId });
  }));

  app.get("/api/admin/cohorts/:id", async (req, reply) => send(reply, async () =>
    packages.cohortDetail(id((req.params as { id: string }).id))));

  app.post("/api/admin/cohorts/:id/advance", async (req, reply) => send(reply, async () =>
    ({ status: await packages.advanceCohort(id((req.params as { id: string }).id)) })));

  app.post("/api/admin/cohorts/:id/members", async (req, reply) => send(reply, async () => {
    const cohortId = id((req.params as { id: string }).id);
    const email = text((req.body as { email?: unknown } | null)?.email, "email", 254);
    const user = await users.getUserByEmail(email);
    if (!user) throw new packages.PackageRuleError("No account has that email.", 404);
    return reply.code(201).send({ membershipId: await packages.addMember(user.id, cohortId, userIdOf(req)) });
  }));

  app.post("/api/admin/memberships/:id/decision", async (req, reply) => send(reply, async () => {
    const approve = (req.body as { approve?: unknown } | null)?.approve;
    if (typeof approve !== "boolean") throw new BadInput("approve must be true or false.");
    await packages.decideMembership(id((req.params as { id: string }).id), approve, userIdOf(req));
    return { ok: true };
  }));

  app.post("/api/admin/memberships/:id/deposits", async (req, reply) => send(reply, async () => {
    const membershipId = id((req.params as { id: string }).id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const input = {
      membershipId, amount: amount(body.amount, "amount"), reference: text(body.reference, "reference", 200),
      note: text(body.note, "note", 2000, false), idempotencyKey: idempotencyKey(body.idempotencyKey),
      lateReason: text(body.lateReason, "lateReason", 500, false) || undefined,
    };
    const actor = await confirmed(req, reply);
    if (!actor) return reply;
    const result = await packages.recordDeposit({ ...input, actor });
    return reply.code(result.created ? 201 : 200).send(result);
  }));

  app.post("/api/admin/memberships/:id/withdrawals", async (req, reply) => send(reply, async () => {
    const membershipId = id((req.params as { id: string }).id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const input = {
      membershipId, amount: amount(body.amount, "amount"), reference: text(body.reference, "reference", 200),
      note: text(body.note, "note", 2000, false), idempotencyKey: idempotencyKey(body.idempotencyKey),
    };
    const actor = await confirmed(req, reply);
    if (!actor) return reply;
    await packages.recordWithdrawal({ ...input, actor });
    return reply.code(201).send({ ok: true });
  }));

  app.get("/api/admin/audit", async (_req, reply) => send(reply, async () => ({ entries: await packages.listAudit() })));

  // ── an ordinary account ──────────────────────────────────────────────────

  app.get("/api/packages", async (_req, reply) => send(reply, async () => ({ packages: await packages.offeredPackages() })));

  app.post("/api/packages/cohorts/:id/join", async (req, reply) => send(reply, async () => {
    const cohortId = id((req.params as { id: string }).id);
    const account = await users.getUser(userIdOf(req));
    if (!account) return reply.code(401).send({ error: "not authenticated" });
    // The administrator counts as verified: it has no email (`publicUser`).
    const verified = account.role === "admin" || account.emailVerified;
    if (!verified || !account.twoFactorEnabled) {
      return reply.code(403).send({ error: "Verify your email and turn on two-factor sign-in in your profile first." });
    }
    if (!await packages.cohortIsJoinable(cohortId)) throw new packages.PackageRuleError("This package isn't taking members.");
    return reply.code(201).send({ membershipId: await packages.requestMembership(account.id, cohortId) });
  }));

  app.get("/api/portfolio", async (req, reply) => send(reply, async () => packages.myMemberships(userIdOf(req))));
}
