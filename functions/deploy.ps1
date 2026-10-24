# Sets up and deploys the YehMee Cloud Run functions to the test project. Safe to run again:
# everything that exists already is left as it is, the functions are redeployed.
#   .\functions\deploy.ps1                 everything
#   .\functions\deploy.ps1 -Only resize-image
# Needs gcloud signed in as a project owner. See functions/README.md.
param(
  [string]$Project = "yehmee-test-512401",
  [string]$Region = "us-central1",
  [string]$Zone = "us-central1-a",
  [string]$Vm = "yehmee-test",
  [string]$MailFrom = "YehMee Beauty Lounge <yehmeeeyes@gmail.com>",
  [ValidateSet("", "setup", "send-email", "payment-webhook", "resize-image", "db-backup", "vm")] [string]$Only = "",
  [string]$SshUser = "alainroger_ahuili"
)
$ErrorActionPreference = "Stop"
$gcloud = Join-Path $env:LOCALAPPDATA "Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
$here = $PSScriptRoot
$work = Join-Path ([IO.Path]::GetTempPath()) "yehmee-deploy"
New-Item -ItemType Directory -Force $work | Out-Null

function G {
  # gcloud with the project; stops on failure. Native stderr is progress output, not an error.
  $ErrorActionPreference = "Continue"
  $out = & $gcloud @args --project $Project --quiet 2>&1
  if ($LASTEXITCODE) { $out | Write-Host; throw "gcloud $($args[0..2] -join ' ') failed" }
  $out | Where-Object { $_ -is [string] }
}
function Exists { $ErrorActionPreference = "Continue"; & $gcloud @args --project $Project --quiet 2>&1 | Out-Null; $LASTEXITCODE -eq 0 }
function Step($text) { Write-Host "== $text" -ForegroundColor Cyan }
function YamlFile($name, [hashtable]$values) {
  $path = Join-Path $work "$name.yaml"
  ($values.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name): '$($_.Value -replace "'", "''")'" }) -join "`n" | Set-Content -Encoding ascii $path
  $path
}

$number = (G projects describe $Project --format="value(projectNumber)").Trim()
$vmSa = "$number-compute@developer.gserviceaccount.com"
$sa = @{}
foreach ($n in "email", "webhook", "resize", "backup", "scheduler", "build") { $sa[$n] = "yehmee-fn-$n@$Project.iam.gserviceaccount.com" }
$media = "$Project-media"
$backups = "$Project-backups"
$mailTopic = "yehmee-mail"
$payTopic = "yehmee-payment-events"
$paySub = "yehmee-payment-events-app"
$dbSecret = "yehmee-backup-db-password"

