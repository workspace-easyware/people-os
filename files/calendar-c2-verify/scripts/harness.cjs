// 캘린더 C2 DOM 스텁 하네스. 브라우저가 없는 VM에서 public/calendar.js를 vm으로 돌려
//  (1) 시간 변환 함수가 브라우저 시간대(TZ)와 무관하게 KST를 내는지  (2) 지연 로딩  (3) 실제 로컬 API와의 왕복 (추가→수정→삭제)
//  (4) 이스케이프  를 확인한다. FullCalendar 자체는 가짜 클래스로 대체해 calendar.js가 넘기는 옵션·이벤트만 본다.
// 사용: node harness.cjs <people-os 루트> <base-url> <세션 토큰 A> [--tz-child]
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const [rootArg, base, token] = process.argv.slice(2);
const root = path.resolve(rootArg);
const SRC = fs.readFileSync(path.join(root, 'public/calendar.js'), 'utf8');

function makeCtx(extra) {
  const els = {};
  const stub = (id) => els[id] || (els[id] = {
    id, innerHTML: '', textContent: '', className: '', value: '', checked: false, hidden: false, style: {}, dataset: {}, attrs: {},
    classList: { contains(c) { return String(stub_cls(els[id])).split(/\s+/).includes(c); } },
    setAttribute(k, v) { this.attrs[k] = v; }, focus() {}, remove() {},
  });
  const stub_cls = (e) => (e ? e.className : '');
  const loaded = [];
  const ctx = {
    console, Number, Set, JSON, parseInt, Date, Promise, String, Array, Object, Math, Intl, Error, encodeURIComponent, setTimeout,
    $: stub,
    esc: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    currentUser: { id: 'u_a', name: '에이', role: 'user' },
    confirm: () => true,
    api: async (p, opts = {}) => {
      const r = await fetch(base + p, { ...opts, headers: { 'content-type': 'application/json', cookie: 'people_os_session=' + token } });
      return r.json();
    },
    __loaded: loaded, __els: els,
    document: {
      activeElement: null,
      head: { appendChild(s) { loaded.push(s.src); setTimeout(() => { if (s.src.includes('index.global')) ctx.FullCalendar = ctx.__FakeLib; s.onload && s.onload(); }, 5); } },
      createElement(tag) {
        return { tag, children: [], className: '', textContent: '', appendChild(c) { this.children.push(c); }, remove() {}, setAttribute() {}, addEventListener() {} };
      },
    },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  };
  ctx.escAttr = (s) => ctx.esc(s).replace(/"/g, '&quot;');
  ctx.window = ctx;
  Object.assign(ctx, extra || {});
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return ctx;
}

// ---- 하위 프로세스: TZ를 바꿔 시간 변환 결과를 찍는다 ----
if (process.argv.includes('--tz-child')) {
  const ctx = makeCtx();
  const out = {};
  const run = (code) => vm.runInContext(code, ctx);
  out.tzName = Intl.DateTimeFormat().resolvedOptions().timeZone;
  out.utcToWall = run("calUtcToWall('2026-11-20T14:00:00Z')");
  out.utcToWallMidnight = run("calUtcToWall('2026-11-20T15:00:00Z')");
  out.wallToUtc = run("calWallToUtc('2026-11-20', '23:15')");
  out.wallToUtc2 = run("calWallToUtc('2026-11-21', '00:00')");
  out.fcDateToUtc = run("calFcDateToUtc(new Date(Date.UTC(2026, 10, 20, 0, 0)))");
  out.addDays = run("calAddDays('2026-11-30', 1)");
  out.korDate = run("calKorDate('2026-11-21')");
  out.rangeTimed = run("calFmtRange({all_day:false,start_at:'2026-11-20T14:00:00Z',end_at:'2026-11-20T16:00:00Z'})");
  out.rangeCross = run("calFmtRange({all_day:false,start_at:'2026-11-20T14:00:00Z',end_at:'2026-11-21T16:00:00Z'})");
  out.rangeAllDay = run("calFmtRange({all_day:true,start_date:'2026-11-21',end_date:'2026-11-22'})");
  out.rangeAllDay3 = run("calFmtRange({all_day:true,start_date:'2026-11-21',end_date:'2026-11-24'})");
  out.fcTimed = JSON.stringify(run("(() => { const e = calToFcEvent({id:'x',title:'t',all_day:false,start_at:'2026-11-20T14:00:00Z',end_at:'2026-11-20T16:00:00Z'}); return {allDay:e.allDay,start:e.start,end:e.end}; })()"));
  out.fcAllDay = JSON.stringify(run("(() => { const e = calToFcEvent({id:'x',title:'t',all_day:true,start_date:'2026-11-21',end_date:'2026-11-22'}); return {allDay:e.allDay,start:e.start,end:e.end}; })()"));
  // 오늘: 독립 계산(Intl, Asia/Seoul)과 비교
  const now = Date.now();
  const oracle = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now).replace(' ', 'T');
  ctx.__now = now;
  out.nowMatches = run('calMsToWall(__now)') === oracle;
  console.log(JSON.stringify(out));
  process.exit(0);
}

