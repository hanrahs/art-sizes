'use strict';
/*
 * Art Sizes — photograph each painting and record its height × width (× depth)
 * so the right boxes can be ordered for the move.
 * Everything is stored on the device (IndexedDB). Photos stay on the device;
 * backups and exports contain only names and measurements.
 */

/* =========================================================================
 * Helpers
 * ========================================================================= */
const $ = (sel, el = document) => el.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const today = () => new Date().toISOString().slice(0, 10);
const fmtDate = t => t
  ? new Date(+t).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  : 'never';
const plural = (n, word) => `${n.toLocaleString()} ${n === 1 ? word : word + 's'}`;
const newId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// Measurements — all in cm. Height (h), width (w) and depth (d) are always kept as separate numbers.
const DIMS = [['h', 'Height'], ['w', 'Width'], ['d', 'Depth']];
const parseNum = s => {
  const n = parseFloat(String(s ?? '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
};
const fmtNum = n => (n == null ? '' : String(Math.round(n * 10) / 10));
const hasSize = p => DIMS.every(([k]) => p[k] != null);

/* =========================================================================
 * Storage (IndexedDB)
 * ========================================================================= */
const DB = {
  db: null,
  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('art-sizes', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('paintings', { keyPath: 'id' });
      req.onsuccess = () => { this.db = req.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  },
  all() {
    return new Promise((resolve, reject) => {
      const req = this.db.transaction('paintings').objectStore('paintings').getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  write(fn) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('paintings', 'readwrite');
      fn(tx.objectStore('paintings'));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
  put(p) { return this.write(os => os.put(p)); },
  del(id) { return this.write(os => os.delete(id)); },
  replaceAll(items) { return this.write(os => { os.clear(); items.forEach(i => os.put(i)); }); },
};

/* =========================================================================
 * State
 * ========================================================================= */
const S = {
  items: [],
  tab: 'list',
  query: '',
  sort: localStorage.getItem('sort') || 'new',
};

const settings = {
  get changes() { return +(localStorage.getItem('changes') || 0); },
  set changes(v) { localStorage.setItem('changes', v); },
};
function touched() { settings.changes = settings.changes + 1; }

const byId = id => S.items.find(p => p.id === id);
const bigSide = p => Math.max(p.h || 0, p.w || 0);

function sorted(list) {
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  if (S.sort === 'name') return [...list].sort(byName);
  if (S.sort === 'size') return [...list].sort((a, b) => bigSide(b) - bigSide(a) || byName(a, b));
  return [...list].sort((a, b) => b.addedAt - a.addedAt);
}

/* =========================================================================
 * Navigation — tabs + full-screen sub-views (Android back button works)
 * ========================================================================= */
const stack = [];

function pushView(build) {
  const el = document.createElement('section');
  el.className = 'view sub';
  $('main').appendChild(el);
  stack.push({ el });
  build(el);
  showTop();
  history.pushState({ depth: stack.length }, '');
}
function showTop() {
  const top = stack[stack.length - 1];
  document.querySelectorAll('main > .view').forEach(v => { v.hidden = true; });
  if (top) top.el.hidden = false; else $('#v-' + S.tab).hidden = false;
  $('#tabs').hidden = !!top;
  document.body.classList.toggle('insub', !!top);
}
const goBack = () => history.back();

window.addEventListener('popstate', e => {
  if (openModals.length) {
    closeAllModals();
    history.pushState({ depth: stack.length }, '');
    return;
  }
  const depth = e.state?.depth || 0;
  while (stack.length > depth) stack.pop().el.remove();
  showTop();
  if (!stack.length) refreshTab();
});

function switchTab(tab) {
  S.tab = tab;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  showTop();
  refreshTab();
}
function refreshTab() {
  if (S.tab === 'list') renderList(); else renderMore();
  updateHeader();
}

const subhead = title =>
  `<div class="subhead noprint"><button class="back" data-back>‹ Back</button><h2>${esc(title)}</h2></div>`;
document.addEventListener('click', e => { if (e.target.closest('[data-back]')) goBack(); });

/* =========================================================================
 * UI bits: toast, modals
 * ========================================================================= */
let toastTimer;
function toast(msg, actionLabel, action) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${actionLabel ? `<button>${esc(actionLabel)}</button>` : ''}`;
  t.hidden = false;
  if (actionLabel) t.querySelector('button').onclick = () => { t.hidden = true; action(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, actionLabel ? 6000 : 3000);
}

const openModals = [];
function openModal(build) {
  return new Promise(resolve => {
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = '<div class="sheet"></div>';
    document.body.appendChild(ov);
    const close = v => {
      ov.remove();
      const i = openModals.indexOf(close);
      if (i >= 0) openModals.splice(i, 1);
      resolve(v);
    };
    openModals.push(close);
    ov.addEventListener('click', e => { if (e.target === ov) close(null); });
    build(ov.firstChild, close);
  });
}
function closeAllModals() { [...openModals].forEach(c => c(null)); }

function confirmDlg(title, text, okLabel = 'OK', danger = false) {
  return openModal((el, close) => {
    el.innerHTML = `<h3>${esc(title)}</h3><p>${esc(text)}</p>
      <div class="btns"><button class="btn ghost" data-a="c">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-a="ok">${esc(okLabel)}</button></div>`;
    el.onclick = e => {
      if (e.target.dataset.a === 'c') close(false);
      if (e.target.dataset.a === 'ok') close(true);
    };
  });
}

/* =========================================================================
 * Header
 * ========================================================================= */
function updateHeader() {
  const total = S.items.length;
  const sized = S.items.filter(hasSize).length;
  $('#ptext').innerHTML = total
    ? `<b>${plural(total, 'painting')}</b>${sized < total ? ` <span class="muted">· ${total - sized} still ${total - sized === 1 ? 'needs' : 'need'} measuring</span>` : ' <span class="muted">· all measured</span>'}`
    : `<span class="muted">No paintings yet</span>`;
}

/* =========================================================================
 * List
 * ========================================================================= */
function rowHtml(p) {
  return `<li class="row" data-id="${esc(p.id)}">
    ${p.photo ? `<img class="thumb" loading="lazy" src="${p.photo}" alt="">` : `<div class="thumb ph">🖼️</div>`}
    <div class="info">
      <div class="t1">${esc(p.name)}</div>
      <div class="dimcells">${DIMS.map(([k, label]) => `<span class="dimcell ${p[k] == null ? 'missing' : ''}">
        <small>${label}</small>${p[k] == null ? '—' : `${fmtNum(p[k])}<small> cm</small>`}</span>`).join('')}</div>
    </div></li>`;
}

function renderList() {
  const toks = norm(S.query).split(/\s+/).filter(Boolean);
  const items = sorted(S.items.filter(p => toks.every(t => norm(p.name).includes(t))));
  $('#list').innerHTML = items.map(rowHtml).join('');
  $('#empty').innerHTML = !S.items.length
    ? 'Tap <b>Add a painting</b>, take a photo, give it a name you’ll recognise and enter its height and width.'
    : (!items.length ? 'Nothing matches.' : '');
  const n = settings.changes;
  $('#backupnag').innerHTML = n >= 20
    ? `<div class="nag"><span>${n} changes since your last backup</span><button class="btn small" data-a="backup">Back up now</button></div>` : '';
}

function wireList() {
  const q = $('#q');
  q.addEventListener('input', () => { S.query = q.value; renderList(); });
  const sort = $('#sort');
  sort.value = S.sort;
  sort.addEventListener('change', () => { S.sort = sort.value; localStorage.setItem('sort', S.sort); renderList(); });

  $('#v-list').addEventListener('click', e => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'add') return openEditor(null);
    if (a === 'backup') return doBackup();
    const row = e.target.closest('.row');
    if (row) openEditor(row.dataset.id);
  });
}

/* =========================================================================
 * Add / edit a painting
 * ========================================================================= */
function resizeImage(file, max = 1000) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s);
      c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that photo')); };
    img.src = url;
  });
}

function openEditor(id) {
  pushView(el => {
    const p = id ? byId(id) : null;
    let photo = p?.photo || '';
    const num = (name, label) =>
      `<label class="lbl">${label} (cm)<input class="field" name="${name}" inputmode="decimal" autocomplete="off" value="${esc(fmtNum(p?.[name]))}"></label>`;

    el.innerHTML = `${subhead(p ? 'Edit painting' : 'Add a painting')}
      <div class="pad">
        <label class="photo">
          <img ${photo ? `src="${photo}"` : 'hidden'} alt="">
          <span class="photoph" ${photo ? 'hidden' : ''}>📷<br>Tap to take a photo</span>
          <input type="file" accept="image/*" capture="environment" hidden>
        </label>
        <button class="btn ghost small" data-a="nophoto" ${photo ? '' : 'hidden'} style="margin-top:6px">Remove photo</button>
        <label class="lbl">Name<input class="field" name="name" autocomplete="off" autocapitalize="sentences" value="${esc(p?.name || '')}" placeholder="e.g. Big blue one, hallway"></label>
        <div class="dims">${DIMS.map(([k, label]) => num(k, label)).join('')}</div>
        <p class="muted small">Measure the outside of the frame in cm, at the deepest point for depth.</p>
        <button class="btn primary wide" data-a="save" style="margin-top:18px">Save</button>
        ${p ? `<button class="btn danger wide" data-a="delete">Delete painting</button>`
            : `<button class="btn wide" data-a="savenext">Save &amp; add another</button>`}
      </div>`;

    const fileInp = $('input[type=file]', el);
    const setPhoto = src => {
      photo = src;
      const img = $('.photo img', el);
      img.hidden = !src;
      if (src) img.src = src; else img.removeAttribute('src');
      $('.photoph', el).hidden = !!src;
      $('[data-a=nophoto]', el).hidden = !src;
    };
    fileInp.addEventListener('change', async () => {
      const file = fileInp.files[0];
      fileInp.value = '';
      if (!file) return;
      try {
        setPhoto(await resizeImage(file));
        const name = $('input[name=name]', el);
        if (!name.value) name.focus();
      } catch (err) { toast(err.message); }
    });

    const save = async () => {
      const val = n => $(`input[name=${n}]`, el).value.trim();
      const data = { name: val('name'), h: parseNum(val('h')), w: parseNum(val('w')), d: parseNum(val('d')), photo };
      if (!data.name) { toast('Please give it a name'); $('input[name=name]', el).focus(); return false; }
      for (const k of ['h', 'w', 'd']) {
        if (val(k) && data[k] == null) { toast('That size doesn’t look like a number'); $(`input[name=${k}]`, el).focus(); return false; }
      }
      if (p) {
        Object.assign(p, data, { updatedAt: Date.now() });
        await DB.put(p);
      } else {
        const np = { id: newId(), addedAt: Date.now(), updatedAt: Date.now(), ...data };
        S.items.push(np);
        await DB.put(np);
      }
      touched();
      return true;
    };

    el.onclick = async e => {
      const b = e.target.closest('button');
      if (!b) return;
      const a = b.dataset.a;
      if (a === 'nophoto') setPhoto('');
      if (a === 'save' && await save()) { goBack(); toast(p ? 'Saved' : 'Added'); }
      if (a === 'savenext' && await save()) {
        goBack();
        setTimeout(() => { openEditor(null); toast('Added — next one'); }, 50);
      }
      if (a === 'delete') {
        if (!(await confirmDlg('Delete painting?', `Remove “${p.name}” from the list?`, 'Delete', true))) return;
        S.items = S.items.filter(x => x !== p);
        await DB.del(p.id);
        touched();
        goBack();
        toast('Deleted', 'Undo', async () => {
          S.items.push(p);
          await DB.put(p);
          refreshTab();
        });
      }
    };
  });
}

/* =========================================================================
 * Export & backup tab
 * ========================================================================= */
function renderMore() {
  const el = $('#v-more');
  const missing = S.items.filter(p => !hasSize(p)).length;
  el.innerHTML = `<div class="pad">
    <h3 style="margin-top:4px">For the preservation team</h3>
    <button class="btn primary wide" data-a="csv">Spreadsheet of all sizes (CSV)</button>
    <button class="btn wide" data-a="print">Printable list (print / save as PDF)</button>
    <p class="muted small">Height, width and depth are separate columns, all in cm.${missing ? ` <span class="warn">${plural(missing, 'painting')} still ${missing === 1 ? 'is' : 'are'} missing a measurement.</span>` : ''}</p>

    <h3>Backup</h3>
    <p class="small">${plural(settings.changes, 'change')} since last backup (${fmtDate(localStorage.getItem('lastBackup'))}).</p>
    <button class="btn primary wide" data-a="backup">Back up — save to OneDrive</button>
    <p class="muted small">Opens Android’s share menu: choose <b>OneDrive</b> and pick a folder. The backup holds names and sizes only, not photos.</p>
    <button class="btn ghost wide" data-a="restore">Restore from a backup file…</button>
    <input type="file" id="restorefile" accept=".txt,.json,text/plain,application/json" hidden>

    <h3>About</h3>
    <p class="muted small" id="storageinfo">All data, including photos, is stored on this device only.</p>
  </div>`;

  navigator.storage?.persisted?.().then(ok => {
    const i = $('#storageinfo');
    if (i) i.textContent = `All data, including photos, is stored on this device only. ${ok ? 'Storage is protected from automatic clean-up.' : 'Tip: install the app to your home screen so Android keeps the data safe.'}`;
  });
  $('#restorefile', el).onchange = e => { if (e.target.files[0]) doRestore(e.target.files[0]); e.target.value = ''; };
}

function wireMore() {
  $('#v-more').addEventListener('click', e => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'csv') exportCsv();
    if (a === 'print') openPrint();
    if (a === 'backup') doBackup();
    if (a === 'restore') $('#restorefile').click();
  });
}

/* =========================================================================
 * Files: share / backup / restore / CSV
 * ========================================================================= */
async function shareFile(filename, content, type) {
  const file = new File([content], filename, { type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    } catch (err) {
      if (err.name === 'AbortError') return 'cancelled';
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return 'downloaded';
}

async function doBackup() {
  const data = {
    app: 'art-sizes',
    version: 1,
    exported: new Date().toISOString(),
    // Photos stay on the phone; each measurement is its own field.
    paintings: S.items.map(p => ({
      id: p.id, name: p.name, height_cm: p.h, width_cm: p.w, depth_cm: p.d, addedAt: p.addedAt, updatedAt: p.updatedAt,
    })),
  };
  // Saved as .txt because Android's share menu won't accept .json files.
  const res = await shareFile(`art-sizes-backup-${today()}.txt`, JSON.stringify(data, null, 1), 'text/plain');
  if (res === 'cancelled') return;
  localStorage.setItem('lastBackup', Date.now());
  settings.changes = 0;
  toast(res === 'shared' ? 'Backup shared' : 'Backup downloaded');
  refreshTab();
}

async function doRestore(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { data = null; }
  if (data?.app !== 'art-sizes' || !Array.isArray(data.paintings)) { toast('That file isn’t an Art Sizes backup'); return; }
  const ok = await confirmDlg('Restore backup?',
    `Backup from ${fmtDate(Date.parse(data.exported))}: ${plural(data.paintings.length, 'painting')}. This REPLACES the list in the app. Photos are kept for paintings that are in both.`,
    'Replace', true);
  if (!ok) return;
  const photos = new Map(S.items.map(p => [p.id, p.photo]));
  const items = data.paintings.map(p => ({
    id: p.id, name: p.name, h: p.height_cm ?? null, w: p.width_cm ?? null, d: p.depth_cm ?? null,
    addedAt: p.addedAt, updatedAt: p.updatedAt, photo: photos.get(p.id) || '',
  }));
  await DB.replaceAll(items);
  S.items = items;
  settings.changes = 0;
  refreshTab();
  toast('Backup restored');
}

function exportCsv() {
  const cell = v => {
    const s = String(v ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [['#', 'Name', 'Height (cm)', 'Width (cm)', 'Depth (cm)']];
  sorted(S.items).forEach((p, i) => rows.push([i + 1, p.name, fmtNum(p.h), fmtNum(p.w), fmtNum(p.d)]));
  const csv = '﻿' + rows.map(r => r.map(cell).join(',')).join('\r\n');
  shareFile(`painting-sizes-${today()}.csv`, csv, 'text/csv');
}

/* =========================================================================
 * Printable list (print → Save as PDF)
 * ========================================================================= */
function openPrint() {
  const opts = { photos: true };
  pushView(el => {
    const build = () => {
      const items = sorted(S.items);
      const doc = `<h1>Paintings — sizes</h1>
        <p class="pmuted">${esc(new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }))} · ${plural(items.length, 'painting')} · all sizes in cm, outside of frame</p>
        <table><tr><th>#</th>${opts.photos ? '<th></th>' : ''}<th>Name</th><th>Height (cm)</th><th>Width (cm)</th><th>Depth (cm)</th></tr>
        ${items.map((p, i) => `<tr><td>${i + 1}</td>${opts.photos ? `<td>${p.photo ? `<img src="${p.photo}" alt="">` : ''}</td>` : ''}
          <td>${esc(p.name)}</td><td>${fmtNum(p.h)}</td><td>${fmtNum(p.w)}</td><td>${fmtNum(p.d)}</td></tr>`).join('')}</table>`;
      el.innerHTML = `<div class="noprint">${subhead('Printable list')}
          <div class="pad printopts">
            <label><input type="checkbox" data-o="photos" ${opts.photos ? 'checked' : ''}> Show photos</label>
            <button class="btn primary wide" data-a="print">Print / Save as PDF</button>
            <p class="muted small">In the print screen pick <b>Save as PDF</b>, then share the PDF. Uses the sort order from the list screen.</p>
          </div></div>
        <div class="printdoc">${doc}</div>`;
    };
    build();
    el.onchange = e => { if (e.target.dataset.o) { opts.photos = e.target.checked; build(); } };
    el.onclick = e => {
      if (e.target.closest('[data-a]')?.dataset.a === 'print') window.print();
    };
  });
}

/* =========================================================================
 * Start-up
 * ========================================================================= */
async function init() {
  try {
    await DB.open();
    S.items = await DB.all();
  } catch (err) {
    $('#ptext').textContent = 'Could not open storage: ' + err.message;
    return;
  }
  history.replaceState({ depth: 0 }, '');
  $('#tabs').addEventListener('click', e => {
    const b = e.target.closest('[data-tab]');
    if (b) switchTab(b.dataset.tab);
  });
  wireList();
  wireMore();
  switchTab('list');

  navigator.storage?.persist?.();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
