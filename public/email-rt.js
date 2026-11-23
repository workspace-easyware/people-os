// 새 메일 간단 서식 편집 (2026-11-23) — contenteditable + document.execCommand. 라이브러리·CDN 없음.
//  - emailSanitizeHtml(html) → { html, text }: 허용 목록 방식 살균. 보내기 직전과 붙여넣기에서 쓴다.
//  - emailRt*: 툴바·단축키·선택 영역 보존. 화면 id는 index.html #emailComposeCard 참조.
// 살균은 DOMParser(스크립트 실행·이미지 로드 없는 비활성 문서)로 파싱한 뒤 "허용 태그만 새로 만들어" 복사한다.
// 원본 노드의 속성은 절대 복사하지 않는다 → on* 핸들러·알 수 없는 속성은 구조상 들어올 수 없다.
(function (g) {
  'use strict';

  var ALLOWED = { P: 1, DIV: 1, BR: 1, B: 1, STRONG: 1, I: 1, EM: 1, U: 1, S: 1, STRIKE: 1, SPAN: 1, A: 1, UL: 1, OL: 1, LI: 1, BLOCKQUOTE: 1 };
  // 내용까지 통째로 버리는 태그 (나머지 모르는 태그는 껍데기만 벗기고 글자는 남긴다)
  var DROP = { SCRIPT: 1, STYLE: 1, IFRAME: 1, FRAME: 1, FRAMESET: 1, OBJECT: 1, EMBED: 1, APPLET: 1, IMG: 1, PICTURE: 1, SVG: 1, MATH: 1,
    META: 1, BASE: 1, LINK: 1, HEAD: 1, TITLE: 1, TEMPLATE: 1, NOSCRIPT: 1, TEXTAREA: 1, SELECT: 1, OPTION: 1, BUTTON: 1, INPUT: 1,
    FORM: 1, AUDIO: 1, VIDEO: 1, CANVAS: 1, SOURCE: 1, TRACK: 1 };
  var FAMILY = {
    sans: 'Arial,Helvetica,sans-serif',
    serif: 'Georgia,"Times New Roman",serif',
    mono: '"Courier New",Courier,monospace',
  };
  var SIZES = { 'xx-small': 1, 'x-small': 1, small: 1, medium: 1, large: 1, 'x-large': 1, 'xx-large': 1, 'xxx-large': 1 };
  var FONT_TAG_SIZE = { 1: 'x-small', 2: 'small', 3: 'medium', 4: 'large', 5: 'x-large', 6: 'xx-large', 7: 'xxx-large' };
  var BLOCK = { P: 1, DIV: 1, LI: 1, BLOCKQUOTE: 1, UL: 1, OL: 1 };

  function colorOk(v) {
    v = String(v).trim();
    return /^#[0-9a-f]{3,8}$/i.test(v) ||
      /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/i.test(v) ||
      /^[a-z]{3,20}$/i.test(v);
  }
  function parseStyle(attr) {
    var o = {};
    String(attr || '').split(';').forEach(function (d) {
      var i = d.indexOf(':');
      if (i < 1) return;
      var k = d.slice(0, i).trim().toLowerCase();
      var v = d.slice(i + 1).trim();
      // 따옴표·역슬래시·주석·url()·expression 등이 하나라도 있으면 그 선언은 버린다 (색 rgb()는 colorOk가 따로 통과시킨다)
      if (/[\\<>@"']|\/\*|url\s*\(|expression|javascript|import/i.test(v)) return;
      o[k] = v;
    });
    return o;
  }
  // 허용 속성만 새 style 문자열로 만든다.
  function buildStyle(src, tag) {
    var s = parseStyle(src), out = [];
    if (tag === 'SPAN') {
      if (s.color && colorOk(s.color)) out.push('color:' + s.color);
      var bg = s['background-color'] || s.background;
      if (bg && colorOk(bg)) out.push('background-color:' + bg);
      var fs = s['font-size'];
      if (fs && (SIZES[fs.toLowerCase()] || /^\d{1,2}(\.\d+)?(px|pt|em)$/i.test(fs))) out.push('font-size:' + fs.toLowerCase());
      var ff = (s['font-family'] || '').toLowerCase();
      if (ff) out.push('font-family:' + (/mono|courier|consolas/.test(ff) ? FAMILY.mono : /sans|arial|helvetica|verdana/.test(ff) ? FAMILY.sans : /serif|georgia|times/.test(ff) ? FAMILY.serif : FAMILY.sans));
    }
    if (/^(SPAN|P|DIV|LI|UL|OL|BLOCKQUOTE)$/.test(tag)) {
      var ta = (s['text-align'] || '').toLowerCase();
      if (/^(left|center|right|justify)$/.test(ta)) out.push('text-align:' + ta);
    }
    return out.join(';');
  }
  function indentPx(src) {
    var s = parseStyle(src);
    var v = s['margin-left'];
    if (!v && s.margin) { var p = s.margin.split(/\s+/); v = p.length === 4 ? p[3] : p.length === 2 ? p[1] : p.length === 1 ? p[0] : ''; }
    var m = /^(\d{1,3})(px)$/i.exec(v || '');
    return m ? Math.min(+m[1], 400) : 0;
  }
  function hrefOk(h) {
    h = String(h || '').trim();
    return /^(https?:\/\/|mailto:)[^\s<>"']+$/i.test(h) ? h : '';
  }

  function cleanChildren(src, dst, doc) {
    for (var n = src.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) { dst.appendChild(doc.createTextNode(n.nodeValue)); continue; }
      if (n.nodeType !== 1) continue;
      var tag = n.tagName.toUpperCase();
      if (DROP[tag]) continue;
      if (tag === 'FONT') { // 붙여넣기 등에서 오는 <font>는 span으로 바꾼다
        var st = [], c = n.getAttribute('color'), sz = n.getAttribute('size');
        if (c && colorOk(c)) st.push('color:' + c);
        if (sz && FONT_TAG_SIZE[sz]) st.push('font-size:' + FONT_TAG_SIZE[sz]);
        var f = doc.createElement('span');
        if (st.length) f.setAttribute('style', st.join(';'));
        cleanChildren(n, f, doc);
        dst.appendChild(f);
        continue;
      }
      if (!ALLOWED[tag]) { cleanChildren(n, dst, doc); continue; } // 껍데기만 벗김
      if (tag === 'BR') { dst.appendChild(doc.createElement('br')); continue; }
      if (tag === 'A') {
        var href = hrefOk(n.getAttribute('href'));
        if (!href) { cleanChildren(n, dst, doc); continue; }
        var a = doc.createElement('a');
        a.setAttribute('href', href);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
        cleanChildren(n, a, doc);
        dst.appendChild(a);
        continue;
      }
      var el = doc.createElement(tag.toLowerCase());
      var styleAttr = n.getAttribute('style');
      var style = buildStyle(styleAttr, tag);
      if (tag === 'BLOCKQUOTE') {
        var ind = indentPx(styleAttr);
        // 들여쓰기(Chrome은 margin-left 있는 blockquote로 만든다)와 인용(세로선)을 구분한다
        style = (ind ? 'margin:0 0 0 ' + ind + 'px' : 'margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex;color:#555') + (style ? ';' + style : '');
      }
      if (style) el.setAttribute('style', style);
      if (tag === 'SPAN' && !style) { cleanChildren(n, dst, doc); continue; } // 스타일 없는 span은 벗긴다
      cleanChildren(n, el, doc);
      dst.appendChild(el);
    }
  }

  // 살균된 DOM → 일반 텍스트 (블록은 줄바꿈, 목록은 "- "/"1. ", 인용은 "> ", 링크는 "글자 (주소)")
  function toText(node, ctx) {
    var out = '';
    for (var n = node.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) { out += n.nodeValue; continue; }
      var tag = n.tagName;
      if (tag === 'BR') { out += '\n'; continue; }
      var inner;
      if (tag === 'UL' || tag === 'OL') { inner = toText(n, { list: tag, i: 0 }); out += (out && !/\n$/.test(out) ? '\n' : '') + inner; continue; }
      inner = toText(n, ctx);
      if (tag === 'A') {
        var h = n.getAttribute('href') || '';
        out += inner.trim() && inner.trim() !== h.replace(/^mailto:/i, '') && inner.trim() !== h ? inner + ' (' + h.replace(/^mailto:/i, '') + ')' : inner;
      } else if (tag === 'LI') {
        ctx.i = (ctx.i || 0) + 1;
        out += (out && !/\n$/.test(out) ? '\n' : '') + (ctx.list === 'OL' ? ctx.i + '. ' : '- ') + inner.replace(/\n+$/, '') + '\n';
      } else if (tag === 'BLOCKQUOTE') {
        out += (out && !/\n$/.test(out) ? '\n' : '') + inner.replace(/\n+$/, '').split('\n').map(function (l) { return '> ' + l; }).join('\n') + '\n';
      } else if (BLOCK[tag]) {
        out += (out && !/\n$/.test(out) ? '\n' : '') + inner + (/\n$/.test(inner) ? '' : '\n');
      } else out += inner;
    }
    return out;
  }

  // 입력: 에디터 innerHTML(또는 임의 HTML). 출력: html(발송용, 래퍼 div 포함), inner(래퍼 없음), text.
  function emailSanitizeHtml(html) {
    var doc = new DOMParser().parseFromString('<!doctype html><html><body>' + String(html || ''), 'text/html');
    var root = doc.createElement('div');
    cleanChildren(doc.body, root, doc);
    var text = toText(root, {}).replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
    var inner = root.innerHTML;
    return {
      text: text,
      inner: inner,
      html: text ? '<div style="font-family:' + FAMILY.sans + ';font-size:14px;line-height:1.5">' + inner + '</div>' : '',
    };
  }
  g.emailSanitizeHtml = emailSanitizeHtml;

  // ───── 편집기 ─────
  var inited = false, saved = null;
  function ed() { return document.getElementById('emailBody'); }
  function inEditor(node) { var e = ed(); return !!(e && node && e.contains(node)); }
  function refreshEmpty() {
    var e = ed();
    if (e.innerHTML === '<br>') e.innerHTML = '';
    e.classList.toggle('empty', !e.textContent.trim() && !e.querySelector('li,blockquote'));
  }
  function restoreRange() {
    var e = ed();
    e.focus();
    var sel = window.getSelection();
    if (saved && !inEditor(sel.anchorNode)) { sel.removeAllRanges(); sel.addRange(saved); }
    else if (!sel.rangeCount || !inEditor(sel.anchorNode)) { var r = document.createRange(); r.selectNodeContents(e); r.collapse(false); sel.removeAllRanges(); sel.addRange(r); }
  }
  function exec(cmd, val, css) {
    restoreRange();
    try { document.execCommand('styleWithCSS', false, !!css); } catch (e) {}
    var ok = document.execCommand(cmd, false, val == null ? null : val);
    refreshEmpty(); updateState();
    return ok;
  }
  function updateState() {
    var tb = document.getElementById('emailToolbar');
    if (!tb) return;
    var sel = window.getSelection();
    var active = sel && inEditor(sel.anchorNode);
    tb.querySelectorAll('[data-cmd]').forEach(function (b) {
      var c = b.getAttribute('data-cmd');
      if (!/^(bold|italic|underline|strikeThrough|insertOrderedList|insertUnorderedList|justifyLeft|justifyCenter|justifyRight)$/.test(c)) return;
      var on = false;
      try { on = !!active && document.queryCommandState(c); } catch (e) {}
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  function normUrl(u) {
    u = String(u || '').trim();
    if (/^(https?:|mailto:)/i.test(u)) return u;
    if (/^[a-z][a-z0-9+.\-]*:/i.test(u)) return ''; // javascript: 등 다른 스킴은 거부
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u)) return 'mailto:' + u;
    return u ? 'https://' + u.replace(/^\/+/, '') : '';
  }
  function openLink() {
    restoreRange();
    var sel = window.getSelection();
    saved = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : saved;
    var a = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
    a = a && a.closest ? a.closest('a') : null;
    var bar = document.getElementById('emailLinkBar'), inp = document.getElementById('emailLinkUrl');
    bar.style.display = '';
    inp.value = a ? a.getAttribute('href') : '';
    inp.focus();
  }
  function applyLink() {
    var inp = document.getElementById('emailLinkUrl');
    var url = normUrl(inp.value);
    if (!url || !hrefOk(url)) { inp.setCustomValidity && inp.setCustomValidity(''); inp.focus(); inp.style.borderColor = '#d93025'; return; }
    inp.style.borderColor = '';
    document.getElementById('emailLinkBar').style.display = 'none';
    restoreRange();
    var sel = window.getSelection();
    if (sel.isCollapsed) exec('insertHTML', '<a href="' + esc(url) + '">' + esc(url.replace(/^mailto:/i, '')) + '</a>');
    else exec('createLink', url);
  }
  function closeLink() { document.getElementById('emailLinkBar').style.display = 'none'; restoreRange(); }

  function command(c) {
    switch (c) {
      case 'quote': {
        var sel = window.getSelection(), n = sel.anchorNode, el = n && (n.nodeType === 1 ? n : n.parentElement);
        var inQuote = el && el.closest && el.closest('blockquote') && inEditor(el);
        return inQuote ? exec('outdent') : exec('formatBlock', '<blockquote>');
      }
      case 'link': return openLink();
      case 'clear': exec('removeFormat'); return exec('unlink');
      case 'indent': case 'outdent': return exec(c, null, true);
      case 'justifyLeft': case 'justifyCenter': case 'justifyRight': return exec(c, null, true);
      default: return exec(c); // bold·italic·underline·strikeThrough·목록은 태그로 (styleWithCSS 끔)
    }
  }

  g.emailRtFont = function (v) { exec('fontName', v === 'mono' ? 'monospace' : v === 'serif' ? 'serif' : 'sans-serif', true); };
  g.emailRtSize = function (v) { exec('fontSize', v, true); };
  g.emailRtSet = function (html) { var e = ed(); e.innerHTML = html; saved = null; refreshEmpty(); };

  g.emailRtInit = function () {
    if (inited) return;
    inited = true;
    var e = ed(), tb = document.getElementById('emailToolbar');
    try { document.execCommand('defaultParagraphSeparator', false, 'div'); } catch (x) {}
    // 버튼은 mousedown에서 포커스를 빼앗지 않게 해 선택 영역을 유지한다
    tb.addEventListener('mousedown', function (ev) { if (ev.target.closest('button')) ev.preventDefault(); });
    tb.addEventListener('click', function (ev) {
      var b = ev.target.closest('button[data-cmd]');
      if (b) command(b.getAttribute('data-cmd'));
    });
    document.getElementById('rtFore').addEventListener('input', function () { exec('foreColor', this.value, true); });
    document.getElementById('rtBack').addEventListener('input', function () { exec('hiliteColor', this.value, true); });
    document.getElementById('emailLinkOk').addEventListener('click', applyLink);
    document.getElementById('emailLinkCancel').addEventListener('click', closeLink);
    document.getElementById('emailLinkUrl').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); applyLink(); } else if (ev.key === 'Escape') { ev.preventDefault(); closeLink(); }
    });
    document.addEventListener('selectionchange', function () {
      var sel = window.getSelection();
      if (sel.rangeCount && inEditor(sel.anchorNode)) { saved = sel.getRangeAt(0).cloneRange(); updateState(); }
    });
    e.addEventListener('input', refreshEmpty);
    e.addEventListener('keydown', function (ev) {
      if (!(ev.ctrlKey || ev.metaKey) || ev.altKey) return;
      var k = ev.key.toLowerCase(), map = { b: 'bold', i: 'italic', u: 'underline', k: 'link' };
      if (ev.shiftKey || !map[k]) return;
      ev.preventDefault();
      command(map[k]);
    });
    // 붙여넣기: 서식은 살균해서 넣고, 이미지·알 수 없는 태그는 버린다
    e.addEventListener('paste', function (ev) {
      var cd = ev.clipboardData;
      if (!cd) return;
      ev.preventDefault();
      var html = cd.getData('text/html'), text = cd.getData('text/plain');
      if (html) exec('insertHTML', emailSanitizeHtml(html).inner);
      else if (text) exec('insertHTML', String(text).split(/\r?\n/).map(esc).join('<br>'));
    });
    e.addEventListener('drop', function (ev) { if (ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files.length) ev.preventDefault(); });
  };
})(window);