if ($Only -in "", "setup") {
  Step "APIs"
  G services enable run.googleapis.com cloudfunctions.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com eventarc.googleapis.com pubsub.googleapis.com cloudscheduler.googleapis.com secretmanager.googleapis.com | Out-Null

  Step "Service accounts"
  $names = @{ email = "send-email function"; webhook = "payment-webhook function"; resize = "resize-image function"; backup = "db-backup function"; scheduler = "Cloud Scheduler for db-backup"; build = "builds the functions" }
  foreach ($n in $names.Keys) {
    if (-not (Exists iam service-accounts describe $sa[$n])) { G iam service-accounts create "yehmee-fn-$n" --display-name "YehMee $($names[$n])" | Out-Null }
  }
  foreach ($role in "roles/cloudbuild.builds.builder", "roles/logging.logWriter", "roles/artifactregistry.writer", "roles/storage.objectViewer") {
    G projects add-iam-policy-binding $Project --member "serviceAccount:$($sa.build)" --role $role --condition None | Out-Null
  }
  # Event-triggered functions are invoked through Eventarc with their own account
  foreach ($n in "email", "resize") {
    G projects add-iam-policy-binding $Project --member "serviceAccount:$($sa[$n])" --role roles/eventarc.eventReceiver --condition None | Out-Null
  }
  # Cloud Storage publishes the upload events that start resize-image
  G projects add-iam-policy-binding $Project --member "serviceAccount:service-$number@gs-project-accounts.iam.gserviceaccount.com" --role roles/pubsub.publisher --condition None | Out-Null

  Step "Pub/Sub"
  if (-not (Exists pubsub topics describe $mailTopic)) { G pubsub topics create $mailTopic | Out-Null }
  if (-not (Exists pubsub topics describe $payTopic)) { G pubsub topics create $payTopic | Out-Null }
  if (-not (Exists pubsub subscriptions describe $paySub)) {
    G pubsub subscriptions create $paySub --topic $payTopic --ack-deadline 60 --message-retention-duration 7d --expiration-period never | Out-Null
  }
  G pubsub topics add-iam-policy-binding $mailTopic --member "serviceAccount:$vmSa" --role roles/pubsub.publisher | Out-Null
  G pubsub topics add-iam-policy-binding $payTopic --member "serviceAccount:$($sa.webhook)" --role roles/pubsub.publisher | Out-Null
  G pubsub subscriptions add-iam-policy-binding $paySub --member "serviceAccount:$vmSa" --role roles/pubsub.subscriber | Out-Null

  Step "Buckets"
  if (-not (Exists storage buckets describe "gs://$media")) {
    G storage buckets create "gs://$media" --location $Region --uniform-bucket-level-access --public-access-prevention | Out-Null
  }
  if (-not (Exists storage buckets describe "gs://$backups")) {
    G storage buckets create "gs://$backups" --location $Region --uniform-bucket-level-access --public-access-prevention | Out-Null
  }
  $lifecycle = Join-Path $work "lifecycle.json"
  '{"rule":[{"action":{"type":"Delete"},"condition":{"age":30}}]}' | Set-Content -Encoding ascii $lifecycle
  G storage buckets update "gs://$backups" --lifecycle-file $lifecycle | Out-Null
  G storage buckets add-iam-policy-binding "gs://$media" --member "serviceAccount:$vmSa" --role roles/storage.objectAdmin | Out-Null
  G storage buckets add-iam-policy-binding "gs://$media" --member "serviceAccount:$($sa.resize)" --role roles/storage.objectAdmin | Out-Null
  G storage buckets add-iam-policy-binding "gs://$backups" --member "serviceAccount:$($sa.backup)" --role roles/storage.objectCreator | Out-Null

  Step "Backup database user"
  if (-not (Exists secrets describe $dbSecret)) {
    $bytes = New-Object byte[] 24; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $password = -join ($bytes | ForEach-Object { $_.ToString("x2") })
    $file = Join-Path $work "dbpass.txt"; [IO.File]::WriteAllText($file, $password)
    G secrets create $dbSecret --replication-policy automatic --data-file $file | Out-Null
    Remove-Item $file
  }
  G secrets add-iam-policy-binding $dbSecret --member "serviceAccount:$($sa.backup)" --role roles/secretmanager.secretAccessor | Out-Null
}

if ($Only -in "", "setup") {
  Step "VM: static IP, access to Pub/Sub and the media bucket"
  $ip = (G compute instances describe $Vm --zone $Zone --format="value(networkInterfaces[0].accessConfigs[0].natIP)").Trim()
  if (-not (Exists compute addresses describe yehmee-test-ip --region $Region)) {
    # Promote the current address, so stopping the VM below does not change it
    G compute addresses create yehmee-test-ip --region $Region --addresses $ip | Out-Null
  }
  $scopes = G compute instances describe $Vm --zone $Zone --format="value(serviceAccounts[0].scopes)"
  if ($scopes -notmatch "devstorage.read_write") {
    Write-Host "   restarting the VM to change its access scopes (about a minute)"
    G compute instances stop $Vm --zone $Zone | Out-Null
    G compute instances set-service-account $Vm --zone $Zone --service-account $vmSa --scopes "storage-rw,pubsub,logging-write,monitoring-write,service-control,service-management,trace" | Out-Null
    G compute instances start $Vm --zone $Zone | Out-Null
  }
}

$base = @("--gen2", "--runtime", "nodejs24", "--region", $Region, "--build-service-account", "projects/$Project/serviceAccounts/$($sa.build)")

if ($Only -in "", "send-email") {
  Step "send-email"
  $envFile = YamlFile "send-email" @{ MAIL_FROM = $MailFrom }
  $secret = if (Exists secrets describe yehmee-smtp-url) { @("--set-secrets", "SMTP_URL=yehmee-smtp-url:latest") } else { @() }
  if ($secret) { G secrets add-iam-policy-binding yehmee-smtp-url --member "serviceAccount:$($sa.email)" --role roles/secretmanager.secretAccessor | Out-Null }
  else { Write-Host "   no yehmee-smtp-url secret yet: emails are logged, not sent (see functions/README.md)" }
  G functions deploy yehmee-send-email @base --source "$here\send-email" --entry-point sendEmail `
    --trigger-topic $mailTopic --retry --service-account $sa.email --trigger-service-account $sa.email `
    --env-vars-file $envFile @secret --memory 256Mi --max-instances 3 | Out-Null
}

