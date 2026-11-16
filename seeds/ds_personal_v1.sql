-- 개인 RAG 골든 세트 ds_personal_v1 (2026-11-16). 멱등. 마이그레이션이 아님 — d1 execute --file로 적용.
-- 이 데이터셋은 개인 풀(viewer 필요)에서만 답이 나온다. ds_core_v1(공용 풀, viewer 없음) 러너로 돌리지 말 것.
-- 자동 러너는 보류(viewer 인식 실행 경로 필요). 수동 확인: POST /api/personal/ask (hr.jhkang@gmail.com 세션).
INSERT OR IGNORE INTO eval_datasets (id, name, description, version) VALUES
 ('ds_personal_v1', 'personal_v1', '개인 RAG(개인 풀) 골든 세트 v1 — 본인 전사본 질문, 근거 없음, 풀 격리 확인. hr.jhkang@gmail.com 전사본 기준. 공용 풀 러너로 실행 금지(viewer 필요).', 1);

-- Nokia 항목은 ds_core_v1에서 이동 (Nokia 문장은 개인 전사본에만 있음). id 유지.
UPDATE eval_items SET dataset_id='ds_personal_v1', question='Nokia는 네트워크 문제 해결 시간을 얼마나 줄였나요?',
  expected_answer='네트워크 문제 해결(트러블슈팅) 시간을 80% 이상 줄였다.',
  expected_sources='[{"title_like":"clip2min"}]', expected_verdict='grounded',
  tags='["transcript","personal","golden"]', source='golden',
  prereq='전사본 "clip2min"(Gemini Enterprise 고객 사례, 소유자 hr.jhkang@gmail.com)이 라이브에 남아 있어야 함. 11-25 데모 데이터 정리 때 지우지 말 것.',
  active=1, updated_at=datetime('now')
 WHERE id='gi_s01_nokia_transcript';

INSERT OR REPLACE INTO eval_items (id, dataset_id, question, expected_answer, expected_sources, expected_verdict, tags, source, origin_ref, prereq, active) VALUES
 ('gi_p01_docomo_transcript','ds_personal_v1',
  'NTT Docomo는 데이터 에이전트로 데이터 수집부터 인사이트까지 걸리는 시간을 어떻게 바꿨나요?',
  '데이터 수집에서 인사이트까지 2주 걸리던 것을 즉각적인 실시간 결과로 줄였고, 연간 45만 시간 이상을 절감했다.',
  '[{"title_like":"clip2min"}]','grounded','["transcript","personal","golden"]','golden',NULL,
  '전사본 clip2min 필요(소유자 hr.jhkang@gmail.com).',1),
 ('gi_p02_leave_expired_transcript','ds_personal_v1',
  '11월 팀 회의에서 인사담당이 작년에 소멸된 연차가 며칠이라고 했나요?',
  '작년에 소멸된 연차는 5일이다.',
  '[{"title_like":"11월 팀 회의 전사본"}]','grounded','["transcript","personal","golden"]','golden',NULL,
  '전사본 "11월 팀 회의 전사본 (샘플)" 필요(동일 문서가 여러 건 있음).',1),
 ('gi_p03_plod_highlight_transcript','ds_personal_v1',
  'Plod에서 녹음 중에 중요한 순간을 표시하려면 어떻게 하나요?',
  '녹음 중 기기의 press to highlight(눌러서 하이라이트)로 그 순간을 즉시 표시한다. 앱에서도 하이라이트를 추가할 수 있고 사진이나 텍스트를 덧붙일 수 있다.',
  '[{"title_like":"original"}]','grounded','["transcript","personal","golden"]','golden',NULL,
  '전사본 "original"(How to use Plod) 필요.',1),
 ('gi_p04_noevidence_budget','ds_personal_v1',
  '내 전사본들에서 2027년 마케팅 예산은 얼마라고 했나요?',
  NULL,'[]','ungrounded','["no-evidence","personal","golden"]','golden',NULL,
  '어느 개인 문서에도 마케팅 예산 언급 없음(2026-11-16 확인).',1),
 ('gi_p05_noevidence_plod_price','ds_personal_v1',
  'Plod 구독 요금제는 월 얼마인가요?',
  NULL,'[]','ungrounded','["no-evidence","personal","golden"]','golden',NULL,
  'Plod 전사본에 가격 정보 없음(2026-11-16 확인). 그럴듯하지만 근거 없는 질문.',1),
 ('gi_p06_isolation_shared_policy','ds_personal_v1',
  '평가는 목표 달성도, 역량, 협업을 각각 몇 퍼센트로 반영하나요?',
  NULL,'[]','ungrounded','["isolation","personal","golden"]','golden',NULL,
  '답(60/30/10)은 공용 풀 "평가·승진" 규정에만 있음. 개인 창에서는 규정 내용이 나오면 안 됨(HR 창 안내 리다이렉트 또는 근거 없음이면 통과).',1),
 ('gi_p07_isolation_other_user_MANUAL','ds_personal_v1',
  '(수동) 다른 사용자(coach.jhkang@gmail.com)가 올린 전사본에만 있는 내용을 hr.jhkang@gmail.com 개인 창에서 질문',
  NULL,'[]','ungrounded','["isolation","personal","manual","golden"]','golden',NULL,
  '수동 확인용 — 비활성. 2026-11-16 기준 coach 사용자는 문서가 0건이라 자동 설정 불가(가짜로 만들지 않음). 절차: coach로 로그인해 고유 문구가 든 전사본 업로드 → hr 계정 /api/personal/ask로 그 문구 질문 → 출처·답에 coach 문서가 없어야 함 → coach 문서 삭제.',0);
