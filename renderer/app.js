'use strict';

const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  settings: null,
  status: { active: false, profiles: {} },
  sel: null,
  view: 'dash', // 'dash' | 'profile'
  tab: 'feeds',
  logs: [],
  logFilter: 'all',
  info: {},
  update: null
};
const t = (key, vars) => I18N.t(state.settings ? state.settings.language : 'en', key, vars);

// ---- tiny DOM helper (never innerHTML: feed texts and file paths are untrusted) -----------------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (c) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  kids.forEach(add);
  return el;
}

const curProfile = () => state.settings.profiles.find((p) => p.id === state.sel) || null;
const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtDateTime = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'short', timeStyle: 'medium' });
const mmss = (ms) => {
  const sec = Math.max(0, Math.round(ms / 1000));
  const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60;
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
};

// ---- saving ---------------------------------------------------------------------------------------
let saveTimer = null;
function saveProfile(p, { rerenderIfChanged = true } = {}) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const before = JSON.stringify(p);
    const saved = await api.profiles.save(p);
    if (!saved) return;
    const i = state.settings.profiles.findIndex((x) => x.id === saved.id);
    if (i >= 0) state.settings.profiles[i] = saved;
    // the app corrected something (duplicate folder name, out-of-range number…): show the corrected values
    if (rerenderIfChanged && JSON.stringify(saved) !== before) renderMain();
    renderRail();
  }, 250);
}

async function patchSettings(patch) {
  state.settings = await api.settings.update(patch);
  return state.settings;
}

// ---- top bar, rail ------------------------------------------------------------------------------
function profileLed(p) {
  const st = state.status.profiles[p.id] || {};
  if (st.running) return 'run';
  if (!p.enabled) return '';
  const feeds = p.feeds.filter((f) => f.enabled);
  const res = feeds.map((f) => st.feeds?.[f.id]).filter(Boolean);
  if (!res.length) return '';
  const bad = res.filter((r) => !r.ok).length;
  return bad === 0 ? 'ok' : bad === res.length ? 'bad' : 'warn';
}

function dashLed() {
  const leds = state.settings.profiles.map(profileLed);
  return leds.includes('bad') ? 'bad' : leds.includes('warn') ? 'warn' : leds.includes('run') ? 'run' : leds.includes('ok') ? 'ok' : '';
}

function renderRail() {
  const ul = $('#profileList');
  const list = state.settings.profiles;
  $('#btnDash').classList.toggle('sel', state.view === 'dash');
  $('#dashLed').className = 'led ' + dashLed();
  ul.replaceChildren(
    ...list.map((p, i) => {
      const go = () => select(p.id);
      return h('li', {
          class: 'profile-item' + (state.view === 'profile' && p.id === state.sel ? ' sel' : ''), tabIndex: 0, role: 'button', draggable: true, 'data-id': p.id,
          onclick: go,
          onkeydown: (e) => {
            if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); moveProfile(p.id, e.key === 'ArrowUp' ? -1 : 1); return; }
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
          },
          ondragstart: (e) => { e.dataTransfer.setData('text/plain', p.id); e.dataTransfer.effectAllowed = 'move'; e.currentTarget.classList.add('dragging'); },
          ondragend: (e) => { e.currentTarget.classList.remove('dragging'); clearDropMarks(); },
          ondragover: (e) => { e.preventDefault(); clearDropMarks(); e.currentTarget.classList.add(dropBefore(e) ? 'drop-before' : 'drop-after'); },
          ondrop: (e) => { e.preventDefault(); const from = e.dataTransfer.getData('text/plain'); const before = dropBefore(e); clearDropMarks(); dropProfile(from, p.id, before); }
        },
        h('span', { class: 'led ' + profileLed(p) }),
        h('div', { class: 'pname' }, p.name, h('div', { class: 'psub' }, `${p.feeds.filter((f) => f.enabled).length}/${p.feeds.length} feeds · ${p.intervalMin} min`)),
        h('div', { class: 'mv' },
          h('button', { class: 'mvb', title: t('rail.up'), 'aria-label': t('rail.up'), disabled: i === 0, onclick: (e) => { e.stopPropagation(); moveProfile(p.id, -1); } }, '▲'),
          h('button', { class: 'mvb', title: t('rail.down'), 'aria-label': t('rail.down'), disabled: i === list.length - 1, onclick: (e) => { e.stopPropagation(); moveProfile(p.id, 1); } }, '▼')));
    })
  );
  renderTop();
}

const dropBefore = (e) => e.offsetY < e.currentTarget.clientHeight / 2;
const clearDropMarks = () => document.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));

// The order of this list is also the order of the dashboard; it is saved with the settings.
async function setOrder(ids) {
  const byId = new Map(state.settings.profiles.map((p) => [p.id, p]));
  state.settings.profiles = ids.map((id) => byId.get(id)).filter(Boolean);
  renderRail();
  if (state.view === 'dash') renderDashboard();
  await api.profiles.reorder(ids);
}
function moveProfile(id, delta) {
  const ids = state.settings.profiles.map((p) => p.id);
  const i = ids.indexOf(id), j = i + delta;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  setOrder(ids).then(() => { const el = document.querySelector(`.profile-item[data-id="${id}"]`); el?.focus(); });
}
function dropProfile(fromId, toId, before) {
  if (!fromId || fromId === toId) return;
  const ids = state.settings.profiles.map((p) => p.id).filter((x) => x !== fromId);
  const k = ids.indexOf(toId);
  if (k < 0) return;
  ids.splice(before ? k : k + 1, 0, fromId);
  setOrder(ids);
}
function sortProfilesAz() {
  const ids = [...state.settings.profiles].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })).map((p) => p.id);
  setOrder(ids);
}

function renderTop() {
  let ok = 0, bad = 0;
  for (const p of state.settings.profiles) {
    for (const f of p.feeds.filter((x) => x.enabled && p.enabled)) {
      const r = state.status.profiles[p.id]?.feeds?.[f.id];
      if (r) r.ok ? ok++ : bad++;
    }
  }
  const active = state.status.active;
  const box = $('#topStatus');
  box.replaceChildren(...[
    h('span', { class: 'led ' + (state.settings.profiles.length ? (active ? 'ok' : 'warn') : '') }),
    h('span', {}, state.settings.profiles.length ? (active ? t('top.running') : t('top.paused')) : t('top.noProfiles')),
    ok || bad ? h('span', { class: 'badge' }, t('top.feedsOk', { n: ok })) : null,
    bad ? h('span', { class: 'badge bad' }, t('top.feedsBad', { n: bad })) : null
  ].filter(Boolean));
  $('#btnPause').textContent = active ? t('top.pause') : t('top.resume');
}

function select(id) {
  state.sel = id;
  state.view = 'profile';
  renderRail();
  renderMain();
}

