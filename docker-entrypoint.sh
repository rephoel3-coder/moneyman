#!/bin/sh
set -e

# Default command
if [ "$#" -eq 0 ]; then
  set -- node dst/index.js
fi

# Some environments (e.g. antivirus/security software with HTTPS scanning,
# like ESET's SSL/TLS filtering) transparently intercept and re-sign all
# outbound TLS traffic with their own root CA. The host OS trusts that CA,
# but this container is an isolated environment that never sees it, so
# every HTTPS request - including the scraped bank sites - fails with
# ERR_CERT_AUTHORITY_INVALID. Mounting CA cert file(s) into /certs lets the
# container trust them too, matching what the host already trusts.
if [ -d /certs ]; then
  for cert in /certs/*; do
    [ -f "$cert" ] || continue
    cp "$cert" "/usr/local/share/ca-certificates/$(basename "$cert" | sed 's/\.[^.]*$//').crt"
  done
  update-ca-certificates
fi

if [ "$MONEYMAN_UNSAFE_STDOUT" = "true" ]; then
  if [ -n "$MONEYMAN_STDOUT_GREP" ]; then
    # Diagnostic aid: the CI job log API truncates to a fixed tail line
    # count regardless of total size, so a noisy multi-account run can push
    # an earlier account's trace out entirely. Filtering here keeps only
    # what's relevant, so it survives the truncation.
    exec "$@" 2>&1 | grep --line-buffered -iE "$MONEYMAN_STDOUT_GREP"
  else
    exec "$@"
  fi
else
  if [ -z "$MONEYMAN_LOG_FILE_PATH" ]; then
    MONEYMAN_LOG_FILE_PATH="/tmp/moneyman.log"
  fi
  export MONEYMAN_LOG_FILE_PATH

  export MONEYMAN_PUBLIC_LOG_FD="${MONEYMAN_PUBLIC_LOG_FD:-3}"
  PUBLIC_LOG_FD="${MONEYMAN_PUBLIC_LOG_FD}"

  # Duplicate stdout to the public log FD so public logs bypass redirection
  eval "exec ${PUBLIC_LOG_FD}>&1"

  exec "$@" > "$MONEYMAN_LOG_FILE_PATH" 2>&1
fi
