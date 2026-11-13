// 로컬 폴백 로직: Workers AI / Vectorize가 로컬에서 안 돌 때
// 데모 흐름이 끊기지 않게 D1 텍스트 검색 + 추출식 요약으로 답한다.
// 클라우드에서는 같은 인터페이스로 Workers AI / Vectorize를 먼저 시도한다.
import seed from "../seed/seed-data.json";

export type Policy = { id: string; title: string; section: string; body: string };

/** 조문 단위 근거 chunk (C5). id는 Vectorize 색인 키와 같다. */
export type Chunk = { id: string; doc_id: string; article: string; text: string; ord: number };

/**
 * 정책 본문을 제N조 단위로 나눈다.
 * - 본문을 `제\d+조` 마커 앞 기준으로 자른다. 마커가 없으면 통째로 1개.
 * - article 라벨: 마커 뒤 첫 문장까지. 마커가 없는 조각은 section에서
 *   조 부분만 뽑는다 ("제3장 휴가 — 제12조 연차휴가" → "제12조 연차휴가").
 * - 시드 정책 7건은 본문이 단일 조문이라 1건당 chunk 1개가 나온다.
 */
export function splitPolicyIntoChunks(policy: Policy): Chunk[] {
  const parts = policy.body.split(/(?=제\d+조)/).map((s) => s.trim()).filter((s) => s.length > 0);
  return parts.map((text, ord) => {
    let article = "";
    const m = text.match(/^제\d+조\s*([^.。\n]{0,30})/);
    if (m) article = m[0].trim();
    if (!article) {
      const secParts = policy.section.split("—").map((s) => s.trim()).filter((s) => s.length > 0);
      article = secParts.length > 1 ? secParts[secParts.length - 1] : policy.section;
    }
    return { id: `${policy.id}-chunk-${ord}`, doc_id: policy.id, article, text, ord };
  });
}

export function policies(): Policy[] {
  return seed.policies as Policy[];
}

/**
 * Markdown 문서(암묵지 답)를 근거 chunk로 나눈다 (C5-b).
 * - 1차: `제\d+조` 마커 기준 분할 (정책 청킹과 동일).
 * - 2차: 긴 조각은 문단 단위로 다시 나눈다 (800자 상한). 문단 하나가
 *   800자를 넘으면 문장 단위로 나눈다.
 * - article 라벨: 마커 뒤 첫 문장, 없으면 첫 줄(제목 부호 제거, 30자 상한),
 *   그것도 없으면 문서 제목. 암묵지 답은 보통 조문 마커가 없어 첫 줄이 라벨이 된다.
 */
export function splitMarkdownIntoChunks(doc: { id: string; title: string; body: string }): Chunk[] {
  const parts = doc.body.split(/(?=제\d+조)/).map((s) => s.trim()).filter((s) => s.length > 0);
  const chunks: Chunk[] = [];
  let ord = 0;
  const articleOf = (text: string): string => {
    const m = text.match(/^제\d+조\s*([^.。\n]{0,30})/);
    if (m) return m[0].trim();
    // 첫 줄이 본문 상단 메타("작성자: …", "원 질문: …")면 건너뛰고
    // 첫 내용 줄을 라벨로 쓴다 (출처 표시가 메타 줄이 되지 않게).
    const first = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !/^(작성자:|원 질문:)/.test(l))[0] || "";
    const clean = first.replace(/^#+\s*/, "");
    return clean.slice(0, 30) || doc.title;
  };
  for (const part of parts) {
    const paras = part.split(/\n\s*\n/).map((s) => s.trim()).filter((s) => s.length > 0);
    let buf = "";
    const flush = () => {
      if (!buf) return;
      chunks.push({ id: `${doc.id}-chunk-${ord}`, doc_id: doc.id, article: articleOf(buf), text: buf, ord });
      ord++;
      buf = "";
    };
    for (const p of paras) {
      // 문단 하나가 상한을 넘으면 문장 단위로 쪼개서 채운다.
      const pieces = p.length > 800 ? p.split(/(?<=[.?!])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 0) : [p];
      for (const piece of pieces) {
        if (buf && buf.length + piece.length + 2 > 800) flush();
        buf = buf ? buf + "\n\n" + piece : piece;
      }
    }
    flush();
  }
  return chunks.length
    ? chunks
    : [{ id: `${doc.id}-chunk-0`, doc_id: doc.id, article: doc.title, text: doc.body.slice(0, 2000), ord: 0 }];
}

