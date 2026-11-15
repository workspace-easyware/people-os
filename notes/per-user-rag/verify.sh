#!/usr/bin/env bash
# 개인별 RAG 격리 로컬 검증 (2026-11-15)
# - wrangler dev --local (http://127.0.0.1:8787) 기준. 프록시 env 해제하고 curl을 쓴다.
# - 로컬에는 Vectorize가 없어 /api/ask는 D1 폴백 경로(d1-text)로 돈다.
#   Vectorize user_id 필터 경로는 로컬에서 검증 불가 → 원격에서 부모가 검증.
# - Secure 쿠키는 curl이 http로 다시 안 보내므로, Set-Cookie에서 토큰을 뽑아
#   -H "Cookie: people_os_session=<token>" 으로 직접 보낸다.
# - 사용법: bash notes/per-user-rag/verify.sh
set -u
cd "$(dirname "$0")/../.." || exit 1
export PATH="$HOME/.local/bin:$PATH"
BASE="http://127.0.0.1:8787"
LOG="notes/per-user-rag/verify.log"
: > "$LOG"
PASS=0; FAIL=0
note() { echo "$*" | tee -a "$LOG"; }
ok()   { PASS=$((PASS+1)); note "PASS: $*"; }
bad()  { FAIL=$((FAIL+1)); note "FAIL: $*"; }
chk()  { # chk <label> <condition-command...>
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$label"; else bad "$label"; fi
}
# curl -s + 프록시 해제
C() { env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY curl -s "$@"; }
# 토큰 추출: Set-Cookie 헤더에서 people_os_session 값만 뽑는다
tok_of() { grep -i '^set-cookie:' | sed -n 's/.*people_os_session=\([a-f0-9]*\).*/\1/p' | head -1; }

note "== 0. health =="
C "$BASE/api/health" | tee -a "$LOG" | grep -q '"ok":true' && ok "health ok" || bad "health ok"

