#!/usr/bin/env bash
# WF-1 로컬 검증. 전제: wrangler dev --local --port 8798 --persist-to files/workflow-verify/wf1/state, 0027 + seed-users 적용.
# 실행: bash files/workflow-verify/wf1/run.sh  (people-os 디렉터리에서). PASS/FAIL 집계를 마지막에 출력.
B=http://localhost:8798/api/workflows
cu() { curl --noproxy '*' -s -m 20 -w '\n%{http_code}' "$@"; }
A=(-H 'cookie: people_os_session=tokA' -H 'content-type: application/json')
Bb=(-H 'cookie: people_os_session=tokB' -H 'content-type: application/json')
PASS=0; FAIL=0
# check <label> <expected-http> <body-grep-or-empty> <curl args...>
check() {
  local label=$1 want=$2 pat=$3; shift 3
  local out; out=$(cu "$@"); local code=${out##*$'\n'}; local body=${out%$'\n'*}
  LAST=$body
  if [ "$code" = "$want" ] && { [ -z "$pat" ] || echo "$body" | grep -q -- "$pat"; }; then
    PASS=$((PASS+1)); echo "PASS [$code] $label"
  else
    FAIL=$((FAIL+1)); echo "FAIL [$code want $want] $label :: $(echo "$body" | head -c 200)"
  fi
}
DEF='{"version":1,"steps":[{"id":"s1","type":"summarize","name":"요약","config":{"docId":"{{input.docId}}"}},{"id":"s2","type":"send_email","name":"발송","config":{}}]}'

echo "## 익명 401 (쿠키 없음 / 시크릿만)"
check "anon GET list" 401 "" $B
check "anon POST create" 401 "" -X POST $B -H 'content-type: application/json' -d '{}'
check "admin-secret only GET" 401 "" -H 'x-admin-secret: x' $B
check "admin-secret only POST run" 401 "" -H 'x-admin-secret: x' -X POST $B/x/runs -d '{}'
check "anon GET run" 401 "" $B/runs/abc

echo "## 생성"
check "create ok" 201 '"status":"draft"' "${A[@]}" -X POST $B -d "{\"name\":\"테스트 WF\",\"description\":\"d\",\"definition\":$DEF}"
WID=$(echo "$LAST" | sed -n 's/.*"workflow":{"id":"\([^"]*\)".*/\1/p')
echo "   WID=$WID"
check "send_email requiresApproval forced true" 200 '"id":"s2","type":"send_email","name":"발송","config":{},"requiresApproval":true' "${A[@]}" $B/$WID
check "create bad version" 400 "version" "${A[@]}" -X POST $B -d '{"name":"x","definition":{"version":2,"steps":[]}}'
check "create empty steps" 400 "steps" "${A[@]}" -X POST $B -d '{"name":"x","definition":{"version":1,"steps":[]}}'
check "create bad type" 400 "type" "${A[@]}" -X POST $B -d '{"name":"x","definition":{"version":1,"steps":[{"id":"a","type":"nope","name":"n","config":{}}]}}'
check "create dup id" 400 "중복" "${A[@]}" -X POST $B -d '{"name":"x","definition":{"version":1,"steps":[{"id":"a","type":"llm","name":"n","config":{}},{"id":"a","type":"llm","name":"m","config":{}}]}}'
check "create empty step name" 400 "name" "${A[@]}" -X POST $B -d '{"name":"x","definition":{"version":1,"steps":[{"id":"a","type":"llm","name":"","config":{}}]}}'
check "create send_email approval=false" 400 "승인" "${A[@]}" -X POST $B -d '{"name":"x","definition":{"version":1,"steps":[{"id":"a","type":"send_email","name":"n","config":{},"requiresApproval":false}]}}'
check "create missing name" 400 "name" "${A[@]}" -X POST $B -d "{\"definition\":$DEF}"
check "create bad JSON" 400 "" "${A[@]}" -X POST $B -d '{oops'

echo "## 조회 / 수정"
check "list has WF" 200 "$WID" "${A[@]}" $B
check "get detail + steps" 200 '"steps":\[' "${A[@]}" $B/$WID
check "patch name+status" 200 '"name":"수정됨","description":"d","status":"active"' "${A[@]}" -X PATCH $B/$WID -d '{"name":"수정됨","status":"active"}'
check "patch bad status" 400 "status" "${A[@]}" -X PATCH $B/$WID -d '{"status":"zzz"}'
check "patch bad definition" 400 "" "${A[@]}" -X PATCH $B/$WID -d '{"definition":{"version":1,"steps":[]}}'
check "patch definition ok" 200 '"id":"t1"' "${A[@]}" -X PATCH $B/$WID -d '{"definition":{"version":1,"steps":[{"id":"t1","type":"llm","name":"L","config":{"prompt":"hi"}}]}}'

echo "## run 생성 / 조회"
check "create run" 201 '"status":"queued","input":{"docId":"d1"},"output":null,"current_step":0' "${A[@]}" -X POST $B/$WID/runs -d '{"input":{"docId":"d1"}}'
RID=$(echo "$LAST" | sed -n 's/.*"run":{"id":"\([^"]*\)".*/\1/p')
echo "   RID=$RID"
check "run detail has steps[]" 200 '"steps":\[\]' "${A[@]}" $B/runs/$RID
check "run list" 200 "$RID" "${A[@]}" $B/$WID/runs
check "run bad input (array)" 400 "input" "${A[@]}" -X POST $B/$WID/runs -d '{"input":[1]}'
check "run without body ok" 201 '"input":{}' "${A[@]}" -X POST $B/$WID/runs

echo "## 타인(B) 접근 → 404 / 목록은 비어 있음"
check "B get WF" 404 "" "${Bb[@]}" $B/$WID
check "B patch WF" 404 "" "${Bb[@]}" -X PATCH $B/$WID -d '{"name":"해킹"}'
check "B delete WF" 404 "" "${Bb[@]}" -X DELETE $B/$WID
check "B list runs" 404 "" "${Bb[@]}" $B/$WID/runs
check "B create run" 404 "" "${Bb[@]}" -X POST $B/$WID/runs -d '{}'
check "B get run" 404 "" "${Bb[@]}" $B/runs/$RID
check "B list empty" 200 '"workflows":\[\]' "${Bb[@]}" $B
check "A still intact after B attempts" 200 '"name":"수정됨"' "${A[@]}" $B/$WID

echo "## 크기 상한 / Origin"
python3 -c "import json;print(json.dumps({'name':'big','definition':{'version':1,'steps':[{'id':'a','type':'llm','name':'n','config':{'x':'y'*270000}}]}}))" > files/workflow-verify/wf1/big-def.json
check "definition >256KB → 413" 413 "" "${A[@]}" -X POST $B --data-binary @files/workflow-verify/wf1/big-def.json
python3 -c "import json;print(json.dumps({'input':{'x':'y'*70000}}))" > files/workflow-verify/wf1/big-input.json
check "input >64KB → 413" 413 "" "${A[@]}" -X POST $B/$WID/runs --data-binary @files/workflow-verify/wf1/big-input.json
check "Origin mismatch → 403" 403 "" "${A[@]}" -H 'origin: https://evil.example' -X POST $B/$WID/runs -d '{}'
check "Origin same → 201" 201 "" "${A[@]}" -H 'origin: http://localhost:8798' -X POST $B/$WID/runs -d '{}'

echo "## 삭제 (runs·steps 포함)"
check "A delete WF" 200 '"ok":true' "${A[@]}" -X DELETE $B/$WID
check "get after delete" 404 "" "${A[@]}" $B/$WID
check "run after delete" 404 "" "${A[@]}" $B/runs/$RID
echo "RESULT: PASS=$PASS FAIL=$FAIL"