// ---- main panel ---------------------------------------------------------------------------------
function renderMain() {
  const main = $('#main');
  if (state.view === 'dash') return renderDashboard();
  const p = curProfile();
  if (!p) {
    main.replaceChildren(h('div', { class: 'empty' }, h('h2', { text: t('empty.title') }), h('p', { text: t('empty.text') }), h('button', { class: 'btn primary', onclick: openNewDialog, text: t('empty.create') })));
    return;
  }
  const change = () => saveProfile(p);
  const pathRow = (labelKey, field, { browse, open: canOpen, clear, hint }) => {
    const after = () => { change(); if (field === 'placeholderPath') setTimeout(() => loadPlaceholderPreview(p), 400); };
    const input = h('input', { type: 'text', value: p[field], placeholder: field === 'outputDir' ? t('p.outputPh') : '', spellcheck: false, onchange: (e) => { p[field] = e.target.value.trim(); after(); } });
    return [
      h('label', { text: t(labelKey) }),
      h('div', {},
        h('div', { class: 'pathbox' }, input,
          h('button', { class: 'btn', text: t('p.browse'), onclick: async () => { const v = await api.pick[browse](); if (v) { p[field] = v; input.value = v; after(); } } }),
          canOpen ? h('button', { class: 'btn', text: t('p.open'), onclick: async () => { const r = await api.profiles.openOutput(p.id); if (r !== 'ok') alert(r === 'no-folder' ? t('p.noOutput') : t('err.openFolder')); } }) : null,
          clear ? h('button', { class: 'btn', text: t('p.clear'), onclick: () => { p[field] = ''; input.value = ''; after(); } }) : null),
        hint ? h('div', { class: 'hint', text: hint }) : null)
    ];
  };

  main.replaceChildren(
    h('div', { class: 'phead' },
      h('div', {},
        h('input', { class: 'pname-input', type: 'text', value: p.name, maxLength: 60, 'aria-label': 'Profile name', onchange: (e) => { p.name = e.target.value.trim() || p.name; change(); } }),
        h('div', { class: 'next', id: 'nextRun' })),
      h('div', { class: 'pactions' },
        h('button', { class: 'btn primary', id: 'btnRun', text: t('p.runNow'), onclick: () => api.profiles.runNow(p.id) }),
        h('button', { class: 'btn danger', text: t('p.delete'), onclick: async () => { if (await confirmDlg(t('p.deleteTitle'), t('p.deleteText'), t('common.delete'))) { await api.profiles.remove(p.id); state.settings.profiles = state.settings.profiles.filter((x) => x.id !== p.id); state.sel = state.settings.profiles[0]?.id || null; state.view = 'dash'; renderRail(); renderMain(); } } }))),
    h('div', { class: 'prow' },
      h('label', { text: t('p.enabled') }),
      h('div', { class: 'check' }, h('input', { type: 'checkbox', checked: p.enabled, onchange: (e) => { p.enabled = e.target.checked; change(); } }),
        h('span', { text: t('p.interval') }), h('input', { type: 'number', min: 1, max: 1440, value: p.intervalMin, onchange: (e) => { p.intervalMin = Number(e.target.value); change(); } }), h('span', { text: t('p.minutes') })),
      h('span', {}), h('div', { class: 'hint', text: t('p.intervalHint') }),
      ...pathRow('p.output', 'outputDir', { browse: 'folder', open: true }),
      ...pathRow('p.placeholder', 'placeholderPath', { browse: 'image', clear: true, hint: t('p.placeholderHint') }),
      h('span', {}), h('div', { class: 'phprev' }, h('span', { class: 'hint', text: t('p.phPreview') }), h('img', { id: 'phThumb', alt: '', width: 240, height: 135, hidden: true }))),
    h('div', { class: 'tabs', role: 'tablist' }, ...['feeds', 'options', 'format', 'log'].map((k) => h('button', { class: 'tab' + (state.tab === k ? ' sel' : ''), role: 'tab', text: t('tab.' + k), onclick: () => { state.tab = k; renderMain(); } }))),
    state.tab === 'feeds' ? feedsTab(p, change) : state.tab === 'options' ? optionsTab(p, change) : state.tab === 'format' ? formatTab(p, change) : logTab()
  );
  refreshDynamic();
  loadPlaceholderPreview(p);
}

async function loadPlaceholderPreview(p) {
  const img = $('#phThumb');
  if (!img) return;
  const url = await api.placeholderPreview(p.placeholderPath);
  if (url && $('#phThumb') === img) { img.src = url; img.hidden = false; }
}

// ---- feeds tab ----------------------------------------------------------------------------------
function feedsTab(p, change) {
  const nameOf = (id) => p.feeds.find((x) => x.id === id)?.folder || '?';
  const rows = p.feeds.map((f) => {
    const merge = f.type === 'merge';
    return h('tr', {},
      h('td', {}, h('input', { type: 'checkbox', checked: f.enabled, 'aria-label': t('f.on'), onchange: (e) => { f.enabled = e.target.checked; change(); } })),
      h('td', {}, h('input', { type: 'text', value: f.folder, maxLength: 100, 'aria-label': t('f.folder'), onchange: (e) => { f.folder = e.target.value; change(); } })),
      h('td', { class: 'url' }, merge
        ? h('span', { class: 'hint', text: f.sources.length ? t('f.mergeOf', { names: f.sources.map(nameOf).join(', ') }) : t('f.mergeNone') })
        : h('input', { type: 'url', value: f.url, spellcheck: false, placeholder: 'https://…', 'aria-label': t('f.url'), onchange: (e) => { f.url = e.target.value.trim(); change(); } })),
      h('td', {}, h('input', { type: 'number', min: 1, max: 100, value: f.maxItems, 'aria-label': t('f.max'), onchange: (e) => { f.maxItems = Number(e.target.value); change(); } })),
      h('td', {}, merge ? null : h('input', { type: 'number', min: 0, max: 1440, value: f.intervalMin || '', placeholder: String(p.intervalMin), title: t('f.everyHint'), 'aria-label': t('f.every'), onchange: (e) => { f.intervalMin = Number(e.target.value) || 0; change(); } })),
      h('td', {}, merge ? null : h('input', { type: 'checkbox', checked: f.insecureTls, 'aria-label': t('f.tls'), title: t('f.tlsHint'), onchange: (e) => { f.insecureTls = e.target.checked; change(); } })),
      h('td', { class: 'st', 'data-feed': f.id }),
      h('td', {}, h('div', { class: 'row-actions' },
        h('button', { class: 'btn small', text: t('f.options'), onclick: () => openFeedDialog(p, f, change) }),
        h('button', { class: 'btn small', text: t('f.test'), onclick: () => testFeed(f, p) }),
        h('button', { class: 'btn small', text: '×', title: t('f.remove'), 'aria-label': t('f.remove'), onclick: () => { p.feeds = p.feeds.filter((x) => x.id !== f.id); for (const m of p.feeds) m.sources = (m.sources || []).filter((sid) => sid !== f.id); change(); renderMain(); } })))
    );
  });
  const addFeed = (type) => { p.feeds.push({ id: crypto.randomUUID(), type, folder: type === 'merge' ? 'Latest' : `Feed${p.feeds.length + 1}`, url: '', sources: type === 'merge' ? p.feeds.filter((x) => x.type === 'feed').map((x) => x.id) : [], maxItems: type === 'merge' ? 15 : 10, intervalMin: 0, staleHours: 0, filters: { include: [], exclude: [], scope: 'both', sort: 'feed', dedupe: false }, enabled: true, insecureTls: false }); change(); renderMain(); };
  return h('div', {},
    p.feeds.length
      ? h('table', { class: 'feeds' },
          h('thead', {}, h('tr', {}, ...['f.on', 'f.folder', 'f.url', 'f.max', 'f.every', 'f.tls', 'f.status', ''].map((k) => h('th', { text: k ? t(k) : '', title: k === 'f.tls' ? t('f.tlsHint') : k === 'f.every' ? t('f.everyHint') : undefined })))),
          h('tbody', {}, rows))
      : h('p', { class: 'hint', text: t('f.none') }),
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn', text: t('f.add'), onclick: () => addFeed('feed') }),
      h('button', { class: 'btn', text: t('f.addMerge'), onclick: () => addFeed('merge') })),
    h('p', { class: 'hint', text: t('f.duplicate') }),
    h('div', { class: 'alert-line warn-line', text: t('f.legal') })
  );
}

