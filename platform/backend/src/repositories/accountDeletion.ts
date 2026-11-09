/**
 * Deleting an account, genuinely (owner decision OD-6, migration 054).
 *
 * One transaction, with the account row and its membership rows locked:
 *  - refused (`membership_active`) while the account has an approved seat in a
 *    cohort that is open, running or settling, or money not settled to zero
 *    (`packages.membershipBlocksDeletion`);
 *  - memberships with no ledger rows (a join request, a rejection) are deleted;
 *  - the rest get one opaque `former_member_ref` and outlive the account with
 *    `user_id` NULL, so the append-only ledger keeps every amount;
 *  - the users row is deleted. Foreign keys do the rest (`tests/accountDeletionDb.test.ts`
 *    holds every one of them to its rule): watchlists, layouts, scripts,
 *    drawings, pane studies, push devices, alerts with their events and outbox,
 *    verification links, recovery codes, sign-in history and step-up grants go
 *    with it; `admin_audit.actor`, `ledger_entries.recorded_by`,
 *    `memberships.decided_by` and `packages.created_by` become NULL.
 *
 * Kept afterwards: audit rows naming the account only by its uuid in `target`
 * (no email or name is stored there), and the anonymous membership and ledger
 * rows for settled money.
 */
import { randomBytes } from "node:crypto";
import { pool } from "../db/pool";
import { membershipBlocksDeletion } from "./packages";

export type DeletionOutcome = "deleted" | "not_found" | "admin" | "membership_active";

/** A read-only look before asking for a credential, so a code is not spent on a refusal. */
export async function deletionBlocked(userId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    return await membershipBlocksDeletion(client, userId);
  } finally {
    client.release();
  }
}

export async function deleteAccount(userId: string): Promise<DeletionOutcome> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ role: string }>("SELECT role FROM users WHERE id = $1 FOR UPDATE", [userId]);
    if (!rows[0]) { await client.query("ROLLBACK"); return "not_found"; }
    if (rows[0].role === "admin") { await client.query("ROLLBACK"); return "admin"; }
    await client.query("SELECT id FROM memberships WHERE user_id = $1 FOR UPDATE", [userId]);
    if (await membershipBlocksDeletion(client, userId)) { await client.query("ROLLBACK"); return "membership_active"; }
    await client.query(
      `DELETE FROM memberships m WHERE m.user_id = $1
          AND NOT EXISTS (SELECT 1 FROM ledger_entries e WHERE e.membership_id = m.id)`, [userId]);
    await client.query("UPDATE memberships SET former_member_ref = $2 WHERE user_id = $1",
      [userId, `former-${randomBytes(4).toString("hex")}`]);
    const deleted = await client.query("DELETE FROM users WHERE id = $1 AND role <> 'admin'", [userId]);
    await client.query("COMMIT");
    return (deleted.rowCount ?? 0) > 0 ? "deleted" : "not_found";
  } catch (error) {
    await client.query("ROLLBACK").catch((rollbackError: Error) => { broken = rollbackError; });
    throw error;
  } finally {
    client.release(broken);
  }
}