if ($Only -in "", "payment-webhook") {
  Step "payment-webhook"
  $envFile = YamlFile "payment-webhook" @{ PAYMENT_EVENTS_TOPIC = $payTopic; ALLOW_TEST_EVENTS = "true" }
  G functions deploy yehmee-payment-webhook @base --source "$here\payment-webhook" --entry-point paymentWebhook `
    --trigger-http --allow-unauthenticated --service-account $sa.webhook `
    --env-vars-file $envFile --memory 256Mi --max-instances 3 | Out-Null
}

if ($Only -in "", "resize-image") {
  Step "resize-image"
  G functions deploy yehmee-resize-image @base --source "$here\resize-image" --entry-point resizeImage `
    --trigger-bucket $media --service-account $sa.resize --trigger-service-account $sa.resize `
    --memory 1Gi --cpu 1 --max-instances 3 | Out-Null
}

if ($Only -in "", "db-backup") {
  Step "db-backup"
  $dbHost = (G compute instances describe $Vm --zone $Zone --format="value(networkInterfaces[0].networkIP)").Trim()
  $envFile = YamlFile "db-backup" @{ DB_HOST = $dbHost; DB_USER = "yehmee_backup"; DB_NAME = "yehmee"; BACKUP_BUCKET = $backups }
  G functions deploy yehmee-db-backup @base --source "$here\db-backup" --entry-point dbBackup `
    --trigger-http --no-allow-unauthenticated --service-account $sa.backup `
    --network default --subnet default --egress-settings private-ranges-only `
    --env-vars-file $envFile --set-secrets "DB_PASSWORD=$($dbSecret):latest" --memory 512Mi --timeout 300 --max-instances 1 | Out-Null
  $url = (G functions describe yehmee-db-backup --region $Region --format="value(serviceConfig.uri)").Trim()
  G functions add-invoker-policy-binding yehmee-db-backup --region $Region --member "serviceAccount:$($sa.scheduler)" | Out-Null

  Step "Nightly schedule (03:00 Berlin time)"
  $job = @("yehmee-db-backup-nightly", "--location", $Region, "--schedule", "0 3 * * *", "--time-zone", "Europe/Berlin", "--uri", $url, "--http-method", "POST", "--oidc-service-account-email", $sa.scheduler, "--oidc-token-audience", $url, "--attempt-deadline", "320s")
  if (Exists scheduler jobs describe yehmee-db-backup-nightly --location $Region) { G scheduler jobs update http @job | Out-Null }
  else { G scheduler jobs create http @job | Out-Null }
}

if ($Only -in "", "vm") {
  Step "VM: connect the booking app (functions/configure-vm.sh)"
  $pass = (G secrets versions access latest --secret $dbSecret).Trim()
  $hook = (G functions describe yehmee-payment-webhook --region $Region --format="value(serviceConfig.uri)").Trim()
  # Scripts go over with Unix line endings; the wrapper holds the password and deletes itself
  $script = Join-Path $work "configure-vm.sh"
  [IO.File]::WriteAllText($script, ([IO.File]::ReadAllText("$here\configure-vm.sh") -replace "`r`n", "`n"))
  $wrapper = Join-Path $work "yehmee-vm.sh"
  [IO.File]::WriteAllText($wrapper, "#!/bin/bash`nset -e`ntrap 'rm -f /tmp/yehmee-vm.sh /tmp/configure-vm.sh' EXIT`nbash /tmp/configure-vm.sh '$pass' '$media' '$hook'`n")
  G compute scp $script $wrapper "$($SshUser)@$($Vm):/tmp/" --zone $Zone | Out-Null
  Remove-Item $wrapper
  G compute ssh "$($SshUser)@$Vm" --zone $Zone --command "sudo bash /tmp/yehmee-vm.sh"
}

Step "Done"
G functions list --regions $Region --format="table(name,state,environment,eventTrigger.eventType)"
