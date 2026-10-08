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
const mmss = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
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
  const dashItem = h('li', { class: 'profile-item' + (state.view === 'dash' ? ' sel' : ''), tabIndex: 0, role: 'button', onclick: () => { state.view = 'dash'; renderRail(); renderMain(); }, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); state.view = 'dash'; renderRail(); renderMain(); } } },
    h('span', { class: 'led ' + (dashLed()) }), h('div', { class: 'pname', text: t('rail.dashboard') }));
  ul.replaceChildren(
    dashItem,
    ...state.settings.profiles.map((p) =>
      h('li', { class: 'profile-item' + (state.view === 'profile' && p.id === state.sel ? ' sel' : ''), tabIndex: 0, role: 'button', onclick: () => select(p.id), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(p.id); } } },
        h('span', { class: 'led ' + profileLed(p) }),
        h('div', { class: 'pname' }, p.name, h('div', { class: 'psub' }, `${p.feeds.filter((f) => f.enabled).length}/${p.feeds.length} feeds · ${p.intervalMin} min`))
      )
    )
  );
  renderTop();
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
    h('div', { class: 'tabs', role: 'tablist' }, ...['feeds', 'format', 'log'].map((k) => h('button', { class: 'tab' + (state.tab === k ? ' sel' : ''), role: 'tab', text: t('tab.' + k), onclick: () => { state.tab = k; renderMain(); } }))),
    state.tab === 'feeds' ? feedsTab(p, change) : state.tab === 'format' ? formatTab(p, change) : logTab()
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
  const rows = p.feeds.map((f) =>
    h('tr', {},
      h('td', {}, h('input', { type: 'checkbox', checked: f.enabled, 'aria-label': t('f.on'), onchange: (e) => { f.enabled = e.target.checked; change(); } })),
      h('td', {}, h('input', { type: 'text', value: f.folder, maxLength: 100, 'aria-label': t('f.folder'), onchange: (e) => { f.folder = e.target.value; change(); } })),
      h('td', { class: 'url' }, h('input', { type: 'url', value: f.url, spellcheck: false, placeholder: 'https://…', 'aria-label': t('f.url'), onchange: (e) => { f.url = e.target.value.trim(); change(); } })),
      h('td', {}, h('input', { type: 'number', min: 1, max: 100, value: f.maxItems, 'aria-label': t('f.max'), onchange: (e) => { f.maxItems = Number(e.target.value); change(); } })),
      h('td', {}, h('input', { type: 'number', min: 0, max: 1440, value: f.intervalMin || '', placeholder: String(p.intervalMin), title: t('f.everyHint'), 'aria-label': t('f.every'), onchange: (e) => { f.intervalMin = Number(e.target.value) || 0; change(); } })),
      h('td', {}, h('input', { type: 'checkbox', checked: f.insecureTls, 'aria-label': t('f.tls'), title: t('f.tlsHint'), onchange: (e) => { f.insecureTls = e.target.checked; change(); } })),
      h('td', { class: 'st', 'data-feed': f.id }),
      h('td', {}, h('div', { class: 'row-actions' },
        h('button', { class: 'btn small', text: t('f.test'), onclick: () => testFeed(f) }),
        h('button', { class: 'btn small', text: '×', title: t('f.remove'), 'aria-label': t('f.remove'), onclick: () => { p.feeds = p.feeds.filter((x) => x.id !== f.id); change(); renderMain(); } })))
    )
  );
  return h('div', {},
    p.feeds.length
      ? h('table', { class: 'feeds' },
          h('thead', {}, h('tr', {}, ...['f.on', 'f.folder', 'f.url', 'f.max', 'f.every', 'f.tls', 'f.status', ''].map((k) => h('th', { text: k ? t(k) : '', title: k === 'f.tls' ? t('f.tlsHint') : k === 'f.every' ? t('f.everyHint') : undefined })))),
          h('tbody', {}, rows))
      : h('p', { class: 'hint', text: t('f.none') }),
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn', text: t('f.add'), onclick: () => { p.feeds.push({ id: crypto.randomUUID(), folder: `Feed${p.feeds.length + 1}`, url: '', maxItems: 10, intervalMin: 0, enabled: true, insecureTls: false }); change(); renderMain(); } })),
    h('p', { class: 'hint', text: t('f.duplicate') })
  );
}

