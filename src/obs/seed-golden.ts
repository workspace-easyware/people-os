// S4 M3 — 골든 데이터셋 시드 + 승격 helper (S4 설계서 §9.3, §10).
//
// 원칙
// - 기대 답(expected_answer)은 `seed/seed-data.json` 정책 본문(또는 사람이 게시한 암묵지/문서 본문)을
//   사람이 요약한 문장이다. 모델로 자동 생성하지 않는다 (정답을 모델이 만들면 순환이 된다).
// - 원문을 확보하지 못한 항목은 TODO 플레이스홀더: active=0 + prereq에 사유. 기대 답을 지어내지 않는다.
// - 멱등: 고정 id(`ds_core_v1`, `gi_<slug>`) + INSERT OR IGNORE. 다시 돌려도 행이 늘지 않고,
//   이미 있는 행(사람이 PATCH한 active·문구 포함)은 덮어쓰지 않는다.
import type { EvalItem, ExpectedSource, ExpectedVerdict, ObsEnv } from "./types";
import { newId } from "./db";

export const GOLDEN_DATASET_ID = "ds_core_v1";
export const GOLDEN_DATASET_NAME = "core_v1";
export const GOLDEN_DATASET_DESC =
  "People OS 핵심 골든 질문 세트 v1 — 정책 Q&A, 암묵지, 업로드 문서 파서, 근거 없음 확인. 기대 답은 사람이 시드 본문에서 요약한 것.";

type SeedItem = {
  id: string;
  question: string;
  expectedAnswer: string | null;
  expectedSources: ExpectedSource[];
  expectedVerdict: ExpectedVerdict;
  tags: string[];
  prereq: string | null;
  active: boolean;
};

/** 시드 시점에 로컬/대상 D1에서 확인하는 조건부 항목(S-05, S-07)의 판정 결과. */
export type SeedProbe = {
  tacitDocId: string | null;
  tacitAnswer: string | null;
  hwpxDocId: string | null;
  hwpxScopeAnswer: string | null;
};

const TODO = "TODO";

/** 확정 항목(prereq 확인됨) — 정책 본문은 seed/seed-data.json 의 사람 요약. */
function activeItems(): SeedItem[] {
  return [
    {
      id: "gi_s03_leave_3days",
      question: "연차 3일 쓸 수 있어?",
      expectedAnswer:
        "연차휴가는 근로자가 원하는 시기에 쓸 수 있고(사업 운영에 막대한 지장이 있을 때만 시기 변경), 사용 시에는 최소 3일 전까지 팀장에게 신청하는 것이 원칙이다.",
      expectedSources: [{ title_like: "연차휴가", article_like: "제12조" }],
      expectedVerdict: "grounded",
      tags: ["policy", "seed", "leave"],
      prereq: null,
      active: true,
    },
    {
      id: "gi_s04_leave_accrual",
      question: "연차휴가는 입사 몇 년이 지나면 생기나요?",
      expectedAnswer:
        "입사 1년 미만은 1개월 개근 시 1일씩 부여되고, 1년 이상 근속하면 15일이 부여된다. 이후 근속 2년마다 1일이 가산되어 최대 25일까지 부여된다.",
      expectedSources: [{ title_like: "연차휴가", article_like: "제12조" }],
      expectedVerdict: "grounded",
      tags: ["policy", "seed", "leave", "regression"],
      prereq: null,
      active: true,
    },
    {
      id: "gi_s10_training_support",
      question: "교육 지원은 어떻게 돼?",
      expectedAnswer:
        "교육비는 회사가 부담한다. 신규 입사자는 입사 후 3개월 이내 필수 교육을 이수하고, 직무 교육은 연 20시간 이상을 권장한다. 외부 교육은 사전 승인이 필요하고 교육 후에는 팀 내 공유 세션을 진행한다.",
      expectedSources: [{ title_like: "교육", article_like: "제18조" }],
      expectedVerdict: "grounded",
      tags: ["policy", "seed", "training"],
      prereq: null,
      active: true,
    },
    {
      id: "gi_s11_travel_expense",
      question: "출장비는 어떻게 정산해요?",
      expectedAnswer:
        "출장비는 실비 정산이 원칙이다. 숙박비는 1박 기준 국내 15만원(해외는 지역별 상한)이고, 경비는 영수증을 첨부해 귀국 후 7일 이내에 정산한다.",
      expectedSources: [{ title_like: "출장", article_like: "제20조" }],
      expectedVerdict: "grounded",
      tags: ["policy", "seed", "travel"],
      prereq: null,
      active: true,
    },
  ];
}

