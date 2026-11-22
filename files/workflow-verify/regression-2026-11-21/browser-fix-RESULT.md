# 브라우저 화면 회귀 버그 수정 결과 — 2026-11-21

세션: Opus 5.5 `-p` 세션(14분, 중단) → Fable 5.2 `-p` 세션이 이어서 마무리.
지시: `browser-fix-2026-11-21-prompt.md` + `browser-fix-2026-11-21-prompt-fable.md`. 근거 화면 기록: `browser-check-2026-11-21.md`.

## 판정: 코드 수정·배포 완료. 화면 버튼이 실제로 눌리는지는 Merlin 브라우저 확인이 남았다.

- 배포: People OS만 1회. **`483b32b8` → `474e11ab-cc6b-4463-9adb-cdeac8548ce4`** (편집 Worker는 건드리지 않음).
- `npx tsc --noEmit` 오류 0. 바뀐 화면 JS 5개 `node --check` 통과.
- 테스트 대기 동작 `wfpa_wfrun_mwq51k7g_02syzj_1_t1`은 **`queued` 그대로** (API로 승인·거절하지 않았다).
- 커밋·태그는 하지 않았다 (Merlin 몫).

## Opus 변경 인계 판단

Opus가 남긴 8개 파일 변경 + 새 파일 `public/ui-dialog.js`를 diff로 전부 읽었다. **전부 살렸고, 1곳만 고쳤다.**

| 변경 | 판단 |
|---|---|
| `public/ui-dialog.js` (새 파일) + `index.html` script 태그 | 살림. 메시지는 `textContent`만 씀, Esc·바깥 클릭·취소 = false, 기본 포커스 "취소" |
| `public/styles.css` 대화상자·토스트 스타일 | **고침**: `.ui-dlg-danger`가 `button.primary`보다 우선순위가 낮아 빨간 확인 버튼이 파란색으로 나왔을 것 → `button.primary.ui-dlg-danger`로 바꿈 |
| `public/workflow.js` 일괄 승인·거절, 동기식 승인, `actions=1` 해시 | 살림 |
| `public/agents.js` 대화 지우기, 대기 동작 배지 | 살림 |
| `public/index.html` 코칭 드롭다운, 라이브러리 편집 버튼 | 살림 |
| `public/pptx-edit.js` 형식 안내 문구 | 살림 |
| `src/index.ts` `/api/library`에 `source_kind` | 살림 |
| `src/assistant/routes.ts` `pendingActions`·`workflowId` | 살림 |
| `src/workflow/nodes.ts` ask 노드에 trace sink | 살림 (3번의 진짜 원인 — 아래) |

## 항목별 결과

### 1. 일괄 승인·대화 지우기 무반응 — 고침 (브라우저 확인 남음)

- **원인 확정 수준: 코드 경로로 확정, 브라우저 재현은 못 함.** 이 VM에는 headless 브라우저·DOM 라이브러리가 없다 (`chromium`·`playwright`·`jsdom` 없음).
  - `wfPaDecide`(수정 전)는 선택이 있으면 곧바로 `if (!confirm(...)) return;`이었다. 선택이 없을 때는 "결정할 동작을 선택하세요" 메시지를 내고, API가 실패하면 `wfFail`이 메시지를 낸다. **아무 표시 없이 끝나는 경로는 `confirm()`이 false인 경우 하나뿐이다.**
  - `clearChat`(수정 전)도 같다: `if (!global.confirm(...)) return;` 뒤에는 성공·실패 모두 메시지 줄에 글이 나온다.
  - 서버 쪽 근거: 대기 동작 행이 `queued` 그대로이고 대화도 그대로다 = 요청이 서버에 가지 않았다. API 자체는 라이브 회귀에서 통과했다.
- 고친 내용: 페이지 내 확인 대화상자 `uiConfirm()` + 토스트 `uiToast()` (`public/ui-dialog.js`).
  - 일괄 승인·거절 (`wfPaDecide`), 대화 지우기 (`clearChat`), 같은 화면의 동기식 승인 (`wfDecide`)에 적용.
  - 실패 피드백: 요청 오류·401·"서버가 결과를 돌려주지 않음"을 대기 동작 막대 바로 아래 상태 줄(`#wfPaNote`) + 토스트로 낸다. 취소해도 "취소했습니다"가 나온다. 대화상자가 떠 있는 동안 버튼은 잠긴다 (겹침 방지).