// ---- feed options (filters, order, merge sources, alert) ----------------------------------------------
const splitWords = (v) => v.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);

function openFeedDialog(p, f, change) {
  $('#feedTitle').textContent = `${t('fo.title')} — ${f.folder}`;
  const fl = f.filters;
  const merge = f.type === 'merge';
  const words = (key) => h('textarea', { rows: 3, spellcheck: false, value: fl[key].join('\n'), onchange: (e) => { fl[key] = splitWords(e.target.value); change(); } });
  const sel = (get, set, opts) => h('select', { onchange: (e) => { set(e.target.value); change(); } }, opts.map(([v, k]) => h('option', { value: v, selected: get() === v, text: t(k) })));
  const rowsDom = [];
  if (merge) {
    rowsDom.push(h('div', { class: 'sec' }, h('h3', { text: t('fo.sources') }), h('p', { class: 'hint', text: t('fo.sourcesHint') }),
      ...p.feeds.filter((x) => x.type === 'feed').map((x) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.sources.includes(x.id), onchange: (e) => { f.sources = e.target.checked ? [...f.sources, x.id] : f.sources.filter((sid) => sid !== x.id); change(); } }), h('span', { text: x.folder })))));
  }
  rowsDom.push(h('div', { class: 'sec' }, h('h3', { text: t('fo.filters') }), h('p', { class: 'hint', text: t('fo.words') }),
    h('div', { class: 'form' },
      h('label', { text: t('fo.include') }), words('include'),
      h('label', { text: t('fo.exclude') }), words('exclude'),
      h('label', { text: t('fo.scope') }), sel(() => fl.scope, (v) => { fl.scope = v; }, [['both', 'fo.scopeBoth'], ['title', 'fo.scopeTitle']]),
      merge ? null : h('label', { text: t('fo.sort') }), merge ? null : sel(() => fl.sort, (v) => { fl.sort = v; }, [['feed', 'fo.sortFeed'], ['newest', 'fo.sortNewest']]),
      merge ? null : h('span', {}), merge ? null : h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: fl.dedupe, onchange: (e) => { fl.dedupe = e.target.checked; change(); } }), h('span', { text: t('fo.dedupe') })))));
  rowsDom.push(h('div', { class: 'sec' }, h('h3', { text: t('o.checks') }),
    h('div', { class: 'check' }, h('span', { text: t('fo.stale') }), h('input', { type: 'number', min: 0, max: 720, value: f.staleHours || '', placeholder: String(p.staleHours), onchange: (e) => { f.staleHours = Number(e.target.value) || 0; change(); } }), h('span', { class: 'hint', text: t('fo.staleHint') }))));
  $('#feedBody').replaceChildren(...rowsDom);
  const dlg = $('#dlgFeed');
  dlg.onclose = () => { dlg.onclose = null; renderMain(); };
  dlg.showModal();
}

// ---- preview ("as it would be written") ---------------------------------------------------------------
async function testFeed(f, p, raw = false) {
  const body = $('#testBody');
  body.replaceChildren(h('p', { text: t('test.loading') }));
  $('#dlgTest').showModal();
  const r = await api.feed.test(f, p.id, raw);
  if (!r.ok) return body.replaceChildren(h('p', { class: 'badge bad', text: t('test.failed', { e: r.error }) }));
  body.replaceChildren(
    f.type === 'merge' ? null : h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: raw, onchange: (e) => testFeed(f, p, e.target.checked) }), h('span', { text: t('test.raw') })),
    h('p', { class: 'hint', text: raw ? t('test.rawSummary', { total: r.total, m: r.items.length }) : t('test.summary', { sel: r.selected, total: r.total, removed: r.removed }) }),
    h('div', { class: 'tgrid' }, r.items.map((it) =>
      h('div', { class: 'tcard' },
        h('div', { class: 'thumb' }, it.thumb ? h('img', { src: it.thumb, alt: '' }) : t('test.noImage')),
        h('div', { class: 'tb' },
          h('div', { class: 'tfile', text: `${it.n}  ·  ${it.imageFile}` }),
          h('div', { class: 'tt', text: it.titleLine }), h('div', { class: 'td', text: it.descLine }),
          it.date ? h('div', { class: 'tdate', text: fmtDateTime(it.date) }) : null,
          it.hasImage ? null : h('span', { class: 'badge', text: it.imageFailed ? t('test.imgFailed') : t('test.noImage') })))))
  );
}

