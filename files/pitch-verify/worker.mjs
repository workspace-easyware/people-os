// [검증 전용 Worker] public/을 그대로 서빙하고, 아래 경로만 가로챈다.
//   /pitch-content.html  → fixture.html  (?hostile 이 Referer에 있으면 fixture-hostile.html)
//   /api/health          → 가짜 바인딩 응답 (Referer에 health=fail 이 있으면 503, health=bad 면 잘못된 JSON)
//   /app-sim.html, /__verify/app-sim.js → 앱 껍데기 모의
//   /architecture.svg    → public에 없으면 자리표시 그림 (O-B가 만들기 전)
// 실제 프로젝트 Worker(src/index.ts)와 무관. 배포하지 않는다.
import fixture from './fixture.html';
import hostile from './fixture-hostile.html';
import appSim from './app-sim.html';
import { runUnit } from './unit.mjs';

const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="760" viewBox="0 0 1200 760"><rect width="1200" height="760" fill="#f8fbff" stroke="#c3d2e4"/><rect x="300" y="250" width="600" height="200" rx="12" fill="#123863"/><text x="600" y="360" font-size="40" text-anchor="middle" fill="#fff" font-family="sans-serif">placeholder — O-B architecture.svg</text></svg>`;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const ref = req.headers.get('referer') || '';
    const html = (s) => new Response(s, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } });
    if (url.pathname === '/pitch-content.html') return html(ref.includes('hostile') || url.searchParams.has('hostile') ? hostile : fixture);
    if (url.pathname === '/api/health') {
      if (ref.includes('health=fail') || url.searchParams.get('mode') === 'fail') return new Response('down', { status: 503 });
      if (ref.includes('health=bad') || url.searchParams.get('mode') === 'bad') return Response.json({ ok: true, bindings: null });
      return Response.json({ ok: true, service: 'people-os', mode: 'live', bindings: { d1: true, kv: true, r2: true, vectorize: true, ai: true, durable_objects: true } });
    }
    if (url.pathname === '/app-sim.html') return html(appSim);
    if (url.pathname === '/__verify/unit') { const r = runUnit(); return new Response(r.text, { status: r.fail ? 500 : 200 }); }
    const res = await env.ASSETS.fetch(req);
    if (res.status === 404 && url.pathname === '/architecture.svg') return new Response(PLACEHOLDER_SVG, { headers: { 'content-type': 'image/svg+xml' } });
    return res;
  },
};
