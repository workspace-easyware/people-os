/* 페이지 내 확인 대화상자 + 토스트 (브라우저 화면 회귀 수정, 2026-11-21). 순수 JS, 스타일은 styles.css ".ui-dlg-*", ".ui-toast*".
 *
 *   uiConfirm(message, { title, okText, cancelText, danger }) → Promise<boolean>
 *     네이티브 confirm()을 대신한다. 자동화 브라우저·일부 내장 브라우저는 네이티브 확인창을 띄우지 않고
 *     자동으로 "취소"를 돌려준다 → `if (!confirm(...)) return;` 버튼이 아무 표시 없이 무반응이 된다.
 *     페이지 안 대화상자는 그런 환경에서도 보이고, 클릭으로 확인할 수 있다.
 *     Esc·바깥 클릭·취소 = false. 기본 포커스는 "취소" (되돌릴 수 없는 동작을 Enter 한 번에 실행하지 않게).
 *   uiToast(text, isErr) — 화면 오른쪽 아래 5초 토스트 (role=status / 오류는 role=alert).
 *
 * 메시지는 textContent로만 넣는다 (HTML 없음).
 */
(function (g) {
  'use strict';
  var open = null; // 한 번에 하나만

  function uiConfirm(message, opts) {
    opts = opts || {};
    if (open) open.finish(false);
    return new Promise(function (resolve) {
      var back = document.createElement('div');
      back.className = 'ui-dlg-back';
      var box = document.createElement('div');
      box.className = 'ui-dlg';
      box.setAttribute('role', 'alertdialog');
      box.setAttribute('aria-modal', 'true');
      var id = 'uiDlg' + Date.now().toString(36);
      if (opts.title) {
        var h = document.createElement('h3');
        h.className = 'ui-dlg-title'; h.id = id + 't'; h.textContent = opts.title;
        box.appendChild(h);
        box.setAttribute('aria-labelledby', h.id);
      }
      var p = document.createElement('p');
      p.className = 'ui-dlg-msg'; p.id = id + 'm'; p.textContent = String(message == null ? '' : message);
      box.appendChild(p);
      box.setAttribute('aria-describedby', p.id);
      var btns = document.createElement('div');
      btns.className = 'ui-dlg-btns';
      var cancel = document.createElement('button');
      cancel.type = 'button'; cancel.className = 'secondary'; cancel.textContent = opts.cancelText || '취소';
      cancel.setAttribute('data-ui-dlg', 'cancel');
      var ok = document.createElement('button');
      ok.type = 'button'; ok.className = opts.danger ? 'primary ui-dlg-danger' : 'primary'; ok.textContent = opts.okText || '확인';
      ok.setAttribute('data-ui-dlg', 'ok');
      btns.appendChild(cancel); btns.appendChild(ok);
      box.appendChild(btns);
      back.appendChild(box);
      var prevFocus = document.activeElement;
      var done = false;
      function finish(v) {
        if (done) return;
        done = true; open = null;
        document.removeEventListener('keydown', onKey, true);
        if (back.parentNode) back.parentNode.removeChild(back);
        try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch (x) { /* 무시 */ }
        resolve(v);
      }
      function onKey(ev) {
        if (ev.key === 'Escape') { ev.preventDefault(); finish(false); return; }
        if (ev.key === 'Tab') { // 포커스를 대화상자 안에 가둔다 (버튼 2개)
          ev.preventDefault();
          (document.activeElement === ok ? cancel : ok).focus();
        }
      }
      cancel.onclick = function () { finish(false); };
      ok.onclick = function () { finish(true); };
      back.addEventListener('mousedown', function (ev) { if (ev.target === back) finish(false); });
      document.addEventListener('keydown', onKey, true);
      open = { finish: finish };
      document.body.appendChild(back);
      cancel.focus();
    });
  }

  function uiToast(text, isErr) {
    var wrap = document.getElementById('uiToastBox');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'uiToastBox';
      wrap.className = 'ui-toast-box';
      document.body.appendChild(wrap);
    }
    var t = document.createElement('div');
    t.className = 'ui-toast' + (isErr ? ' err' : '');
    t.setAttribute('role', isErr ? 'alert' : 'status');
    t.textContent = String(text == null ? '' : text);
    wrap.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, isErr ? 8000 : 5000);
  }

  g.uiConfirm = uiConfirm;
  g.uiToast = uiToast;
})(typeof window !== 'undefined' ? window : globalThis);