export function sampleTranscript(): string {
  return seed.sample_transcript;
}

export function coachingTranscript(): string {
  return seed.coaching_transcript;
}

export function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.?!])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3);
}

/** 추출식 요약: 첫 문장들을 3줄 요약 + 액션 패턴 추출 (각 항목 160자 상한) */
export function localSummarize(text: string): { summary: string[]; actions: string[] } {
  const s = sentences(text);
  const summary = s.slice(0, 3);
  const actions: string[] = [];
  for (const line of sentences(text)) {
    const t = line.replace(/^[가-힣]+:\s*/, "").trim();
    if (/할게요|하려고요|신청|공유|내주세요|확인하고|진행/.test(t) && t.length > 5) actions.push(t.slice(0, 160));
  }
  return { summary: summary.length ? summary : [text.slice(0, 120)], actions: actions.slice(0, 5) };
}

/** 키워드 기반 로컬 검색: 질문 토큰과 정책 본문의 겹침으로 순위 매김 */
// 한국어 조사·어미 제거 (C5 Phase 2): "지각하면"→"지각", "출장비는"→"출장비",
// "정산해요"→"정산"처럼 토큰 끝의 조사·어미를 떼어 본문과 겹치게 한다.
// 2자 미만으로 줄면 떼지 않는다 ("휴가"의 "가"는 떼지 않음).
// 긴 접미사부터 시도한다 ("에서"를 "에"보다 먼저 떼야 "출장에서"→"출장"이 된다).
const TOKEN_SUFFIXES = ["입니다", "이에요", "에서", "으로", "부터", "까지", "하면", "해요", "돼요", "에는", "에게", "하고", "이고", "는", "은", "이", "가", "을", "를", "에", "와", "과", "의", "도", "만", "로", "해", "돼"];
// 내용어가 아닌 토큰은 겹침 신호에서 뺀다 (본문에 흔해 오탐을 만든다).
const TOKEN_STOPWORDS = new Set(["에서", "으로", "부터", "까지", "하는", "있는", "없는", "것", "수", "어떻게", "왜", "언제", "무엇", "어디", "있나요", "없나요", "있어", "없어", "인가요", "인가", "뭐예요", "뭐에요", "해요", "돼요"]);

/** 토큰 끝의 조사·어미를 떼고 2자 이상만 남긴다. */
export function stemToken(token: string): string {
  let t = token;
  for (let i = 0; i < 2; i++) {
    let stripped = false;
    for (const suf of TOKEN_SUFFIXES) {
      if (t.endsWith(suf) && t.length - suf.length >= 2) { t = t.slice(0, t.length - suf.length); stripped = true; break; }
    }
    if (!stripped) break;
  }
  return t;
}

/** 질문을 겹침 신호가 되는 토큰 목록으로 바꾼다 (어미 제거 + 불용어 제외 + 중복 제거). */
export function questionTokens(question: string): string[] {
  const raw = question.replace(/[?.,!]/g, " ").split(/\s+/).filter((t) => t.length >= 2);
  const stemmed = raw.map(stemToken).filter((t) => t.length >= 2 && !TOKEN_STOPWORDS.has(t));
  return [...new Set(stemmed)];
}

