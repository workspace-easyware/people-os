#!/usr/bin/env bash
# LMS O1 로컬 검증 (lms-plan.md 8.1 L1, L3~L21). 로컬 전용 — 원격 주소를 넣지 말 것.
#
# 준비 (people-os 디렉터리에서, 한 번):
#   npx wrangler d1 execute people-os-db --file migrations/0023_lms.sql --local
#   npx wrangler d1 execute people-os-db --file seeds/lms_seed_v1.sql --local
#   npx wrangler d1 execute people-os-db --file files/lms-s1-verify/users.sql --local
#   npx wrangler d1 execute people-os-db --file files/lms-verify/test-data.sql --local      # 진도 초기화 포함
#   npx wrangler r2 object put people-os-dev-preview/lms/videos/les_test/test.bin --file files/lms-verify/test.bin --content-type application/octet-stream --local
#     (wrangler dev는 preview_bucket_name = people-os-dev-preview를 FILES로 묶는다. people-os-files에만 넣으면 404)
#   npx wrangler dev --local --port 8791      (출력을 head로 자르지 말 것)
# 실행:  bash files/lms-verify/run.sh [base_url]     → 결과표는 files/lms-verify/out/result.txt
# L20 관리자 검증은 ADMIN_SECRET 환경변수가 있을 때만 X-Admin-Secret 성공 경로까지 본다.
set -u
cd "$(dirname "$0")"
BASE="${1:-http://127.0.0.1:8791}/api/lms"
OUT=out; mkdir -p "$OUT"; : > "$OUT/result.txt"
A="cookie: people_os_session=lmsS1tokenA"
B="cookie: people_os_session=lmsS1tokenB"
CURL=(env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY curl -sS --max-time 10)
PASS=0; FAIL=0

check() { # id desc cond(0/1) detail
  if [ "$3" = 1 ]; then PASS=$((PASS+1)); s=PASS; else FAIL=$((FAIL+1)); s=FAIL; fi
  printf '%-4s %-5s %s  [%s]\n' "$1" "$s" "$2" "$4" | tee -a "$OUT/result.txt"
}
code() { "${CURL[@]}" -o /dev/null -w '%{http_code}' "$@"; }
hdr()  { grep -i "^$1:" "$2" | head -1 | cut -d' ' -f2- | tr -d '\r'; }
# vid NAME [curl args...] → $OUT/NAME.body, $OUT/NAME.h, echo status
vid() { local n=$1; shift; "${CURL[@]}" -D "$OUT/$n.h" -o "$OUT/$n.body" -w '%{http_code}' "$@"; }
slice() { tail -c +$(($1+1)) test.bin | head -c "$2"; }

V="$BASE/lessons/les_test/video"

# ---- L1 (회귀): 쿠키 없이 전부 401 ----
r="$(code "$BASE/courses") $(code "$BASE/courses/course_o1_test") $(code "$BASE/summary") $(code -X POST -H 'content-type: application/json' -d '{"completed":true}' "$BASE/lessons/les_test/progress") $(code "$V") $(code -I "$V")"
check L1 "쿠키 없이 courses/course/summary/progress/video/HEAD" "$([ "$r" = "401 401 401 401 401 401" ] && echo 1 || echo 0)" "$r"

# ---- L3 (회귀): 과정 목록 ----
"${CURL[@]}" -H "$A" "$BASE/courses" > "$OUT/L3.json"
ok=0; grep -q '"id":"course_storytelling"[^}]*"lesson_count":1,"completed_count":0' "$OUT/L3.json" && grep -q '"id":"course_claude_allinone"[^}]*"lesson_count":14,"completed_count":0' "$OUT/L3.json" && ok=1
grep -q course_o1_draft "$OUT/L3.json" && ok=0   # 미게시 과정은 일반 사용자에게 안 보인다
check L3 "A 과정 목록: 스토리텔링 1강·클로드 14강, 완료 0, DRAFT 숨김" $ok "$(grep -o '"id":"course_[a-z0-9_]*"' "$OUT/L3.json" | tr '\n' ' ')"

