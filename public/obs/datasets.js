// S4 M3 — Datasets UI. window.PeopleOSObs.datasets.mount(el)
// 데이터셋 목록 → 항목 목록(기대 판정·근거·사전 조건 메모) + 활성 토글. 쓰기는 관리자 시크릿(X-Admin-Secret) 필요.
// 모든 텍스트는 textContent로만 넣는다 (XSS 방지). obs.css가 있으면 그 변수를 쓰고, 없어도 읽을 수 있게 최소 스타일을 주입한다.
(function () {
  "use strict";
  var NS = (window.PeopleOSObs = window.PeopleOSObs || {});
  var API = "/api/obs";
  var SECRET_KEY = "peopleos.obs.adminSecret";

  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === "class") el.className = attrs[k];
      else if (k === "text") el.textContent = attrs[k];
      else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== false && attrs[k] != null) el.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c != null) el.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return el;
  }

  function injectStyle() {
    if (document.getElementById("obs-ds-style")) return;
    var s = document.createElement("style");
    s.id = "obs-ds-style";
    s.textContent =
      ".obs-ds{font:14px/1.5 system-ui,sans-serif;color:var(--obs-fg,#1a1a1a)}" +
      ".obs-ds table{border-collapse:collapse;width:100%}.obs-ds th,.obs-ds td{border-bottom:1px solid var(--obs-line,#e3e3e3);padding:6px 8px;text-align:left;vertical-align:top}" +
      ".obs-ds th{font-weight:600;white-space:nowrap}.obs-ds .ds-muted{color:var(--obs-muted,#777);font-size:12px}" +
      ".obs-ds .ds-badge{display:inline-block;padding:0 6px;border-radius:8px;border:1px solid var(--obs-line,#ccc);font-size:12px}" +
      ".obs-ds .ds-g{background:#e8f5e9}.obs-ds .ds-u{background:#fff3e0}.obs-ds .ds-off{opacity:.62}" +
      ".obs-ds .ds-prereq{margin-top:4px;padding:4px 6px;background:#fff8e1;border-left:3px solid #f5a623;font-size:12px;white-space:pre-wrap}" +
      ".obs-ds .ds-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0}" +
      ".obs-ds .ds-err{color:#b00020}.obs-ds .ds-row{cursor:pointer}.obs-ds .ds-ans{white-space:pre-wrap;margin-top:4px}";
    document.head.appendChild(s);
  }

  function secret() { try { return sessionStorage.getItem(SECRET_KEY) || ""; } catch (e) { return ""; } }

  async function api(method, path, body) {
    var headers = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    var s = secret();
    if (s) headers["x-admin-secret"] = s;
    var res = await fetch(API + path, { method: method, headers: headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    var data = null;
    try { data = await res.json(); } catch (e) { /* 비 JSON 응답 */ }
    if (!res.ok || !data || data.ok === false) {
      var msg = (data && data.error) || ("HTTP " + res.status);
      if (res.status === 401) msg = "관리자 시크릿이 필요합니다 (쓰기 동작). 위 입력란에 넣고 다시 시도하세요.";
      var err = new Error(msg); err.status = res.status; throw err;
    }
    return data;
  }

  function sourceText(s) {
    var parts = [];
    if (s.doc_id) parts.push("doc:" + s.doc_id);
    if (s.title_like) parts.push("제목~" + s.title_like);
    if (s.article_like) parts.push("조문~" + s.article_like);
    return parts.join(" · ") || "(없음)";
  }

  function mount(el) {
    injectStyle();
    el.textContent = "";
    var root = h("div", { class: "obs-ds" });
    el.appendChild(root);

    var state = { datasets: [], current: null, filter: "all", msg: "", err: "" };

    function setMsg(m, isErr) { state.msg = isErr ? "" : m; state.err = isErr ? m : ""; renderStatus(); }
    var status = h("div", { class: "ds-muted" });
    function renderStatus() {
      status.textContent = state.err || state.msg || "";
      status.className = state.err ? "ds-err" : "ds-muted";
    }

    var secretInput = h("input", { type: "password", placeholder: "관리자 시크릿 (쓰기용)", autocomplete: "off", value: secret() });
    secretInput.addEventListener("change", function () {
      try { sessionStorage.setItem(SECRET_KEY, secretInput.value.trim()); } catch (e) { /* 저장 불가 */ }
    });

    var seedBtn = h("button", { type: "button", text: "골든 시드 실행", onclick: async function () {
      try {
        try { sessionStorage.setItem(SECRET_KEY, secretInput.value.trim()); } catch (e) { /* noop */ }
        var r = await api("POST", "/datasets/seed");
        setMsg("시드 완료: 추가 " + r.inserted + " · 건너뜀 " + r.skipped + " (멱등)", false);
        await loadList(r.datasetId);
      } catch (e) { setMsg("시드 실패: " + e.message, true); }
    } });

    var listBox = h("div");
    var itemsBox = h("div");
    root.appendChild(h("div", { class: "ds-bar" }, [h("strong", { text: "데이터셋" }), secretInput, seedBtn]));
    root.appendChild(status);
    root.appendChild(listBox);
    root.appendChild(itemsBox);

    function renderList() {
      listBox.textContent = "";
      if (!state.datasets.length) {
        listBox.appendChild(h("p", { class: "ds-muted", text: "데이터셋이 없습니다. 관리자 시크릿을 입력하고 '골든 시드 실행'을 누르세요." }));
        return;
      }
      var tbody = h("tbody");
      state.datasets.forEach(function (d) {
        var tr = h("tr", { class: "ds-row", onclick: function () { openDataset(d.id); } }, [
          h("td", { text: d.name }), h("td", { class: "ds-muted", text: d.id }),
          h("td", { text: "v" + d.version }),
          h("td", { text: "활성 " + d.activeCount + " / 전체 " + d.itemCount }),
          h("td", { class: "ds-muted", text: d.description || "" }),
        ]);
        if (state.current && state.current.dataset.id === d.id) tr.style.fontWeight = "600";
        tbody.appendChild(tr);
      });
      listBox.appendChild(h("table", null, [
        h("thead", null, [h("tr", null, ["이름", "id", "버전", "항목", "설명"].map(function (t) { return h("th", { text: t }); }))]),
        tbody,
      ]));
    }

    function renderItems() {
      itemsBox.textContent = "";
      if (!state.current) return;
      var ds = state.current.dataset, items = state.current.items;
      var shown = items.filter(function (i) {
        return state.filter === "all" || (state.filter === "active" ? i.active : !i.active);
      });
      var sel = h("select", { onchange: function () { state.filter = sel.value; renderItems(); } },
        [["all", "전체"], ["active", "활성만"], ["inactive", "비활성(플레이스홀더)"]].map(function (o) {
          var op = h("option", { value: o[0], text: o[1] }); if (o[0] === state.filter) op.selected = true; return op;
        }));
      itemsBox.appendChild(h("div", { class: "ds-bar" }, [
        h("strong", { text: ds.name + " · v" + ds.version }), sel,
        h("span", { class: "ds-muted", text: "활성 항목만 평가 실행에 포함됩니다" }),
      ]));
      var tbody = h("tbody");
      shown.forEach(function (it) {
        var toggle = h("input", { type: "checkbox", title: "활성 토글(관리자)" });
        toggle.checked = it.active;
        toggle.addEventListener("change", async function () {
          var want = toggle.checked;
          try {
            await api("PATCH", "/datasets/" + encodeURIComponent(ds.id) + "/items/" + encodeURIComponent(it.id), { active: want });
            setMsg(it.id + " → " + (want ? "활성" : "비활성") + " (데이터셋 버전 +1)", false);
            await openDataset(ds.id);
          } catch (e) { toggle.checked = !want; setMsg("변경 실패: " + e.message, true); }
        });
        var q = h("td", null, [h("div", { text: it.question }), h("div", { class: "ds-muted", text: it.id + " · " + it.source })]);
        if (it.tags.length) q.appendChild(h("div", { class: "ds-muted", text: it.tags.join(", ") }));
        var ans = h("td", null, [it.expectedAnswer
          ? h("div", { class: "ds-ans", text: it.expectedAnswer })
          : h("div", { class: "ds-muted", text: "(기대 답 없음 — TODO)" })]);
        if (it.prereq) ans.appendChild(h("div", { class: "ds-prereq", text: "사전 조건 · " + it.prereq }));
        tbody.appendChild(h("tr", { class: it.active ? "" : "ds-off" }, [
          h("td", null, [toggle]),
          q,
          h("td", null, [h("span", { class: "ds-badge " + (it.expectedVerdict === "grounded" ? "ds-g" : "ds-u"), text: it.expectedVerdict })]),
          h("td", { class: "ds-muted", text: it.expectedSources.map(sourceText).join(" / ") || "(없음)" }),
          ans,
        ]));
      });
      if (!shown.length) tbody.appendChild(h("tr", null, [h("td", { colspan: "5", class: "ds-muted", text: "표시할 항목이 없습니다." })]));
      itemsBox.appendChild(h("table", null, [
        h("thead", null, [h("tr", null, ["활성", "질문", "기대 판정", "기대 근거", "기대 답 · 사전 조건"].map(function (t) { return h("th", { text: t }); }))]),
        tbody,
      ]));
    }

    async function openDataset(id) {
      try {
        state.current = await api("GET", "/datasets/" + encodeURIComponent(id));
        await refreshListOnly();
        renderItems();
      } catch (e) { setMsg("불러오기 실패: " + e.message, true); }
    }
    async function refreshListOnly() {
      var r = await api("GET", "/datasets");
      state.datasets = r.datasets; renderList();
    }
    async function loadList(openId) {
      try {
        await refreshListOnly();
        var id = openId || (state.current && state.current.dataset.id) || (state.datasets[0] && state.datasets[0].id);
        if (id) await openDataset(id); else renderItems();
      } catch (e) { setMsg("목록 불러오기 실패: " + e.message, true); }
    }
    loadList();
  }

  NS.datasets = { mount: mount };
})();
