#!/usr/bin/env bash
# Runs in AWS CloudShell (ap-south-1). CHART LAYOUTS ONLY.
#
#   ./wipe_charts.sh            → read-only list of saved layouts
#   ./wipe_charts.sh --delete   → RDS snapshot, then delete every saved layout
#
# Deployments, alert history and the live alert runner are NOT touched.
set -euo pipefail

# Production identifiers come from the untracked .env in this directory (X-11).
. "$(dirname "$0")/env.sh"
aws_env_require APP_INSTANCE DB_ID REGION

MODE="${1:-inventory}"
STAMP=$(date -u +%Y%m%d%H%M%S)
PAYLOAD='IyEvdXNyL2Jpbi9lbnYgYmFzaAojIFJ1bnMgT04gdGhlIGFwcCBFQzIuIFRvdWNoZXMgY2hhcnRfbGF5b3V0cyBPTkxZLgpzZXQgLWV1byBwaXBlZmFpbApNT0RFPSIkezE6LWludmVudG9yeX0iCmNkIC9vcHQvc3J0cmVuZC9kZXBsb3ltZW50CnNldCAtYTsgLiAuLy5lbnY7IHNldCArYSAgICAgICAgICAjIERBVEFCQVNFX1VSTCDigJQgbmV2ZXIgZWNob2VkCgojIERBVEFCQVNFX1VSTCB1c2VzIHNzbG1vZGU9dmVyaWZ5LWZ1bGwsIHNvIHBzcWwgbmVlZHMgdGhlIFJEUyByb290IENBLiBGZXRjaAojIEFtYXpvbidzIHJlZ2lvbmFsIGJ1bmRsZSBhbmQgcG9pbnQgbGlicHEgYXQgaXQgdmlhIFBHU1NMUk9PVENFUlQg4oCUIHRoaXMga2VlcHMKIyBmdWxsIGNlcnRpZmljYXRlIHZlcmlmaWNhdGlvbiByYXRoZXIgdGhhbiBkb3duZ3JhZGluZyBzc2xtb2RlLgpDQT0vdG1wL3Jkcy1jYS1hcC1zb3V0aC0xLnBlbQppZiBbICEgLXMgIiRDQSIgXTsgdGhlbgogIGN1cmwgLWZzUyAtbyAiJENBIiBodHRwczovL3RydXN0c3RvcmUucGtpLnJkcy5hbWF6b25hd3MuY29tL2FwLXNvdXRoLTEvYXAtc291dGgtMS1idW5kbGUucGVtCmZpCmVjaG8gInJkcyBjYSBidW5kbGU6ICQod2MgLWMgPCAiJENBIikgYnl0ZXMiCgpQU1FMPShkb2NrZXIgcnVuIC0tcm0gLWkgLWUgUEdTU0xST09UQ0VSVD0vcmRzLWNhLnBlbSAtdiAiJENBIjovcmRzLWNhLnBlbTpybwogICAgICBwb3N0Z3JlczoxNi1hbHBpbmUgcHNxbCAiJERBVEFCQVNFX1VSTCIgLXYgT05fRVJST1JfU1RPUD0xKQoKZWNobyAiPT09IHNhdmVkIGNoYXJ0IGxheW91dHMgPT09IgoiJHtQU1FMW0BdfSIgLVAgcGFnZXI9b2ZmIC1jICIKU0VMRUNUIG5hbWUsIHN5bWJvbCwgdGltZWZyYW1lLCBzdHJhdGVneV9rZXksIHVwZGF0ZWRfYXQ6OmRhdGUgQVMgdXBkYXRlZApGUk9NIGNoYXJ0X2xheW91dHMgT1JERVIgQlkgdXBkYXRlZF9hdCBERVNDOyIKQkVGT1JFPSQoIiR7UFNRTFtAXX0iIC10IC1BIC1jICJTRUxFQ1QgY291bnQoKikgRlJPTSBjaGFydF9sYXlvdXRzOyIgfCB0ciAtZCAnWzpzcGFjZTpdJykKZWNobyAidG90YWwgbGF5b3V0czogJEJFRk9SRSIKCmVjaG8gIj09PSB1bnRvdWNoZWQgKHJlYWQtb25seSwgZm9yIHJlZmVyZW5jZSkgPT09IgoiJHtQU1FMW0BdfSIgLVAgcGFnZXI9b2ZmIC1jICIKU0VMRUNUIChTRUxFQ1QgY291bnQoKikgRlJPTSBkZXBsb3ltZW50cykgQVMgZGVwbG95bWVudHMsCiAgICAgICAoU0VMRUNUIGNvdW50KCopIEZST00gZGVwbG95bWVudHMgV0hFUkUgc3RhdHVzPSdhY3RpdmUnKSBBUyBhY3RpdmUsCiAgICAgICAoU0VMRUNUIGNvdW50KCopIEZST00gYWxlcnRzKSBBUyBhbGVydF9oaXN0b3J5OyIKCmlmIFsgIiRNT0RFIiAhPSAiLS1kZWxldGUiIF07IHRoZW4KICBlY2hvICJJTlZFTlRPUlkgT05MWSDigJQgbm90aGluZyBjaGFuZ2VkLiBSZS1ydW4gd2l0aCAtLWRlbGV0ZSB0byByZW1vdmUgYWxsIGxheW91dHMuIgogIGV4aXQgMApmaQoKZWNobyAiPT09IGRlbGV0aW5nIEFMTCAkQkVGT1JFIGNoYXJ0IGxheW91dHMgPT09IgoiJHtQU1FMW0BdfSIgLWMgIkRFTEVURSBGUk9NIGNoYXJ0X2xheW91dHM7IgpBRlRFUj0kKCIke1BTUUxbQF19IiAtdCAtQSAtYyAiU0VMRUNUIGNvdW50KCopIEZST00gY2hhcnRfbGF5b3V0czsiIHwgdHIgLWQgJ1s6c3BhY2U6XScpCmVjaG8gImxheW91dHM6ICRCRUZPUkUgLT4gJEFGVEVSIgplY2hvICI9PT0gY29uZmlybWluZyBkZXBsb3ltZW50cy9hbGVydHMgdW50b3VjaGVkID09PSIKIiR7UFNRTFtAXX0iIC1QIHBhZ2VyPW9mZiAtYyAiClNFTEVDVCAoU0VMRUNUIGNvdW50KCopIEZST00gZGVwbG95bWVudHMpIEFTIGRlcGxveW1lbnRzLAogICAgICAgKFNFTEVDVCBjb3VudCgqKSBGUk9NIGRlcGxveW1lbnRzIFdIRVJFIHN0YXR1cz0nYWN0aXZlJykgQVMgYWN0aXZlLAogICAgICAgKFNFTEVDVCBjb3VudCgqKSBGUk9NIGFsZXJ0cykgQVMgYWxlcnRfaGlzdG9yeTsiClsgIiRBRlRFUiIgPSAiMCIgXSB8fCB7IGVjaG8gInVuZXhwZWN0ZWQ6IGxheW91dHMgcmVtYWluIjsgZXhpdCAxOyB9CmVjaG8gIkNIQVJUUyBDTEVBUkVEIgo='

