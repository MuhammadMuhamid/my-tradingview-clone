# Deploying the execution Bot

This puts the Bot on its own EC2 instance in `ap-south-1` and connects the
production Platform to it for **paper and testnet** manual trading. Every
command runs in AWS CloudShell through `bot-stack.sh`, which pins the Bot commit
in `BOT_SHA`. [OPERATIONS §7](../../../docs/OPERATIONS.md) lists the known pairs.

Nothing here enables real-money orders. A first deployment is `DRY_RUN=true`,
and `MAINNET_MANUAL_TRADING_ENABLED` must stay `false`.

**Status (2026-11-05):** steps 1–9 are done on production and the temporary DNS
override below has been removed. See [OPERATIONS §10](../../../docs/OPERATIONS.md).

## Before you start

1. Deploy the Platform release that contains this file, using the normal flow.
   Older releases don't pass the `MANUAL_TRADING_*` settings to the backend.
   This release changes nothing until `platform-on` is run.
2. Upload `bot-stack.sh` to CloudShell.
3. Run the read-only check:

   ```bash
   bash bot-stack.sh inventory
   ```

   `bot.alphawebstudioz.com` already points at an address that doesn't answer.
   If that address or a `signal-bot` instance belongs to this account, it may
   hold real exchange keys and trade history. Decide what happens to it first.
   `launch` refuses to continue while a `signal-bot` instance exists, unless
   `ALLOW_OLD_BOT=yes` is set.

   **This check only matches the tag `signal-bot`.** It doesn't catch the old
   server tagged `tradingbot`, which must stay stopped because it may hold real
   keys and live settings. Read the `inventory` output yourself.

   Repointing the DNS name also redirects any Platform alert or deployment
   that delivers to it. The new Bot has different webhook secrets, so it rejects
   them, but those deliveries will show as failed.

## Steps

| Step | Command | What it does |
|---|---|---|
| 1 | `bash bot-stack.sh launch` | Creates two secrets, a narrow IAM role, a security group (80 and 443 only), the instance, and an Elastic IP. Also lets the Platform role read the shared key. |
| 2 | Hostinger DNS | Set the A record `bot` to the printed IP, and wait for it to resolve. |
| 3 | `bash bot-stack.sh deploy` | Wait a few minutes for the instance to finish booting, then run this. It builds and starts the Bot. |
| 4 | `bash bot-stack.sh verify` | Expect health 200, manual route 403, and `DRY_RUN=true`. |
| 5 | `bash bot-stack.sh setup-token` | Prints the one-time token. Open `https://bot.alphawebstudioz.com`, create the Bot account, and scan the TOTP code. |
| 6 | `bash bot-stack.sh finish-setup` | Removes the token, which closes registration. |
| 7 | Bot dashboard | **Settings → Exchange account**: add keys from `testnet.binance.vision` and tick **Use Binance testnet**. |
| 8 | `bash bot-stack.sh platform-on` | Connects the Platform and restarts its backend. |
| 9 | `/chart` as admin | Open **Trade**. It should show **PAPER SIMULATION** and the testnet account. |

## Updating a running Bot

Push the Bot commit, set `BOT_SHA` in `bot-stack.sh` to it, then run
`bash bot-stack.sh deploy`. Update the Bot before a Platform release that reads new
Bot routes. Otherwise those pages show an error until the Bot catches up.

## If DNS still shows the old address

A changed record can stay cached for hours, and `platform-on` holds back while the
Platform resolves the wrong address. Check the authoritative answer first. On
2026-11-04, flushing the server's resolver didn't help.

If you can't wait, pin the address in the Platform backend. In
`/opt/srtrend/deployment`, create `compose.bot-dns.yml`:

```yaml
services:
  backend:
    extra_hosts:
      - "bot.alphawebstudioz.com:<bot-elastic-ip>"
```

Start the backend with `-f compose.app.yml -f compose.bot-dns.yml`.

The pin is lost by a Platform deploy, `platform-on`, `platform-off`, or any compose
command that names `compose.app.yml` alone. If DNS is still stale by then, Trade says
"The execution bot could not be reached".

Remove the pin once the server resolves the new address:

```bash
docker compose --env-file .env -f compose.app.yml up -d backend
rm compose.bot-dns.yml
```

CloudShell can also resolve this name wrongly. If only CloudShell disagrees with the
authoritative answer and both servers, a session-only `/etc/hosts` entry gets `deploy`
through.

## Undoing it

- Disconnect the Platform: `bash bot-stack.sh platform-off`
- Stop the Bot and keep its data: `bash bot-stack.sh stop-bot`

Stop-loss and take-profit polling doesn't run while the Bot is stopped. The
script has no delete command. The instance's disk is kept even if the instance
is terminated, so remove it in the console when you no longer need it.

## Before any real money

- Run testnet orders with `DRY_RUN=false`, then check halts, Shariah refusals,
  TP/SL, and a Bot restart. None of this has been run against an exchange yet.
- Schedule `scripts/backup-db.sh`. The Bot's database and the encrypted API keys
  exist only on this instance's disk until you do.
- Note that the Trade ticket currently offers testnet accounts only. Mainnet
  orders need a code change as well as the Bot's mainnet setting.

## Checks after a change to this script

```bash
bash -n platform/deployment/aws/bot-stack.sh
platform/scripts/release.sh gate --peer-bot-root /path/to/bot
```
