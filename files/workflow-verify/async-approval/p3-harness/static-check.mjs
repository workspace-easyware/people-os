// P3 정적 확인: workflow.js의 wf*/wfc* 식별자 참조가 전부 정의돼 있는지 (workflow.js + workflow-canvas.js + index.html 인라인 전역).
// 사용: node static-check.mjs <workflow.js> <workflow-canvas.js> <index.html>
import { readFileSync } from 'node:fs';
const [wfPath, canvasPath, htmlPath] = process.argv.slice(2);
const wf = readFileSync(wfPath, 'utf8');
const canvas = readFileSync(canvasPath, 'utf8');
const html = readFileSync(htmlPath, 'utf8');
const all = wf + '\n' + canvas + '\n' + html;
const defined = new Set();
for (const re of [/function\s+(wf\w*)\s*\(/g, /(?:const|let|var)\s+(wf\w*)\b/g, /,\s*(wf\w*)\s*=/g]) {
  for (const m of all.matchAll(re)) defined.add(m[1]);
}
const used = new Set();
for (const m of wf.matchAll(/\b(wf[A-Z]\w*|wfc\w*|WF_\w+)\b/g)) used.add(m[1]);
for (const m of all.matchAll(/(?:const|let|var)\s+(WF_\w+)/g)) defined.add(m[1]);
const missing = [...used].filter((u) => !defined.has(u)).sort();
const newFns = ['wfPaLoad', 'wfPaReload', 'wfPaRender', 'wfPaRow', 'wfPaDetail', 'wfPaDecide', 'wfPaToggle', 'wfPaFetchRun', 'wfPaShowRun', 'wfPaSyncBar', 'wfPaSelectable', 'wfPaStopTimers', 'wfPaMine', 'wfPaSummary', 'wfPaTypeLabel', 'wfPaCls', 'wfPaAll'];
const calls = Object.fromEntries(newFns.map((f) => [f, { defined: defined.has(f), refs: (wf.match(new RegExp(`\\b${f}\\b`, 'g')) || []).length - 1 }]));
const unused = newFns.filter((f) => calls[f].refs < 1);
// DOM id 참조: $('x') 가 만들어지는 id인지 (id: 'x')
const ids = new Set([...all.matchAll(/id:\s*'([\w-]+)'/g)].map((m) => m[1]).concat([...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1])));
const dollar = [...new Set([...wf.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]))];
const missingIds = dollar.filter((d) => !ids.has(d) && !d.startsWith('wff_'));
const out = { missingIdentifiers: missing, newFunctions: calls, unusedNewFunctions: unused, missingDomIds: missingIds, innerHTMLUses: (wf.match(/innerHTML/g) || []).length };
console.log(JSON.stringify(out, null, 2));
process.exit(missing.length || unused.length || missingIds.length ? 1 : 0);
