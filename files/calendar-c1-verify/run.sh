#!/usr/bin/env bash
# C1 로컬 검증. 전제: wrangler dev --port 8799 --persist-to files/calendar-c1-verify/state, 0015+0025+seed-users 적용.
B=http://localhost:8799/api/calendar
cu() { curl --noproxy '*' -s -m 20 -w ' [HTTP:%{http_code}]\n' "$@"; }
A=(-H 'cookie: people_os_session=tokA' -H 'content-type: application/json')
Bb=(-H 'cookie: people_os_session=tokB' -H 'content-type: application/json')
H=(-H 'cookie: people_os_session=tokH' -H 'content-type: application/json')
idof() { sed -n 's/.*"event":{"id":"\([^"]*\)".*/\1/p'; }
echo "## A 개인 일정 생성 (자정 KST에 걸침: 11/20 23:00 KST ~ 11/21 01:00 KST = 14:00Z~16:00Z)"
R=$(cu "${A[@]}" -X POST $B/events -d '{"title":"A 개인","start_at":"2026-11-20T14:00:00Z","end_at":"2026-11-20T16:00:00Z"}'); echo "$R"
PID=$(echo "$R" | idof)
echo "## A 팀 일정"
R=$(cu "${A[@]}" -X POST $B/events -d '{"title":"팀 회식","visibility":"team","category":"meeting","start_at":"2026-11-25T03:00:00Z","end_at":"2026-11-25T05:00:00Z"}'); echo "$R"
TID=$(echo "$R" | idof)
echo "## A 종일 일정 11/21(KST) 하루 = 2026-11-20T15:00:00Z ~ 2026-11-21T15:00:00Z"
R=$(cu "${A[@]}" -X POST $B/events -d '{"title":"종일","all_day":true,"start_at":"2026-11-20T15:00:00Z","end_at":"2026-11-21T15:00:00Z"}'); echo "$R"
echo "## 종일인데 자정 아님 → 400"
cu "${A[@]}" -X POST $B/events -d '{"title":"x","all_day":true,"start_at":"2026-11-20T14:00:00Z","end_at":"2026-11-21T15:00:00Z"}'
echo "## B가 A 개인 조회/수정/삭제 → 404"
cu "${Bb[@]}" $B/events/$PID
cu "${Bb[@]}" -X PATCH $B/events/$PID -d '{"version":0,"title":"해킹"}'
cu "${Bb[@]}" -X DELETE $B/events/$PID
echo "## B 목록: 팀 일정만 보여야 함 (개인·종일 제외)"
cu "${Bb[@]}" "$B/events?from=2026-11-01T00:00:00Z&to=2026-12-01T00:00:00Z"
echo "## B가 팀 일정 조회 200 / 수정 403 / 삭제 403"
cu "${Bb[@]}" $B/events/$TID
cu "${Bb[@]}" -X PATCH $B/events/$TID -d '{"version":0,"title":"B수정"}'
cu "${Bb[@]}" -X DELETE $B/events/$TID
echo "## hr_admin 세션: 팀 일정 수정 200 (version 0→1), 개인 일정은 404"
cu "${H[@]}" -X PATCH $B/events/$TID -d '{"version":0,"title":"HR수정"}'
cu "${H[@]}" $B/events/$PID
echo "## hr_admin이 공개범위 바꾸기 → 403"
cu "${H[@]}" -X PATCH $B/events/$TID -d '{"version":1,"visibility":"private"}'
echo "## version 불일치 409 (현재 1인데 0)"
cu "${A[@]}" -X PATCH $B/events/$TID -d '{"version":0,"title":"충돌"}'
echo "## 작성자 A 정상 수정 (version 1)"
cu "${A[@]}" -X PATCH $B/events/$TID -d '{"version":1,"title":"A수정"}'
echo "## 경계: 자정 KST에 걸친 개인 일정(14:00Z~16:00Z)이 11/20 KST 날(11/19T15Z~11/20T15Z)에도, 11/21 KST 날(11/20T15Z~11/21T15Z)에도 잡혀야 한다"
cu "${A[@]}" "$B/events?from=2026-11-19T15:00:00Z&to=2026-11-20T15:00:00Z"
cu "${A[@]}" "$B/events?from=2026-11-20T15:00:00Z&to=2026-11-21T15:00:00Z"
echo "## 경계: 종일(11/21 KST)이 11/20 KST 날(~11/20T15Z, 끝 포함 안 함)과 11/22 KST 날(11/21T15Z~)로 새지 않는다 → '종일' 없어야 함"
cu "${A[@]}" "$B/events?from=2026-11-19T15:00:00Z&to=2026-11-20T15:00:00Z"
cu "${A[@]}" "$B/events?from=2026-11-21T15:00:00Z&to=2026-11-22T15:00:00Z"
echo "## 기간 63일 → 400, 62일 → 200"
cu "${A[@]}" "$B/events?from=2026-11-01T00:00:00Z&to=2027-01-03T00:00:01Z"
cu "${A[@]}" "$B/events?from=2026-11-01T00:00:00Z&to=2027-01-02T00:00:00Z"
echo "## 검증 400들: end<=start / 32일 / 시각 형식 / 없는 날짜 / category / visibility"
cu "${A[@]}" -X POST $B/events -d '{"title":"x","start_at":"2026-11-20T14:00:00Z","end_at":"2026-11-20T14:00:00Z"}'
cu "${A[@]}" -X POST $B/events -d '{"title":"x","start_at":"2026-11-01T00:00:00Z","end_at":"2026-12-02T00:00:00Z"}'
cu "${A[@]}" -X POST $B/events -d '{"title":"x","start_at":"2026-11-20 14:00","end_at":"2026-11-20T16:00:00Z"}'
cu "${A[@]}" -X POST $B/events -d '{"title":"x","start_at":"2026-02-30T14:00:00Z","end_at":"2026-03-01T16:00:00Z"}'
cu "${A[@]}" -X POST $B/events -d '{"title":"x","category":"bad","start_at":"2026-11-20T14:00:00Z","end_at":"2026-11-20T16:00:00Z"}'
cu "${A[@]}" -X POST $B/events -d '{"title":"x","visibility":"public","start_at":"2026-11-20T14:00:00Z","end_at":"2026-11-20T16:00:00Z"}'
echo "## 31일 정확히 → 201, 본문 256KB 초과 → 413"
cu "${A[@]}" -X POST $B/events -d '{"title":"31일","start_at":"2026-11-01T00:00:00Z","end_at":"2026-12-02T00:00:00Z"}' | head -c 80; echo
python3 -c "print('{\"title\":\"' + 'x'*270000 + '\"}')" > files/calendar-c1-verify/big.json
cu "${A[@]}" -X POST $B/events --data-binary @files/calendar-c1-verify/big.json
echo "## Origin 불일치 → 403, 동일 Origin → 통과"
cu "${A[@]}" -H 'origin: https://evil.example' -X POST $B/events -d '{"title":"x","start_at":"2026-11-20T14:00:00Z","end_at":"2026-11-20T16:00:00Z"}'
cu "${A[@]}" -H 'origin: http://localhost:8799' -X POST $B/events -d '{"title":"origin ok","start_at":"2026-11-20T14:00:00Z","end_at":"2026-11-20T16:00:00Z"}' | head -c 60; echo
echo "## 시크릿만으로 POST/DELETE → 401"
cu -H 'x-admin-secret: x' -X POST $B/events -d '{}'
cu -H 'x-admin-secret: x' -X DELETE $B/events/$TID
echo "## 작성자 A 삭제 → 200, 이후 조회 404 / 목록에서 사라짐"
cu "${A[@]}" -X DELETE $B/events/$TID
cu "${A[@]}" $B/events/$TID