/** 조건부·플레이스홀더 항목. probe 결과에 따라 S-05/S-07이 활성 또는 TODO가 된다. */
function conditionalItems(probe: SeedProbe): SeedItem[] {
  const items: SeedItem[] = [];

  // S-01 Nokia 전사본 — 원문 미확보 (§10, O6)
  items.push({
    id: "gi_s01_nokia_transcript",
    question: "Nokia는 네트워크 문제 해결 시간을 얼마나 줄였나요?",
    expectedAnswer: null,
    expectedSources: [],
    expectedVerdict: "grounded",
    tags: ["transcript", "seed", "placeholder"],
    prereq:
      `${TODO}: 질문 원문 미확보(현재 문구는 설계서 §10의 임시 질문). 기대 답은 전사본 문장 "They reduced networking troubleshooting time by over 80%"에서 사람이 확인해 작성 — 요지 후보는 '80% 이상 단축'이나 전사본 원문 확인 전이라 비워 둠. ` +
      `사전 조건: 해당 전사본 문서가 라이브에 남아 있어야 함(11-25 데모 데이터 정리 때 지우지 않게 표시). 근거 문서 제목은 라이브 D1에서 확인 후 expected_sources에 입력.`,
    active: false,
  });

  // S-02 유연근무 DOCX 제2조 — 원문·본문 미확보
  items.push({
    id: "gi_s02_flex_docx",
    question: "유연근무제는 누구에게 적용되나요?",
    expectedAnswer: null,
    expectedSources: [{ article_like: "제2조" }], // 업로드 문서 제목은 라이브 확인 후 title_like 추가
    expectedVerdict: "grounded",
    tags: ["parser", "docx", "seed", "placeholder"],
    prereq:
      `${TODO}: 질문 원문 미확보(임시 질문). 기대 답은 test-files/test-docx.docx 제2조 본문에서 사람이 요약해야 함(이 시드는 docx 본문을 읽지 못했다). ` +
      `사전 조건: DOCX가 라이브에서 toMarkdown으로 변환·색인돼 있어야 함(C5 Phase 3 라이브 확인 대기).`,
    active: false,
  });

  // S-05 출산 전후 재택(암묵지) — kind='tacit' 문서가 게시돼 있을 때만 활성
  if (probe.tacitDocId && probe.tacitAnswer) {
    items.push({
      id: "gi_s05_tacit_maternity_remote",
      question: "출산 전후 재택 가능해요?",
      expectedAnswer: probe.tacitAnswer,
      expectedSources: [{ title_like: "출산" }],
      expectedVerdict: "grounded",
      tags: ["tacit", "seed"],
      prereq:
        `시드 시점에 이 DB의 documents(kind='tacit')에 게시 문서가 있음(${probe.tacitDocId}). 기대 답은 그 문서의 사람이 쓴 게시 본문(작성자·원 질문 머리글 제외)을 그대로 옮긴 것. ` +
        `주의: 데모 리셋 때 이 항목도 함께 바뀐다 — 게시가 사라지면 기대 판정이 ungrounded가 되므로 비활성화할 것. 라이브 DB에서 다시 확인하기 전까지 로컬 확인분임.`,
      active: true,
    });
  } else {
    items.push({
      id: "gi_s05_tacit_maternity_remote",
      question: "출산 전후 재택 가능해요?",
      expectedAnswer: null,
      expectedSources: [{ title_like: "출산" }],
      expectedVerdict: "grounded",
      tags: ["tacit", "seed", "placeholder"],
      prereq:
        `${TODO}: 시드 시점에 이 DB에서 게시된 암묵지 문서(kind='tacit', 출산·재택)를 찾지 못함. 게시 후 기대 답을 그 본문에서 그대로 옮겨 PATCH로 활성화. ` +
        `게시 전이라면 기대 판정은 ungrounded가 된다.`,
      active: false,
    });
  }

  // S-06 근거 없음 — 검증된 질문 미확보
  items.push({
    id: "gi_s06_ungrounded",
    question: "회사 주차장 정기권은 어떻게 신청하나요?",
    expectedAnswer: null,
    expectedSources: [],
    expectedVerdict: "ungrounded",
    tags: ["ungrounded", "seed", "placeholder"],
    prereq:
      `${TODO}: 사용자가 확인한 근거 없음 질문으로 교체 필요(현재는 7개 규정 주제와 겹치지 않게 고른 임시 질문). ` +
      `로컬에서 no-evidence(근거 없음·LLM 미호출)를 확인한 뒤 활성화.`,
    active: false,
  });

  // S-07 HWPX 적용 범위 — HWPX 업로드 문서가 있을 때만 활성
  if (probe.hwpxDocId && probe.hwpxScopeAnswer) {
    items.push({
      id: "gi_s07_hwpx_scope",
      question: "이 규정은 누구에게 적용되나요?",
      expectedAnswer: probe.hwpxScopeAnswer,
      expectedSources: [{ title_like: "hwpx", article_like: "제2조" }],
      expectedVerdict: "grounded",
      tags: ["parser", "hwpx", "seed", "ambiguous"],
      prereq:
        `시드 시점에 이 DB에 HWPX 업로드 문서가 있음(${probe.hwpxDocId}, 제2조 적용 범위 본문 확인). "이 규정"은 지시어라 다른 업로드 문서가 늘면 모호해진다(ambiguous). ` +
        `라이브 DB에서 다시 확인하기 전까지 로컬 확인분임. 사전 조건: HWPX 업로드 문서가 라이브에 있어야 함.`,
      active: true,
    });
  } else {
    items.push({
      id: "gi_s07_hwpx_scope",
      question: "이 규정은 누구에게 적용되나요?",
      expectedAnswer: null,
      expectedSources: [{ title_like: "hwpx", article_like: "제2조" }],
      expectedVerdict: "grounded",
      tags: ["parser", "hwpx", "seed", "ambiguous", "placeholder"],
      prereq:
        `${TODO}: 시드 시점에 이 DB에서 HWPX 업로드 문서(제2조 적용 범위)를 찾지 못함. test-files/test-hwpx.hwpx 제2조 본문에서 사람이 요약한 뒤 활성화. ` +
        `사전 조건: HWPX 업로드 문서가 라이브에 있어야 함.`,
      active: false,
    });
  }

  // S-08 PDF 파서 — 질문 자체가 TODO
  items.push({
    id: "gi_s08_pdf",
    question: "TODO: test-files/test-pdf.pdf 내용 기반 질문",
    expectedAnswer: null,
    expectedSources: [],
    expectedVerdict: "grounded",
    tags: ["parser", "pdf", "seed", "placeholder"],
    prereq: `${TODO}: C5 Phase 3 라이브 확인("DOCX/PDF 실제 변환") 뒤 질문·기대 답을 사람이 작성. 그 전에는 실행에서 제외.`,
    active: false,
  });

  return items;
}

