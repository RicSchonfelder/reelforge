#!/usr/bin/env bash
# Smoke test do Reelforge no servidor (roda localmente no host)
BASE="http://127.0.0.1:4170"
pass=0; fail=0

check() {
  local name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "ok   - $name ($actual)"
    pass=$((pass+1))
  else
    echo "FAIL - $name (esperado $expected, obtido $actual)"
    fail=$((fail+1))
  fi
}

code() { curl -s -o /tmp/reelforge-smoke.out -w "%{http_code}" "$@"; }

check "GET /api/overview" 200 "$(code "$BASE/api/overview")"
check "POST /api/agent/chat sem header (anti-CSRF)" 403 "$(code -X POST "$BASE/api/agent/chat" -H 'Content-Type: application/json' -d '{"message":"teste csrf"}')"
check "POST /api/agent/chat com header" 201 "$(code -X POST "$BASE/api/agent/chat" -H 'Content-Type: application/json' -H 'X-Reelforge-Client: 1' -d '{"message":"Verifique se ha novos videos no editor externo"}')"
check "POST com JSON array (rejeitado)" 400 "$(code -X POST "$BASE/api/agent/chat" -H 'Content-Type: application/json' -H 'X-Reelforge-Client: 1' -d '[1,2,3]')"
check "POST com corpo vazio" 400 "$(code -X POST "$BASE/api/agent/chat" -H 'Content-Type: application/json' -H 'X-Reelforge-Client: 1' -d '{}')"
check "GET /api/insights sem credenciais" 502 "$(code "$BASE/api/insights")"
check "GET / (index)" 200 "$(code "$BASE/")"
check "GET /app.js" 200 "$(code "$BASE/app.js")"
check "GET /styles.css" 200 "$(code "$BASE/styles.css")"
check "GET /api/creative-matrix" 200 "$(code "$BASE/api/creative-matrix")"
check "GET /api/timeline" 200 "$(code "$BASE/api/timeline")"
check "GET /api/editor" 200 "$(code "$BASE/api/editor")"
check "GET /api/agent/chat" 200 "$(code "$BASE/api/agent/chat")"
check "GET rota inexistente" 404 "$(code "$BASE/api/inexistente")"
check "GET traversal estatico" 404 "$(code --path-as-is "$BASE/../.env")"

echo "---"
echo "Resultado: $pass ok, $fail fail"
grep -o '"command"' /tmp/reelforge-smoke.out >/dev/null 2>&1
exit $fail
