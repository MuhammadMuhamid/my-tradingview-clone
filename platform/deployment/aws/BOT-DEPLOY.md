# Deploying the execution Bot

This puts the Bot on its own EC2 instance in `ap-south-1` and connects the
production Platform to it for **paper and testnet** manual trading. Every
command runs in AWS CloudShell through `bot-stack.sh`. It pairs Platform
`deploy/execution-bot` with Bot `76d17c5`.

Nothing here enables real-money orders. A first deployment is `DRY_RUN=true`,
and `MAINNET_MANUAL_TRADING_ENABLED` must stay `false`.

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