# ---- L4: Range 없음 → 200 전체 ----
s=$(vid L4 -H "$A" "$V")
ok=0; [ "$s" = 200 ] && [ "$(hdr accept-ranges "$OUT/L4.h")" = bytes ] && [ "$(hdr content-length "$OUT/L4.h")" = 1000 ] && cmp -s "$OUT/L4.body" test.bin && [ -z "$(hdr content-range "$OUT/L4.h")" ] && ok=1
check L4 "Range 없음 → 200, Accept-Ranges, Content-Length 1000, 본문 일치" $ok "$s cl=$(hdr content-length "$OUT/L4.h") cc=$(hdr cache-control "$OUT/L4.h") nosniff=$(hdr x-content-type-options "$OUT/L4.h") etag=$(hdr etag "$OUT/L4.h")"

# ---- L5: bytes=0-1 (Safari 첫 요청) ----
s=$(vid L5 -H "$A" -H 'range: bytes=0-1' "$V")
ok=0; [ "$s" = 206 ] && [ "$(hdr content-range "$OUT/L5.h")" = "bytes 0-1/1000" ] && [ "$(hdr content-length "$OUT/L5.h")" = 2 ] && cmp -s "$OUT/L5.body" <(slice 0 2) && ok=1
check L5 "bytes=0-1 → 206, bytes 0-1/1000, 2바이트" $ok "$s $(hdr content-range "$OUT/L5.h") len=$(wc -c < "$OUT/L5.body")"

# ---- L6: bytes=100-199 ----
s=$(vid L6 -H "$A" -H 'range: bytes=100-199' "$V")
ok=0; [ "$s" = 206 ] && [ "$(hdr content-range "$OUT/L6.h")" = "bytes 100-199/1000" ] && cmp -s "$OUT/L6.body" <(slice 100 100) && ok=1
check L6 "bytes=100-199 → 206, 원본 100~199와 바이트 일치" $ok "$s $(hdr content-range "$OUT/L6.h") head=$(head -c 12 "$OUT/L6.body" | tr '\n' '|')"

# ---- L7: bytes=900- / bytes=-100 ----
s1=$(vid L7a -H "$A" -H 'range: bytes=900-' "$V"); s2=$(vid L7b -H "$A" -H 'range: bytes=-100' "$V")
ok=0; [ "$s1" = 206 ] && [ "$s2" = 206 ] && [ "$(hdr content-range "$OUT/L7a.h")" = "bytes 900-999/1000" ] && [ "$(hdr content-range "$OUT/L7b.h")" = "bytes 900-999/1000" ] && cmp -s "$OUT/L7a.body" <(slice 900 100) && cmp -s "$OUT/L7b.body" <(slice 900 100) && ok=1
check L7 "bytes=900- / bytes=-100 → 둘 다 206 bytes 900-999/1000" $ok "$s1 $(hdr content-range "$OUT/L7a.h") / $s2 $(hdr content-range "$OUT/L7b.h")"

# ---- L8: 끝이 크기 초과 ----
s=$(vid L8 -H "$A" -H 'range: bytes=500-5000' "$V")
ok=0; [ "$s" = 206 ] && [ "$(hdr content-range "$OUT/L8.h")" = "bytes 500-999/1000" ] && cmp -s "$OUT/L8.body" <(slice 500 500) && ok=1
check L8 "bytes=500-5000 → 206 bytes 500-999/1000" $ok "$s $(hdr content-range "$OUT/L8.h")"