- 검증: 로컬 `wrangler dev --local`에서 `/ui-dialog.js` 200(파일과 `cmp` 동일), 홈 HTML에 script 태그 1개, 결정 API 200/409 (`evidence/bf-local-decide-reject.json`, Opus 세션). 라이브에서도 새 파일이 서비스된다 (아래 스모크).
- **남은 확인 (Merlin 브라우저)**: "일괄 승인 (1)" 클릭 → 화면 안에 "대기 동작 일괄 승인" 대화상자 → "1개 승인" 클릭 → 토스트 + 행이 executed로. 대화 지우기도 같은 식.
- **범위 밖으로 남긴 네이티브 `confirm()` (같은 문제가 생긴다)**:
  - `public/workflow.js`: 저장 안 한 변경 버리기(567), 스케줄 삭제(806), 단계 삭제(909), 워크플로 삭제(1108)
  - `public/index.html`: 녹음 삭제(757), 비밀번호 초기화(1132), 파일 삭제(1616)
  - `public/approval.js`: 강제 반려(135), 회수(136)
  - `public/calendar.js`(541, 653, 665), `public/lms.js`(277, 360), `public/plaud.js`(225), `public/meet.js`(114), `public/chat.js`(44)
  - 자동화 브라우저로 이 버튼들을 누르면 똑같이 조용히 무반응이다. `uiConfirm`으로 바꾸면 된다 (`await` 한 줄).

### 2. 코칭 대상 드롭다운 비어 있음 + 전사본 10회 중복

- **전사본 중복 — 원인 확정, 고침.** 라이브에 같은 제목 "11월 팀 회의 전사본 (샘플)" 전사본 문서가 실제로 10개 있다 (`evidence/bf-before-documents-coaching.json`: 전사본 18개 중 10개, 2026-11-13에 샘플을 반복 업로드한 것). 서버·화면이 중복으로 만든 것이 아니다. 화면에서 제목·본문·소유자가 같은 것은 최신 1개만 보이고 "같은 내용 N개 (최신만 표시)"를 붙인다. 문서는 지우지 않았다.
- **코칭 대상 비어 있음 — 원인 미확정, 방어 수정만.** 서버는 라이브에서 3명을 돌려준다 (`evidence/bf-before-users-coaching.json`: 강준호·김불꽃·이구름 → 본인 제외 2명이 떠야 한다). 화면 코드도 그 응답이면 2명을 그린다. 재현하지 못했다. 가능한 설명 2가지: (a) 수정 전 코드는 전사본 목록(본문 포함 약 165 KB)을 다 받은 뒤에야 사용자 목록을 불렀다 — 그사이에 봤다, (b) 닫힌 드롭다운은 선택된 항목("지정 안 함")만 보인다.
  - 고친 내용: 두 목록을 동시에 따로 부른다. 실패하면 드롭다운 첫 줄에 사유를 적는다 ("지정 안 함 — 목록 오류: …"). 다른 계정이 정말 없으면 "지정 안 함 (고를 수 있는 다른 계정이 없습니다)". 늦게 끝난 이전 호출이 새 결과를 덮지 않게 순번을 둔다.
  - **남은 확인 (Merlin 브라우저)**: 코칭 리플렉션 탭에서 "코칭 대상"을 펼치면 김불꽃·이구름이 보이는지. 그래도 비면 첫 줄 문구가 원인을 말해 준다.

### 3. 트레이스 상세 스팬 없음 — 원인 확정, 고침