// ---- schedule & options tab ---------------------------------------------------------------------------
function optionsTab(p, change) {
  const sch = p.schedule;
  const timeInput = (w, key) => h('input', { type: 'text', value: w[key], maxLength: 5, size: 5, placeholder: 'HH:MM', 'aria-label': t(key === 'from' ? 'o.from' : 'o.to'), onchange: (e) => { w[key] = e.target.value.trim(); change(); } });
  const windowRow = (w, i) => h('div', { class: 'wrow' },
    h('div', { class: 'days' }, [1, 2, 3, 4, 5, 6, 0].map((d) => h('label', { class: 'day' }, h('input', { type: 'checkbox', checked: w.days.includes(d), onchange: (e) => { w.days = e.target.checked ? [...w.days, d] : w.days.filter((x) => x !== d); change(); } }), h('span', { text: t('o.d' + d) })))),
    h('span', { text: t('o.from') }), timeInput(w, 'from'), h('span', { text: t('o.to') }), timeInput(w, 'to'),
    h('span', { text: t('o.every') }), h('input', { type: 'number', min: 0, max: 1440, value: w.intervalMin || '', placeholder: String(p.intervalMin), onchange: (e) => { w.intervalMin = Number(e.target.value) || 0; change(); } }),
    h('button', { class: 'btn small', text: '×', title: t('o.remove'), 'aria-label': t('o.remove'), onclick: () => { sch.windows.splice(i, 1); change(); renderMain(); } }));
  return h('div', { class: 'opts' },
    h('div', { class: 'sec' }, h('h3', { text: t('o.windows') }),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: sch.enabled, onchange: (e) => { sch.enabled = e.target.checked; if (sch.enabled && !sch.windows.length) sch.windows.push({ days: [0, 1, 2, 3, 4, 5, 6], from: '06:00', to: '24:00', intervalMin: 0 }); change(); renderMain(); } }), h('span', { text: t('o.windowsOn') })),
      h('p', { class: 'hint', text: t('o.windowsHint') }),
      sch.enabled ? [...sch.windows.map(windowRow), sch.windows.length ? null : h('p', { class: 'hint', text: t('o.noWindows') }), h('button', { class: 'btn small', text: t('o.addWindow'), onclick: () => { sch.windows.push({ days: [0, 1, 2, 3, 4, 5, 6], from: '06:00', to: '24:00', intervalMin: 0 }); change(); renderMain(); } })] : null),
    h('div', { class: 'sec' }, h('h3', { text: t('o.checks') }),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: p.verifyOutput, onchange: (e) => { p.verifyOutput = e.target.checked; change(); } }), h('span', { text: t('o.verify') })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: p.dedupeAcrossFeeds, onchange: (e) => { p.dedupeAcrossFeeds = e.target.checked; change(); } }), h('span', { text: t('o.dedupeAcross') })),
      h('div', { class: 'check' }, h('span', { text: t('o.stale') }), h('input', { type: 'number', min: 0, max: 720, value: p.staleHours, onchange: (e) => { p.staleHours = Number(e.target.value) || 0; change(); } }), h('span', { text: t('o.hours') })),
      h('p', { class: 'hint', text: t('o.staleHint') })));
}

// ---- format tab ---------------------------------------------------------------------------------
const FORMAT_DEFAULTS = { encoding: 'utf8', lineEnding: 'lf', trailingNewline: false, emptyValue: '-', maxTitleChars: 0, maxDescChars: 0, titleFile: '{folder}_Title.Txt', descFile: '{folder}_Description.Txt', imageDir: '{folder}', imageStart: 1, imagePad: 5, imageExt: 'JPG', jpegQuality: 85, modernImages: true, resize: 'none', width: 0, height: 0, metadataFile: true };

function formatTab(p, change) {
  const f = p.format;
  const text = (k, w) => h('input', { type: 'text', value: f[k], style: undefined, class: w || '', spellcheck: false, onchange: (e) => { f[k] = e.target.value; change(); updateTree(); } });
  const num = (k, min, max) => h('input', { type: 'number', min, max, value: f[k], onchange: (e) => { f[k] = Number(e.target.value); change(); updateTree(); } });
  const sel = (k, opts) => h('select', { onchange: (e) => { f[k] = e.target.value; change(); renderMain(); } }, opts.map(([v, label]) => h('option', { value: v, selected: f[k] === v, text: t(label) })));
  const chk = (k, label) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f[k], onchange: (e) => { f[k] = e.target.checked; change(); updateTree(); } }), h('span', { text: t(label) }));
  const tree = h('div', { class: 'tree', id: 'tree' });
  function updateTree() {
    const folder = p.feeds[0]?.folder || 'News';
    const n = (s) => String(s).replaceAll('{folder}', folder);
    const img = (i) => `${String(f.imageStart + i).padStart(f.imagePad, '0')}.${f.imageExt}`;
    tree.textContent = [`${p.outputDir || '<' + t('p.output') + '>'}`, `├─ ${n(f.imageDir)}/`, `│   ├─ ${img(0)}`, `│   ├─ ${img(1)}`, `│   └─ …`, `├─ ${n(f.titleFile)}`, `├─ ${n(f.descFile)}`, f.metadataFile ? `└─ ${folder}_metadata.json` : ''].filter(Boolean).join('\n');
  }
  const wrap = h('div', {},
    h('div', { class: 'callout', text: t('fmt.intro') }),
    h('div', { class: 'form' },
      h('label', { text: t('fmt.encoding') }), sel('encoding', [['utf8', 'fmt.utf8'], ['utf8-bom', 'fmt.utf8bom'], ['windows-1252', 'fmt.win1252']]),
      h('label', { text: t('fmt.lineEnding') }), h('div', { class: 'inline' }, sel('lineEnding', [['lf', 'fmt.lf'], ['crlf', 'fmt.crlf']]), chk('trailingNewline', 'fmt.trailing')),
      h('label', { text: t('fmt.empty') }), text('emptyValue'),
      h('label', { text: t('fmt.maxTitle') }), h('div', { class: 'inline' }, num('maxTitleChars', 0, 2000), h('span', { class: 'hint', text: t('fmt.chars') })),
      h('label', { text: t('fmt.maxDesc') }), h('div', { class: 'inline' }, num('maxDescChars', 0, 5000), h('span', { class: 'hint', text: t('fmt.chars') })),
      h('label', { text: t('fmt.titleFile') }), h('div', {}, text('titleFile'), h('div', { class: 'hint', text: t('fmt.tplHint') })),
      h('label', { text: t('fmt.descFile') }), text('descFile'),
      h('label', { text: t('fmt.imageDir') }), text('imageDir'),
      h('label', { text: t('fmt.imgStart') }), num('imageStart', 0, 99999),
      h('label', { text: t('fmt.imgPad') }), num('imagePad', 1, 8),
      h('label', { text: t('fmt.imgExt') }), text('imageExt'),
      h('label', { text: t('fmt.quality') }), num('jpegQuality', 30, 100),
      h('label', { text: t('fmt.resize') }), h('div', { class: 'inline' }, sel('resize', [['none', 'fmt.rNone'], ['cover', 'fmt.rCover'], ['contain', 'fmt.rContain']]),
        f.resize !== 'none' ? [h('span', { text: t('fmt.width') }), num('width', 0, 8000), h('span', { text: t('fmt.height') }), num('height', 0, 8000)] : null),
      h('span', {}), chk('metadataFile', 'fmt.meta'),
      h('span', {}), chk('modernImages', 'fmt.modern')),
    h('div', { class: 'hint', text: t('fmt.preview') }), tree,
    h('div', { class: 'toolbar' }, h('button', { class: 'btn', text: t('fmt.reset'), onclick: () => { p.format = { ...FORMAT_DEFAULTS }; change(); renderMain(); } }))
  );
  updateTree();
  return wrap;
}

