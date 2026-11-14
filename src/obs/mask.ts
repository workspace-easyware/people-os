// S4 M2 — PII 마스킹 (설계서 §8 "PII 마스킹", 계획서 B.1 정규식).
// 목록·상세 API 응답의 질문·답·프롬프트에만 적용한다. D1·R2 원본은 그대로 둔다.
// 순서가 중요하다: 긴/구체적인 패턴(토큰·주민번호)을 먼저 지워야 짧은 패턴
// (계좌·전화)이 그 일부를 따로 잡아 흔적을 남기지 않는다.

export type MaskKind = "token" | "rrn" | "email" | "phone" | "account";

type Rule = { kind: MaskKind; re: RegExp; replace: string | ((m: string) => string) };

const RULES: Rule[] = [
  // API 키·토큰: Bearer 헤더, 잘 알려진 접두어(sk-, ghp_, xox?-, AKIA…), JWT, 긴 hex/base64 덩어리.
  { kind: "token", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, replace: "Bearer [토큰]" },
  { kind: "token", re: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, replace: "[토큰]" },
  { kind: "token", re: /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/g, replace: "[토큰]" },
  { kind: "token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, replace: "[토큰]" },
  { kind: "token", re: /\bAKIA[0-9A-Z]{16}\b/g, replace: "[토큰]" },
  { kind: "token", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: "[토큰]" },
  // key=value 형태 (api_key=…, token: …, secret=…)
  {
    kind: "token",
    re: /\b(api[_-]?key|access[_-]?token|secret|token|password|passwd|pwd)(\s*[:=]\s*)["']?[^\s"',;]{6,}/gi,
    replace: (m: string) => m.replace(/([:=]\s*)["']?[^\s"',;]{6,}$/, "$1[토큰]"),
  },
  // 32자 이상 hex 또는 40자 이상 base64url 덩어리 (영문·숫자가 섞인 것만 — 한국어 문장은 안 걸린다)
  { kind: "token", re: /\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Fa-f0-9]{32,}\b/g, replace: "[토큰]" },
  { kind: "token", re: /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}\b/g, replace: "[토큰]" },
  // 주민등록번호 \d{6}-[1-4]\d{6} (외국인등록번호 5~8 포함, 하이픈 없는 13자리도)
  { kind: "rrn", re: /(?<!\d)\d{6}\s?-?\s?[1-8]\d{6}(?!\d)/g, replace: "[주민번호]" },
  // 이메일
  { kind: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, replace: "[이메일]" },
  // 휴대전화 010/011/016~019, 일반 전화 02/0xx, +82 국제 표기
  { kind: "phone", re: /(?<!\d)(?:\+82[\s-]?|0)1[016789][\s.-]?\d{3,4}[\s.-]?\d{4}(?!\d)/g, replace: "[전화번호]" },
  { kind: "phone", re: /(?<!\d)(?:\+82[\s-]?|0)(?:2|[3-6][1-5])[\s.-]?\d{3,4}[\s.-]?\d{4}(?!\d)/g, replace: "[전화번호]" },
  // 계좌번호: 하이픈으로 묶인 숫자 3~4 덩어리, 총 10~16자리 (예: 110-123-456789, 1002-123-456789)
  // 숫자 합계 10~16자리만 — 날짜(2026-11-14, 8자리)는 건드리지 않는다.
  {
    kind: "account",
    re: /(?<!\d)\d{2,6}-\d{2,6}-\d{2,8}(?:-\d{1,3})?(?!\d)/g,
    replace: (m: string) => {
      const n = m.replace(/\D/g, "").length;
      return n >= 10 && n <= 16 ? "[계좌번호]" : m;
    },
  },
];

/** 문자열의 PII를 치환한다. null/undefined는 그대로. */
export function maskPII(text: string): string;
export function maskPII(text: string | null | undefined): string | null | undefined;
export function maskPII(text: string | null | undefined): string | null | undefined {
  if (text == null || text === "") return text;
  let out = String(text);
  for (const r of RULES) {
    r.re.lastIndex = 0;
    out = typeof r.replace === "string" ? out.replace(r.re, r.replace) : out.replace(r.re, r.replace);
  }
  return out;
}

/** 어떤 종류가 걸렸는지 센다 (테스트·화면 표시용). */
export function detectPII(text: string): Partial<Record<MaskKind, number>> {
  const found: Partial<Record<MaskKind, number>> = {};
  let rest = String(text ?? "");
  for (const r of RULES) {
    r.re.lastIndex = 0;
    let hits = 0;
    rest = rest.replace(r.re, (m: string) => {
      const rep = typeof r.replace === "string" ? r.replace : r.replace(m);
      if (rep === m) return m;
      hits++;
      return " ";
    });
    if (hits) found[r.kind] = (found[r.kind] || 0) + hits;
  }
  return found;
}

/** JSON 값 안의 모든 문자열에 마스킹을 적용한다 (프롬프트 messages, 원 응답). */
export function maskDeep<T>(value: T, depth = 0): T {
  if (depth > 12) return value;
  if (typeof value === "string") return maskPII(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, depth + 1)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = maskDeep(v, depth + 1);
    return out as T;
  }
  return value;
}

/** 단위 테스트 케이스 — `runMaskSelfTest()`가 실패 목록을 돌려준다 (빈 배열 = 통과). */
export const MASK_CASES: Array<{ input: string; expect: string }> = [
  { input: "주민번호 900101-1234567 입니다", expect: "주민번호 [주민번호] 입니다" },
  { input: "외국인 9001015234567", expect: "외국인 [주민번호]" },
  { input: "연락처 010-1234-5678 / 01012345678", expect: "연락처 [전화번호] / [전화번호]" },
  { input: "+82 10-9876-5432로 전화", expect: "[전화번호]로 전화" },
  { input: "사무실 02-123-4567", expect: "사무실 [전화번호]" },
  { input: "메일 hong.gildong@example.co.kr 로", expect: "메일 [이메일] 로" },
  { input: "계좌 110-123-456789 입금", expect: "계좌 [계좌번호] 입금" },
  { input: "키 sk-abcdefghijklmnop1234 노출", expect: "키 [토큰] 노출" },
  { input: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456", expect: "Authorization: Bearer [토큰]" },
  { input: "api_key=AbC123xyz789", expect: "api_key=[토큰]" },
  { input: "연차 3일 쓸 수 있어? 제12조 2026-11-14", expect: "연차 3일 쓸 수 있어? 제12조 2026-11-14" },
];

export function runMaskSelfTest(): Array<{ input: string; expect: string; got: string }> {
  const fails: Array<{ input: string; expect: string; got: string }> = [];
  for (const c of MASK_CASES) {
    const got = maskPII(c.input);
    if (got !== c.expect) fails.push({ ...c, got });
  }
  return fails;
}
