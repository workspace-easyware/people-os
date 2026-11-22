# 로컬 통합 시험 요약 (wrangler dev --local, 포트 8792, 상태 files/workflow-verify/xlsx-edit-pilot/state 재사용)

| 시험 | 결과 | 근거 |
|---|---|---|
| `POST /api/docx/create` (def-test.json) | 201, 10,685 B, 섹션 5 / 블록 20 / 표 셀 12, R2 `docs/created/<id>.docx` | local-create.json |
| 기존 다운로드 라우트 | 200, DOCX Content-Type, 한글 파일명(RFC 5987) | local-download-headers.txt, docx-create-pilot/out/created-local.docx |
| 다시 열어 구조 확인 (파일럿 /verify) | 15/15 통과, XML 17부품 well-formed | local-verify.json |
| 라이브러리 목록 | 새 문서 행 (kind file, has_source 1, canDelete) | local-library.json |
| 익명 | 401 | (응답) |
| 섹션 51개 | 413 limit "섹션이 너무 많습니다 (상한 50)" | def-too-many-sections.json |
| 빈 본문 / def+instruction / 칸 수>헤더 / 제목 없음 / 배열 본문 | 400 (각각 명확한 한국어 오류) | (응답) |
| instruction (로컬) | 502 "AI 호출 실패: Binding AI needs to be run remotely" — 로컬 workerd는 Workers AI를 못 부른다 (알려진 한계) | (응답) |
| 워크플로 `docx_create` + `requiresApproval` | run waiting_approval(생성 전) → approve → 생성(`{{input.coach}}`·`{{input.mentor}}` 치환) → `create_task`가 `{{steps.s1.output.docId}}` 받음 → succeeded | wf-docx.json, local-wf-run.json, local-wf-reread.json |

로컬 상태 보정: 재사용한 상태에 `reflections.mode`(0018)·`reflections.coach_id/coachee_id`(0020)가 없어 `/api/library`가 500이었다 — 이번 변경과 무관한 로컬 스키마 차이라 그 열만 `d1 execute --local`로 넣었다. 운영 DB는 마이그레이션으로 만들어져 영향 없음.