- 원인: `evt_mwq5qak0_0hm83i`는 `/api/ask`가 아니라 **어시스턴트의 `ask_rag` 도구**가 만든 행이다 (`session_id = wf_asst_…_t2_2`). 이 경로(`src/workflow/nodes.ts` `runAskNode`)는 `runAsk`를 trace sink 없이 불렀다. sink가 없으면 `runAsk`는 `ask_events` 기본 9개 컬럼만 쓴다 → 라이브 행에서 `model`·`latency_ms`·`trace_r2_key`가 전부 null. 상세 화면은 올바른 곳을 보고 있었고, 볼 데이터가 없었다. 워크플로 `ask_rag`·`ask_personal` 단계와 조사 하위 에이전트(`wf_research_…`)도 같은 경로라 똑같았다.
- 고친 내용: `runAskNode`가 `/api/ask`와 같은 `createTraceSink()`를 넘긴다 → 스팬·근거 후보·R2 원문이 남는다.
- 검증 (라이브, 배포 뒤): 어시스턴트에 "경조사 휴가는 며칠인가요?" 1건을 보냈다 (턴 3, 완료). 새 행 `evt_mwq6qua0_tn0lde`: `model @cf/qwen/qwen3.8-27b`, `latency_ms 12009`, 토큰 639/251, `trace_r2_key traces/evt_mwq6qua0_tn0lde.json`. 상세 API `GET /api/obs/traces/evt_mwq6qua0_tn0lde` 200, 9,831 B — 스팬 9개(cache·session·router·topic_guard·embed·vectorize·rerank·llm·session_save), 근거 후보, 프롬프트·응답 원문 있음 (`evidence/bf-live/trace-detail-new.json`). 비교: 옛 행 상세는 1,648 B에 `no_r2_key` (`trace-detail-old.json`).
- 한계: 이미 만들어진 행(`evt_mwq5qak0_0hm83i` 포함)은 그대로다 — 기록이 없어서 되살릴 수 없다. 새 질문부터 적용된다.

### 4. 에이전트 진행 기록 2초 갱신 — 설계대로, 고치지 않음

- 라이브 이벤트 기록으로 확인했다 (`evidence/bf-live-asst-events-before.json`, 턴 2 "연차는 며칠이야?"):

  | 경과 | 이벤트 |
  |---|---|
  | 0.0초 | 메시지 접수, 턴 시작 |
  | 3.2초 | 도구 호출: HR 규정 검색 (ask_rag) |
  | 34.4초 | 도구 결과, 스텝 1 |
  | 34.4~39.3초 | 답 글 조각 14개 |
  | 39.3초 | 스텝 2, 턴 끝 |

- 진행 이벤트는 **도구·스텝 경계에서만** 생긴다. `ask_rag` 한 번이 31초 걸렸고 (그중 답 생성 LLM 25.7초 — 트레이스 `timings_json`), 그동안에는 새 이벤트가 없다. 화면이 15초 동안 그대로였던 구간이 바로 이 31초다. 이벤트는 제때 왔고 렌더링 누락이 아니다. 2초 주기는 SSE가 안 될 때의 폴링 간격이지 "2초마다 새 줄이 생긴다"는 뜻이 아니다.
- 지시대로 고치지 않았다. 참고로, 답 말풍선의 "답을 만드는 중…"을 "HR 규정 검색 실행 중… (N초)"처럼 지금 도는 도구 + 경과 초로 바꾸면 멈춘 것처럼 보이는 문제는 화면 JS만으로 풀 수 있다 (하지 않음 — 원하면 다음 과제로).

### 5. 승인 대기 배지 → 결재함 링크 — 설계 판단 + 고침

- 판단: **대기 동작은 워크플로우 화면에 둔다. 결재함에 얹지 않는다.** 근거: (1) 결재함(`#approval`)은 문서 결재 전용이고 결재선·회수·반려 흐름이 따로 있다. (2) 지연 승인 대기 동작은 P3 설계에서 워크플로우 화면 "대기 동작" 섹션의 일괄 승인·거절로 결정한다 — 승인 화면을 두 군데 두면 상태가 어긋난다. (3) 그래서 기존 에이전트 상세의 "결재함" 링크는 가 봐야 아무것도 없는 잘못된 링크였다.
- 고친 내용:
  - 에이전트 상세의 동기식 승인 안내에서 "결재함" 링크를 뺐다 (워크플로 실행 화면만).
  - 지연 승인 대기 동작이 있으면 에이전트 상세에 **"대기 동작 N개" 배지 + "워크플로우 화면 대기 동작에서 승인·거절" 링크**가 뜬다. 링크는 `#workflow/<id>?run=<run>&actions=1`이고, 워크플로우 화면이 그 run의 대기 동작만 걸러 보여 주며 섹션으로 이동한다.
  - 서버: `GET /api/agents/wf/:runId/:step` 응답에 `pendingActions`(그 단계의 본인 queued 수)와 `workflowId` 추가.
