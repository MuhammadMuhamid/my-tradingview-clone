import crypto from "node:crypto";
import pg from "pg";

const secret = process.env.WEBHOOK_SECRET ?? "";
const encryptionKey = process.env.ALERT_ENCRYPTION_KEY ?? "";
if (secret.length < 32) throw new Error("WEBHOOK_SECRET missing or too short");
if (encryptionKey.length < 32) throw new Error("ALERT_ENCRYPTION_KEY missing or too short");

const expected = [
  "DEXEUSDT", "SYNUSDT", "ZECUSDT", "ALLOUSDT", "KAITOUSDT", "JTOUSDT",
  "TAOUSDT", "PUMPUSDT", "EIGENUSDT", "JSTUSDT", "JUPUSDT", "INJUSDT",
  "PYTHUSDT", "TIAUSDT",
];
const key = crypto.createHash("sha256").update(encryptionKey).digest();
const encrypt = (value) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `enc:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64")}`;
};
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const before = await client.query(
    `SELECT d.id,d.symbol,d.secret FROM deployments d
     JOIN strategies s ON s.id=d.strategy_id
     WHERE d.timeframe='15m' AND s.key='mtf_lean' FOR UPDATE`
  );
  const symbols = before.rows.map((r) => r.symbol).sort();
  if (symbols.length !== expected.length || expected.some((s) => !symbols.includes(s))) {
    throw new Error(`15m deployment set mismatch: ${symbols.join(",")}`);
  }
  const encrypted = encrypt(secret);
  await client.query(
    `UPDATE deployments d SET secret=$1,updated_at=now()
     FROM strategies s
     WHERE d.strategy_id=s.id AND d.timeframe='15m' AND s.key='mtf_lean'`,
    [encrypted]
  );
  await client.query("COMMIT");
  console.log(JSON.stringify({ updated: symbols.length, symbols, expectedSecretHash: hash(secret) }));
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
