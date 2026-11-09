/**
 * Turn two-factor sign-in off for one account from the server, for an
 * administrator who has lost both their authenticator and their recovery
 * codes (owner decision OD-2). There is deliberately no way to do this from
 * the app: whoever runs this already holds the database.
 *
 *   local:    cd platform/backend && npm run reset-admin-2fa -- <user-id | --admin>
 *   deployed: docker exec -i <backend> node dist/scripts/resetAdmin2fa.js <user-id | --admin>
 *
 * In one transaction it clears the TOTP secret, its enabled time and last-used
 * step, deletes the recovery codes and every step-up grant, bumps the session
 * version (every session of the account ends, so whoever held one must sign
 * in again) and appends an `admin_audit` row `auth.2fa.reset` with actor NULL
 * (no signed-in account did it). A running server may keep its cached view of
 * the account for up to 15 seconds (`security/requestUser.ts`).
 *
 * It prints the account id and the new session version, never a secret.
 */
import { closePool, pool } from "../db/pool";
import { appendAdminAudit } from "../repositories/adminAudit";
import { ADMIN_USER_ID } from "../repositories/users";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The account id named on the command line, or null when the arguments are not exactly one id or `--admin`. */
export function targetOf(argv: readonly string[]): string | null {
  const args = argv.filter((a) => a !== "--");
  if (args.length !== 1) return null;
  const only = args[0]!;
  if (only === "--admin") return ADMIN_USER_ID;
  return UUID.test(only) ? only.toLowerCase() : null;
}

export async function resetTwoFactor(userId: string): Promise<{ found: false } | { found: true; sessionVersion: number }> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ role: string }>("SELECT role FROM users WHERE id = $1 FOR UPDATE", [userId]);
    if (!rows[0]) {
      await client.query("ROLLBACK");
      return { found: false };
    }
    const updated = await client.query<{ session_version: number }>(
      `UPDATE users SET totp_secret_enc = NULL, totp_enabled_at = NULL, totp_last_step = 0,
              session_version = session_version + 1
        WHERE id = $1 RETURNING session_version`, [userId]);
    await client.query("DELETE FROM totp_recovery_codes WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM step_up_grants WHERE user_id = $1", [userId]);
    await appendAdminAudit(null, "auth.2fa.reset", `user:${userId}`,
      { role: rows[0].role, by: "server_script" }, client);
    await client.query("COMMIT");
    return { found: true, sessionVersion: updated.rows[0]!.session_version };
  } catch (error) {
    await client.query("ROLLBACK").catch((rollbackError: Error) => { broken = rollbackError; });
    throw error;
  } finally {
    client.release(broken);
  }
}

async function main(): Promise<number> {
  const target = targetOf(process.argv.slice(2));
  if (!target) {
    console.error("usage: npm run reset-admin-2fa -- <user-id | --admin>");
    return 2;
  }
  const result = await resetTwoFactor(target);
  if (!result.found) {
    console.error(`no account ${target}`);
    return 1;
  }
  console.log(`two-factor sign-in is off for ${target}; every session ended (session version ${result.sessionVersion}).`);
  console.log("Sign in with the password, then turn two-factor on again from the profile.");
  return 0;
}

if (require.main === module) {
  main()
    .then(async (code) => { await closePool(); process.exit(code); })
    .catch(async (error: Error) => {
      console.error(`reset failed: ${error.message}`);
      await closePool().catch(() => undefined);
      process.exit(1);
    });
}
