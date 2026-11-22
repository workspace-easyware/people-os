// doc-fix 2026-11-22 로컬 전용 하네스 (배포하지 않는다): 임시 세션 토큰(난수 64 hex, 줄바꿈 없음)만 만든다.
export default {
  async fetch() {
    const b = new Uint8Array(32);
    crypto.getRandomValues(b);
    return new Response([...b].map((x) => x.toString(16).padStart(2, "0")).join(""));
  },
};