async function testFeed(f) {
  const body = $('#testBody');
  body.replaceChildren(h('p', { text: t('test.loading') }));
  $('#dlgTest').showModal();
  const r = await api.feed.test({ url: f.url, insecureTls: f.insecureTls }, state.sel);
  if (!r.ok) return body.replaceChildren(h('p', { class: 'badge bad', text: t('test.failed', { e: r.error }) }));
  body.replaceChildren(
    h('p', { class: 'hint', text: t('test.total', { n: r.total, m: r.items.length }) }),
    h('div', { class: 'tgrid' }, r.items.map((it) =>
      h('div', { class: 'tcard' },
        h('div', { class: 'thumb' }, it.thumb ? h('img', { src: it.thumb, alt: '' }) : t('test.noImage')),
        h('div', { class: 'tb' }, h('div', { class: 'tt', text: it.title || '—' }), h('div', { class: 'td', text: it.description || '—' }), it.hasImage ? null : h('span', { class: 'badge', text: it.imageFailed ? t('test.imgFailed') : t('test.noImage') })))))
  );
}

// ---- format tab ---------------------------------------------------------------------------------
const FORMAT_DEFAULTS = { encoding: 'utf8', lineEnding: 'lf', trailingNewline: false, emptyValue: '-', maxTitleChars: 0, maxDescChars: 0, titleFile: '{folder}_Title.Txt', descFile: '{folder}_Description.Txt', imageDir: '{folder}', imageStart: 1, imagePad: 5, imageExt: 'JPG', jpegQuality: 85, resize: 'none', width: 0, height: 0, metadataFile: true };

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
      h('span', {}), chk('metadataFile', 'fmt.meta')),
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
function feedStatusNodes(r, feed) {
  if (!r) return [h('span', { class: 'time', text: feed && !feed.url ? t('f.noUrl') : t('f.never') })];
  if (!r.ok) return [h('span', { class: 'led bad' }), ' ', h('span', { class: 'bad-text', text: r.error }), ' ', h('span', { class: 'time', text: fmtTime(r.at) })];
  const text = r.unchanged ? t('f.unchanged', { items: r.items }) : t('f.stat', { items: r.items, img: r.imagesOriginal, ph: r.placeholders });
  return [h('span', { class: 'led ok' }), ' ', text, ' ', h('span', { class: 'time', text: fmtTime(r.at) })];
}