// ---- log tab ------------------------------------------------------------------------------------
function logLine(e) {
  return h('div', { class: `l ${e.level}` }, h('span', { class: 'ts', text: fmtTime(e.t) + '  ' }), e.message);
}
function logTab() {
  const box = h('div', { class: 'log', id: 'logBox' });
  const fill = () => {
    const allowed = state.logFilter === 'all' ? null : state.logFilter === 'warn' ? ['warn', 'error'] : ['error'];
    const list = state.logs.filter((e) => !allowed || allowed.includes(e.level));
    box.replaceChildren(...(list.length ? list.map(logLine) : [h('div', { class: 'hint', text: t('log.empty') })]));
    box.scrollTop = box.scrollHeight;
  };
  setTimeout(fill);
  return h('div', {},
    h('div', { class: 'toolbar' },
      h('select', { onchange: (e) => { state.logFilter = e.target.value; fill(); } }, [['all', 'log.all'], ['warn', 'log.warn'], ['error', 'log.error']].map(([v, k]) => h('option', { value: v, selected: state.logFilter === v, text: t(k) }))),
      h('button', { class: 'btn', text: t('log.openFolder'), onclick: () => api.logs.openFolder() })),
    box);
}

// ---- live status (feed cells, countdown) -----------------------------------------------------------
const staleOf = (p, f, r) => { const hrs = (f && f.staleHours) || (p && p.staleHours) || 0; return hrs && r?.ok && r.changedAt && Date.now() - r.changedAt > hrs * 3_600_000 ? Math.floor((Date.now() - r.changedAt) / 3_600_000) : 0; };

function feedStatusNodes(r, feed, p) {
  if (!r) return [h('span', { class: 'time', text: feed && feed.type !== 'merge' && !feed.url ? t('f.noUrl') : t('f.never') })];
  if (!r.ok) return [h('span', { class: 'led bad' }), ' ', h('span', { class: 'bad-text', text: r.error }), ' ', h('span', { class: 'time', text: fmtDateTime(r.at) })];
  const text = (r.unchanged ? t('f.unchanged', { items: r.items }) : t('f.stat', { items: r.items, img: r.imagesOriginal, ph: r.placeholders })) + (r.filteredOut ? ` · ${t('f.leftOut', { n: r.filteredOut })}` : '');
  const quiet = staleOf(p, feed, r);
  return [h('span', { class: 'led ' + (quiet ? 'warn' : 'ok') }), ' ', text, ' ', h('span', { class: 'time', text: fmtDateTime(r.at) }), ...(quiet ? [h('div', {}, h('span', { class: 'badge bad', text: t('f.staleBadge', { h: quiet }) }))] : [])];
}

function refreshDynamic() {
  renderRail();
  if (state.view === 'dash') return renderDashboard();
  const p = curProfile();
  if (!p) return;
  const st = state.status.profiles[p.id] || {};
  for (const td of document.querySelectorAll('td.st')) {
    const id = td.getAttribute('data-feed');
    td.replaceChildren(...feedStatusNodes(st.feeds?.[id], p.feeds.find((f) => f.id === id), p));
  }
  tickCountdown();
  const run = $('#btnRun');
  if (run) run.disabled = !!st.running;
}

function nextText(st) {
  return st?.running ? t('p.running') : st?.nextRunAt ? t('p.nextIn', { t: mmss(st.nextRunAt - Date.now()) }) : t('p.notScheduled');
}

function tickCountdown() {
  for (const el of document.querySelectorAll('[data-next]')) el.textContent = nextText(state.status.profiles[el.getAttribute('data-next')]);
  for (const el of document.querySelectorAll('[data-until]')) {
    const ms = Number(el.getAttribute('data-until')) - Date.now();
    el.textContent = ms > 0 ? mmss(ms) : t('dash.now');
  }
  const clock = $('#dashClock');
  if (clock) clock.textContent = new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' });
  const p = curProfile();
  const el = $('#nextRun');
  if (el && p) el.textContent = nextText(state.status.profiles[p.id]);
}
setInterval(tickCountdown, 1000);

// ---- dashboard ---------------------------------------------------------------------------------------
// The profile wakes up as often as its most frequent feed needs (same rule as the scheduler in the main process).
const tickMs = (p) => Math.min(p.intervalMin, ...p.feeds.filter((f) => f.enabled && f.intervalMin > 0).map((f) => f.intervalMin)) * 60_000;

// What will be checked, and when, in time order. A feed is due `every` after its last check; it is then
// checked at the first wake-up of its profile that is not earlier than that.
function upcomingChecks() {
  const out = [];
  const active = state.status.active;
  for (const p of state.settings.profiles) {
    if (!p.enabled) continue;
    const st = state.status.profiles[p.id] || {};
    const tick = tickMs(p);
    for (const f of p.feeds.filter((x) => x.enabled)) {
      const r = st.feeds?.[f.id];
      let when = null;
      if (st.running) when = 'running';
      else if (active && st.nextRunAt) {
        const due = r ? r.at + (f.intervalMin || p.intervalMin) * 60_000 - 5000 : 0;
        when = st.nextRunAt;
        while (when < due) when += tick;
      }
      out.push({ p, f, when });
    }
  }
  return out.sort((a, b) => (typeof a.when === 'number' ? a.when : Infinity) - (typeof b.when === 'number' ? b.when : Infinity));
}