/** 시드 순서: S-01 … S-11 (S-09는 질문 항목이 아니라 넣지 않는다). */
export function buildSeedItems(probe: SeedProbe): SeedItem[] {
  const byId = new Map<string, SeedItem>();
  for (const it of [...activeItems(), ...conditionalItems(probe)]) byId.set(it.id, it);
  const order = [
    "gi_s01_nokia_transcript", "gi_s02_flex_docx", "gi_s03_leave_3days", "gi_s04_leave_accrual",
    "gi_s05_tacit_maternity_remote", "gi_s06_ungrounded", "gi_s07_hwpx_scope", "gi_s08_pdf",
    "gi_s10_training_support", "gi_s11_travel_expense",
  ];
  return order.map((id) => byId.get(id)!);
}

/**
 * S-05/S-07의 사전 조건을 대상 D1에서 확인한다. 읽기 전용.
 * - 암묵지: kind='tacit' 이면서 제목/본문에 '출산'과 '재택|집에서' 가 있는 문서. 기대 답은 본문에서
 *   머리글(작성자·원 질문 줄)을 뗀 사람 작성 텍스트를 그대로 쓴다.
 * - HWPX: 제목 또는 R2 키에 hwpx가 있고 본문에 '제2조 적용 범위'가 있는 문서. 본문이 "전 직원에게 적용"을
 *   말할 때만 기대 답을 채운다(그렇지 않으면 사람이 요약하도록 TODO).
 */