- 검증: 로컬 응답 `pendingActions`·`workflowId` 확인 (`evidence/bf2-local-agent-wf.json`). 라이브: 테스트 run `wfrun_mwq51k7g_02syzj` 단계 2의 응답이 `pendingActions: 1`, `workflowId: wf_mwq4q0ns_h1idxs` (`evidence/bf-live/agent-wf-E.json`) → 배지와 링크가 뜨는 조건이 맞는다. 화면에 실제로 뜨는지는 Merlin 브라우저 확인.

### 6. Word 편집 버튼 + 엑셀 UI

- .docx 편집은 구현하지 않았다 (지시대로).
- 고친 내용: `/api/library`가 문서마다 원본 형식 `source_kind`(pptx·xlsx·docx·other·null)를 준다 (R2 키는 내보내지 않음). 라이브러리는 **PPTX·XLSX에만 "편집본 만들기" 버튼**을 달고, Word에는 "Word 편집 미지원 (새로 만들기는 됩니다)", 그 밖에는 "편집 미지원 형식" 글을 둔다. 버튼을 눌러 서버가 형식 오류를 낸 경우의 문구도 "이 파일 형식은 편집할 수 없습니다. 편집본 만들기는 PPTX·XLSX 파일만 됩니다 (Word 문서는 '새 Word 문서 만들기'로 새로 만들 수 있습니다)."로 바꿨다.
- 로컬 검증: 형식별 문서 4개가 `pptx`·`xlsx`·`docx`·`other`로 나온다 (`evidence/bf2-local-library.json`).
- 엑셀 라이브 확인 (API 수준 — 브라우저 없음): 시험 xlsx(5,134 B, 3시트)를 hr.jhkang 개인 문서로 업로드 (201, `doc_mwq6qbg7_7h752g`) → `/api/library`에서 그 행이 `has_source: 1`, `source_kind: "xlsx"` = 화면이 버튼을 다는 조건 충족 → 편집기가 여는 `POST /api/xlsx/inspect` 200, 3시트 (`evidence/bf-live/xlsx-*.json`, `library-with-xlsx.json`) → 문서 삭제 200 (벡터 1개 삭제), 남은 `doc_nodes` 2행도 지움. 지금 라이브 라이브러리의 다른 문서는 docx 1 · other 3 · 원본 없음 1이다. **버튼이 화면에 보이고 편집기 패널이 열리는 것 자체는 확인하지 못했다** — xlsx를 하나 올려 Merlin이 보면 된다.
- 한계: 형식은 업로드한 파일 이름의 확장자로 판단한다 (R2 키 `docs/<id>/source.<ext>`). 확장자가 틀린 xlsx는 버튼이 안 뜬다.

### 7. 알림 벨에 지연 승인 알림 없음 — 설계상 없음, 고치지 않음

- 알림을 만드는 곳은 `src/workflow/approvals.ts` 하나이고, 동기식 승인(run이 `waiting_approval`로 멈출 때)에서만 불린다. 지연 승인 경로(`src/workflow/pending-actions.ts`, 엔진·에이전트의 대기열 넣기)에는 알림 코드가 없다. P1~P3 결과 문서에도 지연 승인 알림은 없다 (동기식 알림 `wfapr_…`만 나온다). 버그가 아니라 설계다: 지연 승인은 run을 멈추지 않고 동작을 쌓아 두었다가 워크플로우 화면에서 한꺼번에 결정한다.
- 다만 지금은 워크플로우 화면에 들어가야만 대기 동작이 있는 줄 안다. 알림이 필요하면 "run이 끝날 때 대기 동작이 1개 이상이면 알림 1건 (run당 1건)"이 맞는 모양이다 — 동작마다 알림을 내면 벨이 넘친다. 이번에는 하지 않았다.