if [ "$MODE" = "--delete" ]; then
  echo "== pre-wipe RDS snapshot pre-charts-$STAMP =="
  aws rds create-db-snapshot --region "$REGION" \
    --db-instance-identifier "$DB_ID" \
    --db-snapshot-identifier "pre-charts-$STAMP" >/dev/null
  aws rds wait db-snapshot-available --region "$REGION" \
    --db-snapshot-identifier "pre-charts-$STAMP"
  echo "snapshot available: pre-charts-$STAMP"
fi

echo "== running on app EC2 via SSM ($MODE) =="
CMD_ID="$(aws ssm send-command --region "$REGION" \
  --instance-ids "$APP_INSTANCE" \
  --document-name AWS-RunShellScript \
  --comment "chart layouts $MODE $STAMP" \
  --timeout-seconds 900 \
  --parameters "{\"commands\":[\"set -euo pipefail\",\"echo '$PAYLOAD' | base64 -d > /tmp/charts.sh\",\"chmod +x /tmp/charts.sh\",\"/tmp/charts.sh $MODE\",\"rm -f /tmp/charts.sh\"],\"executionTimeout\":[\"900\"]}" \
  --query 'Command.CommandId' --output text)"
echo "ssm command: $CMD_ID"

STATUS=InProgress
while [ "$STATUS" = InProgress ] || [ "$STATUS" = Pending ] || [ "$STATUS" = Delayed ]; do
  sleep 10
  STATUS="$(aws ssm get-command-invocation --region "$REGION" \
    --command-id "$CMD_ID" --instance-id "$APP_INSTANCE" \
    --query 'Status' --output text 2>/dev/null || echo InProgress)"
  echo "  $(date -u +%H:%M:%S) $STATUS"
done

echo "== output ($STATUS) =="
aws ssm get-command-invocation --region "$REGION" \
  --command-id "$CMD_ID" --instance-id "$APP_INSTANCE" \
  --query 'StandardOutputContent' --output text
if [ "$STATUS" != Success ]; then
  echo "== stderr =="
  aws ssm get-command-invocation --region "$REGION" \
    --command-id "$CMD_ID" --instance-id "$APP_INSTANCE" \
    --query 'StandardErrorContent' --output text | tail -30
  exit 1
fi