# ---- L9: 시작이 크기 이상 → 416 (+ 추가 경계) ----
s=$(vid L9 -H "$A" -H 'range: bytes=1000-' "$V")
s2=$(vid L9b -H "$A" -H 'range: bytes=-0' "$V")
s3=$(vid L9c -H "$A" -H 'range: bytes=200-100' "$V")
ok=0; [ "$s" = 416 ] && [ "$(hdr content-range "$OUT/L9.h")" = "bytes */1000" ] && [ "$s2" = 416 ] && [ "$s3" = 416 ] && ok=1
check L9 "bytes=1000- → 416 bytes */1000 (bytes=-0, 200-100도 416)" $ok "$s $(hdr content-range "$OUT/L9.h") / -0:$s2 / 200-100:$s3"

# ---- L10: 다중·불량 Range 무시 ----
s1=$(vid L10a -H "$A" -H 'range: bytes=0-1,5-6' "$V"); s2=$(vid L10b -H "$A" -H 'range: abc' "$V"); s3=$(vid L10c -H "$A" -H 'range: items=0-1' "$V")
ok=0; [ "$s1" = 200 ] && [ "$s2" = 200 ] && [ "$s3" = 200 ] && cmp -s "$OUT/L10a.body" test.bin && cmp -s "$OUT/L10b.body" test.bin && ok=1
check L10 "bytes=0-1,5-6 / abc / items=0-1 → 200 전체" $ok "$s1 / $s2 / $s3"

# ---- L11: HEAD ----
s=$("${CURL[@]}" -I -H "$A" -o "$OUT/L11.h" -w '%{http_code}' "$V")
s2=$("${CURL[@]}" -I -H "$A" -H 'range: bytes=0-1' -o "$OUT/L11b.h" -w '%{http_code}' "$V")
ok=0; [ "$s" = 200 ] && [ "$(hdr content-length "$OUT/L11.h")" = 1000 ] && [ "$(hdr accept-ranges "$OUT/L11.h")" = bytes ] && [ "$s2" = 206 ] && [ "$(hdr content-range "$OUT/L11b.h")" = "bytes 0-1/1000" ] && ok=1
check L11 "HEAD → 200 헤더만 (Range 붙이면 206)" $ok "$s cl=$(hdr content-length "$OUT/L11.h") / range:$s2 $(hdr content-range "$OUT/L11b.h")"

# ---- If-Range ----
etag=$(hdr etag "$OUT/L4.h")
s1=$(vid IR1 -H "$A" -H 'range: bytes=0-1' -H "if-range: $etag" "$V"); s2=$(vid IR2 -H "$A" -H 'range: bytes=0-1' -H 'if-range: "stale"' "$V")
check L11+ "If-Range 일치 → 206 / 불일치 → 200 전체" "$([ "$s1" = 206 ] && [ "$s2" = 200 ] && echo 1 || echo 0)" "$s1 / $s2"

# ---- L12: 없는 강의 / 유튜브 강의 / 객체 없음 / 미게시 ----
r="$(code -H "$A" "$BASE/lessons/no_such/video") $(code -H "$A" "$BASE/lessons/les_claude_01/video") $(code -H "$A" "$BASE/lessons/les_test_noobj/video") $(code -H "$A" "$BASE/lessons/les_test_draft/video")"
check L12 "없는 강의 / 유튜브 강의 / R2 객체 없음 / 미게시(일반 사용자) → 404" "$([ "$r" = "404 404 404 404" ] && echo 1 || echo 0)" "$r"
# D1 size_bytes가 낡아도 실제 크기로 응답
s=$(vid STALE -H "$A" -H 'range: bytes=900-' "$BASE/lessons/les_test_stale/video")
check L12+ "D1 size_bytes 낡음(5) → 실제 크기 기준 bytes 900-999/1000" "$([ "$s" = 206 ] && [ "$(hdr content-range "$OUT/STALE.h")" = "bytes 900-999/1000" ] && echo 1 || echo 0)" "$s $(hdr content-range "$OUT/STALE.h")"