function renderDashboard() {
  const main = $('#main');
  const profiles = state.settings.profiles;
  if (!profiles.length) {
    main.replaceChildren(h('div', { class: 'empty' }, h('h2', { text: t('empty.title') }), h('p', { text: t('empty.text') }), h('button', { class: 'btn primary', onclick: openNewDialog, text: t('empty.create') })));
    return;
  }
  let ok = 0, bad = 0, lastChange = 0;
  for (const p of profiles) {
    if (!p.enabled) continue;
    for (const f of p.feeds.filter((x) => x.enabled)) {
      const r = state.status.profiles[p.id]?.feeds?.[f.id];
      if (!r) continue;
      r.ok ? ok++ : bad++;
      if (r.changedAt) lastChange = Math.max(lastChange, r.changedAt);
    }
  }
  const up = upcomingChecks();
  const first = up.find((u) => typeof u.when === 'number');
  const tile = (label, value, cls, extra) => h('div', { class: 'tile ' + (cls || '') }, h('div', { class: 'tile-label', text: label }), h('div', { class: 'tile-value' }, value), extra || null);

  const card = (p) => {
    const st = state.status.profiles[p.id] || { feeds: {} };
    const dirDown = Object.values(st.feeds || {}).some((r) => r.code === 'output-missing');
    const rows = p.feeds.filter((f) => f.enabled).map((f) => {
      const r = st.feeds?.[f.id];
      return h('tr', {},
        h('td', {}, h('span', { class: 'led ' + (!r ? '' : r.ok ? 'ok' : 'bad') }), ' ', f.folder),
        h('td', { class: 'st' }, ...(r ? (r.ok ? [(r.unchanged ? t('f.unchanged', { items: r.items }) : t('f.stat', { items: r.items, img: r.imagesOriginal, ph: r.placeholders })) + (r.filteredOut ? ` · ${t('f.leftOut', { n: r.filteredOut })}` : ''), staleOf(p, f, r) ? h('span', { class: 'badge bad', text: t('f.staleBadge', { h: staleOf(p, f, r) }) }) : null] : [h('span', { class: 'bad-text', text: r.error })]) : [h('span', { class: 'time', text: t('dash.pending') })])),
        h('td', { class: 'time', text: r ? fmtDateTime(r.at) : '—' }),
        h('td', { class: 'time', text: r?.changedAt ? fmtDateTime(r.changedAt) : '—' }));
    });
    return h('section', { class: 'dcard' },
      h('div', { class: 'dcard-head' },
        h('span', { class: 'led ' + profileLed(p) }),
        h('h3', { text: p.name }), p.enabled ? null : h('span', { class: 'badge', text: t('dash.disabled') }),
        h('span', { class: 'next', 'data-next': p.id }),
        h('div', { class: 'dcard-actions' },
          h('button', { class: 'btn small', text: t('p.runNow'), disabled: !!st.running, onclick: () => api.profiles.runNow(p.id) }),
          h('button', { class: 'btn small', text: t('p.open'), onclick: () => api.profiles.openOutput(p.id) }),
          h('button', { class: 'btn small', text: t('dash.edit'), onclick: () => select(p.id) }))),
      h('div', { class: 'path', text: p.outputDir || t('p.outputPh') }),
      dirDown ? h('div', { class: 'alert-line', text: t('dash.dirMissing') }) : null,
      rows.length
        ? h('table', { class: 'feeds dtable' }, h('thead', {}, h('tr', {}, ...['dash.feed', 'dash.status', 'dash.checked', 'dash.updated'].map((k) => h('th', { text: t(k) })))), h('tbody', {}, rows))
        : h('p', { class: 'hint', text: t('dash.noFeeds') }));
  };

  const whenCells = (u) => {
    if (u.when === 'running') return [h('td', { class: 'time', text: '—' }), h('td', { text: t('dash.runningNow') })];
    if (u.when === null) return [h('td', { class: 'time', text: '—' }), h('td', { text: t('dash.pausedShort') })];
    return [h('td', { class: 'time', text: fmtDateTime(u.when) }), h('td', { class: 'time', 'data-until': String(u.when) })];
  };
  const problems = state.logs.filter((e) => e.level !== 'info').slice(-10).reverse();
  main.replaceChildren(
    h('div', { class: 'tiles' },
      tile(t('dash.now'), h('span', { id: 'dashClock', class: 'clock' })),
      tile(t('dash.schedules'), h('span', {}, h('span', { class: 'led ' + (state.status.active ? 'ok' : 'warn') }), ' ', state.status.active ? t('top.running') : t('top.paused')), '', h('button', { class: 'btn small', text: state.status.active ? t('top.pause') : t('top.resume'), onclick: async () => { state.status = await api.scheduler.setPaused(state.status.active); refreshDynamic(); } })),
      tile(t('dash.feedsOk'), String(ok), ok ? 'good' : ''),
      tile(t('dash.problems'), String(bad), bad ? 'bad' : ''),
      tile(t('dash.nextCheck'), first ? h('span', { 'data-until': String(first.when) }) : '—', '', first ? h('div', { class: 'tile-sub', text: t('dash.nextWhat', { p: first.p.name, f: first.f.folder }) }) : null),
      tile(t('dash.lastChange'), lastChange ? fmtDateTime(lastChange) : t('dash.notYet'), 'small')),
    h('section', { class: 'dcard' },
      h('div', { class: 'dcard-head' }, h('h3', { text: t('dash.upcoming') })),
      up.length
        ? h('div', { class: 'scroll' }, h('table', { class: 'feeds dtable' },
            h('thead', {}, h('tr', {}, ...['dash.when', 'dash.in', 'dash.profile', 'dash.feed'].map((k) => h('th', { text: t(k) })))),
            h('tbody', {}, up.map((u) => h('tr', {}, ...whenCells(u), h('td', { text: u.p.name }), h('td', { text: u.f.folder }))))))
        : h('p', { class: 'hint', text: t('dash.nothingScheduled') })),
    h('div', { class: 'dgrid' }, profiles.map(card)),
    h('section', { class: 'dcard' },
      h('div', { class: 'dcard-head' }, h('h3', { text: t('dash.recent') })),
      problems.length ? h('div', { class: 'log short' }, problems.map(logLine)) : h('p', { class: 'hint', text: t('dash.noProblems') })));
  tickCountdown();
}

// ---- dialogs ------------------------------------------------------------------------------------
function confirmDlg(title, text, okLabel) {
  return new Promise((resolve) => {
    const dlg = $('#dlgConfirm');
    $('#confirmTitle').textContent = title;
    $('#confirmText').textContent = text;
    const ok = $('#confirmOk');
    ok.textContent = okLabel;
    const done = (v) => { dlg.close(); ok.onclick = null; dlg.onclose = null; resolve(v); };
    ok.onclick = () => done(true);
    dlg.onclose = () => resolve(false);
    dlg.showModal();
  });
}

function openNewDialog() {
  $('#newName').value = state.settings.profiles.length ? '' : t('new.defaultName');
  $('#dlgNew').showModal();
  $('#newName').focus();
}

function renderHelp() {
  const lang = state.settings.language;
  const blocks = HELP[lang] || HELP.en;
  const table = (tb) => h('table', {}, h('thead', {}, h('tr', {}, tb.head.map((c) => h('th', { text: c })))), h('tbody', {}, tb.rows.map((r) => h('tr', {}, r.map((c) => h('td', {}, c))))));
  $('#helpBody').replaceChildren(...blocks.flatMap((b) => [h('h3', { text: b.h }), ...(b.p || []).map((x) => h('p', { text: x })), b.ul ? h('ul', {}, b.ul.map((x) => h('li', { text: x }))) : null, b.table ? table(b.table) : null, ...(b.after || []).map((x) => h('p', { text: x }))].filter(Boolean)));
}