function refreshDynamic() {
  renderRail();
  if (state.view === 'dash') return renderDashboard();
  const p = curProfile();
  if (!p) return;
  const st = state.status.profiles[p.id] || {};
  for (const td of document.querySelectorAll('td.st')) {
    const id = td.getAttribute('data-feed');
    td.replaceChildren(...feedStatusNodes(st.feeds?.[id], p.feeds.find((f) => f.id === id)));
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
  const p = curProfile();
  const el = $('#nextRun');
  if (el && p) el.textContent = nextText(state.status.profiles[p.id]);
  const soon = $('#dashSoonest');
  if (soon) {
    const times = state.settings.profiles.map((x) => state.status.profiles[x.id]?.nextRunAt).filter(Boolean);
    soon.textContent = state.status.active && times.length ? mmss(Math.min(...times) - Date.now()) : '—';
  }
}
setInterval(tickCountdown, 1000);

// ---- dashboard ---------------------------------------------------------------------------------------
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
  const tile = (label, value, cls, extra) => h('div', { class: 'tile ' + (cls || '') }, h('div', { class: 'tile-label', text: label }), h('div', { class: 'tile-value' }, value), extra || null);

  const card = (p) => {
    const st = state.status.profiles[p.id] || { feeds: {} };
    const dirDown = Object.values(st.feeds || {}).some((r) => r.code === 'output-missing');
    const rows = p.feeds.filter((f) => f.enabled).map((f) => {
      const r = st.feeds?.[f.id];
      return h('tr', {},
        h('td', {}, h('span', { class: 'led ' + (!r ? '' : r.ok ? 'ok' : 'bad') }), ' ', f.folder),
        h('td', { class: 'st' }, ...(r ? (r.ok ? [r.unchanged ? t('f.unchanged', { items: r.items }) : t('f.stat', { items: r.items, img: r.imagesOriginal, ph: r.placeholders })] : [h('span', { class: 'bad-text', text: r.error })]) : [h('span', { class: 'time', text: t('dash.pending') })])),
        h('td', { class: 'time', text: r ? fmtTime(r.at) : '—' }),
        h('td', { class: 'time', text: r?.changedAt ? fmtTime(r.changedAt) : '—' }));
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

  const problems = state.logs.filter((e) => e.level !== 'info').slice(-10).reverse();
  main.replaceChildren(
    h('div', { class: 'tiles' },
      tile(t('dash.schedules'), h('span', {}, h('span', { class: 'led ' + (state.status.active ? 'ok' : 'warn') }), ' ', state.status.active ? t('top.running') : t('top.paused')), '', h('button', { class: 'btn small', text: state.status.active ? t('top.pause') : t('top.resume'), onclick: async () => { state.status = await api.scheduler.setPaused(state.status.active); refreshDynamic(); } })),
      tile(t('dash.feedsOk'), String(ok), ok ? 'good' : ''),
      tile(t('dash.problems'), String(bad), bad ? 'bad' : ''),
      tile(t('dash.nextCheck'), h('span', { id: 'dashSoonest', text: '—' })),
      tile(t('dash.lastChange'), lastChange ? fmtTime(lastChange) : t('dash.notYet'))),
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
  const gen = (key, label) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: g[key], onchange: async (e) => { await patchSettings({ general: { [key]: e.target.checked } }); } }), h('span', { text: t(label) }));
  const msgBox = h('div', { class: 'hint', id: 'setMsg' });
  const tokenInput = h('input', { type: 'password', value: tg.botToken, autocomplete: 'off', spellcheck: false, onchange: (e) => patchSettings({ notifications: { telegram: { botToken: e.target.value } } }) });
  const chats = h('textarea', { rows: 3, spellcheck: false, value: tg.recipients.map((r) => (r.note ? `${r.chatId} ${r.note}` : r.chatId)).join('\n'), onchange: (e) => {
    const recipients = e.target.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.search(/\s/); return i < 0 ? { chatId: l, note: '' } : { chatId: l.slice(0, i), note: l.slice(i).trim() }; });
    patchSettings({ notifications: { telegram: { recipients } } });
  } });
  $('#settingsBody').replaceChildren(
    h('div', { class: 'sec' }, h('h3', { text: t('s.general') }),
      gen('startOnBoot', 's.startOnBoot'), gen('startMinimized', 's.startMinimized'), gen('runOnLaunch', 's.runOnLaunch'), gen('keepAwake', 's.keepAwake'),
      h('div', { class: 'check' }, h('span', { text: t('s.logDays') }), h('input', { type: 'number', min: 1, max: 365, value: g.logRetentionDays, onchange: (e) => patchSettings({ general: { logRetentionDays: Number(e.target.value) } }) }), h('span', { text: t('s.days') }))),
    h('div', { class: 'sec' }, h('h3', { text: t('s.alerts') }),
      h('p', { class: 'hint', text: t('s.alertsHint') }),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: n.desktop, onchange: (e) => patchSettings({ notifications: { desktop: e.target.checked } }) }), h('span', { text: t('s.desktop') })),
      h('div', { class: 'check' }, h('span', { text: t('s.threshold') }), h('input', { type: 'number', min: 1, max: 100, value: n.failThreshold, onchange: (e) => patchSettings({ notifications: { failThreshold: Number(e.target.value) } }) }), h('span', { text: t('s.failures') })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: tg.enabled, onchange: (e) => patchSettings({ notifications: { telegram: { enabled: e.target.checked } } }) }), h('span', { text: t('s.tgEnable') })),
      h('label', { class: 'field' }, h('span', { text: t('s.tgToken') }), tokenInput),
      h('label', { class: 'field' }, h('span', { text: t('s.tgChats') }), chats),
      h('p', { class: 'hint', text: t('s.tgNote') }),
      h('button', { class: 'btn', text: t('s.tgTest'), onclick: async () => { await patchSettings({ notifications: { telegram: { botToken: tokenInput.value } } }); const r = await api.telegram.test({ botToken: tokenInput.value, recipients: state.settings.notifications.telegram.recipients }); msgBox.textContent = r.ok ? t('s.tgOk') : r.error; } })),
    h('div', { class: 'sec' }, h('h3', { text: t('s.backup') }),
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn', text: t('s.export'), onclick: async () => { const r = await api.settings.export(); if (r.ok) msgBox.textContent = t('s.exported', { f: r.file }); } }),
        h('button', { class: 'btn', text: t('s.import'), onclick: async () => { const r = await api.settings.import(); if (r.ok) { state.settings = r.settings; state.sel = state.settings.profiles[0]?.id || null; state.view = 'dash'; applyLang(); msgBox.textContent = t('s.importOk'); } else if (r.error) msgBox.textContent = r.error; } })),
      h('p', { class: 'hint', text: t('s.backupNote') })),
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
function applyLang() {
  I18N.apply(state.settings.language);
  $('#lang').value = state.settings.language;
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
$('#lang').onchange = async (e) => { await patchSettings({ language: e.target.value }); applyLang(); };
$('#newCreate').onclick = async () => {
  const p = await api.profiles.create($('#newName').value.trim() || t('new.defaultName'), $('#newStarter').checked);
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
