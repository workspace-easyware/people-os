// XAI-4 설명서 렌더 확인: 실제 트레이스 상세 응답(trace-detail.json)으로 buildExplainDoc을 돌려 HTML을 쓴다.
// 실행: node files/workflow-verify/xai-4/explain-doc-check.js  (people-os 디렉터리에서)
const fs = require('fs');
const path = require('path');
const dir = __dirname;
const root = path.resolve(dir, '../../..');
global.window = global;
global.document = { addEventListener() {}, querySelector() { return null; } };
eval(fs.readFileSync(path.join(root, 'public/obs/common.js'), 'utf8'));
eval(fs.readFileSync(path.join(root, 'public/obs/traces.js'), 'utf8'));
const O = global.PeopleOSObs || global.ObsUI || Object.values(global).find((v) => v && v.traces && v.traces.buildExplainDoc);
const res = JSON.parse(fs.readFileSync(path.join(dir, 'trace-detail.json'), 'utf8'));
const t = res.trace; t.__masked = !!res.masked;
const html = O.traces.buildExplainDoc(t);
fs.writeFileSync(path.join(dir, 'explain-doc-sample.html'), html);
const must = ['AI 판단 설명서', '질문', '답변', '인용된 근거', '결정적 근거', '판정과 그 이유', '사용된 모델', '판단 시각', '질문자 역할', '이 답이 달라지려면', '@cf/qwen/qwen3.8-27b'];
let fail = 0;
for (const m of must) { const ok = html.includes(m); if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + m); }
console.log(fail ? `FAILED ${fail}` : 'ALL PASS', html.length, 'bytes');