export function localSearch(question: string, docs: Policy[]): Array<Policy & { score: number; snippet: string }> {
  const tokens = questionTokens(question);
  const scored = docs.map((d) => {
    let score = 0;
    for (const t of tokens) {
      if (d.title.includes(t)) score += 3;
      if (d.section.includes(t)) score += 2;
      const hits = d.body.split(t).length - 1;
      score += hits;
    }
    // 동의어 보정: 연차/휴가, 근무/시간, 출장, 보안, 평가
    if (/연차|휴가/.test(question) && /연차/.test(d.body)) score += 5;
    if (/근무|출근|퇴근|시간/.test(question) && /근무/.test(d.body)) score += 5;
    if (/출장/.test(question) && /출장/.test(d.body)) score += 5;
    if (/보안|기밀|피싱/.test(question) && /보안|기밀/.test(d.body)) score += 5;
    if (/평가|승진/.test(question) && /평가|승진/.test(d.body)) score += 5;
    // 바꿔 말한 질문 보정 (C5 Phase 2 키워드 게이트의 안전망): "쉴 수 있나요",
    // "하루 쉬고 싶어요"는 토큰 겹침이 없어도 연차 규정과 연결돼야 한다.
    if (/쉬|쉴|쉰|쉼|휴식|휴무/.test(question) && /연차|휴가/.test(d.body)) score += 5;
    if (/병가|아프|아파/.test(question) && /병가/.test(d.body)) score += 5;
    if (/지각|늦/.test(question) && /지각|결근/.test(d.body)) score += 5;
    // 후속 질문 보정: "신청은 며칠 전에" — 기한 문구가 있는 규정을 우대
    if (/신청/.test(question) && /연차/.test(d.body)) score += 4;
    if (/며칠 전|언제까지|기한/.test(question) && /일 전|주 전/.test(d.body)) score += 6;
    if (/며칠 전|언제까지/.test(question) && /3일 전/.test(d.body)) score += 4;
    const snippet = d.body.slice(0, 220);
    return { ...d, score, snippet };
  });
  return scored.filter((d) => d.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
}

/**
 * 조문 단위 로컬 검색 (C5): D1 텍스트 폴백이 정책 통째가 아니라 조문을
 * 근거 단위로 쓰게 한다. localSearch의 점수 로직을 그대로 재사용한다
 * (chunk를 {id, title, section: article, body: text}로 넘김).
 */
export function localSearchChunks(
  question: string,
  chunks: Array<Chunk & { title: string }>
): Array<Chunk & { title: string; score: number; snippet: string }> {
  const docs: Policy[] = chunks.map((ch) => ({ id: ch.id, title: ch.title, section: ch.article, body: ch.text }));
  const found = localSearch(question, docs);
  const byId = new Map(chunks.map((ch) => [ch.id, ch]));
  return found.map((f) => ({ ...(byId.get(f.id)!), score: f.score, snippet: f.snippet }));
}

/** 로컬 코칭 리플렉션: 질문 추출 + 패턴 키워드 + 다음 질문 템플릿 */
export function localReflect(transcript: string): { questions: string[]; patterns: string[]; next_questions: string[] } {
  const questions = sentences(transcript)
    .filter((l) => l.includes("?") || /언제|무슨|어떻게|왜/.test(l))
    .map((l) => l.replace(/^[가-힣 ]+:\s*/, "").trim().slice(0, 140))
    .filter((l) => l.length > 5)
    .slice(0, 3);
  const patterns: string[] = [];
  if (/부담/.test(transcript)) patterns.push("타인의 눈치와 '팀장으로서 분위기를 만들어야 한다'는 부담감이 연결되어 있다");
  if (/연차/.test(transcript)) patterns.push("팀원의 연차 사용과 자신의 연차 미사용이 같은 패턴으로 반복된다");
  if (/보여주고|행동/.test(transcript)) patterns.push("말보다 행동으로 보여주려는 변화 의지가 드러난다");
  if (patterns.length === 0) patterns.push("대화에서 반복되는 주제를 다음 세션에서 더 깊게 탐색할 수 있다");
  const next_questions = [
    "연차를 직접 쓰는 모습을 보이면 팀 분위기에 어떤 변화가 생길 것 같나요?",
    "팀원의 부담감을 덜어주기 위해 이번 주에 할 수 있는 가장 작은 행동은 무엇인가요?",
    "작년에 소멸된 연차 5일에 대해 지금 어떤 감정이 드나요?",
  ];
  return { questions: questions.length ? questions : ["지난주 가장 어려웠던 순간은 언제였나요?"], patterns, next_questions };
}
