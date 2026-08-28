#!/bin/sh
# Picks which of the three services this container runs.
#
# `exec` in every branch so the service is PID 1 and receives SIGTERM
# directly. Without it the shell holds PID 1, swallows the signal, and the
# platform waits out its grace period before killing the container — which
# looks like a slow deploy and is actually a lost shutdown.
set -e

case "${SERVICE:-}" in
  agents)
    echo "starting the reference agents"
    exec node tools/reference-agents/dist/serve.js
    ;;

  explorer)
    echo "starting the explorer (API + UI)"
    exec node packages/explorer-api/dist/cli.js
    ;;

  indexer)
    # --v2 indexes the marketplace deployment: the v2 receipts contract and
    # the adapter registry that backs the directory.
    echo "starting the indexer"
    exec node packages/indexer/dist/cli.js --v2
    ;;

  "")
    echo "SERVICE is not set. Expected one of: agents, explorer, indexer." >&2
    exit 2
    ;;

  *)
    echo "unknown SERVICE '${SERVICE}'. Expected one of: agents, explorer, indexer." >&2
    exit 2
    ;;
esac
