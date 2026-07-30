#!/usr/bin/env bash
#
# Drive the machine over the wire protocol directly, with no CLI involved.
#
# The CLI is a convenience, not the interface. `POST /rpc` is plain JSON-RPC 2.0
# over HTTP, so anything that can make an HTTP request can drive the emulator —
# a language with no Node in sight, a CI step, or curl in a shell script.
#
# See docs/DEBUG-PROTOCOL.md for the full method list.

source "$(dirname "$0")/lib.sh"

say '1. Start a machine and find it the way any client would'

start_emulator

# A running emulator publishes where to reach it, so a client needs no
# configuration. ~/.6502/session.json is 0600 — it holds the token that
# authorises driving the machine and reading its CF image.
LOCK="${SIXTY5O2_HOME:-$HOME/.6502}/session.json"
show "cat $LOCK"
node -e '
  const lock = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
  // Everything except the token, which should not end up in a CI log.
  const { token, ...rest } = lock
  console.log(JSON.stringify({ ...rest, token: "(redacted)" }, null, 2))
' "$LOCK"

PORT=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).port)' "$LOCK")
TOKEN=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).token)' "$LOCK")

# A one-line JSON-RPC call. Two headers matter, and both are load-bearing:
#
#   Content-Type: application/json   Required. It is the one content type a web
#                                    page cannot send cross-origin without a
#                                    preflight, which this server never answers —
#                                    so it stops a page the user happens to have
#                                    open from firing commands at the machine.
#   Authorization: Bearer <token>    Optional on loopback, required otherwise.
rpc() {
  local method="$1" params="${2:-null}"
  curl -sS -X POST "http://127.0.0.1:$PORT/rpc" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $TOKEN" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$method\",\"params\":$params}"
}

say '2. Ask what the machine is'

show "curl -X POST http://127.0.0.1:\$PORT/rpc -H 'Content-Type: application/json' \\
    -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"session.info\"}'"
info=$(rpc session.info)
printf '%s\n' "$info" | node -e '
  let text = ""
  process.stdin.on("data", (c) => { text += c })
  process.stdin.on("end", () => console.log(JSON.stringify(JSON.parse(text).result, null, 2).slice(0, 400)))
'
expect_match 'it speaks protocol version 1' "$info" '"protocol":1'

say '3. Drive it: run, type a line, read the answer'

rpc exec.run '{"mode":"turbo"}' >/dev/null
rpc wait.for '{"serial":"OK","timeoutMs":30000}' >/dev/null

# serial.write returns the console cursor as it stood before the write, and
# wait.for takes it back — which is what makes "wait for the reply to what I just
# sent" correct even though the machine runs hundreds of thousands of cycles
# between the two calls.
cursor=$(rpc serial.write '{"data":"PRINT 6*7\r"}' | node -e '
  let text = ""
  process.stdin.on("data", (c) => { text += c })
  process.stdin.on("end", () => process.stdout.write(String(JSON.parse(text).result.cursor)))
')
printf '   console cursor at the moment of the write: %s\n' "$cursor"

reply=$(rpc wait.for "{\"serial\":\"OK\",\"since\":$cursor,\"timeoutMs\":20000}")
output=$(printf '%s' "$reply" | node -e '
  let text = ""
  process.stdin.on("data", (c) => { text += c })
  process.stdin.on("end", () => process.stdout.write(JSON.parse(text).result.output))
')
printf '%s\n' "$output"
expect_match 'BASIC answered 42' "$output" '^ 42$'

say '4. Read memory — bytes come back as base64'

read_result=$(rpc mem.read '{"address":"$0300","length":8}')
printf '%s\n' "$read_result"
expect_match 'the reply carries base64 data' "$read_result" '"data":"'

say '5. Errors are JSON-RPC errors, with codes a client can branch on'

# -32601 METHOD_NOT_FOUND, -32602 INVALID_PARAMS, -32000 NOT_SUPPORTED.
expect_match 'an unknown method' "$(rpc nonsense.method)" '"code":-32601'
expect_match 'a bad parameter' "$(rpc mem.read '{"address":"nowhere"}')" '"code":-32602'

say '6. The guards are real'

status=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/rpc" \
  -H 'Content-Type: text/plain' -H "Authorization: Bearer $TOKEN" -d '{}')
expect 'a request without the JSON content type' "$status" 415

status=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/rpc" \
  -H 'Content-Type: application/json' -H 'Origin: https://example.com' \
  -H "Authorization: Bearer $TOKEN" -d '{}')
expect 'a request carrying a browser Origin' "$status" 401

status=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/rpc" \
  -H 'Content-Type: application/json' -H 'Authorization: Bearer wrong' -d '{}')
expect 'a request with the wrong token' "$status" 401

status=$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/anything")
expect 'any other endpoint' "$status" 404

say 'Example 5 passed'
