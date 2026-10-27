#!/bin/sh
# Eval runner: reviews one materialised eval workspace headlessly with the
# quality-loop review skill and writes its verified findings to $QL_OUTPUT.
#
# ql eval run sets: QL_WORKSPACE (cwd), QL_BASE, QL_OUTPUT, QL_INTENT,
# QL_PLUGIN_ROOT, and QL_DEPTH with --depth. It never names the case.
# Optional: QL_MODEL, QL_DEPTH, QL_EFFORT. An inherited QL_DEPTH is checked
# and recorded as the run's depth, like --depth.
set -eu

: "${QL_BASE:?QL_BASE is not set}"
: "${QL_OUTPUT:?QL_OUTPUT is not set}"
: "${QL_PLUGIN_ROOT:?QL_PLUGIN_ROOT is not set}"

prompt="/quality-loop:review --base $QL_BASE --out $QL_OUTPUT"
if [ -n "${QL_DEPTH:-}" ]; then prompt="$prompt --depth $QL_DEPTH"; fi
if [ -n "${QL_INTENT:-}" ]; then prompt="$prompt Intent of the change: $QL_INTENT"; fi

set -- -p --plugin-dir "$QL_PLUGIN_ROOT" \
  --allowedTools=Read,Write,Edit,Bash,Agent,Skill,Glob,Grep
if [ -n "${QL_MODEL:-}" ]; then set -- "$@" --model "$QL_MODEL"; fi
if [ -n "${QL_EFFORT:-}" ]; then set -- "$@" --effort "$QL_EFFORT"; fi

claude "$@" "$prompt" < /dev/null
test -s "$QL_OUTPUT"
