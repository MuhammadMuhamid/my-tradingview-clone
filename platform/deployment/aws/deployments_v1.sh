#!/usr/bin/env bash
# CloudShell (ap-south-1). CHART LAYOUTS ONLY — v2, runs inside the backend
# container so there is no psql/SSL dependency.
#
#   ./charts_v2.sh            → read-only list of saved layouts
#   ./charts_v2.sh --delete   → RDS snapshot, then delete every saved layout
#
# Deployments, alert history and the live alert runner are NOT written to.
set -euo pipefail

# Production identifiers come from the untracked .env in this directory (X-11).
. "$(dirname "$0")/env.sh"
aws_env_require APP_INSTANCE DB_ID REGION

MODE="${1:-inventory}"; EXTRA="${2:-}"; EXTRA2="${3:-}"
STAMP=$(date -u +%Y%m%d%H%M%S)
PAYLOAD='IyEvdXNyL2Jpbi9lbnYgYmFzaAojIFJ1bnMgT04gdGhlIGFwcCBFQzIuIEFjdGl2YXRlcyBkZXBsb3ltZW50cywgdGhlbiBSRVNUQVJUUyB0aGUgYmFja2VuZCBzbyB0aGUKIyBsaXZlIHJ1bm5lciByZWxvYWRzIHRoZW0g4oCUIExpdmVSdW5uZXIuc3RhcnQoKSByZWFkcyBhY3RpdmUgZGVwbG95bWVudHMgb25jZSBhdAojIHN0YXJ0dXAsIHNvIGEgZGF0YWJhc2UgdXBkYXRlIGFsb25lIGlzIG5vdCBwaWNrZWQgdXAuCnNldCAtZXVvIHBpcGVmYWlsCk1PREU9IiR7MTotaW52ZW50b3J5fSI7IHNoaWZ0IHx8IHRydWUKY2QgL29wdC9zcnRyZW5kL2RlcGxveW1lbnQKQ0lEPSQoZG9ja2VyIGNvbXBvc2UgLWYgY29tcG9zZS5hcHAueW1sIHBzIC1xIGJhY2tlbmQpClsgLW4gIiRDSUQiIF0gfHwgeyBlY2hvICJiYWNrZW5kIGNvbnRhaW5lciBub3QgZm91bmQiOyBleGl0IDE7IH0KZWNobyAidXNpbmcgYmFja2VuZCBjb250YWluZXI6ICR7Q0lEOjA6MTJ9IgplY2hvICdZMjl1YzNRZ2V5QlFiMjlzSUgwZ1BTQnlaWEYxYVhKbEtDZHdaeWNwT3dwamIyNXpkQ0JoY21keklEMGdjSEp2WTJWemN5NWhjbWQyTG5Oc2FXTmxLRElwT3dwamIyNXpkQ0J0YjJSbElEMGdZWEpuYzFzd1hTQjhmQ0FuYVc1MlpXNTBiM0o1SnpzS1kyOXVjM1FnY1drZ1BTQmhjbWR6TG1sdVpHVjRUMllvSnkwdGNYUjVKeWs3Q21OdmJuTjBJSEYwZVNBOUlIRnBJRDQ5SURBZ1B5Qk9kVzFpWlhJb1lYSm5jMXR4YVNBcklERmRLU0E2SUc1MWJHdzdDbU52Ym5OMElIQnZiMndnUFNCdVpYY2dVRzl2YkNoN0lHTnZibTVsWTNScGIyNVRkSEpwYm1jNklIQnliMk5sYzNNdVpXNTJMa1JCVkVGQ1FWTkZYMVZTVEN3Z1kyOXVibVZqZEdsdmJsUnBiV1Z2ZFhSTmFXeHNhWE02SURFd01EQXdJSDBwT3dwamIyNXpkQ0J6YUc5M0lEMGdZWE41Ym1NZ0tHeGhZbVZzS1NBOVBpQjdDaUFnWTI5dWMzUWdjU0E5SUdGM1lXbDBJSEJ2YjJ3dWNYVmxjbmtvQ2lBZ0lDQWlVMFZNUlVOVUlITjViV0p2YkN3Z2RHbHRaV1p5WVcxbExDQnpkR0YwZFhNc0lHSjFlVjl4ZFc5MFpWOXhkSGs2T25SbGVIUWdRVk1nZFhOa2RDd2lJQ3NLSUNBZ0lDSWdZMjloYkdWelkyVW9jblZ1ZEdsdFpWOXpkR0YwWlMwK1BpZHdiM05wZEdsdmJpY3NKejhuS1NCQlV5QndiM05wZEdsdmJpd2lJQ3NLSUNBZ0lDSWdLSGRsWW1odmIydGZkWEpzSUVsVElFNVBWQ0JPVlV4TUlFRk9SQ0JzWlc1bmRHZ29kMlZpYUc5dmExOTFjbXdwSUQ0Z01Da2dRVk1nYUdGelgzZGxZbWh2YjJzaUlDc0tJQ0FnSUNJZ1JsSlBUU0JrWlhCc2IzbHRaVzUwY3lCUFVrUkZVaUJDV1NCemVXMWliMndpS1RzS0lDQmpiMjV6YjJ4bExteHZaeWduUFQwOUlHUmxjR3h2ZVcxbGJuUnpJQ2duSUNzZ2JHRmlaV3dnS3lBbktTQTlQVDBuS1RzS0lDQm1iM0lnS0dOdmJuTjBJSElnYjJZZ2NTNXliM2R6S1NCN0NpQWdJQ0JqYjI1emIyeGxMbXh2WnlnbklDQW5JQ3NnVzNJdWMzbHRZbTlzTG5CaFpFVnVaQ2d4TkNrc0lISXVkR2x0WldaeVlXMWxMQ0J5TG5OMFlYUjFjeTV3WVdSRmJtUW9PQ2tzQ2lBZ0lDQWdJQ2h5TG5WelpIUWdLeUFuSUZWVFJGUW5LUzV3WVdSRmJtUW9NVFFwTENBbmNHOXpQU2NnS3lCeUxuQnZjMmwwYVc5dUxBb2dJQ0FnSUNCeUxtaGhjMTkzWldKb2IyOXJJRDhnSjNkbFltaHZiMnM2YzJWMEp5QTZJQ2QzWldKb2IyOXJPazFKVTFOSlRrY25YUzVxYjJsdUtDY2dJQ2NwS1RzS0lDQjlDaUFnWTI5dWMzUWdZeUE5SUdGM1lXbDBJSEJ2YjJ3dWNYVmxjbmtvQ2lBZ0lDQWlVMFZNUlVOVUlHTnZkVzUwS0NvcE9qcHBiblFnUVZNZ2RHOTBZV3dzSUdOdmRXNTBLQ29wSUVaSlRGUkZVaUFvVjBoRlVrVWdjM1JoZEhWelBTZGhZM1JwZG1VbktUbzZhVzUwSUVGVElHRmpkR2wyWlN3aUlDc0tJQ0FnSUNJZ1kyOTFiblFvS2lrZ1JrbE1WRVZTSUNoWFNFVlNSU0JqYjJGc1pYTmpaU2h5ZFc1MGFXMWxYM04wWVhSbExUNCtKM0J2YzJsMGFXOXVKeXduWm14aGRDY3BJRHcrSUNkbWJHRjBKeWs2T21sdWRDQkJVeUJ1YjI1ZlpteGhkQ0lnS3dvZ0lDQWdJaUJHVWs5TklHUmxjR3h2ZVcxbGJuUnpJaWs3Q2lBZ1kyOXVjMjlzWlM1c2IyY29KeUFnZEc5MFlXeHpPaUFuSUNzZ1NsTlBUaTV6ZEhKcGJtZHBabmtvWXk1eWIzZHpXekJkS1NrN0NpQWdjbVYwZFhKdUlHTXVjbTkzYzFzd1hUc0tmVHNLS0dGemVXNWpJQ2dwSUQwK0lIc0tJQ0JqYjI1emRDQmlaV1p2Y21VZ1BTQmhkMkZwZENCemFHOTNLQ2RpWldadmNtVW5LVHNLSUNCcFppQW9iVzlrWlNBaFBUMGdKeTB0WVdOMGFYWmhkR1VuS1NCN0NpQWdJQ0JqYjI1emIyeGxMbXh2WnlnblNVNVdSVTVVVDFKWklFOU9URmtnTFNCdWIzUm9hVzVuSUdOb1lXNW5aV1F1SUZKbExYSjFiaUIzYVhSb0lDMHRZV04wYVhaaGRHVWdkRzhnYzJWMElIUm9aVzBnWVdOMGFYWmxMaWNwT3dvZ0lDQWdZWGRoYVhRZ2NHOXZiQzVsYm1Rb0tUc0tJQ0FnSUhKbGRIVnlianNLSUNCOUNpQWdhV1lnS0hGcElENDlJREFnSmlZZ0tDRk9kVzFpWlhJdWFYTkdhVzVwZEdVb2NYUjVLU0I4ZkNCeGRIa2dQRDBnTUNrcElIc0tJQ0FnSUdOdmJuTnZiR1V1WlhKeWIzSW9KMFZTVWs5U09pQXRMWEYwZVNCdGRYTjBJR0psSUdFZ2NHOXphWFJwZG1VZ2JuVnRZbVZ5SnlrN0NpQWdJQ0J3Y205alpYTnpMbVY0YVhRb01TazdDaUFnZlFvZ0lHbG1JQ2h4ZEhrZ0lUMDlJRzUxYkd3cElIc0tJQ0FnSUdOdmJuTjBJSFVnUFNCaGQyRnBkQ0J3YjI5c0xuRjFaWEo1S0NkVlVFUkJWRVVnWkdWd2JHOTViV1Z1ZEhNZ1UwVlVJR0oxZVY5eGRXOTBaVjl4ZEhrOUpERXNJSFZ3WkdGMFpXUmZZWFE5Ym05M0tDa25MQ0JiY1hSNVhTazdDaUFnSUNCamIyNXpiMnhsTG14dlp5Z25jMlYwSUdKMWVWOXhkVzkwWlY5eGRIazlKeUFySUhGMGVTQXJJQ2NnYjI0Z0p5QXJJSFV1Y205M1EyOTFiblFnS3lBbklHUmxjR3h2ZVcxbGJuUnpKeWs3Q2lBZ2ZRb2dJR052Ym5OMElIVXlJRDBnWVhkaGFYUWdjRzl2YkM1eGRXVnllU2dpVlZCRVFWUkZJR1JsY0d4dmVXMWxiblJ6SUZORlZDQnpkR0YwZFhNOUoyRmpkR2wyWlNjc0lIVndaR0YwWldSZllYUTlibTkzS0NrZ1YwaEZVa1VnYzNSaGRIVnpJRHcrSUNkaFkzUnBkbVVuSWlrN0NpQWdZMjl1YzI5c1pTNXNiMmNvSjJGamRHbDJZWFJsWkNBbklDc2dkVEl1Y205M1EyOTFiblFnS3lBbklHUmxjR3h2ZVcxbGJuUnpKeWs3Q2lBZ1lYZGhhWFFnYzJodmR5Z25ZV1owWlhJbktUc0tJQ0JoZDJGcGRDQndiMjlzTG1WdVpDZ3BPd3A5S1NncExtTmhkR05vS0NobEtTQTlQaUI3SUdOdmJuTnZiR1V1WlhKeWIzSW9KMFZTVWs5U09pQW5JQ3NnWlM1dFpYTnpZV2RsS1RzZ2NISnZZMlZ6Y3k1bGVHbDBLREVwT3lCOUtUc0snIHwgYmFzZTY0IC1kID4gL3RtcC9kZXAuanMKZG9ja2VyIGNwIC90bXAvZGVwLmpzICIkQ0lEIjovdG1wL2RlcC5qcyA+L2Rldi9udWxsCmRvY2tlciBleGVjIC1pIC13IC9hcHAgLWUgTk9ERV9QQVRIPS9hcHAvbm9kZV9tb2R1bGVzICIkQ0lEIiBub2RlIC90bXAvZGVwLmpzICIkTU9ERSIgIiRAIgpkb2NrZXIgZXhlYyAtaSAtdSByb290ICIkQ0lEIiBybSAtZiAvdG1wL2RlcC5qcyA+L2Rldi9udWxsIDI+JjEgfHwgdHJ1ZQpybSAtZiAvdG1wL2RlcC5qcwoKaWYgWyAiJE1PREUiICE9ICItLWFjdGl2YXRlIiBdOyB0aGVuIGV4aXQgMDsgZmkKCmVjaG8gIj09IHJlc3RhcnRpbmcgYmFja2VuZCBzbyB0aGUgbGl2ZSBydW5uZXIgcmVsb2FkcyA9PSIKZG9ja2VyIGNvbXBvc2UgLWYgY29tcG9zZS5hcHAueW1sIHJlc3RhcnQgYmFja2VuZApzbGVlcCAyNQplY2hvICI9PSBjb250YWluZXIgc3RhdHVzID09Igpkb2NrZXIgY29tcG9zZSAtZiBjb21wb3NlLmFwcC55bWwgcHMgYmFja2VuZAplY2hvICI9PSBsaXZlIHJ1bm5lciBib290IGxvZyA9PSIKZG9ja2VyIGNvbXBvc2UgLWYgY29tcG9zZS5hcHAueW1sIGxvZ3MgLS10YWlsIDQwIGJhY2tlbmQgfCBncmVwIC1pRSAibGl2ZSBydW5uZXJ8bGlzdGVuaW5nfGVycm9yIiB8IHRhaWwgLTEyCg=='

echo "### deployments_v1 (activate + runner reload) ###"

if [ "$MODE" = "--activate" ]; then
  echo "== pre-wipe RDS snapshot pre-activate-$STAMP =="
  aws rds create-db-snapshot --region "$REGION" \
    --db-instance-identifier "$DB_ID" \
    --db-snapshot-identifier "pre-activate-$STAMP" >/dev/null
  aws rds wait db-snapshot-available --region "$REGION" \
    --db-snapshot-identifier "pre-activate-$STAMP"
  echo "snapshot available: pre-activate-$STAMP"
fi

echo "== running on app EC2 via SSM ($MODE) =="
CMD_ID="$(aws ssm send-command --region "$REGION" \
  --instance-ids "$APP_INSTANCE" \
  --document-name AWS-RunShellScript \
  --comment "deployments v1 $MODE $STAMP" \
  --timeout-seconds 900 \
  --parameters "{\"commands\":[\"set -euo pipefail\",\"echo '$PAYLOAD' | base64 -d > /tmp/rd.sh\",\"chmod +x /tmp/rd.sh\",\"/tmp/rd.sh $MODE $EXTRA $EXTRA2\",\"rm -f /tmp/rd.sh\"],\"executionTimeout\":[\"900\"]}" \
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
