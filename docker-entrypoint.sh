#!/bin/sh
set -e

# Default command
if [ "$#" -eq 0 ]; then
  set -- node dst/index.js
fi

if [ "$MONEYMAN_UNSAFE_STDOUT" = "true" ]; then
  exec "$@"
else
  if [ -z "$MONEYMAN_LOG_FILE_PATH" ]; then
    MONEYMAN_LOG_FILE_PATH="/tmp/moneyman.log"
  fi
  export MONEYMAN_LOG_FILE_PATH

  export MONEYMAN_PUBLIC_LOG_FD="${MONEYMAN_PUBLIC_LOG_FD:-3}"
  PUBLIC_LOG_FD="${MONEYMAN_PUBLIC_LOG_FD}"

  # Duplicate stdout to the public log FD so public logs bypass redirection
  eval "exec ${PUBLIC_LOG_FD}>&1"

  # TEMPORARY diagnostic (see commit message): report whether
  # getFailureScreenShotPath()'s screenshots actually got written to
  # /tmp/moneyman, since a mounted volume showed zero files despite a
  # failed scrape. Only file names/sizes are logged, never image content.
  set +e
  "$@" > "$MONEYMAN_LOG_FILE_PATH" 2>&1
  status=$?
  set -e

  if [ -d /tmp/moneyman ]; then
    echo "[diagnostic] /tmp/moneyman contents:" >&"$PUBLIC_LOG_FD"
    find /tmp/moneyman -exec ls -la {} \; >&"$PUBLIC_LOG_FD" 2>&1
  else
    echo "[diagnostic] /tmp/moneyman does not exist" >&"$PUBLIC_LOG_FD"
  fi

  exit "$status"
fi
