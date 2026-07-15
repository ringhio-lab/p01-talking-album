'use strict';

// 写真と音声は端末のIndexedDBだけに置く。リポジトリにもサーバーにも個人データを入れない。
// （GitHub Free ではPrivateリポジトリのPagesが使えず、写真を同梱する設計が取れないため）

const DB_NAME = 'talking-album';
const STORE = 'items';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
  });
}

const db = {
  async all() { return tx(await openDb(), 'readonly', s => s.getAll()); },
  async add(item) { return tx(await openDb(), 'readwrite', s => s.add(item)); },
  async put(item) { return tx(await openDb(), 'readwrite', s => s.put(item)); },
  async del(id) { return tx(await openDb(), 'readwrite', s => s.delete(id)); },
};

// --- 子供の画面 ---

const grid = document.getElementById('grid');
const empty = document.getElementById('empty');
const big = document.getElementById('big');
const bigImg = document.getElementById('bigImg');
let audio = null;
const urls = []; // 再描画のたびに revoke してリークを防ぐ

function objectUrl(blob) { const u = URL.createObjectURL(blob); urls.push(u); return u; }

async function renderGrid() {
  urls.splice(0).forEach(URL.revokeObjectURL);
  const items = await db.all();
  grid.innerHTML = '';
  empty.hidden = items.length > 0;

  for (const item of items) {
    const btn = document.createElement('button');
    btn.className = 'card';
    const img = document.createElement('img');
    img.src = objectUrl(item.image);
    img.alt = '';
    btn.appendChild(img);
    btn.addEventListener('click', () => play(item, btn, img.src));
    grid.appendChild(btn);
  }
}

function play(item, card, src) {
  // iOS は再生にユーザー操作を要求する。タップハンドラ内で呼ぶので満たしている。
  if (audio) { audio.pause(); audio = null; }
  document.querySelectorAll('.card.playing').forEach(c => c.classList.remove('playing'));

  bigImg.src = src;
  big.classList.add('on');
  card.classList.add('playing');

  if (item.audio) {
    audio = new Audio(objectUrl(item.audio));
    audio.play().catch(() => { /* 音が出せなくても写真は出す */ });
    audio.onended = () => card.classList.remove('playing');
  } else {
    card.classList.remove('playing');
  }
}

// 大きい写真はどこを触っても閉じる（2歳児に閉じるボタンは見つけられない）
big.addEventListener('click', () => {
  big.classList.remove('on');
  if (audio) { audio.pause(); audio = null; }
  document.querySelectorAll('.card.playing').forEach(c => c.classList.remove('playing'));
});

// --- 親モードへの隠し入口（画面上部を1秒長押し）---
// 見えるボタンを置くと子供が押すので、意図的に発見しにくくしている。

const parent = document.getElementById('parent');
const hdr = document.getElementById('hdr');
let timer = null;

function armLongPress(el) {
  const start = () => { timer = setTimeout(() => { openParent(); }, 1000); };
  const cancel = () => { clearTimeout(timer); };
  el.addEventListener('touchstart', start, { passive: true });
  el.addEventListener('touchend', cancel);
  el.addEventListener('touchmove', cancel, { passive: true });
  el.addEventListener('mousedown', start);
  el.addEventListener('mouseup', cancel);
  el.addEventListener('mouseleave', cancel);
}
// ヘッダーは safe-area 分しか高さが無いので、上端40pxを当たり判定にする
const hotzone = document.createElement('div');
hotzone.style.cssText = 'position:fixed;top:0;left:0;right:0;height:40px;z-index:15';
document.body.appendChild(hotzone);
armLongPress(hotzone);
armLongPress(hdr);

function openParent() { parent.classList.add('on'); renderList(); }
document.getElementById('close').addEventListener('click', async () => {
  parent.classList.remove('on');
  await renderGrid();
});

// --- 親モード：写真の追加と録音 ---

document.getElementById('pick').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  for (const f of files) await db.add({ image: f, audio: null, name: '' });
  e.target.value = '';
  await renderList();
});

const listEl = document.getElementById('list');
const listUrls = [];

async function renderList() {
  listUrls.splice(0).forEach(URL.revokeObjectURL);
  const items = await db.all();
  listEl.innerHTML = '';

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'item';

    const img = document.createElement('img');
    const u = URL.createObjectURL(item.image); listUrls.push(u);
    img.src = u;
    row.appendChild(img);

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = item.audio ? '声あり' : '声なし';
    row.appendChild(meta);

    const rec = document.createElement('button');
    rec.textContent = 'ろくおん';
    rec.addEventListener('click', () => toggleRecord(item, rec, meta));
    row.appendChild(rec);

    if (item.audio) {
      const listen = document.createElement('button');
      listen.textContent = 'きく';
      listen.addEventListener('click', () => {
        const a = new Audio(URL.createObjectURL(item.audio));
        a.play().catch(() => {});
      });
      row.appendChild(listen);
    }

    const del = document.createElement('button');
    del.textContent = 'けす';
    del.addEventListener('click', async () => { await db.del(item.id); await renderList(); });
    row.appendChild(del);

    listEl.appendChild(row);
  }
}

// iOS Safari の MediaRecorder は webm を出さない。対応する mime を選ぶ。
function pickMime() {
  const candidates = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'];
  for (const m of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
  }
  return ''; // ブラウザ既定に任せる
}

let recorder = null;
let recordingFor = null;

async function toggleRecord(item, btn, meta) {
  if (recorder && recordingFor === item.id) { recorder.stop(); return; }
  if (recorder) { recorder.stop(); }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    meta.textContent = 'マイクが使えません（設定で許可してください）';
    return;
  }

  const mime = pickMime();
  recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  recordingFor = item.id;
  const chunks = [];

  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/mp4' });
    recorder = null; recordingFor = null;
    item.audio = blob;
    await db.put(item);
    await renderList();
  };

  recorder.start();
  btn.textContent = 'とめる';
  btn.className = 'rec';
  meta.textContent = 'ろくおん中…';
}

// --- 起動 ---

renderGrid();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