function renderSettings() {
  const s = state.settings;
  const g = s.general;
  const n = s.notifications;
  const tg = n.telegram;
  const em = n.email;
  const dg = n.digest;
  const gen = (key, label) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: g[key], onchange: async (e) => { await patchSettings({ general: { [key]: e.target.checked } }); } }), h('span', { text: t(label) }));
  const msgBox = h('div', { class: 'hint', id: 'setMsg' });
  // Email and Telegram: same fields, labels and behaviour as the other OnAir Garage apps (Dead Air Watchdog)
  const mail = (patch) => patchSettings({ notifications: { email: patch } });
  const field = (labelKey, control) => h('label', { class: 'field' }, h('span', { text: t(labelKey) }), control);
  const mRes = h('span', { class: 'testres', role: 'status' });
  const tRes = h('span', { class: 'testres', role: 'status' });
  const mHost = h('input', { type: 'text', value: em.host, placeholder: 'smtp.example.org', spellcheck: false, onchange: (e) => mail({ host: e.target.value }) });
  const mPort = h('input', { type: 'number', min: 1, max: 65535, value: em.port, class: 'num', onchange: (e) => mail({ port: Number(e.target.value) || 587 }) });
  const mUser = h('input', { type: 'text', value: em.user, spellcheck: false, autocomplete: 'off', onchange: (e) => mail({ user: e.target.value }) });
  const mPass = h('input', { type: 'password', value: em.pass, autocomplete: 'new-password', onchange: (e) => mail({ pass: e.target.value }) });
  const mFrom = h('input', { type: 'text', value: em.from, placeholder: 'alerts@example.org', spellcheck: false, onchange: (e) => mail({ from: e.target.value }) });
  const mTo = h('input', { type: 'text', id: 'mTo', value: em.recipients.join(', '), placeholder: 'engineer@example.org', spellcheck: false, onchange: () => saveEmailRecipients() });
  const mSecure = h('input', { type: 'checkbox', checked: em.secure, onchange: (e) => mail({ secure: e.target.checked }) });
  const typedAddresses = () => mTo.value.split(/[\s,;]+/).filter(Boolean);
  const saveEmailRecipients = async () => {
    const typed = typedAddresses();
    const next = await mail({ recipients: typed });
    mTo.value = next.notifications.email.recipients.join(', '); // show what was kept
    if (next.notifications.email.recipients.length < new Set(typed.map((x) => x.toLowerCase())).size) { mRes.className = 'testres is-fail'; mRes.textContent = t('s.emailDropped'); }
  };
  const tToken = h('input', { type: 'password', value: tg.botToken, spellcheck: false, autocomplete: 'new-password', placeholder: '123456789:AA...', onchange: (e) => patchSettings({ notifications: { telegram: { botToken: e.target.value.trim() } } }) });
  const tRecipients = h('div', { id: 'tRecipients' });
  const readRecipients = () => [...tRecipients.querySelectorAll('.rec')].map((row) => { const [c, n2] = row.querySelectorAll('input'); return { chatId: c.value.trim(), note: n2.value.trim() }; }).filter((r) => r.chatId);
  const saveRecipients = () => patchSettings({ notifications: { telegram: { recipients: readRecipients() } } });
  const addRecipientRow = (r = { chatId: '', note: '' }) => {
    const row = h('div', { class: 'rec' },
      h('input', { type: 'text', value: r.chatId, placeholder: t('set.tg.chat'), 'aria-label': t('set.tg.chat'), spellcheck: false, onchange: saveRecipients }),
      h('input', { type: 'text', value: r.note || '', placeholder: t('set.tg.note'), 'aria-label': t('set.tg.note'), onchange: saveRecipients }),
      h('button', { type: 'button', class: 'btn small', text: t('set.tg.remove'), onclick: () => { row.remove(); saveRecipients(); } }));
    tRecipients.append(row);
  };
  tg.recipients.forEach(addRecipientRow);
  const runTest = async (out, fn) => {
    out.className = 'testres';
    out.textContent = t('set.test.sending');
    const r = await fn();
    out.textContent = r.ok ? t('set.test.ok') : t('set.test.fail', { error: r.error });
    out.classList.add(r.ok ? 'is-ok' : 'is-fail');
  };
  const cmdApp = h('pre', { class: 'cmd' });
  const cmdNode = h('pre', { class: 'cmd' });
  const copyText = async (text, box) => { try { await navigator.clipboard.writeText(text); box.textContent = t('s.headlessCopied'); } catch { box.textContent = text; } };
  api.cliInfo().then((info) => {
    const q = (x) => `"${x}"`;
    const tail = `--settings ${q('<exported-settings.json>')} --data ${q(info.dataDir)}`;
    cmdApp.textContent = info.platform === 'win32' ? `set ELECTRON_RUN_AS_NODE=1\n${q(info.exe)} ${q(info.script)} ${tail}` : `ELECTRON_RUN_AS_NODE=1 ${q(info.exe)} ${q(info.script)} ${tail}`;
    cmdNode.textContent = `node src/cli.js --settings <exported-settings.json> --data ./tfb-data`;
  });
  $('#settingsBody').replaceChildren(
    h('div', { class: 'sec' }, h('h3', { text: t('s.general') }),
      gen('startOnBoot', 's.startOnBoot'), gen('startMinimized', 's.startMinimized'), gen('runOnLaunch', 's.runOnLaunch'), gen('keepAwake', 's.keepAwake'), gen('rememberState', 's.remember'),
      h('div', { class: 'check' }, h('span', { text: t('s.logDays') }), h('input', { type: 'number', min: 1, max: 365, value: g.logRetentionDays, onchange: (e) => patchSettings({ general: { logRetentionDays: Number(e.target.value) } }) }), h('span', { text: t('s.days') }))),
    h('div', { class: 'sec' }, h('h3', { text: t('s.alerts') }),
      h('p', { class: 'hint', text: t('s.alertsHint') }),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: n.desktop, onchange: (e) => patchSettings({ notifications: { desktop: e.target.checked } }) }), h('span', { text: t('s.desktop') })),
      h('div', { class: 'check' }, h('span', { text: t('s.threshold') }), h('input', { type: 'number', min: 1, max: 100, value: n.failThreshold, onchange: (e) => patchSettings({ notifications: { failThreshold: Number(e.target.value) } }) }), h('span', { text: t('s.failures') })),
      h('p', { class: 'hint', text: t('set.n.local') }),

      h('h4', { class: 'sub', text: t('set.mail.title') }),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: em.enabled, onchange: (e) => mail({ enabled: e.target.checked }) }), h('span', { text: t('set.mail.enable') })),
      h('div', { class: 'cols' }, field('set.mail.host', mHost), field('set.mail.port', mPort), field('set.mail.user', mUser), field('set.mail.pass', mPass), field('set.mail.from', mFrom), field('set.mail.to', mTo)),
      h('label', { class: 'check' }, mSecure, h('span', { text: t('set.mail.secure') })),
      h('p', { class: 'hint', text: t('s.emailNote') }),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn small', id: 'mTest', text: t('set.test'), onclick: () => runTest(mRes, async () => { await saveEmailRecipients(); return api.email.test({ host: mHost.value.trim(), port: Number(mPort.value) || 587, secure: mSecure.checked, user: mUser.value.trim(), pass: mPass.value, from: mFrom.value.trim(), recipients: typedAddresses() }); }) }), mRes),

      h('h4', { class: 'sub', text: t('set.tg.title') }),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: tg.enabled, onchange: (e) => patchSettings({ notifications: { telegram: { enabled: e.target.checked } } }) }), h('span', { text: t('set.tg.enable') })),
      field('set.tg.token', tToken),
      h('div', { class: 'field' }, h('span', { text: t('set.tg.recipients') }), tRecipients, h('div', {}, h('button', { type: 'button', class: 'btn small', id: 'tAdd', text: t('set.tg.add'), onclick: () => addRecipientRow() }))),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn small', id: 'tTest', text: t('set.test'), onclick: () => runTest(tRes, () => api.telegram.test({ botToken: tToken.value.trim(), recipients: readRecipients() })) }), tRes),

      h('h4', { class: 'sub', text: t('s.digest') }),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: dg.enabled, onchange: (e) => patchSettings({ notifications: { digest: { enabled: e.target.checked } } }) }), h('span', { text: t('s.digestOn') })),
      h('div', { class: 'check' }, h('span', { text: t('s.digestTimes') }), h('input', { type: 'text', value: dg.times.join(', '), size: 22, onchange: async (e) => { const next = await patchSettings({ notifications: { digest: { times: e.target.value.split(/[\s,;]+/).filter(Boolean) } } }); e.target.value = next.notifications.digest.times.join(', '); } })),
      h('button', { class: 'btn', text: t('s.digestNow'), onclick: async () => { const nn = state.settings.notifications; if (!nn.telegram.enabled && !nn.email.enabled) { msgBox.textContent = t('s.digestNone'); return; } await api.digest.send(); msgBox.textContent = t('s.digestSent'); } })),
    h('div', { class: 'sec' }, h('h3', { text: t('s.backup') }),
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn', text: t('s.export'), onclick: async () => { const r = await api.settings.export(); if (r.ok) msgBox.textContent = t('s.exported', { f: r.file }); } }),
        h('button', { class: 'btn', text: t('s.import'), onclick: async () => { const r = await api.settings.import(); if (r.ok) { state.settings = r.settings; state.sel = state.settings.profiles[0]?.id || null; state.view = 'dash'; applyLang(); msgBox.textContent = t('s.importOk'); } else if (r.error) msgBox.textContent = r.error; } })),
      h('p', { class: 'hint', text: t('s.backupNote') })),
    h('div', { class: 'sec' }, h('h3', { text: t('s.headless') }),
      h('p', { class: 'hint', text: t('s.headlessText') }),
      h('div', { class: 'hint', text: t('s.headlessApp') }), cmdApp, h('button', { class: 'btn small', text: t('s.headlessCopy'), onclick: () => copyText(cmdApp.textContent, msgBox) }),
      h('div', { class: 'hint', text: t('s.headlessNode') }), cmdNode, h('button', { class: 'btn small', text: t('s.headlessCopy'), onclick: () => copyText(cmdNode.textContent, msgBox) }),
      h('p', { class: 'hint', text: t('s.headlessEnv') })),
    h('div', { class: 'sec' }, h('h3', { text: t('s.updates') }),
      gen('checkUpdates', 's.checkUpdates'),
      h('button', { class: 'btn', text: t('s.checkNow'), onclick: async () => { const r = await checkUpdate(true); msgBox.textContent = !r.ok ? t('s.updateErr', { e: r.error }) : r.noRelease ? t('s.noRelease') : r.available ? t('update.available', { v: r.latest, c: r.current }) : t('s.upToDate'); } })),
    msgBox);
}

