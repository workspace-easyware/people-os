# 개인별 RAG 격리 — 원격 적용 런북 (부모용, 2026-11-15)

로컬 구현·검증 완료. 원격 작업은 하지 않았음. 아래 순서대로 원격에서 실행할 것.
계정 ID: 44501085a1a83d8c0f838a44c1800144. D1 people-os-db, Vectorize people-os-index-m3.
원격 wrangler는 cf-wrangler 헬퍼(`~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py`,
직접 실행, python3 접두 금지)로만 실행할 것 (plain npx wrangler는 토큰이 없어 원격 실패).

## 0. 전제 확인

- GitHub people-os 저장소에 최신 코드가 푸시돼 있어야 한다 (모듈 A·B·C + 통합 수정).
- 원격 D1에 hr.jhkang@gmail.com 계정이 존재하는지 확인한다.
  0016의 이관 UPDATE는 users를 참조하므로, 계정이 없으면 이관은 no-op이 된다
  (실패는 안 하지만 전사본 소유자가 비어 있게 됨).

## 1. Vectorize user_id 메타데이터 인덱스 생성 (가장 먼저!)

벡터를 넣기 전에 인덱스를 만들어야 한다. 인덱스 생성 전에 넣은 벡터는
해당 속성으로 필터가 안 걸린다. 명령어:

```bash
cf-wrangler.py vectorize create-metadata-index people-os-index-m3 --property-name user_id --type string
```

wrangler 3.114 도움말 기준 positionals는 `<name> <property-name> <type>`이다.
위 플래그 형태가 안 되면 위치 인자 형태를 쓴다:

```bash
cf-wrangler.py vectorize create-metadata-index people-os-index-m3 user_id string
```

생성 확인: `cf-wrangler.py vectorize get people-os-index-m3` (또는 list)으로
metadataIndexes에 user_id(string)가 있는지 본다.

## 2. 원격 D1 마이그레이션 0016 적용

```bash
cd files/people-os
cf-wrangler.py d1 migrations apply people-os-db --remote
```

적용 후 확인 (원격 D1 쿼리):

```sql
PRAGMA table_info(documents);  -- owner_id 컬럼 확인
SELECT kind, COUNT(*) FROM documents WHERE owner_id IS NOT NULL GROUP BY kind;
-- 기대: transcript 16건이 hr.jhkang@gmail.com의 id로 채워져 있음
SELECT id, email FROM users WHERE email = 'hr.jhkang@gmail.com';
```

만약 transcript 소유자가 비어 있으면 (마이그레이션 적용 전에 계정이 없어서),
이관 UPDATE만 따로 다시 돌린다:

```sql
UPDATE documents SET owner_id = (SELECT id FROM users WHERE email = 'hr.jhkang@gmail.com') WHERE kind = 'transcript' AND owner_id IS NULL;
UPDATE recordings SET owner_id = (SELECT id FROM users WHERE email = 'hr.jhkang@gmail.com') WHERE owner_id IS NULL;
```

## 3. 배포

```bash
cf-wrangler.py deploy
```

배포 후 health 확인: https://people-os.workspace-easyware.workers.dev/api/health

## 4. 재색인 실행 (POST /api/admin/reindex)

메타데이터 인덱스 생성(1번) 이후에 실행해야 한다. 관리자 게이트:
hr_admin 세션 쿠키 또는 X-Admin-Secret 헤더.

```bash
curl -X POST "https://people-os.workspace-easyware.workers.dev/api/admin/reindex?limit=500" \
  -H "x-admin-secret: <ADMIN_SECRET>"
```

- 응답: `{ ok, upserted, total, chunks, errors }`. total은 chunks 전체 개수.
- chunks가 500을 넘으면 offset으로 나눠서 돌린다:
  `?limit=500&offset=500`, `?limit=500&offset=1000` …
- upsert는 같은 id에 멱등이라 중간에 끊겨도 다시 돌리면 된다.
- 완료 후 meta `vector_reindexed_v2`에 { upserted, at }가 남는다.

주의: 재색인은 bge-m3 임베딩을 다시 돌리므로 Workers AI 호출이 생긴다.
21건 문서 기준 chunks는 수십~100개 수준이라 1~2회 호출로 끝난다.

## 5. 원격 검증 (부모가 직접)

로컬에서 검증 못한 Vectorize 필터 경로를 원격에서 확인한다:

1. **격리 테스트**: 테스트 사용자 2명을 만들고, A가 개인 문서(전사본)를 올린 뒤
   B 세션으로 그 내용을 질문 → grounded=false, A 문서 미노출.
   A 세션으로 같은 질문 → grounded=true, A 문서 출처.
   (로컬 절차는 `notes/per-user-rag/verify.sh` 4번 섹션 참조. 로컬은 D1 경로로 통과.)
2. **공용 회귀**: "연차 3일 쓸 수 있어?" 등 골든셋 6개 질문이 여전히
   grounded=true이고 공용 출처인지 확인.
3. **수동 평가 1회**: 오늘(11-15) 일일 한도 5회 중 남은 횟수 안에서
   골든셋 평가를 돌려 6/6 유지 확인. (6/6을 만들려고 반복 실행 금지 — Goodhart 방지.)
4. **덱·녹음 게이트**: A가 만든 덱을 B가 받으면 403, A가 받으면 200.

## 6. 로컬 검증 결과 요약 (참조)

- 로컬 검증 스크립트 `notes/per-user-rag/verify.sh`: **35/35 통과**.
  (격리 7건, 목록 필터 3건, 덱 게이트 4건, 녹음 게이트 3건, 골든셋 6건,
  무회귀 4건, 마이그레이션 이관 1건, 문서 생성·pool 배지 3건 등.)
- lib.ts 필터 헬퍼 단위 검증 `notes/per-user-rag/filter-unit-test.mjs`: **11/11 통과**.
- `npx tsc --noEmit`: 오류 0.
- 로컬에서 검증 불가한 것: Vectorize user_id 필터 실제 동작 (로컬에 Vectorize 없음),
  /api/admin/reindex의 실제 임베딩·upsert (로컬 AI 불가로 errors 반환 확인만 함).
  두 항목은 위 4·5번 원격 단계에서 확인해야 한다.

## 7. 알려진 제한·후속 과제 (이번 작업 범위 밖)

- **JSON 경로 문서 색인 누락**: POST /api/documents JSON 경로는 chunk를 안 만들어
  RAG에 안 보인다 (프론트 텍스트 입력이 이 경로). 고치려면 JSON 경로에서
  indexDocument 호출 추가. 자세한 내용은 ISOLATION-TESTS.md 5번 참조.
- **평가 실행기의 격리 테스트**: runAsk(origin='eval')는 viewer가 없어 공용만 본다.
  격리 테스트를 평가 항목으로 넣으려면 runner.ts에 viewer 전달이 필요.
- **tasks/reflections는 소유자 범위 없음**: 할 일·코칭 리플렉션은 전역이다.
  개인별 범위가 필요하면 별도 작업.
- **기존 캐시**: 캐시 키에 viewer id를 넣어 기존 캐시와 분리했다. 기존 캐시 행은
  TTL(3600초)로 자연 소멸한다. 개인 문서 기반 답이 섞일 위험은 없다.