note "== 1. bootstrap admin (이미 있으면 로그인) =="
ADMIN_JSON=$(C -i -X POST "$BASE/api/bootstrap" -H 'Content-Type: application/json' -d '{"secret":"test-bootstrap-local-only","email":"hr.jhkang@gmail.com","name":"강준호","password":"TestAdmin-2026-local"}')
echo "$ADMIN_JSON" >> "$LOG"
ADMIN_ID=$(echo "$ADMIN_JSON" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
ADMIN_TOK=$(echo "$ADMIN_JSON" | tok_of)
if [ -z "$ADMIN_TOK" ]; then
  note "bootstrap 409 (이미 존재) → admin 로그인으로 전환"
  LOGIN_JSON=$(C -i -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"email":"hr.jhkang@gmail.com","password":"TestAdmin-2026-local"}')
  echo "$LOGIN_JSON" >> "$LOG"
  ADMIN_ID=$(echo "$LOGIN_JSON" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
  ADMIN_TOK=$(echo "$LOGIN_JSON" | tok_of)
fi
[ -n "$ADMIN_ID" ] && [ -n "$ADMIN_TOK" ] && ok "admin 세션 id=$ADMIN_ID" || bad "admin 세션"
ADMIN_CK="Cookie: people_os_session=$ADMIN_TOK"

note "== 1b. backfill (원격 순서 시뮬레이션: 관리자 생성 후 이관 UPDATE 재실행) =="
npx wrangler d1 execute people-os-db --local --command "UPDATE documents SET owner_id = (SELECT id FROM users WHERE email = 'hr.jhkang@gmail.com') WHERE kind = 'transcript' AND owner_id IS NULL; UPDATE recordings SET owner_id = (SELECT id FROM users WHERE email = 'hr.jhkang@gmail.com') WHERE owner_id IS NULL;" >> "$LOG" 2>&1
TR_N=$(npx wrangler d1 execute people-os-db --local --command "SELECT COUNT(*) AS n FROM documents WHERE kind='transcript' AND owner_id IS NOT NULL;" 2>&1 | grep -o '"n": [0-9]*' | head -1 | grep -o '[0-9]*')
note "transcript docs with owner: n=$TR_N (expect >= 2: 기존 2건 + 이후 생성분)"
[ "${TR_N:-0}" -ge 2 ] && ok "기존 전사본 이관됨 (n=$TR_N)" || bad "기존 전사본 이관 (got n=$TR_N)"

note "== 2. 사용자 A·B 생성 + 비밀번호 설정 + 로그인 =="
ask() { # ask <cookie-header-or-empty> <session> <question> -> prints body
  local ck="$1" sess="$2" q="$3"
  if [ -n "$ck" ]; then C -X POST "$BASE/api/ask" -H "$ck" -H 'Content-Type: application/json' -d "{\"question\":\"$q\",\"sessionId\":\"$sess\",\"force\":true}";
  else C -X POST "$BASE/api/ask" -H 'Content-Type: application/json' -d "{\"question\":\"$q\",\"sessionId\":\"$sess\",\"force\":true}"; fi
}
mkuser() { # mkuser <email> <name> -> prints TOKEN (이미 있으면 로그인)
  local email="$1" name="$2"
  local resp setup tok
  resp=$(C -X POST "$BASE/api/admin/users" -H "$ADMIN_CK" -H 'Content-Type: application/json' -d "{\"email\":\"$email\",\"name\":\"$name\",\"role\":\"user\"}")
  echo "$resp" >> "$LOG"
  setup=$(echo "$resp" | grep -o '#setup=[a-f0-9]*' | cut -d= -f2)
  if [ -z "$setup" ]; then
    # 이미 존재하면 기존 비밀번호로 로그인
    local r2
    r2=$(C -i -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$email\",\"password\":\"TestUser12-2026-local\"}")
    echo "$r2" >> "$LOG"
    echo "$r2" | tok_of
    return
  fi
  local r2
  r2=$(C -i -X POST "$BASE/api/auth/set-password" -H 'Content-Type: application/json' -d "{\"token\":\"$setup\",\"password\":\"TestUser12-2026-local\"}")
  echo "$r2" >> "$LOG"
  echo "$r2" | tok_of
}
A_TOK=$(mkuser "usera@test.local" "사용자A")
B_TOK=$(mkuser "userb@test.local" "사용자B")
[ -n "$A_TOK" ] && ok "사용자 A 생성+로그인" || bad "사용자 A 생성+로그인"
[ -n "$B_TOK" ] && ok "사용자 B 생성+로그인" || bad "사용자 B 생성+로그인"
A_CK="Cookie: people_os_session=$A_TOK"
B_CK="Cookie: people_os_session=$B_TOK"
A_ID=$(C "$BASE/api/auth/me" -H "$A_CK" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
B_ID=$(C "$BASE/api/auth/me" -H "$B_CK" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
note "A id=$A_ID / B id=$B_ID"

note "== 3. A가 개인 전사본 문서 생성 (고유 토큰: 알파프로젝트 시제품) =="
# 주의: JSON 경로(/api/documents)는 색인을 안 타서(chunk 0개) RAG에 안 보인다 (기존 문제).
# 그래서 파일 업로드 경로(multipart, personal=true)로 만든다 — indexDocument가 chunk를 만든다.
printf '알파프로젝트 시제품 회의록. 김철수 팀장은 알파프로젝트 시제품을 다음 주 수요일까지 완성하기로 했다. 알파프로젝트 시제품 검수는 목요일에 한다.' > notes/per-user-rag/alpha.txt
DOC_JSON=$(C -X POST "$BASE/api/documents" -H "$A_CK" -F "file=@notes/per-user-rag/alpha.txt;type=text/plain" -F "title=알파프로젝트 시제품 회의" -F "personal=true")
echo "$DOC_JSON" >> "$LOG"
A_DOC=$(echo "$DOC_JSON" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$A_DOC" ] && ok "A 개인 문서 생성 id=$A_DOC" || bad "A 개인 문서 생성"
# D1에 chunk가 생겼는지 확인 (indexDocument는 로컬에서 AI 실패로 chunk만 남김)
CH=$(npx wrangler d1 execute people-os-db --local --command "SELECT COUNT(*) AS n FROM chunks WHERE doc_id='$A_DOC';" 2>&1 | grep -o '"n": [0-9]*' | head -1)
note "A doc chunks: $CH"
[ "$CH" != '"n": 0' ] && ok "A 문서 chunk 생성됨 ($CH)" || bad "A 문서 chunk 없음"
OWNER=$(npx wrangler d1 execute people-os-db --local --command "SELECT owner_id FROM documents WHERE id='$A_DOC';" 2>&1 | grep -o '"owner_id": "[^"]*"' | head -1)
note "A doc owner: $OWNER (expect $A_ID)"
# pool 배지: 개인 파일 업로드는 kind=file이지만 pool이 personal이어야 한다
POOL=$(ask "$A_CK" "iso-a-0" "알파프로젝트 시제품은 언제 완성돼?" | python3 -c "import json,sys; d=json.load(sys.stdin); print((d.get('sources') or [{}])[0].get('pool'))" 2>/dev/null)
note "A doc pool badge: $POOL (expect personal)"
[ "$POOL" = "personal" ] && ok "개인 파일 pool 배지 personal" || bad "개인 파일 pool 배지 (got $POOL)"

note "== 4. 격리 테스트: /api/ask =="
Q_ALPHA="알파프로젝트 시제품은 언제 완성돼?"
# B가 물으면 근거 없음이어야 한다
RB=$(ask "$B_CK" "iso-b-1" "$Q_ALPHA")
echo "B ask: $RB" >> "$LOG"
echo "$RB" | grep -q '"grounded":false' && ok "B는 A 문서 근거 없음" || bad "B는 A 문서 근거 없음: $RB"
echo "$RB" | grep -q "$A_DOC" && bad "B 응답에 A 문서 id 노출됨" || ok "B 응답에 A 문서 id 없음"
# A가 물으면 근거 있음이어야 한다
RA=$(ask "$A_CK" "iso-a-1" "$Q_ALPHA")
echo "A ask: $RA" >> "$LOG"
echo "$RA" | grep -q '"grounded":true' && ok "A는 본인 문서 근거 있음" || bad "A는 본인 문서 근거 있음: $RA"
echo "$RA" | grep -q "$A_DOC" && ok "A 응답 출처에 본인 문서 포함" || bad "A 응답 출처에 본인 문서 없음: $RA"
# 익명이 물으면 근거 없음
RN=$(ask "" "iso-n-1" "$Q_ALPHA")
echo "anon ask: $RN" >> "$LOG"
echo "$RN" | grep -q '"grounded":false' && ok "익명은 A 문서 근거 없음" || bad "익명은 A 문서 근거 없음: $RN"
# admin(hr_admin)은 본인 개인 문서만 본다 — A 문서가 admin에게 안 보여야 한다
RADMIN=$(ask "$ADMIN_CK" "iso-adm-1" "$Q_ALPHA")
echo "admin ask: $RADMIN" >> "$LOG"
echo "$RADMIN" | grep -q '"grounded":false' && ok "admin도 A 개인 문서 안 봄" || bad "admin도 A 개인 문서 안 봄: $RADMIN"
# B가 공용 규정 질문 → 근거 있음
RQ=$(ask "$B_CK" "iso-b-2" "연차 3일 쓸 수 있어?")
echo "B regulation ask: $RQ" >> "$LOG"
echo "$RQ" | grep -q '"grounded":true' && ok "B 공용 규정 질문 근거 있음" || bad "B 공용 규정 질문 근거 있음: $RQ"

note "== 5. 목록 필터: /api/library =="
LB=$(C "$BASE/api/library" -H "$B_CK")
echo "$LB" | grep -q "$A_DOC" && bad "B library에 A 문서 노출" || ok "B library에 A 문서 없음"
LA=$(C "$BASE/api/library" -H "$A_CK")
echo "$LA" | grep -q "$A_DOC" && ok "A library에 본인 문서 있음" || bad "A library에 본인 문서 없음"
LADM=$(C "$BASE/api/library" -H "$ADMIN_CK")
echo "$LADM" | grep -q "$A_DOC" && ok "admin library에 A 문서 있음(전체 조회)" || bad "admin library에 A 문서 없음"

note "== 6. R2 게이트: 덱 =="
DECK_JSON=$(C -X POST "$BASE/api/deck" -H "$A_CK" -H 'Content-Type: application/json' -d '{"title":"A 덱","bullets":["알파프로젝트 시제품"]}')
DECK_ID=$(echo "$DECK_JSON" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
note "deck id=$DECK_ID"
[ -n "$DECK_ID" ] && ok "A 덱 생성" || bad "A 덱 생성"
CODE_B=$(C -o /dev/null -w "%{http_code}" "$BASE/api/deck/$DECK_ID" -H "$B_CK")
[ "$CODE_B" = "403" ] && ok "B 덱 다운로드 403" || bad "B 덱 다운로드 403 (got $CODE_B)"
CODE_A=$(C -o /dev/null -w "%{http_code}" "$BASE/api/deck/$DECK_ID" -H "$A_CK")
[ "$CODE_A" = "200" ] && ok "A 덱 다운로드 200" || bad "A 덱 다운로드 200 (got $CODE_A)"
CODE_ADM=$(C -o /dev/null -w "%{http_code}" "$BASE/api/deck/$DECK_ID" -H "$ADMIN_CK")
[ "$CODE_ADM" = "200" ] && ok "admin 덱 다운로드 200" || bad "admin 덱 다운로드 200 (got $CODE_ADM)"

note "== 7. R2 게이트: 녹음 =="
REC_ID="rec_test_a_owner"
npx wrangler d1 execute people-os-db --local --command "INSERT OR REPLACE INTO recordings (id, title, provider, model, object_key, mime_type, size, transcript, transcript_status, doc_id, owner_id, created_at) VALUES ('$REC_ID','A 녹음','workers-ai','@cf/openai/whisper','recordings/$REC_ID/a.ogg','audio/ogg',100,'알파프로젝트 시제품 전사본','ready',NULL,'$A_ID',datetime('now'));" >> "$LOG" 2>&1
CODE_RB=$(C -o /dev/null -w "%{http_code}" "$BASE/api/recordings/$REC_ID" -H "$B_CK")
[ "$CODE_RB" = "403" ] && ok "B 녹음 조회 403" || bad "B 녹음 조회 403 (got $CODE_RB)"
CODE_RA=$(C -o /dev/null -w "%{http_code}" "$BASE/api/recordings/$REC_ID" -H "$A_CK")
[ "$CODE_RA" = "200" ] && ok "A 녹음 조회 200" || bad "A 녹음 조회 200 (got $CODE_RA)"
CODE_RADV=$(C -X POST "$BASE/api/recordings/$REC_ID/advance" -H "$B_CK" -o /dev/null -w "%{http_code}")
[ "$CODE_RADV" = "403" ] && ok "B advance 403" || bad "B advance 403 (got $CODE_RADV)"

note "== 8. 골든셋 6개 (D1 폴백 경로, admin 세션) =="
golden() { # golden <label> <question> <expected-substring-in-source-title>
  local label="$1" q="$2" expect="$3"
  local r
  r=$(ask "$ADMIN_CK" "golden-$label" "$q")
  echo "golden $label: $r" >> "$LOG"
  if echo "$r" | python3 -c "
import json, sys
d = json.load(sys.stdin)
srcs = d.get('sources') or []
titles = ' '.join((s.get('title') or '') + ' ' + (s.get('section') or '') for s in srcs)
sys.exit(0 if (d.get('grounded') is True and '$expect' in titles) else 1)
"; then ok "골든셋 $label ($expect)"; else bad "골든셋 $label ($expect): $r"; fi
}
golden "s03" "연차 3일 쓸 수 있어?" "연차"
golden "s04" "연차휴가는 입사 몇 년이 지나면 생기나요?" "연차"
golden "s05" "출산 전후 재택 가능해요?" "출산"
golden "s07" "이 규정은 누구에게 적용되나요?" "적용"
golden "s10" "교육 지원은 어떻게 돼?" "교육"
golden "s11" "출장비는 어떻게 정산해요?" "출장"

note "== 9. 무회귀: home / obs / reindex 게이트 =="
C "$BASE/api/home" -H "$ADMIN_CK" | grep -q '"ok":true' && ok "home 200" || bad "home 200"
C "$BASE/api/obs/traces?limit=1" -H "x-admin-secret: test-admin-secret-local-only" | grep -q '"ok":true' && ok "obs traces (시크릿) 200" || bad "obs traces (시크릿) 200"
CODE_RE=$(C -X POST "$BASE/api/admin/reindex" -o /dev/null -w "%{http_code}")
[ "$CODE_RE" = "401" ] && ok "reindex 익명 401" || bad "reindex 익명 401 (got $CODE_RE)"
RE_ADM=$(C -X POST "$BASE/api/admin/reindex?limit=5" -H "x-admin-secret: test-admin-secret-local-only")
echo "reindex admin: $RE_ADM" >> "$LOG"
echo "$RE_ADM" | grep -q '"errors"' && ok "reindex 관리자 호출 응답 (로컬 AI 불가로 errors 예상)" || bad "reindex 관리자 호출 응답: $RE_ADM"

note "== 결과: PASS=$PASS FAIL=$FAIL =="
[ "$FAIL" -eq 0 ] && note "ALL PASS" || note "FAILURES PRESENT"
