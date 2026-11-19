// 검증용 사이트 빌드: public/ 전체를 files/calendar-c2-verify/site/로 복사하고 index.html 사본에만 C2w 배선을 적용한다.
// 원본 public/index.html은 읽기만 한다. 사용: node build-site.js <people-os 루트>
const fs = require('fs');
const path = require('path');
const root = path.resolve(process.argv[2]);
const src = path.join(root, 'public');
const dst = path.join(root, 'files/calendar-c2-verify/site');
fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, { recursive: true });
let h = fs.readFileSync(path.join(src, 'index.html'), 'utf8');
const rep = (label, from, to) => {
  if (!h.includes(from)) { console.log('FAIL 패치 지점 없음: ' + label); process.exitCode = 1; return; }
  h = h.replace(from, to);
  console.log('ok   ' + label);
};
rep('css 링크', '<link rel="stylesheet" href="/org.css" />', '<link rel="stylesheet" href="/org.css" />\n<link rel="stylesheet" href="/calendar.css" />');
rep('탭 버튼', '    <button data-tab="tasks">', '    <button data-tab="calendar"><span class="nav-label">캘린더</span></button>\n    <button data-tab="tasks">');
rep('섹션', '  <section id="tab-org">', '  <section id="tab-calendar"><div id="calendarMount"></div></section>\n  <section id="tab-org">');
rep('script', '<script src="/org.js"></script>', '<script src="/org.js"></script>\n<script src="/calendar.js"></script>');
rep('TABS', "'lms','personal','ask','library','obs','admin','org','about','pitch'];", "'lms','personal','ask','library','obs','admin','org','about','pitch','calendar'];");
rep('COACHEE_TABS', "'personal', 'ask', 'library', 'about', 'pitch'];", "'personal', 'ask', 'library', 'about', 'pitch', 'calendar'];");
rep('익명 숨김', '.tabs button[data-tab="lms"]\').forEach', '.tabs button[data-tab="lms"], .tabs button[data-tab="calendar"]\').forEach');
rep('sub 허용', "if (name !== 'obs' && name !== 'approval' && name !== 'pitch') sub = '';", "if (name !== 'obs' && name !== 'approval' && name !== 'pitch' && name !== 'calendar') sub = '';");
rep('hash return', "if (name === 'obs' || name === 'approval' || name === 'pitch') return;", "if (name === 'obs' || name === 'approval' || name === 'pitch' || name === 'calendar') return;");
rep('open/leave', "  if (name === 'org') orgOpen();", "  if (name === 'org') orgOpen();\n  if (name === 'calendar') calendarOpen(sub); else if (window.calendarLeave) calendarLeave();");
fs.writeFileSync(path.join(dst, 'index.html'), h);
fs.writeFileSync(path.join(root, 'files/calendar-c2-verify/index.html'), h);
console.log('built', dst);