### 8. 정리

- 브라우저가 만든 편집본 덱 `deck_mwq5wm1j_g9umtk` "11월 팀 회의 전사본 (샘플) (편집본)" 18,789 B 삭제 (`DELETE /api/decks/:id` 200, R2 오류 없음). 원본 `deck_mwf14fsf_nmvrnq`(65,533 B)는 그대로 있다.
- 이 작업이 라이브에 만든 것과 처리:
  - 시험 세션 1행 (Opus 세션이 hr.jhkang으로 만든 `auth_sessions` 행) — **삭제함**, 뒤에 `/api/auth/me` 401 확인.
  - 시험 xlsx 문서 `doc_mwq6qbg7_7h752g` — 삭제함 (`documents` 0, `doc_nodes` 0).
  - **남긴 것**: hr.jhkang 어시스턴트 대화 턴 3 ("경조사 휴가는 며칠인가요?" + 답)과 그 트레이스 `evt_mwq6qua0_tn0lde`. 오늘 사용량이 1회 늘었다. 대화는 Merlin이 "대화 지우기"를 눌러 볼 재료로 두었고, 트레이스는 4번 확인 목록의 대상이다.
- 끝 상태 확인: 대기 동작 `wfpa_wfrun_mwq51k7g_02syzj_1_t1` `queued`, `[BF]` 문서 0, 편집본 덱 0, 읽지 않은 워크플로 승인 알림 0.
- 로컬 `wrangler dev`(포트 8842)는 끝냈다.

## 라이브 스모크

스모크는 배포 약 3분 뒤에 했다. 정적 파일은 3분 대기 타이머가 끝나기 조금 전에 받았는데 이미 새 버전이 응답했고, 로그인 호출은 그 뒤에 했다.

| 확인 | 결과 |
|---|---|
| 안 바뀐 엔드포인트 바이트 동일 (배포 전 `evidence/smoke/now-*`와 `cmp`) | **4/4 동일**: `docx-create.js`, `xlsx-edit.js`, 익명 `/api/auth/me`(401), 익명 `/api/workflows/templates`(401). `/api/health`도 내용 동일 |
| 바뀐 정적 파일 = 저장소 파일 (`cmp`) | **6/6 동일**: `ui-dialog.js`(4,372 B), `workflow.js`(78,403 B), `agents.js`, `styles.css`, `pptx-edit.js`, 홈 HTML(143,508 B) |
| `/api/library` | 200, 문서마다 `source_kind` 있음 (배포 전 응답에는 0개) |
| `/api/agents/wf/…` | 200, `pendingActions`·`workflowId` 있음 |
| 트레이스 | 새 질문에 스팬 9개 + 원문 (3번) |

근거: `evidence/bf-live/after-*`.

## 바뀐 파일

- 새 파일: `public/ui-dialog.js`
- 화면: `public/index.html`, `public/workflow.js`, `public/agents.js`, `public/pptx-edit.js`, `public/styles.css`
- 서버: `src/index.ts`, `src/assistant/routes.ts`, `src/workflow/nodes.ts`
- 근거: `evidence/bf-*`(Opus 세션), `evidence/bf2-*`·`evidence/bf-live-*`(이 세션). 로컬 전용: `harness/bf-*`, `bf-state/` (커밋에서 뺄 것: `bf-state/`, `harness/bf-seed.txt`).

## Merlin 브라우저 확인 목록

1. 워크플로우 화면 → 대기 동작 → 전체 선택 → "일괄 승인 (1)" → 화면 안 대화상자 → "1개 승인" → 토스트, 행 executed, 메일 1통.
2. 에이전트 → 내 어시스턴트 → "대화 지우기" → 대화상자 → "지우기" → 대화 비워짐.
3. 코칭 리플렉션 → "코칭 대상" 펼치기 → 김불꽃·이구름. 전사본 드롭다운에 샘플이 1줄 ("같은 내용 10개").
4. 관측·평가 → 트레이스 → 배포 뒤 만든 질문의 상세에 단계 타임라인·근거 후보·원문.
5. 에이전트 → "[RG] 지연 승인 시험 think" 단계 → "대기 동작 1개" 배지와 링크 (1번에서 승인하기 전에 볼 것).
6. 라이브러리 → Word 문서 행에 버튼 대신 "Word 편집 미지원" 글.

