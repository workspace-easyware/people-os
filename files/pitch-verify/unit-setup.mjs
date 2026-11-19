// pitch.js를 Worker(workerd) 안에서 불러오기 전에 브라우저 전역을 흉내 낸다 (단위 확인용).
// 독립 페이지 자동 시작은 #pitchStandalone이 없으므로 일어나지 않는다.
globalThis.window = globalThis;
globalThis.document = { readyState: 'complete', getElementById: () => null, addEventListener() {} };
