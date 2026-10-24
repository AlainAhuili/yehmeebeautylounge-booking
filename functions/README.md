# Cloud Run functions

Four small functions in the test project `yehmee-test-512401` (region `us-central1`) that
take work off the booking app on the VM. Each folder is its own package with its own tests
(`npm test` inside it).

```mermaid
flowchart LR
  app[Booking app<br/>VM] -->|email| mailq[(Pub/Sub<br/>yehmee-mail)] --> email[send-email] --> smtp[SMTP]
  psp[SumUp / PayPal] -->|HTTPS| hook[payment-webhook] --> payq[(Pub/Sub<br/>yehmee-payment-events)] -->|pull| app
  app -->|originals/| bucket[(Bucket<br/>…-media)] -->|upload event| resize[resize-image] -->|web/| bucket
  sched[Cloud Scheduler<br/>03:00 Berlin] --> backup[db-backup] -->|internal network| db[(MariaDB<br/>VM)]
  backup -->|db/*.sql.gz| backups[(Bucket<br/>…-backups, 30 days)]
```

| Function | Trigger | What it does |
| --- | --- | --- |
| `send-email` | Pub/Sub `yehmee-mail` | Sends the app's emails (booking confirmation, voucher code, password reset, refund note) over SMTP. Retries when sending fails. |
| `payment-webhook` | HTTPS, public | Address for SumUp (`/sumup`) and PayPal (`/paypal`) notifications. Passes the payment reference to the app, which asks the provider itself whether it was paid, so a booking is confirmed even if the customer closes the payment page. |
| `resize-image` | Upload to `…-media` | Writes `web/<kind>/<file>` (max. 1600 px, upright, no EXIF/GPS) for every `originals/<kind>/<file>` the app uploads. The app serves the web copy, or the original until the copy exists. |
| `db-backup` | Cloud Scheduler, nightly | Dumps the MariaDB database in one snapshot, as the read-only user `yehmee_backup`, to `gs://…-backups/db/yehmee-<time>.sql.gz`. Copies are deleted after 30 days. |

The app uses them only when these are set in `booking/.env` (`configure-vm.sh` sets them):
`MAIL_TOPIC`, `PAYMENT_EVENTS_SUBSCRIPTION`, `MEDIA_BUCKET`, `SUMUP_WEBHOOK_URL`. Without
them it behaves as before: emails are printed, photos stay in `data/uploads`.

## Deploy

```powershell
.\functions\deploy.ps1                       # setup, all four functions, VM settings
.\functions\deploy.ps1 -Only resize-image    # one function again
```

`setup` makes the VM's address static before it restarts the VM once to give it write
access to the media bucket.

## Sending real emails

Until the secret `yehmee-smtp-url` exists, `send-email` only logs each email. With a Gmail
account (2-step verification on, then Google Account → Security → App passwords):

```powershell
Set-Content -NoNewline smtp.txt "smtps://yehmeeeyes%40gmail.com:APP-PASSWORD@smtp.gmail.com:465"
gcloud secrets create yehmee-smtp-url --data-file smtp.txt --project yehmee-test-512401
Remove-Item smtp.txt
.\functions\deploy.ps1 -Only send-email
```

## Payment notifications

- **SumUp:** automatic. The app gives each checkout the webhook address (`SUMUP_WEBHOOK_URL`).
- **PayPal:** developer.paypal.com → the app → Webhooks → add `<payment-webhook URL>/paypal`
  with the events *Checkout order approved* and *Payment capture completed*. To have the
  function check PayPal's signature as well, set `PAYPAL_WEBHOOK_ID`, `PAYPAL_CLIENT_ID`,
  `PAYPAL_CLIENT_SECRET` (and `PAYPAL_ENV=live` for real payments) on the function.
- **Test checkout:** `POST <payment-webhook URL>/test` with `{"ref": "test_sumup_…"}`. Only
  while `ALLOW_TEST_EVENTS=true`; switch it off for production.

## Restoring a backup

```bash
gcloud storage cp gs://yehmee-test-512401-backups/db/yehmee-20261025-0100.sql.gz .
gunzip -c yehmee-20261025-0100.sql.gz | sudo mariadb yehmee
```

Run a backup now: `gcloud scheduler jobs run yehmee-db-backup-nightly --location us-central1`.
