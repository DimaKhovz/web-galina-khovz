/* Анкета-визард: общий движок для взрослой и детской анкеты.
   Подключается на странице, где заранее объявлена переменная FORM_CONFIG:
   {
     formId: 'adult' | 'child',
     schemaUrl: 'schemas/adult.json',
     apiBase: 'https://ВАШ-WORKER.workers.dev',
     doctorWhatsApp: '79057192085'          // запасной канал, если отправка не прошла
   }

   Надёжность (главное требование):
   - Каждый ответ мгновенно пишется в память браузера (localStorage) — ничего не теряется,
     даже если закрыть вкладку или пропал интернет.
   - Копия черновика уходит на сервер (Cloudflare KV) при переходе между разделами,
     раз в 30 секунд, если были изменения, и при сворачивании/закрытии страницы —
     поэтому можно продолжить с другого устройства по личной ссылке (?d=...).
   - Анкета считается отправленной ТОЛЬКО если сервер подтвердил приём. Иначе пациент
     видит понятное сообщение, кнопку «Попробовать ещё раз» и запасные варианты
     (скачать файл / скопировать текст / написать доктору в WhatsApp).
*/
(function () {
  'use strict';
  const CFG = window.FORM_CONFIG;
  if (!CFG) { console.error('FORM_CONFIG не задан'); return; }

  const SYNC_INTERVAL_MS = 30000;
  const LS_CURRENT = 'anketa_' + CFG.formId + '_current';
  const lsDraftKey = (id) => 'anketa_' + CFG.formId + '_draft_' + id;

  let schema = null;
  let answers = {};
  let draftId = null;
  let step = 0;            // 0 = вступление, 1..N = разделы, N+1 = проверка
  let dirty = false;       // есть изменения, ещё не отправленные на сервер
  let syncing = false;
  let serverOk = true;     // последний обмен с сервером удался
  let lastText = '';       // текст анкеты на случай ручной отправки

  const root = document.getElementById('app');

  // ---------- безопасная работа с localStorage (в приватных окнах / встроенных браузерах может падать)
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function lsRemove(k) { try { window.localStorage.removeItem(k); } catch (e) { /* ignore */ } }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'd-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  }
  function getUrlParam(name) { return new URL(window.location.href).searchParams.get(name); }
  function personalLink() {
    const u = new URL(window.location.href);
    u.search = '';
    u.searchParams.set('d', draftId);
    u.hash = '';
    return u.toString();
  }

  function fetchWithTimeout(url, opts, ms) {
    const ctrl = ('AbortController' in window) ? new AbortController() : null;
    const t = ctrl ? setTimeout(() => ctrl.abort(), ms) : null;
    return fetch(url, Object.assign({}, opts, ctrl ? { signal: ctrl.signal } : {}))
      .finally(() => { if (t) clearTimeout(t); });
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // ---------- статус сохранения в шапке
  function setStatus() {
    const box = document.getElementById('save-status');
    if (!box) return;
    box.classList.toggle('error', !serverOk);
    box.querySelector('span:last-child').textContent = serverOk ? 'сохранено' : 'сохранено на этом устройстве';
    box.title = serverOk
      ? 'Ответы сохранены — можно закрыть страницу и вернуться позже по своей ссылке.'
      : 'Нет связи с сервером: ответы сохранены в этом браузере, на сервер отправятся, когда связь появится.';
  }

  // ---------- инициализация
  async function init() {
    try {
      const res = await fetchWithTimeout(CFG.schemaUrl, { cache: 'no-cache' }, 20000);
      if (!res.ok) throw new Error('schema ' + res.status);
      schema = await res.json();
    } catch (e) {
      renderFatal();
      return;
    }

    const urlDraft = getUrlParam('d');
    if (urlDraft && /^[a-zA-Z0-9-]{6,80}$/.test(urlDraft)) draftId = urlDraft;
    else draftId = lsGet(LS_CURRENT) || uuid();
    lsSet(LS_CURRENT, draftId);
    window.history.replaceState({}, '', personalLink());

    try { answers = JSON.parse(lsGet(lsDraftKey(draftId)) || '{}') || {}; } catch (e) { answers = {}; }

    // более свежая версия с сервера (если пациент заполнял на другом устройстве)
    if (CFG.apiBase) {
      try {
        const r = await fetchWithTimeout(CFG.apiBase + '/api/draft/' + draftId, {}, 8000);
        if (r.ok) {
          const remote = await r.json();
          if (remote && remote.submitted) {
            answers = { __submitted: true };
            lsSet(lsDraftKey(draftId), JSON.stringify(answers));
          } else if (remote && remote.answers) {
            const remoteTs = (remote.answers && remote.answers.__ts) || remote.updatedAt || 0;
            if (remoteTs > (answers.__ts || 0)) {
              answers = remote.answers;
              lsSet(lsDraftKey(draftId), JSON.stringify(answers));
            }
          }
        }
      } catch (e) { serverOk = false; /* сервер недоступен — работаем локально */ }
    }

    if (answers.__submitted) { renderDone(false); return; }

    step = 0;
    render();

    setInterval(() => { if (dirty) syncToServer(); }, SYNC_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && dirty) syncToServer(true);
    });
    window.addEventListener('pagehide', () => { if (dirty) syncToServer(true); });
    window.addEventListener('online', () => { if (dirty) syncToServer(); });
  }

  // ---------- сохранение
  function saveLocal() {
    answers.__ts = Date.now();
    answers.__step = step;
    lsSet(lsDraftKey(draftId), JSON.stringify(answers));
    dirty = true;
    setStatus();
  }

  async function syncToServer(onLeave) {
    if (!CFG.apiBase || syncing || answers.__submitted) return;
    syncing = true;
    dirty = false;
    const body = JSON.stringify({ formId: CFG.formId, answers });
    try {
      const r = await fetchWithTimeout(CFG.apiBase + '/api/draft/' + draftId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: !!onLeave && body.length < 60000
      }, 10000);
      if (!r.ok) throw new Error('draft ' + r.status);
      serverOk = true;
    } catch (e) {
      dirty = true;
      serverOk = false;
    } finally {
      syncing = false;
      setStatus();
    }
  }

  function setAnswer(id, value) {
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)) delete answers[id];
    else answers[id] = value;
    saveLocal();
  }

  function goTo(newStep) {
    step = newStep;
    answers.__step = step;
    lsSet(lsDraftKey(draftId), JSON.stringify(answers));
    if (dirty) syncToServer();
    render();
    window.scrollTo(0, 0);
  }

  // ---------- форматирование
  function fieldLabel(f) { return f.label || ''; }
  function plainLabel(f) { return fieldLabel(f).replace(/[:：]\s*$/, ''); }

  function formatAnswer(f) {
    const val = answers[f.id];
    if (f.type === 'checkbox-group') {
      const arr = Array.isArray(val) ? val.slice() : [];
      const other = answers[f.id + '__other'];
      if (other) arr.push('Другое: ' + other);
      return arr.length ? arr.join(', ') : null;
    }
    if (f.type === 'chrono') {
      const lines = [];
      (f.periods || []).forEach(period => {
        const pid = f.id + '__' + period;
        const ev = answers[pid + '__event'];
        const ch = answers[pid + '__change'];
        if (ev || ch) lines.push(`  ${period}: ${ev || '—'} / что изменилось после: ${ch || '—'}`);
      });
      return lines.length ? '\n' + lines.join('\n') : null;
    }
    if (val === undefined || val === null || val === '') return null;
    if (f.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(val)) {
      const [y, m, d] = val.split('-');
      return `${d}.${m}.${y}`;
    }
    return String(val);
  }

  // Анкета в читаемом виде «Вопрос: Ответ» по разделам — именно это получает доктор.
  function buildReadableText() {
    const lines = [];
    lines.push(schema.title);
    lines.push('Дата отправки: ' + new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) + ' (МСК)');
    lines.push('');
    schema.sections.forEach(section => {
      const rows = [];
      (section.fields || []).forEach(f => {
        const formatted = formatAnswer(f);
        if (formatted) rows.push(plainLabel(f) + ':' + (formatted.charAt(0) === '\n' ? '' : ' ') + formatted);
      });
      if (rows.length) {
        lines.push('— ' + section.title + ' —');
        rows.forEach(r => lines.push(r));
        lines.push('');
      }
    });
    return lines.join('\n').trim();
  }

  function patientName() {
    return (answers.fio || answers.child_fio || '').trim();
  }

  // ---------- обязательные поля
  function isEmpty(f) { return formatAnswer(f) === null; }
  function missingRequired(section) {
    return (section.fields || []).filter(f => f.required && isEmpty(f));
  }
  function firstMissingStep() {
    for (let i = 0; i < schema.sections.length; i++) {
      if (missingRequired(schema.sections[i]).length) return i + 1;
    }
    return 0;
  }

  // ---------- поля
  function renderField(f, showErrors) {
    const val = answers[f.id];
    const wrap = el('div', 'field');
    wrap.dataset.fieldId = f.id;

    const label = el('label', 'field-label', fieldLabel(f));
    if (f.required) {
      const star = el('span', 'req', ' *');
      star.title = 'Обязательное поле';
      label.appendChild(star);
    }
    wrap.appendChild(label);

    if (f.hint) wrap.appendChild(el('div', 'field-hint', f.hint));

    if (f.type === 'text' || f.type === 'date' || f.type === 'tel') {
      const input = document.createElement('input');
      input.type = f.type === 'date' ? 'date' : (f.type === 'tel' ? 'tel' : 'text');
      input.id = 'f_' + f.id;
      label.htmlFor = input.id;
      input.value = val || '';
      input.addEventListener('input', (e) => {
        setAnswer(f.id, e.target.value.trim() ? e.target.value : '');
        wrap.classList.remove('has-error');
      });
      wrap.appendChild(input);

    } else if (f.type === 'textarea') {
      const ta = document.createElement('textarea');
      ta.id = 'f_' + f.id;
      label.htmlFor = ta.id;
      ta.value = val || '';
      ta.addEventListener('input', (e) => {
        setAnswer(f.id, e.target.value.trim() ? e.target.value : '');
        wrap.classList.remove('has-error');
      });
      wrap.appendChild(ta);

    } else if (f.type === 'radio' || f.type === 'yesno') {
      const opts = f.type === 'yesno' ? (f.options || ['да', 'нет']) : f.options;
      const row = el('div', 'choice-row');
      const pills = [];
      opts.forEach(opt => {
        const pill = el('label', 'choice-pill' + (val === opt ? ' checked' : ''));
        const inp = document.createElement('input');
        inp.type = 'radio';
        inp.name = f.id;
        inp.checked = val === opt;
        // повторное нажатие на выбранный вариант снимает выбор
        inp.addEventListener('click', () => {
          if (answers[f.id] === opt) {
            setAnswer(f.id, '');
            inp.checked = false;
            pills.forEach(p => p.classList.remove('checked'));
          }
        });
        inp.addEventListener('change', () => {
          setAnswer(f.id, opt);
          pills.forEach(p => p.classList.toggle('checked', p === pill));
          wrap.classList.remove('has-error');
        });
        pill.appendChild(inp);
        pill.appendChild(document.createTextNode(opt));
        pills.push(pill);
        row.appendChild(pill);
      });
      wrap.appendChild(row);

    } else if (f.type === 'checkbox-group') {
      const row = el('div', 'choice-row');
      (f.options || []).forEach(opt => {
        const arr0 = Array.isArray(val) ? val : [];
        const pill = el('label', 'choice-pill' + (arr0.indexOf(opt) >= 0 ? ' checked' : ''));
        const inp = document.createElement('input');
        inp.type = 'checkbox';
        inp.checked = arr0.indexOf(opt) >= 0;
        inp.addEventListener('change', () => {
          const arr = Array.isArray(answers[f.id]) ? answers[f.id].slice() : [];
          const idx = arr.indexOf(opt);
          if (inp.checked && idx < 0) arr.push(opt);
          if (!inp.checked && idx >= 0) arr.splice(idx, 1);
          setAnswer(f.id, arr);
          pill.classList.toggle('checked', inp.checked);
          wrap.classList.remove('has-error');
        });
        pill.appendChild(inp);
        pill.appendChild(document.createTextNode(opt));
        row.appendChild(pill);
      });
      wrap.appendChild(row);
      if (f.allowOther) {
        const otherInput = document.createElement('input');
        otherInput.type = 'text';
        otherInput.placeholder = 'другое / уточните';
        otherInput.className = 'other-input';
        otherInput.value = answers[f.id + '__other'] || '';
        otherInput.addEventListener('input', (e) => setAnswer(f.id + '__other', e.target.value.trim() ? e.target.value : ''));
        wrap.appendChild(otherInput);
      }

    } else if (f.type === 'scale10') {
      const touched = val !== undefined && val !== null && val !== '';
      const sliderWrap = el('div', 'slider-wrap' + (touched ? '' : ' untouched'));
      const input = document.createElement('input');
      input.type = 'range';
      input.min = 0; input.max = 10; input.step = 1;
      input.value = touched ? val : 5;
      input.setAttribute('aria-label', fieldLabel(f));
      const out = el('div', 'slider-value');
      out.appendChild(el('span', '', '0 — слабо'));
      const nSpan = el('span', 'n', touched ? String(val) : 'не выбрано');
      out.appendChild(nSpan);
      out.appendChild(el('span', '', '10 — максимально'));
      const commit = (e) => {
        nSpan.textContent = e.target.value;
        sliderWrap.classList.remove('untouched');
        setAnswer(f.id, Number(e.target.value));
      };
      input.addEventListener('input', commit);
      input.addEventListener('change', commit);
      input.addEventListener('click', commit); // нажатие ровно на «5» тоже засчитываем
      sliderWrap.appendChild(input);
      sliderWrap.appendChild(out);
      wrap.appendChild(sliderWrap);

    } else if (f.type === 'chrono') {
      const grid = el('div', 'chrono-grid');
      (f.periods || []).forEach(period => {
        const pid = f.id + '__' + period;
        const pWrap = el('div');
        pWrap.appendChild(el('div', 'chrono-period', period));
        const ta1 = document.createElement('textarea');
        ta1.placeholder = 'Событие / болезнь / стресс / лечение';
        ta1.style.minHeight = '44px';
        ta1.value = answers[pid + '__event'] || '';
        ta1.addEventListener('input', (e) => setAnswer(pid + '__event', e.target.value.trim() ? e.target.value : ''));
        const ta2 = document.createElement('textarea');
        ta2.placeholder = 'Что изменилось после';
        ta2.style.minHeight = '44px';
        ta2.value = answers[pid + '__change'] || '';
        ta2.addEventListener('input', (e) => setAnswer(pid + '__change', e.target.value.trim() ? e.target.value : ''));
        pWrap.appendChild(ta1);
        pWrap.appendChild(ta2);
        grid.appendChild(pWrap);
      });
      wrap.appendChild(grid);
    }

    if (f.required) {
      wrap.appendChild(el('div', 'field-error', 'Пожалуйста, заполните это поле — оно нужно, чтобы доктор понял, чья это анкета, и мог с вами связаться.'));
      if (showErrors && isEmpty(f)) wrap.classList.add('has-error');
    }
    return wrap;
  }

  // ---------- экраны
  function renderTopbar() {
    const topbar = el('div', 'topbar');
    topbar.appendChild(el('div', 'brand', schema.title));
    const st = el('div', 'status');
    st.id = 'save-status';
    st.appendChild(el('span', 'dot'));
    st.appendChild(el('span', '', 'сохранено'));
    topbar.appendChild(st);
    root.appendChild(topbar);
    setStatus();
  }

  function render(showErrors) {
    root.innerHTML = '';
    renderTopbar();

    const n = schema.sections.length;
    const pWrap = el('div', 'progress-wrap');
    const bar = el('div', 'progress-bar');
    const fill = el('span');
    fill.style.width = Math.round((Math.min(step, n + 1) / (n + 1)) * 100) + '%';
    bar.appendChild(fill);
    pWrap.appendChild(bar);
    let label = 'Вступление';
    if (step >= 1 && step <= n) label = `Раздел ${step} из ${n}`;
    if (step > n) label = 'Проверка перед отправкой';
    pWrap.appendChild(el('div', 'progress-label', label));
    root.appendChild(pWrap);

    const container = el('div', 'container');
    root.appendChild(container);

    if (step === 0) renderIntro(container);
    else if (step <= n) renderSection(container, schema.sections[step - 1], showErrors);
    else renderReview(container);
  }

  function linkBox() {
    const box = el('div', 'link-box');
    box.appendChild(el('div', 'link-box-title', 'Ваша личная ссылка на эту анкету'));
    box.appendChild(el('div', 'link-box-hint', 'Сохраните её (например, отправьте себе в мессенджер) — по ней можно продолжить с любого устройства.'));
    const row = el('div', 'link-row');
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.readOnly = true;
    inp.value = personalLink();
    inp.addEventListener('focus', () => inp.select());
    const btn = el('button', 'btn secondary small', 'Скопировать');
    btn.type = 'button';
    btn.onclick = async () => {
      try { await navigator.clipboard.writeText(inp.value); btn.textContent = 'Скопировано'; }
      catch (e) { inp.focus(); inp.select(); btn.textContent = 'Выделено — скопируйте'; }
      setTimeout(() => { btn.textContent = 'Скопировать'; }, 2500);
    };
    row.appendChild(inp);
    row.appendChild(btn);
    box.appendChild(row);
    return box;
  }

  function hasAnyAnswer() {
    return Object.keys(answers).some(k => !k.startsWith('__'));
  }

  function renderIntro(container) {
    const card = el('div', 'intro-card');
    card.appendChild(el('h1', '', schema.title));
    if (schema.intro) card.appendChild(el('p', '', schema.intro));
    const returning = hasAnyAnswer();
    if (returning) {
      card.appendChild(el('div', 'resume-note strong', 'С возвращением! Ваши ответы сохранены — можно продолжить с того места, где вы остановились.'));
    } else {
      card.appendChild(el('div', 'resume-note', 'Ответы сохраняются автоматически на каждом шаге — можно закрыть страницу и вернуться позже. Чтобы продолжить с другого устройства, сохраните ссылку ниже.'));
    }
    card.appendChild(linkBox());
    container.appendChild(card);

    const nav = el('div', 'nav-row');
    const n = schema.sections.length;
    const savedStep = Math.min(Math.max(parseInt(answers.__step, 10) || 0, 0), n + 1);
    if (returning && savedStep >= 1) {
      const fromStart = el('button', 'btn secondary', 'С первого раздела');
      fromStart.type = 'button';
      fromStart.onclick = () => goTo(1);
      nav.appendChild(fromStart);
      const where = savedStep > n ? 'к проверке анкеты' : `с раздела «${schema.sections[savedStep - 1].title}»`;
      const cont = el('button', 'btn', 'Продолжить ' + where);
      cont.type = 'button';
      cont.onclick = () => goTo(savedStep);
      nav.appendChild(cont);
    } else {
      nav.appendChild(el('span'));
      const next = el('button', 'btn', returning ? 'Продолжить заполнение' : 'Начать заполнение');
      next.type = 'button';
      next.onclick = () => goTo(1);
      nav.appendChild(next);
    }
    container.appendChild(nav);
  }

  function renderSection(container, section, showErrors) {
    const card = el('div', 'section');
    card.appendChild(el('div', 'section-title', section.title));
    if (section.note) card.appendChild(el('div', 'section-note', section.note));
    (section.fields || []).forEach(f => card.appendChild(renderField(f, showErrors)));
    container.appendChild(card);

    const nav = el('div', 'nav-row');
    const back = el('button', 'btn secondary', 'Назад');
    back.type = 'button';
    back.onclick = () => goTo(step - 1);
    const isLast = step === schema.sections.length;
    const next = el('button', 'btn', isLast ? 'К проверке анкеты' : 'Далее');
    next.type = 'button';
    next.onclick = () => {
      const missing = missingRequired(section);
      if (missing.length) {
        render(true);
        const first = root.querySelector('.field.has-error');
        if (first) {
          first.scrollIntoView({ behavior: 'smooth', block: 'center' });
          const inp = first.querySelector('input, textarea');
          // фокус ставим, только если пациент ещё не начал печатать в другом поле
          if (inp) setTimeout(() => {
            const a = document.activeElement;
            if (!a || a === document.body || a.tagName === 'BUTTON') inp.focus({ preventScroll: true });
          }, 300);
        }
        return;
      }
      goTo(step + 1);
    };
    nav.appendChild(back);
    nav.appendChild(next);
    container.appendChild(nav);
  }

  function renderReview(container) {
    const card = el('div', 'section');
    card.appendChild(el('div', 'section-title', 'Проверьте анкету перед отправкой'));
    card.appendChild(el('div', 'section-note', 'Можно вернуться назад и исправить любой ответ — ничего не потеряется. Нажмите на раздел, чтобы перейти к нему.'));

    schema.sections.forEach((section, i) => {
      const head = el('button', 'review-section', `${i + 1}. ${section.title}`);
      head.type = 'button';
      head.onclick = () => goTo(i + 1);
      card.appendChild(head);
      (section.fields || []).forEach(f => {
        const formatted = formatAnswer(f);
        const item = el('div', 'review-item');
        item.appendChild(el('div', 'q', fieldLabel(f)));
        item.appendChild(el('div', 'a' + (formatted ? '' : ' empty'), formatted ? formatted.replace(/^\n/, '') : 'не заполнено'));
        card.appendChild(item);
      });
    });
    container.appendChild(card);

    const nav = el('div', 'nav-row');
    const back = el('button', 'btn secondary', 'Назад');
    back.type = 'button';
    back.onclick = () => goTo(step - 1);
    const submit = el('button', 'btn', 'Отправить доктору');
    submit.type = 'button';
    submit.id = 'submit-btn';
    submit.onclick = (e) => doSubmit(e.currentTarget);
    nav.appendChild(back);
    nav.appendChild(submit);
    container.appendChild(nav);
  }

  // ---------- отправка
  async function doSubmit(btn) {
    const missStep = firstMissingStep();
    if (missStep) { step = missStep; render(true); window.scrollTo(0, 0); return; }

    btn.disabled = true;
    btn.textContent = 'Отправляем…';
    answers.__ts = Date.now();
    lastText = buildReadableText();
    const payload = JSON.stringify({ formId: CFG.formId, answers, title: schema.title, text: lastText, fio: patientName() });

    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, attempt * 2000));
      try {
        const r = await fetchWithTimeout(CFG.apiBase + '/api/submit/' + draftId, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload
        }, 25000);
        if (r.ok) {
          const data = await r.json().catch(() => ({}));
          ok = data && data.ok === true;
        }
      } catch (e) { /* сеть / таймаут — пробуем ещё раз */ }
    }

    if (ok) {
      // на устройстве оставляем только отметку «отправлено» — ответы не хранятся на общем компьютере
      answers = { __submitted: true, __ts: Date.now() };
      dirty = false;
      lsSet(lsDraftKey(draftId), JSON.stringify(answers));
      renderDone(true);
    } else {
      renderSendError();
    }
  }

  function textFileName() {
    return 'Анкета_' + (patientName() || 'пациента').replace(/[^\p{L}\p{N}]+/gu, '_') + '.txt';
  }

  // «Поделиться» — на телефоне открывает выбор приложения (WhatsApp, Telegram, почта...) и прикладывает файл анкеты
  function canShareFile(text) {
    try {
      if (!navigator.share || !navigator.canShare || typeof File === 'undefined') return false;
      return navigator.canShare({ files: [new File([text], textFileName(), { type: 'text/plain' })] });
    } catch (e) { return false; }
  }

  async function shareText(text, btn) {
    try {
      const file = new File([text], textFileName(), { type: 'text/plain' });
      await navigator.share({ files: [file], title: 'Анкета для доктора' });
    } catch (e) {
      if (e && e.name === 'AbortError') return; // пациент сам закрыл окно выбора
      downloadText(text);                       // не получилось поделиться — хотя бы скачиваем файл
      btn.textContent = 'Файл скачан — отправьте его доктору';
    }
  }

  function downloadText(text) {
    const name = textFileName();
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  async function copyText(text, btn) {
    try { await navigator.clipboard.writeText(text); btn.textContent = 'Текст скопирован'; }
    catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); btn.textContent = 'Текст скопирован'; } catch (e2) { btn.textContent = 'Не удалось скопировать'; }
      ta.remove();
    }
  }

  function renderSendError() {
    root.innerHTML = '';
    renderTopbar();
    const container = el('div', 'container');
    const card = el('div', 'section error-card');
    card.appendChild(el('div', 'section-title', 'Не получилось отправить анкету'));
    card.appendChild(el('p', '', 'Похоже, пропала связь с сервером. Ваши ответы никуда не пропали — они сохранены на этом устройстве.'));
    card.appendChild(el('p', '', 'Попробуйте отправить ещё раз через минуту. Если не получается — ' + (canShareFile(lastText) ? 'нажмите «Поделиться» (или скачайте файл, или скопируйте текст)' : 'скачайте анкету файлом или скопируйте текст') + ' и отправьте анкету доктору в мессенджер.'));

    const btns = el('div', 'btn-col');
    const retry = el('button', 'btn', 'Попробовать ещё раз');
    retry.type = 'button';
    retry.onclick = () => doSubmit(retry);
    btns.appendChild(retry);

    if (canShareFile(lastText)) {
      const sh = el('button', 'btn', 'Поделиться: отправить файл в WhatsApp или другое приложение');
      sh.type = 'button';
      sh.onclick = () => shareText(lastText, sh);
      btns.appendChild(sh);
    }

    const dl = el('button', 'btn secondary', 'Скачать анкету файлом');
    dl.type = 'button';
    dl.onclick = () => downloadText(lastText);
    btns.appendChild(dl);

    const cp = el('button', 'btn secondary', 'Скопировать текст анкеты');
    cp.type = 'button';
    cp.onclick = () => copyText(lastText, cp);
    btns.appendChild(cp);

    if (CFG.doctorWhatsApp) {
      const wa = el('a', 'btn secondary', 'Написать доктору в WhatsApp');
      wa.href = 'https://wa.me/' + CFG.doctorWhatsApp;
      wa.target = '_blank';
      wa.rel = 'noopener';
      btns.appendChild(wa);
    }

    const back = el('button', 'btn ghost', 'Вернуться к анкете');
    back.type = 'button';
    back.onclick = () => { step = schema.sections.length + 1; render(); window.scrollTo(0, 0); };
    btns.appendChild(back);

    card.appendChild(btns);
    container.appendChild(card);
    root.appendChild(container);
    window.scrollTo(0, 0);
  }

  function renderDone(justSent) {
    root.innerHTML = '';
    const container = el('div', 'container');
    const box = el('div', 'final-screen');
    box.appendChild(el('h1', '', 'Спасибо! Анкета отправлена доктору.'));
    box.appendChild(el('p', '', 'Если нужно будет что-то уточнить, доктор свяжется с вами. Эту страницу можно закрыть.'));

    const btns = el('div', 'btn-col narrow');
    if (justSent && lastText) {
      const dl = el('button', 'btn secondary', 'Сохранить копию ответов себе');
      dl.type = 'button';
      dl.onclick = () => downloadText(lastText);
      btns.appendChild(dl);
    }
    const again = el('button', 'btn ghost', 'Заполнить анкету для другого человека');
    again.type = 'button';
    again.onclick = startNew;
    btns.appendChild(again);
    box.appendChild(btns);

    container.appendChild(box);
    root.appendChild(container);
    window.scrollTo(0, 0);
  }

  function startNew() {
    draftId = uuid();
    lsSet(LS_CURRENT, draftId);
    answers = {};
    dirty = false;
    lastText = '';
    window.history.replaceState({}, '', personalLink());
    step = 0;
    render();
    window.scrollTo(0, 0);
  }

  function renderFatal() {
    root.innerHTML = '';
    const container = el('div', 'container');
    const box = el('div', 'final-screen');
    box.appendChild(el('h1', '', 'Не удалось загрузить анкету'));
    box.appendChild(el('p', '', 'Проверьте подключение к интернету и обновите страницу. Если вы уже начинали заполнять — ответы сохранены и появятся после загрузки.'));
    const btn = el('button', 'btn', 'Обновить страницу');
    btn.type = 'button';
    btn.onclick = () => window.location.reload();
    box.appendChild(btn);
    container.appendChild(box);
    root.appendChild(container);
  }

  init();
})();