# ---- L13: r2_key 미노출 ----
"${CURL[@]}" -H "$A" "$BASE/courses/course_o1_test" > "$OUT/L13.json"
"${CURL[@]}" -H "$A" "$BASE/courses/course_storytelling" >> "$OUT/L13.json"
check L13 "/courses/:id 응답에 r2_key·lms/videos 없음" "$(grep -q 'r2_key\|lms/videos\|lms/sample' "$OUT/L13.json" && echo 0 || echo 1)" "$(wc -c < "$OUT/L13.json") bytes"

P="$BASE/lessons/les_claude_01/progress"
J='content-type: application/json'
# ---- L14: A 완료 ----
"${CURL[@]}" -H "$A" -H "$J" -X POST -d '{"completed":true}' "$P" > "$OUT/L14.json"
"${CURL[@]}" -H "$A" "$BASE/courses/course_claude_allinone" > "$OUT/L14c.json"
ok=0; grep -q '"completed":true' "$OUT/L14.json" && grep -q '"course":{"lesson_count":14,"completed_count":1}' "$OUT/L14.json" && grep -q '"id":"les_claude_01"[^}]*"completed":true' "$OUT/L14c.json" && grep -q '"lesson_count":14,"completed_count":1' "$OUT/L14c.json" && ok=1
check L14 "A 완료 → 응답·/courses/:id 모두 completed:true, completed_count 1" $ok "$(cat "$OUT/L14.json")"

# ---- L15: B 격리 ----
"${CURL[@]}" -H "$B" "$BASE/courses/course_claude_allinone" > "$OUT/L15.json"
ok=0; grep -q '"id":"les_claude_01"[^}]*"completed":false' "$OUT/L15.json" && grep -q '"completed_count":0' "$OUT/L15.json" && ok=1
check L15 "B의 같은 강의 completed:false (타인 진도 격리)" $ok "$(grep -o '"id":"les_claude_01"[^}]*' "$OUT/L15.json" | head -c 160)"

# ---- L16: 같은 완료 두 번 → completed_at 유지 ----
first=$(grep -o '"completed_at":"[^"]*"' "$OUT/L14.json")
sleep 1.1
"${CURL[@]}" -H "$A" -H "$J" -X POST -d '{"completed":true}' "$P" > "$OUT/L16.json"
second=$(grep -o '"completed_at":"[^"]*"' "$OUT/L16.json")
check L16 "완료 두 번 → completed_at 첫 값 유지" "$([ -n "$first" ] && [ "$first" = "$second" ] && echo 1 || echo 0)" "$first == $second"

# ---- L17: 위치만 → 완료 유지 ----
"${CURL[@]}" -H "$A" -H "$J" -X POST -d '{"position_sec":120}' "$P" > "$OUT/L17.json"
ok=0; grep -q '"completed":true' "$OUT/L17.json" && grep -q '"position_sec":120' "$OUT/L17.json" && grep -q "$first" "$OUT/L17.json" && ok=1
check L17 "position_sec:120만 → 위치 120, 완료·시각 유지" $ok "$(cat "$OUT/L17.json")"

# ---- L18: 동시 완료 10개 (다른 강의) ----
P2="$BASE/lessons/les_claude_02/progress"
for i in $(seq 1 10); do "${CURL[@]}" -o "$OUT/L18.$i.json" -w '%{http_code}\n' -H "$A" -H "$J" -X POST -d '{"completed":true}' "$P2" > "$OUT/L18.$i.code" & done; wait
codes=$(cat "$OUT"/L18.*.code | sort | uniq -c | tr -s ' ' | tr '\n' ';')
nat=$(cat "$OUT"/L18.*.json | grep -o '"completed_at":"[^"]*"' | sort -u | wc -l)
check L18 "동시 완료 10개 → 전부 200, completed_at 1개 값" "$([ "$(cat "$OUT"/L18.*.code | grep -c '^200$')" = 10 ] && [ "$nat" = 1 ] && echo 1 || echo 0)" "codes:$codes distinct_completed_at=$nat (행 수는 DB 쿼리로 별도 확인)"

