#!/usr/bin/env bash
#
# Run every example in order, reporting which pass.
#
# CI runs this. That is the point of the examples being scripts rather than
# fragments in a document: a command that stops working stops the build, instead
# of quietly misleading whoever copies it out of the README.

set -uo pipefail

cd "$(dirname "$0")"

# Each example needs the compiled CLI. Build once here rather than in every one.
if [ -z "${SIXTY502:-}" ]; then
  (cd .. && npm run build:cli --silent)
fi

failed=()
for example in [0-9][0-9]-*.sh; do
  printf '\n\033[1;36m════ %s ════\033[0m\n' "$example"
  if bash "$example"; then
    printf '\033[32m%s ok\033[0m\n' "$example"
  else
    printf '\033[31m%s FAILED\033[0m\n' "$example"
    failed+=("$example")
  fi
done

printf '\n\033[1m════ summary ════\033[0m\n'
if [ ${#failed[@]} -eq 0 ]; then
  printf '\033[32mall examples passed\033[0m\n'
  exit 0
fi

printf '\033[31m%d failed:\033[0m %s\n' "${#failed[@]}" "${failed[*]}"
exit 1