// ---- 본 하네스 ----
let failed = 0;
const check = (label, cond, detail) => { console.log((cond ? 'PASS ' : 'FAIL ') + label + (!cond && detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); if (!cond) failed++; };
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 300));

(async () => {
  // 1) 시간대 불변: 여러 TZ에서 같은 결과
  const zones = ['UTC', 'America/Los_Angeles', 'Pacific/Auckland', 'Asia/Kolkata', 'Asia/Seoul'];
  const results = zones.map((tz) => {
    const r = spawnSync(process.execPath, [__filename, rootArg, base, token, '--tz-child'], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
    if (r.status !== 0) { console.log(r.stderr); return null; }
    return JSON.parse(r.stdout.trim());
  });
  check('시간대 하위 프로세스 전부 실행됨', results.every(Boolean));
  const ref = results[zones.length - 1];
  zones.forEach((tz, i) => {
    const r = results[i];
    const { tzName, ...rest } = r;
    const { tzName: _t, ...refRest } = ref;
    check(`TZ=${tz} (감지 ${tzName}) 결과가 KST 기준과 동일`, JSON.stringify(rest) === JSON.stringify(refRest), rest);
  });
  check('기대값: 14:00Z → KST 23:00', ref.utcToWall === '2026-11-20T23:00:00', ref.utcToWall);
  check('기대값: 15:00Z → KST 다음 날 00:00', ref.utcToWallMidnight === '2026-11-21T00:00:00', ref.utcToWallMidnight);
  check('기대값: KST 11/20 23:15 → 14:15Z', ref.wallToUtc === '2026-11-20T14:15:00Z', ref.wallToUtc);
  check('기대값: KST 11/21 00:00 → 11/20 15:00Z', ref.wallToUtc2 === '2026-11-20T15:00:00Z', ref.wallToUtc2);
  check('기대값: FC 벽시계 11/20 00:00 → 11/19 15:00Z', ref.fcDateToUtc === '2026-11-19T15:00:00Z', ref.fcDateToUtc);
  check('기대값: 월 경계 +1일', ref.addDays === '2026-12-01', ref.addDays);
  check('기대값: 한글 날짜', ref.korDate === '2026년 11월 21일 (토)', ref.korDate);
  check('기대값: 같은 날 범위', ref.rangeTimed === '2026년 11월 20일 (금) 23:00 ~ 2026년 11월 21일 (토) 01:00' , ref.rangeTimed);
  check('기대값: 자정 넘는 범위', ref.rangeCross === '2026년 11월 20일 (금) 23:00 ~ 2026년 11월 22일 (일) 01:00', ref.rangeCross);
  check('기대값: 종일 하루', ref.rangeAllDay === '2026년 11월 21일 (토) · 종일', ref.rangeAllDay);
  check('기대값: 종일 3일', ref.rangeAllDay3 === '2026년 11월 21일 (토) ~ 2026년 11월 23일 (월) · 종일', ref.rangeAllDay3);
  check('FC 이벤트(시각): KST 벽시계 값', ref.fcTimed === '{"allDay":false,"start":"2026-11-20T23:00:00","end":"2026-11-21T01:00:00"}', ref.fcTimed);
  check('FC 이벤트(종일): 날짜 그대로, 끝은 포함 안 함', ref.fcAllDay === '{"allDay":true,"start":"2026-11-21","end":"2026-11-22"}', ref.fcAllDay);
  check('"지금"이 Intl(Asia/Seoul) 계산과 일치 (모든 TZ)', results.every((r) => r.nowMatches));

  // 2) 지연 로딩 + FullCalendar 옵션
  const created = [];
  class FakeCalendar {
    constructor(el, opts) {
      this.opts = opts; this.el = el; this.calls = []; created.push(this);
      this.view = { type: opts.initialView, currentStart: new Date(Date.UTC(2026, 10, 1)), currentEnd: new Date(Date.UTC(2026, 11, 1)) };
    }
    render() { this.calls.push('render'); }
    setOption(k, v) { this.calls.push('setOption:' + k + '=' + v); }
    changeView(v) { this.view.type = v; this.calls.push('changeView:' + v); }
    refetchEvents() { this.calls.push('refetch'); return this.fetch(); }
    updateSize() {}
    gotoDate(d) { this.calls.push('gotoDate:' + d); }
    fetch() {
      const info = { start: new Date(Date.UTC(2026, 9, 25)), end: new Date(Date.UTC(2026, 11, 6)) };
      return new Promise((ok, fail) => this.opts.events(info, (evs) => { this.lastEvents = evs; ok(evs); }, fail));
    }
  }
  const ctx = makeCtx({ __FakeLib: { Calendar: FakeCalendar } });
  check('calendar.js를 읽기만 해서는 스크립트가 로드되지 않음', ctx.__loaded.length === 0, ctx.__loaded);
  check('전역 calendarOpen / calendarLeave 존재', typeof ctx.calendarOpen === 'function' && typeof ctx.calendarLeave === 'function');
  ctx.$('calendarMount'); // 마운트 지점
  await ctx.calendarOpen('');
  check('첫 열기에 FullCalendar 번들 → 한국어 로케일 순서로 동적 로드', JSON.stringify(ctx.__loaded) === JSON.stringify(['/vendor/fullcalendar/index.global.min.js', '/vendor/fullcalendar/ko.global.min.js']), ctx.__loaded);
  const cal = created[0];
  check('Calendar 한 번 생성', created.length === 1);
  check('옵션: timeZone UTC(KST 벽시계 방식) · locale ko · 자체 툴바', cal.opts.timeZone === 'UTC' && cal.opts.locale === 'ko' && cal.opts.headerToolbar === false);
  check('옵션: 07:00부터 보이는 격자 · 끌어서 옮기기 없음', cal.opts.scrollTime === '07:00:00' && !cal.opts.editable && !cal.opts.eventDrop);
  const wallNow = cal.opts.now();
  check('옵션: now()가 KST 벽시계 (UTC 필드 = KST)', ctx.calMsToWall(Date.now()).slice(0, 13) === wallNow.toISOString().slice(0, 13));
  await ctx.calendarOpen('');
  check('두 번째 열기에는 다시 로드하지 않음', ctx.__loaded.length === 2);
  check('월 보기가 기본', cal.opts.initialView === 'dayGridMonth');
  ctx.$('calViewWeek').onclick();
  check('주 보기 전환 (넓은 화면: 시간 격자)', cal.view.type === 'timeGridWeek' && cal.calls.some((c) => c === 'setOption:height=760'), cal.calls);
  ctx.$('calViewMonth').onclick();
  check('월 보기 복귀', cal.view.type === 'dayGridMonth');
  check('주 보기 전환 후 버튼 상태 aria-pressed', ctx.$('calViewMonth').attrs['aria-pressed'] === 'true' && ctx.$('calViewWeek').attrs['aria-pressed'] === 'false');
  const narrow = makeCtx({ __FakeLib: { Calendar: FakeCalendar }, matchMedia: () => ({ matches: true, addEventListener() {} }) });
  narrow.$('calendarMount');
  await narrow.calendarOpen('');
  narrow.$('calViewWeek').onclick();
  check('좁은 화면: 주 보기 = 주간 목록(listWeek)', created[created.length - 1].view.type === 'listWeek');

  // 3) API 왕복: 추가 → 수정 → 삭제 (실제 로컬 서버)
  const t0 = Date.now();
  const nasty = `긴제목 ${'가'.repeat(150)} <img src=x onerror=alert(1)> "quote" & 'x'`;
  const field = (m, id) => m.__f[id];
  const mkForm = (vals) => {
    const f = {};
    for (const [k, v] of Object.entries(vals)) f[k] = { value: v, checked: v === true, hidden: false };
    const m = { __f: f, querySelector: (sel) => (sel === '#calFErr' ? (f.calFErr ||= { hidden: true, textContent: '' }) : sel === '#calFSave' ? (f.calFSave ||= { disabled: false }) : f[sel.slice(1)]) };
    return m;
  };
  const base1 = { calFTitle: nasty, calFAllDay: false, calFSD: '2026-11-20', calFST: '23:00', calFED: '2026-11-21', calFET: '01:00', calFCat: 'coaching', calFLoc: '회의실 <b>A</b>', calFDesc: '메모 <script>alert(1)</script>', calFRemind: '30', calFVis: 'private' };
  // 이름이 title인 필드는 checked 계산에 쓰이지 않도록 별도 지정
  const form1 = mkForm(base1); form1.__f.calFAllDay.checked = false;
  ctx.confirm = () => true;
  await ctx.calSubmit(null, true, form1);
  await tick();
  let list = await cal.fetch();
  const created1 = list.find((e) => e.title === nasty);
  check('추가: 서버에 저장되고 목록에 KST 벽시계로 나타남', !!created1 && created1.start === '2026-11-20T23:00:00' && created1.end === '2026-11-21T01:00:00', created1);
  const raw1 = created1 && created1.extendedProps.raw;
  check('추가: 서버 저장은 UTC (14:00Z~16:00Z), 분류 coaching, 알림 30', raw1 && raw1.start_at === '2026-11-20T14:00:00Z' && raw1.end_at === '2026-11-20T16:00:00Z' && raw1.category === 'coaching' && raw1.remind_minutes === 30, raw1);
  check('이벤트 클래스: 개인 + 코칭 띠', JSON.stringify(cal.opts.eventClassNames({ event: { extendedProps: { raw: raw1 } } })) === '["cal-ev","cal-ev-private","cal-ev-coaching"]');
  // 이스케이프
  const content = cal.opts.eventContent({ event: { extendedProps: { raw: raw1 }, allDay: false }, timeText: '23:00', view: { type: 'dayGridMonth' } });
  const inner = content.domNodes[0].children;
  const titleNode = inner.find((c) => c.className === 'cal-ev-title');
  check('이벤트 제목은 textContent로만 들어감 (HTML 해석 없음)', titleNode && titleNode.textContent === nasty && content.domNodes[0].innerHTML === undefined);
  let detailHtml = '';
  ctx.calOpenModal = (html) => { detailHtml = html; return { querySelector: () => ({}) }; };
  ctx.calShowDetail(raw1);
  check('상세 HTML: 제목·장소·메모가 이스케이프됨 (원본 태그 없음)', !/<img|<b>|<script/.test(detailHtml) && detailHtml.includes('&lt;img src=x onerror=alert(1)&gt;') && detailHtml.includes('&lt;script&gt;'));
  check('상세: 한국 시간 표기', detailHtml.includes('23:00 ~ 2026년 11월 21일 (토) 01:00') && detailHtml.includes('한국 시간'));
  let formHtml = '';
  ctx.calOpenModal = (html) => { formHtml = html; const f = { querySelector: () => ({ addEventListener() {}, set onclick(v) {}, set onchange(v) {}, hidden: false, value: '', checked: false, innerHTML: '', get setAttribute() { return () => {}; } }) }; return f; };
  try { ctx.calShowForm(raw1); } catch (e) { check('수정 폼 렌더', false, String(e)); }
  check('수정 폼: 속성·본문 이스케이프 (value="..." 탈출 불가)', !formHtml.includes('<img') && formHtml.includes('&quot;quote&quot;') && !formHtml.includes('<script>'));
  check('수정 폼: 값이 KST로 채워짐 (23:00 선택, 종료 01:00)', /value="2026-11-20"/.test(formHtml) && /<option value="23:00" selected>/.test(formHtml) && /<option value="01:00" selected>/.test(formHtml));

  // 수정
  const edit = mkForm({ ...base1, calFTitle: '수정된 제목', calFST: '10:00', calFSD: '2026-11-22', calFED: '2026-11-22', calFET: '11:30', calFVis: 'team', calFCat: 'meeting', calFRemind: '' });
  await ctx.calSubmit(raw1, true, edit);
  await tick();
  list = await cal.fetch();
  const edited = list.find((e) => e.id === raw1.id);
  check('수정: 제목·시각·팀 공개 반영 + 버전 증가', edited && edited.title === '수정된 제목' && edited.start === '2026-11-22T10:00:00' && edited.end === '2026-11-22T11:30:00' && edited.extendedProps.raw.visibility === 'team' && edited.extendedProps.raw.version === raw1.version + 1 && edited.extendedProps.raw.remind_minutes === null, edited && edited.extendedProps.raw);
  const editedRaw = edited.extendedProps.raw;
  check('팀 일정 클래스: 초록 + 팀 배지', JSON.stringify(cal.opts.eventClassNames({ event: { extendedProps: { raw: editedRaw } } })) === '["cal-ev","cal-ev-team"]' && cal.opts.eventContent({ event: { extendedProps: { raw: editedRaw }, allDay: false }, timeText: '', view: { type: 'dayGridMonth' } }).domNodes[0].children[0].textContent === '팀');
  // 충돌: 같은 version으로 다시 수정 → 409 → 새로 불러옴 메시지
  const stale = mkForm({ ...base1, calFTitle: '충돌', calFSD: '2026-11-22', calFED: '2026-11-22', calFST: '10:00', calFET: '11:00' });
  ctx.calOpenModal = () => ({ querySelector: () => ({}) });
  await ctx.calSubmit(raw1, true, stale); // raw1.version은 이미 낡음
  await tick();
  check('낡은 version 저장 → 충돌 안내 메시지', ctx.$('calMsg').textContent.includes('다른 곳에서 먼저 수정됐습니다'), ctx.$('calMsg').textContent);
  // 종일 일정 (3일)
  const allday = mkForm({ ...base1, calFTitle: '종일 3일', calFAllDay: true, calFSD: '2026-11-24', calFED: '2026-11-26', calFVis: 'private', calFCat: 'general', calFRemind: '-540' });
  allday.__f.calFAllDay.checked = true;
  await ctx.calSubmit(null, true, allday);
  await tick();
  list = await cal.fetch();
  const ad = list.find((e) => e.title === '종일 3일');
  check('종일 추가: 날짜 그대로(11/24~11/26 포함), 끝은 11/27(미포함), 알림 당일 9시(-540)', ad && ad.allDay === true && ad.start === '2026-11-24' && ad.end === '2026-11-27' && ad.extendedProps.raw.remind_minutes === -540, ad && ad.extendedProps.raw);
  // 검증 오류
  const bad = mkForm({ ...base1, calFTitle: '  ', calFSD: '2026-11-20', calFED: '2026-11-20' });
  const badBox = bad.__f.calFErr = { hidden: true, textContent: '' };
  await ctx.calSubmit(null, true, bad);
  check('빈 제목 → 오류 표시, 요청 안 보냄', badBox.hidden === false && badBox.textContent.includes('제목'), badBox);
  const rev = ctx.calBuildPayload({ title: 'x', all_day: false, sd: '2026-11-20', st: '10:00', ed: '2026-11-20', et: '09:00', category: 'general', location: '', description: '', remind: '' });
  check('종료가 시작보다 앞 → 오류', !!rev.error);
  const long = ctx.calBuildPayload({ title: 'x', all_day: false, sd: '2026-11-01', st: '10:00', ed: '2026-12-05', et: '09:00', category: 'general', location: '', description: '', remind: '' });
  check('31일 초과 → 오류', !!long.error);
  // 필터: 팀 일정 숨김
  ctx.$('calFTeam').onchange({ target: { checked: false } });
  await tick();
  list = await cal.fetch();
  check('필터: 팀 일정 끄면 팀 일정이 목록에서 빠짐', !list.some((e) => e.extendedProps.raw.visibility === 'team') && list.some((e) => e.title === '종일 3일'));
  ctx.$('calFTeam').onchange({ target: { checked: true } });
  // 삭제
  let confirmMsg = '';
  ctx.confirm = (m) => { confirmMsg = m; return true; };
  await ctx.calDelete(editedRaw);
  await tick();
  list = await cal.fetch();
  check('삭제(팀 일정): 확인 문구에 "전원의 달력에서 사라집니다"', confirmMsg.includes('전원의 달력에서 사라집니다'), confirmMsg);
  check('삭제: 목록에서 사라짐', !list.some((e) => e.id === editedRaw.id));
  await ctx.calDelete(ad.extendedProps.raw);
  await tick();
  list = await cal.fetch();
  check('삭제(개인): 종일 일정도 사라짐, 이후 이 하네스의 일정 0개', !list.some((e) => e.title === '종일 3일' || e.id === raw1.id));
  // 해시 상세 진입(알림 링크): 없는 id → 오류 메시지
  await ctx.calendarOpen('cal_not_exist');
  await tick();
  check('#calendar/<없는 id> → 오류 안내 (모달 없음)', ctx.$('calMsg').textContent.includes('열지 못했습니다'), ctx.$('calMsg').textContent);
  const seq0 = vm.runInContext('calSeq', ctx);
  ctx.calendarLeave();
  check('calendarLeave: 시퀀스 증가(늦은 로딩 응답 무시) + 모달 닫힘', vm.runInContext('calSeq', ctx) === seq0 + 1 && vm.runInContext('calModalEl', ctx) === null);
  console.log(failed ? `\n${failed}개 실패` : '\n전부 통과');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
