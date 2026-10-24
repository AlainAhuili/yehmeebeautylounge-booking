#!/bin/bash
# Connects the booking app on the test VM to the Cloud Run functions. Safe to run again.
#   sudo bash configure-vm.sh <backup-db-password> <media-bucket> <payment-webhook-url>
# Run by functions/deploy.ps1 (step "vm").
set -euo pipefail
PASS=$1
BUCKET=$2
WEBHOOK=$3
APP=/opt/yehmee/booking
META=http://metadata.google.internal/computeMetadata/v1/instance
INTERNAL_IP=$(curl -s -H Metadata-Flavor:Google "$META/network-interfaces/0/ip")

echo "== MariaDB also on the internal address $INTERNAL_IP (the VPC firewall keeps it off the internet)"
CONF=/etc/mysql/mariadb.conf.d/50-server.cnf
if ! grep -q "^bind-address *= *127.0.0.1,$INTERNAL_IP" "$CONF"; then
  sed -i "s/^bind-address.*/bind-address            = 127.0.0.1,$INTERNAL_IP/" "$CONF"
  systemctl restart mariadb
fi

echo "== Read-only user for db-backup, only from the functions' subnet"
mariadb -e "CREATE USER IF NOT EXISTS 'yehmee_backup'@'10.128.0.0/255.255.240.0' IDENTIFIED BY '$PASS';
  ALTER USER 'yehmee_backup'@'10.128.0.0/255.255.240.0' IDENTIFIED BY '$PASS';
  GRANT SELECT, SHOW VIEW ON yehmee.* TO 'yehmee_backup'@'10.128.0.0/255.255.240.0';"

echo "== App settings"
set_env() {
  if grep -q "^$1=" "$APP/.env"; then sed -i "s#^$1=.*#$1=$2#" "$APP/.env"; else echo "$1=$2" >> "$APP/.env"; fi
}
set_env MAIL_TOPIC yehmee-mail
set_env PAYMENT_EVENTS_SUBSCRIPTION yehmee-payment-events-app
set_env MEDIA_BUCKET "$BUCKET"
set_env SUMUP_WEBHOOK_URL "$WEBHOOK/sumup"

echo "== Photos uploaded so far → gs://$BUCKET/originals/ (resize-image makes the web copies)"
for kind in services gallery; do
  dir="$APP/data/uploads/$kind"
  if [ -d "$dir" ] && [ -n "$(ls -A "$dir")" ]; then
    gcloud storage cp --no-clobber "$dir"/* "gs://$BUCKET/originals/$kind/"
  fi
done

systemctl restart yehmee-booking
sleep 3
systemctl is-active yehmee-booking
journalctl -u yehmee-booking -n 6 --no-pager -o cat
