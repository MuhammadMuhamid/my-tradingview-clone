import crypto from "node:crypto";
import pg from "pg";

const EXPECTED_HASH = "1ead2e165543f986aad90dd1269bb92f49527733f20b2a9216a14d423bcdf39d";
const key = crypto.createHash("sha256").update(process.env.ALERT_ENCRYPTION_KEY ?? "").digest();
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const decrypt = (value) => {
  if (!value?.startsWith("enc:")) return value;
  const raw = Buffer.from(value.slice(4), "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
};

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const selected = await pool.query(`
  SELECT d.symbol,d.status,d.delivery,d.webhook_url,d.secret,d.buy_quote_qty,d.timeframe,s.key strategy_key,
         d.runtime_state->>'position' position
  FROM deployments d JOIN strategies s ON s.id=d.strategy_id
  WHERE d.timeframe='15m' AND s.key='mtf_lean' ORDER BY d.symbol
`);
const legacy = await pool.query("SELECT count(*)::int n FROM deployments WHERE secret IS NOT NULL AND secret NOT LIKE 'enc:%'");
const duplicate = await pool.query("SELECT symbol,timeframe,count(*)::int n FROM deployments WHERE status='active' GROUP BY symbol,timeframe HAVING count(*)>1");
const leakedPayload = await pool.query("SELECT count(*)::int n FROM alerts WHERE payload ? 'secret' AND payload->>'secret' <> '[REDACTED]'");
const delivery = await pool.query("SELECT delivery_status,count(*)::int n FROM alerts GROUP BY delivery_status ORDER BY delivery_status");
const recentFailures = await pool.query("SELECT count(*)::int n FROM alerts WHERE delivery_status='failed' AND fired_at > now()-interval '24 hours'");
const recentFailureReasons = await pool.query(`
  SELECT coalesce(http_status::text, 'none') http_status,
         left(coalesce(response_body, ''), 180) response,
         count(*)::int n
  FROM alerts
  WHERE delivery_status='failed' AND fired_at > now()-interval '24 hours'
  GROUP BY 1,2 ORDER BY n DESC LIMIT 10
`);
const secretMatches = selected.rows.filter((r) => hash(decrypt(r.secret) ?? "") === EXPECTED_HASH).length;
const failures = [];
if (selected.rows.length !== 14) failures.push(`expected 14 MTF Lean 15m deployments; found ${selected.rows.length}`);
if (secretMatches !== selected.rows.length) failures.push(`secret mismatch on ${selected.rows.length-secretMatches} MTF Lean 15m deployments`);
if (selected.rows.some((r) => !r.secret?.startsWith("enc:"))) failures.push("one or more selected secrets are not encrypted at rest");
if (selected.rows.some((r) => r.status !== "active" || r.delivery !== "custom")) failures.push("one or more selected deployments are not active/custom");
if (selected.rows.some((r) => r.webhook_url !== "https://bot.alphawebstudioz.com/api/webhooks/signal_bots")) failures.push("one or more selected webhook URLs differ");
if (selected.rows.some((r) => Number(r.buy_quote_qty) !== 70.01)) failures.push("one or more selected buy amounts differ from 70.01");
if (legacy.rows[0].n) failures.push(`${legacy.rows[0].n} plaintext deployment credentials remain`);
if (duplicate.rows.length) failures.push("duplicate active symbol/timeframe deployments exist");
if (leakedPayload.rows[0].n) failures.push(`${leakedPayload.rows[0].n} alert payloads contain an unredacted secret`);
console.log(JSON.stringify({
  selected15m: selected.rows.length,
  selectedSymbols: selected.rows.map((r) => r.symbol),
  expectedSecretMatches: secretMatches,
  encryptedAtRest: selected.rows.filter((r) => r.secret?.startsWith("enc:")).length,
  correctWebhookUrl: selected.rows.filter((r) => r.webhook_url === "https://bot.alphawebstudioz.com/api/webhooks/signal_bots").length,
  correctBuyAmount: selected.rows.filter((r) => Number(r.buy_quote_qty) === 70.01).length,
  duplicateActive: duplicate.rows,
  alertDeliveryTotals: delivery.rows,
  failedLast24h: recentFailures.rows[0].n,
  recentFailureReasons: recentFailureReasons.rows,
  failures,
}, null, 2));
await pool.end();