export async function probeSeedPrereqs(db: D1Database): Promise<SeedProbe> {
  const probe: SeedProbe = { tacitDocId: null, tacitAnswer: null, hwpxDocId: null, hwpxScopeAnswer: null };
  try {
    const tacit = await db
      .prepare(
        `SELECT id, content FROM documents
          WHERE kind = 'tacit' AND (title LIKE '%출산%' OR content LIKE '%출산%')
            AND (title LIKE '%재택%' OR title LIKE '%집에서%' OR content LIKE '%재택%')
          ORDER BY created_at DESC LIMIT 1`,
      )
      .first<{ id: string; content: string | null }>();
    if (tacit?.content) {
      const body = tacit.content
        .split("\n")
        .filter((l) => !/^(작성자:|원 질문:)/.test(l.trim()))
        .join("\n")
        .trim();
      if (body) {
        probe.tacitDocId = tacit.id;
        probe.tacitAnswer = body;
      }
    }
  } catch {
    // documents 조회 실패 → 조건 미충족으로 취급 (플레이스홀더)
  }
  try {
    const hwpx = await db
      .prepare(
        `SELECT id, content FROM documents
          WHERE (LOWER(title) LIKE '%hwpx%' OR LOWER(COALESCE(source_r2_key, '')) LIKE '%.hwpx')
            AND content LIKE '%제2조%적용 범위%' AND extract_status = 'ready'
          ORDER BY created_at DESC LIMIT 1`,
      )
      .first<{ id: string; content: string | null }>();
    if (hwpx?.content) {
      probe.hwpxDocId = hwpx.id;
      if (/전\s*직원에게\s*적용/.test(hwpx.content)) {
        probe.hwpxScopeAnswer = "제2조(적용 범위)에 따라 이 규정은 전 직원에게 적용된다.";
      }
    }
  } catch {
    // 위와 동일
  }
  return probe;
}

export type SeedResult = { datasetId: string; inserted: number; skipped: number };

/**
 * 골든 데이터셋 시드. 멱등: 데이터셋·항목 모두 INSERT OR IGNORE(고정 id).
 * 기존 데이터셋에 새 항목이 들어갈 때만 version +1 (항목 변경으로 보므로).
 * 한 번에 batch로 묶는다.
 */