## Merlin 브라우저 확인 결과 — 2026-11-21 18:10~18:12 KST (전부 통과, 4번은 수량 차이만)

- **5번 통과**: 에이전트 화면 "[RG] 지연 승인 테스트" 실행에 노란 안내 "대기 동작 1개" + "워크플로우 화면 대기 동작에서 승인·거절" 링크 → 워크플로우 화면 `?run=wfrun_mwq51k7g_02syzj&actions=1`로 이동, "대기 동작 (1)" 섹션 표시. 네이티브 confirm()은 한 번도 안 뜸.
- **1번 통과**: 전체 선택 → "일괄 승인 (1)" → 화면 안 대화상자 "대기 동작 일괄 승인" ("선택한 1개 동작(메일 1개 · 웹훅 0개)을 승인할까요? … 되돌릴 수 없습니다.") → "1개 승인" → 토스트 "1개 승인했습니다. 실행 결과는 몇 초 안에 목록에 반영됩니다." → 행 "승인됨 (실행 대기)" → 약 20초 뒤 새로고침 없이 "실행됨". 메일함 최상단에 "[RG] 지연 승인 시험 think" 도착 (18:11, 연차휴가 신청 절차 요약 본문).
- **2번 통과**: "대화 지우기" → 화면 안 대화상자 → "지우기" → 토스트 "대화를 지웠습니다." → 대화란 "대화가 없습니다. 아래에 메시지를 보내 보세요."로 비워짐, 사용 횟수 그대로 (3/30회).
- **3번 통과**: 코칭 대상에 "김불꽃 (mercer.jhkang@peopleos.site) · 코칭 대상", "이구름 (coach.jhkang@peopleos.site) · 코치" 표시. 전사본 "11월 팀 회의 전사본 (샘플) · 2026-11-13 · 강준호 · 같은 내용 10개 (최신만 표시)" 1줄.
- **4번 통과 (수량 차이만)**: 트레이스 `evt_mwq6qua0_tn0lde` 상세에 단계 타임라인·근거 후보(Vectorize 5개 모두 하한 미달, D1 3개 채택)·프롬프트/응답 원문 전부 표시. 다만 스팬이 9개가 아니라 **10개** (cache·session·router·topic_guard·embed·vectorize·**d1_merge**·rerank·llm·session_save) — `d1_merge` 스팬 하나가 더 있다. 기능은 되나 개수만 다름. 질문 표기는 "경조사 휴가는 며칠인가?"로 보임 (원본 "며칠인가요?"와 어미 차이 — 화면 표기 차이로 보임).
- **6번 통과**: 라이브러리 test-docx 행에 "편집본 만들기" 버튼 없이 "Word 편집 미지원 (새로 만들기는 됩니다)"만 표시. 덱 행에는 버튼, test-pdf·test-hwpx 행에는 "편집 미지원 형식".

## 테스트 대기 동작 정리 (브라우저 확인 뒤, 2026-11-21 18:13)

- D1 확인: 대기 동작 `executed`, 메일 out `em_mwq6v2ka_3kg07z` + in `em_mwq6v487_nqf8xe` 도착 확인.
- 정리 실행 (`files/workflow-verify/regression-2026-11-21/cleanup-rg-pending.sql`): pending_actions·agent_steps·run_steps·runs·workflows(`wf_mwq4q0ns_h1idxs`)·emails 2행 삭제 + R2 `emails/<id>/raw.eml` 2개 삭제.
- 재확인: pa 0, run 0, wf 0, mail 0. 데모용 워크플로우 `wf_mwpkcw9x_039u20`("지연 승인 시연 (데모용)", run 0)은 건드리지 않음.