// ---- updates --------------------------------------------------------------------------------------
async function checkUpdate(manual) {
  const r = await api.update.check();
  state.update = r;
  const bar = $('#updateBar');
  if (r.ok && r.available) {
    $('#updateText').textContent = t('update.available', { v: r.latest, c: r.current });
    $('#updateDownload').hidden = !r.installer;
    bar.hidden = false;
  } else if (!manual) bar.hidden = true;
  return r;
}
$('#updateClose').onclick = () => { $('#updateBar').hidden = true; };
$('#updateNotes').onclick = () => state.update?.url && api.openExternal(state.update.url);
$('#updateDownload').onclick = async () => {
  const btn = $('#updateDownload');
  btn.disabled = true;
  const off = api.update.onProgress((got, total) => { $('#updateText').textContent = t('update.progress', { p: total ? Math.round((got / total) * 100) : '…' }); });
  const r = await api.update.download();
  off();
  btn.disabled = false;
  $('#updateText').textContent = r.ok ? t('update.done', { f: r.file }) : t('update.err', { e: r.error });
  if (r.ok) { btn.textContent = t('update.reveal'); btn.onclick = () => api.update.reveal(r.file); }
};

// ---- wiring -----------------------------------------------------------------------------------------
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const th = state.settings.theme;
  document.documentElement.dataset.theme = th === 'auto' ? (darkQuery.matches ? 'dark' : 'light') : th;
  $('#theme').value = th;
}
darkQuery.addEventListener('change', () => state.settings && state.settings.theme === 'auto' && applyTheme());

function applyLang() {
  I18N.apply(state.settings.language);
  $('#lang').value = state.settings.language;
  applyTheme();
  renderHelp();
  renderRail();
  renderMain();
  if ($('#dlgSettings').open) renderSettings();
}

for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', () => b.closest('dialog').close());
$('#btnHelp').onclick = () => $('#dlgHelp').showModal();
$('#btnSettings').onclick = () => { renderSettings(); $('#dlgSettings').showModal(); };
$('#btnNewProfile').onclick = openNewDialog;
$('#btnPause').onclick = async () => { state.status = await api.scheduler.setPaused(state.status.active); refreshDynamic(); };
$('#btnDash').onclick = () => { state.view = 'dash'; renderRail(); renderMain(); };
$('#btnSortAz').onclick = sortProfilesAz;
$('#theme').onchange = async (e) => { await patchSettings({ theme: e.target.value }); applyTheme(); };
$('#lang').onchange = async (e) => { await patchSettings({ language: e.target.value }); applyLang(); };
$('#newCreate').onclick = async () => {
  const p = await api.profiles.create($('#newName').value.trim() || t('new.defaultName'));
  state.settings.profiles.push(p);
  $('#dlgNew').close();
  state.tab = 'feeds';
  select(p.id);
};

(async function init() {
  state.settings = await api.settings.get();
  state.info = await api.info();
  state.status = await api.scheduler.status();
  state.logs = await api.logs.get();
  state.sel = state.settings.profiles[0]?.id || null;
  $('#ver').textContent = 'v' + state.info.version;
  applyLang();
  api.onStatus((s) => { state.status = s; refreshDynamic(); });
  api.onLog((e) => {
    state.logs.push(e);
    if (state.logs.length > 500) state.logs.shift();
    const box = $('#logBox');
    if (box) {
      const allowed = state.logFilter === 'all' ? null : state.logFilter === 'warn' ? ['warn', 'error'] : ['error'];
      if (!allowed || allowed.includes(e.level)) {
        const near = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
        box.append(logLine(e));
        if (near) box.scrollTop = box.scrollHeight;
      }
    }
  });
  if (state.settings.general.checkUpdates) {
    setTimeout(() => checkUpdate(false), 5000);
    setInterval(() => state.settings.general.checkUpdates && checkUpdate(false), 6 * 3600_000);
  }
})();