export async function seedGoldenDataset(env: Pick<ObsEnv, "DB">): Promise<SeedResult> {
  const db = env.DB;
  const probe = await probeSeedPrereqs(db);
  const items = buildSeedItems(probe);

  const existed = await db.prepare("SELECT 1 AS x FROM eval_datasets WHERE id = ?").bind(GOLDEN_DATASET_ID).first();

  const stmts: D1PreparedStatement[] = [
    db
      .prepare("INSERT OR IGNORE INTO eval_datasets (id, name, description, version) VALUES (?, ?, ?, 1)")
      .bind(GOLDEN_DATASET_ID, GOLDEN_DATASET_NAME, GOLDEN_DATASET_DESC),
  ];
  for (const it of items) {
    stmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO eval_items
             (id, dataset_id, question, expected_answer, expected_sources, expected_verdict, tags, source, prereq, active)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'seed', ?, ?)`,
        )
        .bind(
          it.id, GOLDEN_DATASET_ID, it.question, it.expectedAnswer,
          JSON.stringify(it.expectedSources), it.expectedVerdict, JSON.stringify(it.tags),
          it.prereq, it.active ? 1 : 0,
        ),
    );
  }
  const results = await db.batch(stmts);
  let inserted = 0;
  for (let i = 1; i < results.length; i++) inserted += results[i].meta?.changes ?? 0;
  const skipped = items.length - inserted;

  if (existed && inserted > 0) {
    await db.prepare("UPDATE eval_datasets SET version = version + 1 WHERE id = ?").bind(GOLDEN_DATASET_ID).run();
  }
  return { datasetId: GOLDEN_DATASET_ID, inserted, skipped };
}

// ---- 승격 (트레이스/공백 → 골든 항목) ----------------------------------------------

export class PromoteError extends Error {
  constructor(public status: 404 | 409 | 400, message: string, public existingId?: string) {
    super(message);
  }
}

export type PromoteInput = {
  expectedAnswer?: string | null;
  expectedSources?: ExpectedSource[];
  expectedVerdict?: ExpectedVerdict;
  datasetId?: string;
  tags?: string[];
};

async function promoteQuestion(
  env: Pick<ObsEnv, "DB">,
  question: string,
  source: EvalItem["source"],
  originRef: string,
  input: PromoteInput,
): Promise<string> {
  const db = env.DB;
  const datasetId = input.datasetId ?? GOLDEN_DATASET_ID;
  const ds = await db.prepare("SELECT 1 AS x FROM eval_datasets WHERE id = ?").bind(datasetId).first();
  if (!ds) throw new PromoteError(404, `dataset not found: ${datasetId}`);
  const verdict: ExpectedVerdict = input.expectedVerdict ?? "grounded";
  if (verdict !== "grounded" && verdict !== "ungrounded") throw new PromoteError(400, "expectedVerdict must be grounded|ungrounded");

  // 같은 질문이 이미 활성 항목이면 409 + 기존 id (수용 기준 ④)
  const dup = await db
    .prepare("SELECT id FROM eval_items WHERE dataset_id = ? AND active = 1 AND question = ? LIMIT 1")
    .bind(datasetId, question)
    .first<{ id: string }>();
  if (dup) throw new PromoteError(409, "question already an active item", dup.id);

  const id = newId("gi");
  await db.batch([
    db
      .prepare(
        `INSERT INTO eval_items
           (id, dataset_id, question, expected_answer, expected_sources, expected_verdict, tags, source, origin_ref, prereq, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)`,
      )
      .bind(
        id, datasetId, question, input.expectedAnswer ?? null,
        JSON.stringify(input.expectedSources ?? []), verdict,
        JSON.stringify(input.tags ?? ["promoted"]), source, originRef,
      ),
    db.prepare("UPDATE eval_datasets SET version = version + 1 WHERE id = ?").bind(datasetId),
  ]);
  return id;
}

/** 트레이스(ask_events 행)의 질문을 골든 항목으로 승격. 기대 답은 호출자(사람)가 준다. */
export async function promoteTraceToItem(
  env: Pick<ObsEnv, "DB">,
  eventId: string,
  input: PromoteInput,
): Promise<string> {
  const ev = await env.DB.prepare("SELECT question FROM ask_events WHERE id = ?").bind(eventId).first<{ question: string }>();
  if (!ev) throw new PromoteError(404, `trace not found: ${eventId}`);
  return promoteQuestion(env, ev.question, "trace", eventId, input);
}

/** 지식 공백(knowledge_gaps 행)의 질문을 골든 항목으로 승격. */
export async function promoteGapToItem(
  env: Pick<ObsEnv, "DB">,
  gapId: string,
  input: PromoteInput,
): Promise<string> {
  const gap = await env.DB.prepare("SELECT question FROM knowledge_gaps WHERE id = ?").bind(gapId).first<{ question: string }>();
  if (!gap) throw new PromoteError(404, `gap not found: ${gapId}`);
  return promoteQuestion(env, gap.question, "gap", gapId, input);
}
