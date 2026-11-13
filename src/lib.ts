// 로컬 폴백 로직: Workers AI / Vectorize가 로컬에서 안 돌 때
// 데모 흐름이 끊기지 않게 D1 텍스트 검색 + 추출식 요약으로 답한다.
// 클라우드에서는 같은 인터페이스로 Workers AI / Vectorize를 먼저 시도한다.
import seed from "../seed/seed-data.json";

export type Policy = { id: string; title: string; section: string; body: string };

export function policies(): Policy[] {
  return seed.policies as Policy[];
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
export function localSearch(question: string, docs: Policy[]): Array<Policy & { score: number; snippet: string }> {
  const tokens = question.replace(/[?.,!]/g, " ").split(/\s+/).filter((t) => t.length >= 2);
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
    // 후속 질문 보정: "신청은 며칠 전에" — 기한 문구가 있는 규정을 우대
    if (/신청/.test(question) && /연차/.test(d.body)) score += 4;
    if (/며칠 전|언제까지|기한/.test(question) && /일 전|주 전/.test(d.body)) score += 6;
    if (/며칠 전|언제까지/.test(question) && /3일 전/.test(d.body)) score += 4;
    const snippet = d.body.slice(0, 220);
    return { ...d, score, snippet };
  });
  return scored.filter((d) => d.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
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