# ---- L19: 본문 user_id 무시 ----
"${CURL[@]}" -H "$A" -H "$J" -X POST -d '{"completed":true,"user_id":"lms-s1-user-b"}' "$BASE/lessons/les_claude_03/progress" > "$OUT/L19.json"
"${CURL[@]}" -H "$B" "$BASE/courses/course_claude_allinone" > "$OUT/L19b.json"
"${CURL[@]}" -H "$A" "$BASE/courses/course_claude_allinone" > "$OUT/L19a.json"
ok=0; grep -q '"id":"les_claude_03"[^}]*"completed":false' "$OUT/L19b.json" && grep -q '"id":"les_claude_03"[^}]*"completed":true' "$OUT/L19a.json" && ok=1
check L19 "본문 user_id=B → 무시, A에만 저장" $ok "B:$(grep -o '"id":"les_claude_03"[^}]*"completed":[a-z]*' "$OUT/L19b.json" | grep -o '"completed":[a-z]*')"

# ---- 진도 입력 검증·404 ----
r="$(code -H "$A" -H "$J" -X POST -d '{"completed":true}' "$BASE/lessons/no_such/progress") $(code -H "$A" -H "$J" -X POST -d '{}' "$P") $(code -H "$A" -H "$J" -X POST -d '{"completed":"yes"}' "$P") $(code -H "$A" -H "$J" -X POST -d '{"position_sec":-1}' "$P") $(code -H "$A" -H "$J" -X POST -d 'not json' "$P")"
check L19+ "없는 강의 404 / {} 400 / completed:\"yes\" 400 / 음수 위치 400 / JSON 아님 400" "$([ "$r" = "404 400 400 400 400" ] && echo 1 || echo 0)" "$r"
# 완료 취소
"${CURL[@]}" -H "$A" -H "$J" -X POST -d '{"completed":false}' "$P" > "$OUT/UNDO.json"
check L19++ "completed:false → 완료 취소, 위치 유지" "$(grep -q '"completed":false,"completed_at":null,"position_sec":120' "$OUT/UNDO.json" && echo 1 || echo 0)" "$(cat "$OUT/UNDO.json")"

# ---- L20: 일반 사용자 admin 403 ----
r=$(code -H "$A" -H "$J" -X POST -d '{"course_id":"course_o1_test","ord":50,"title":"x","youtube_id":"ZN37IV4sbQg"}' "$BASE/admin/lessons")
if [ -n "${ADMIN_SECRET:-}" ]; then
  r2=$(code -H "x-admin-secret: $ADMIN_SECRET" -H "$J" -X POST -d '{"id":"les_o1_admin_probe","course_id":"course_o1_test","ord":50,"title":"probe","youtube_url":"https://youtu.be/ZN37IV4sbQg"}' "$BASE/admin/lessons")
  check L20 "일반 사용자 403 / X-Admin-Secret 200" "$([ "$r" = 403 ] && [ "$r2" = 200 ] && echo 1 || echo 0)" "$r / $r2"
else
  check L20 "일반 사용자 403 (ADMIN_SECRET 미지정 — 성공 경로 생략)" "$([ "$r" = 403 ] && echo 1 || echo 0)" "$r"
fi

# ---- L21: X-Admin-Secret만으로 progress → 401 (영상도) ----
r="$(code -H "x-admin-secret: ${ADMIN_SECRET:-whatever}" -H "$J" -X POST -d '{"completed":true}' "$P") $(code -H "x-admin-secret: ${ADMIN_SECRET:-whatever}" "$V")"
check L21 "X-Admin-Secret만으로 progress / video → 401" "$([ "$r" = "401 401" ] && echo 1 || echo 0)" "$r"

echo "PASS=$PASS FAIL=$FAIL" | tee -a "$OUT/result.txt"
[ "$FAIL" = 0 ]
