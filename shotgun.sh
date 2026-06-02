#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/home/chris/rundisney-queue"
PORT="${PORT:-3737}"
HOST="${HOST:-0.0.0.0}"
MAGICDNS_HOST="${SHOTGUN_MAGICDNS_HOST:-iris.taila6f62d.ts.net}"
PID_FILE="$APP_DIR/.shotgun.pid"
LOG_FILE="$APP_DIR/shotgun.log"
TOKEN_FILE="$APP_DIR/.shotgun-token"
PHONE_URL="http://${MAGICDNS_HOST}:${PORT}/iphone"

cd "$APP_DIR"

listening_pid() {
  lsof -tiTCP:"$PORT" -sTCP:LISTEN -n -P 2>/dev/null | head -n 1 || true
}

print_access() {
  echo "Shotgun URL: $PHONE_URL"
  echo "Local URL: http://localhost:${PORT}/iphone"
}

access_token() {
  if [[ -n "${SHOTGUN_ACCESS_TOKEN:-}" ]]; then
    printf '%s' "$SHOTGUN_ACCESS_TOKEN"
    return
  fi
  if [[ -n "${SHOTGUN_TOKEN:-}" ]]; then
    printf '%s' "$SHOTGUN_TOKEN"
    return
  fi
  if [[ -f "$TOKEN_FILE" ]]; then
    tr -d '\n' < "$TOKEN_FILE"
    return
  fi
  return 1
}

api_get() {
  local path="$1"
  local token sep
  token="$(access_token)" || {
    echo "Shotgun token file not found. Start Shotgun first." >&2
    return 1
  }
  sep="?"
  if [[ "$path" == *"?"* ]]; then
    sep="&"
  fi
  curl -sS "http://localhost:${PORT}${path}${sep}token=${token}" \
    -H "X-Shotgun-Token: ${token}"
}

print_summary() {
  api_get "/api/sessions" | node -e '
let body = "";
process.stdin.on("data", d => body += d);
process.stdin.on("end", () => {
  const data = JSON.parse(body);
  const sessions = data.sessions || [];
  const counts = sessions.reduce((acc, s) => {
    acc[s.status] = (acc[s.status] || 0) + 1;
    return acc;
  }, {});
  console.log(`Config: ${data.config.targetUrl} | count ${data.config.browserCount}`);
  console.log(`Sessions: ${sessions.length}` + (sessions.length ? ` (${Object.entries(counts).map(([k,v]) => `${k}:${v}`).join(", ")})` : ""));
  for (const s of sessions) {
    const bits = [s.name, s.status];
    if (s.waitInfo) bits.push(s.waitInfo);
    if (s.verified) bits.push("verified");
    console.log(`- ${bits.join(" | ")}`);
  }
});
'
}

print_queue_status() {
  api_get "/api/queue-status" | node -e '
let body = "";
process.stdin.on("data", d => body += d);
process.stdin.on("end", () => {
  const data = JSON.parse(body);
  if (data.error) {
    console.log(data.summary || data.error);
    return;
  }
  console.log(`State: ${data.state || "unknown"}`);
  if (data.session?.name) console.log(`Session: ${data.session.name}`);
  if (data.summary) console.log(data.summary);
  if (data.url) console.log(`URL: ${data.url}`);
});
'
}

case "${1:-start}" in
  start)
    if pid="$(listening_pid)"; [[ -n "$pid" ]]; then
      echo "Shotgun already appears to be running on port $PORT (pid $pid)."
      print_access
      exit 0
    fi

    echo "Starting Shotgun..."
    SHOTGUN_NO_OPEN=1 HOST="$HOST" PORT="$PORT" SHOTGUN_MAGICDNS_HOST="$MAGICDNS_HOST" \
      nohup npm start > "$LOG_FILE" 2>&1 &
    pid="$!"
    echo "$pid" > "$PID_FILE"

    for _ in {1..30}; do
      if listening_pid >/dev/null && [[ -n "$(listening_pid)" ]]; then
        echo "Shotgun started on port $PORT."
        print_access
        echo "Log: $LOG_FILE"
        exit 0
      fi
      sleep 0.5
    done

    echo "Shotgun did not begin listening on port $PORT within 15 seconds."
    echo "Log: $LOG_FILE"
    exit 1
    ;;

  status)
    if pid="$(listening_pid)"; [[ -n "$pid" ]]; then
      echo "Shotgun is running on port $PORT (pid $pid)."
      print_access
    else
      echo "Shotgun is not running on port $PORT."
    fi
    ;;

  summary)
    if pid="$(listening_pid)"; [[ -z "$pid" ]]; then
      echo "Shotgun is not running on port $PORT."
      exit 1
    fi
    print_access
    print_summary
    ;;

  queue)
    if pid="$(listening_pid)"; [[ -z "$pid" ]]; then
      echo "Shotgun is not running on port $PORT."
      exit 1
    fi
    print_queue_status
    ;;

  watch)
    interval="${2:-20}"
    cycles="${3:-0}"
    i=0
    if pid="$(listening_pid)"; [[ -z "$pid" ]]; then
      echo "Shotgun is not running on port $PORT."
      exit 1
    fi
    echo "Watching Shotgun every ${interval}s. Press Ctrl-C to stop."
    print_access
    while true; do
      echo
      date '+[%Y-%m-%d %H:%M:%S]'
      print_summary || true
      print_queue_status || true
      i=$((i + 1))
      if [[ "$cycles" != "0" && "$i" -ge "$cycles" ]]; then
        break
      fi
      sleep "$interval"
    done
    ;;

  doctor)
    echo "Shotgun doctor"
    echo "--------------"
    "$0" status
    echo
    echo "Tailscale:"
    if command -v tailscale >/dev/null 2>&1; then
      tailscale status --json 2>/dev/null | node -e '
let body = "";
process.stdin.on("data", d => body += d);
process.stdin.on("end", () => {
  const data = JSON.parse(body || "{}");
  console.log(`State: ${data.BackendState || "unknown"}`);
  console.log(`MagicDNS: ${data.Self?.DNSName || "unknown"}`);
  console.log(`IPs: ${(data.TailscaleIPs || []).join(", ") || "unknown"}`);
  if ((data.Health || []).length) console.log(`Health: ${data.Health.join(" | ")}`);
});
'
    else
      echo "tailscale command not found"
    fi
    echo
    echo "Dashboard:"
    curl -sS -L -o /dev/null -w 'HTTP %{http_code} %{url_effective}\n' "$PHONE_URL" || true
    ;;

  stop)
    pid=""
    if [[ -f "$PID_FILE" ]]; then
      pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    fi
    if [[ -z "$pid" ]]; then
      pid="$(listening_pid)"
    fi
    if [[ -z "$pid" ]]; then
      echo "Shotgun is not running on port $PORT."
      rm -f "$PID_FILE"
      exit 0
    fi

    echo "Stopping Shotgun (pid $pid)..."
    kill "$pid" 2>/dev/null || true
    rm -f "$PID_FILE"
    ;;

  logs)
    touch "$LOG_FILE"
    tail -n "${2:-80}" "$LOG_FILE"
    ;;

  *)
    echo "Usage: $0 [start|status|summary|queue|watch|doctor|stop|logs]"
    exit 2
    ;;
esac
