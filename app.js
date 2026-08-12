'use strict';

// 写真と音声は端末のIndexedDBだけに置く。外部サーバーには送信しない。
const DB_NAME = 'talking-album';
const STORE = 'items';
const MAX_ITEMS = 20;
const MAX_IMAGE_EDGE = 1600;
const RECORDING_LIMIT_MS = 10000;

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

function tx(dbHandle, mode, fn) {
  return new Promise((resolve, reject) => {
    const transaction = dbHandle.transaction(STORE, mode);
    let request;
    try {
      request = fn(transaction.objectStore(STORE));
    } catch (error) {
      transaction.abort();
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve(request && request.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('保存を中止しました'));
  });
}

const db = {
  async all() { return tx(await openDb(), 'readonly', store => store.getAll()); },
  async add(item) { return tx(await openDb(), 'readwrite', store => store.add(item)); },
  async put(item) { return tx(await openDb(), 'readwrite', store => store.put(item)); },
  async del(id) { return tx(await openDb(), 'readwrite', store => store.delete(id)); },
  async clear() { return tx(await openDb(), 'readwrite', store => store.clear()); },
};

const grid = document.getElementById('grid');
const empty = document.getElementById('empty');
const big = document.getElementById('big');
const bigImg = document.getElementById('bigImg');
const parent = document.getElementById('parent');
const statusEl = document.getElementById('status');
const listEl = document.getElementById('list');
const parentCount = document.getElementById('parentCount');
const urls = [];
const listUrls = [];
let audio = null;
let activePlaybackButton = null;
let activeAudioUrl = null;
let audioContext = null;
let activeSources = [];
const DEFAULT_VOICE = { rate: 1, pitch: 0, pattern: 'once', preset: 'normal' };

function voiceOf(item) {
  return { ...DEFAULT_VOICE, ...(item.voice || {}) };
}

function setStatus(message) { statusEl.textContent = message; }
function objectUrl(blob, bucket = urls) {
  const url = URL.createObjectURL(blob);
  bucket.push(url);
  return url;
}
function revokeAll(bucket) { bucket.splice(0).forEach(URL.revokeObjectURL); }

async function renderGrid() {
  revokeAll(urls);
  const items = await db.all();
  grid.innerHTML = '';
  empty.hidden = items.length > 0;

  for (const [index, item] of items.entries()) {
    const button = document.createElement('button');
    button.className = 'card';
    button.style.setProperty('--index', index);
    button.setAttribute('aria-label', item.audio ? '写真を見る、声あり' : '写真を見る、声なし');
    const image = document.createElement('img');
    image.src = objectUrl(item.image);
    image.alt = '';
    button.appendChild(image);
    button.addEventListener('click', () => play(item, button, image.src));
    grid.appendChild(button);
  }
}

function stopPlayback() {
  activeSources.splice(0).forEach(source => { try { source.stop(); } catch (_) {} });
  if (audio) {
    audio.pause();
    audio.src = '';
    audio = null;
  }
  if (activeAudioUrl) {
    URL.revokeObjectURL(activeAudioUrl);
    activeAudioUrl = null;
  }
  if (activePlaybackButton) {
    activePlaybackButton.textContent = activePlaybackButton.dataset.idleLabel || '▶ 声を聞く';
    activePlaybackButton.classList.remove('playing-audio');
    activePlaybackButton = null;
  }
  document.querySelectorAll('.card.playing').forEach(card => card.classList.remove('playing'));
}

function celebrate(card) {
  const colors = ['#ffd45c', '#ff7d68', '#79c9e8', '#8ed59c', '#b09be8'];
  for (let index = 0; index < 7; index += 1) {
    const spark = document.createElement('i');
    spark.className = 'spark';
    const angle = (Math.PI * 2 * index) / 7;
    const distance = 35 + (index % 3) * 11;
    spark.style.left = `${45 + (index % 2) * 10}%`;
    spark.style.top = '48%';
    spark.style.setProperty('--spark', colors[index % colors.length]);
    spark.style.setProperty('--dx', `${Math.cos(angle) * distance}px`);
    spark.style.setProperty('--dy', `${Math.sin(angle) * distance}px`);
    card.appendChild(spark);
    spark.addEventListener('animationend', () => spark.remove(), { once: true });
  }
}

async function playVoice(blob, settings, onEnded) {
  const voice = { ...DEFAULT_VOICE, ...settings };
  const repeatCount = voice.pattern === 'three' ? 3 : voice.pattern === 'twice' ? 2 : 1;
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    await audioContext.resume();
    const buffer = await audioContext.decodeAudioData(await blob.arrayBuffer());
    const pitchFactor = 2 ** (voice.pitch / 12);
    const effectiveRate = Math.max(.5, voice.rate * pitchFactor);
    const duration = buffer.duration / effectiveRate;
    const startAt = audioContext.currentTime + .02;
    for (let index = 0; index < repeatCount; index += 1) {
      const source = audioContext.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = voice.rate;
      source.detune.value = voice.pitch * 100;
      source.connect(audioContext.destination);
      source.start(startAt + index * (duration + .22));
      activeSources.push(source);
      if (index === repeatCount - 1) source.onended = onEnded;
    }
  } catch (_) {
    activeAudioUrl = URL.createObjectURL(blob);
    audio = new Audio(activeAudioUrl);
    audio.playbackRate = voice.rate;
    audio.preservesPitch = false;
    audio.play().catch(onEnded);
    audio.onended = onEnded;
  }
}

function play(item, card, src) {
  // iOSの音声制限を満たすため、ユーザーのタップ内でplay()する。
  stopPlayback();
  bigImg.src = src;
  big.classList.add('on');
  card.classList.add('playing');
  celebrate(card);

  if (!item.audio) {
    card.classList.remove('playing');
    return;
  }

  playVoice(item.audio, voiceOf(item), () => { card.classList.remove('playing'); stopPlayback(); });
}

big.addEventListener('click', () => {
  big.classList.remove('on');
  stopPlayback();
});

// --- 親モードへの入口（右上の鍵を1秒長押し） ---
const parentEntry = document.getElementById('parentEntry');
let longPressTimer = null;

try {
  if (localStorage.getItem('talking-album-parent-hint-seen') === '1') {
    parentEntry.classList.add('hint-seen');
  }
} catch (_) { /* localStorageが使えなくても案内は表示する */ }

function armLongPress(element) {
  const start = () => {
    clearTimeout(longPressTimer);
    element.classList.add('holding');
    longPressTimer = setTimeout(() => {
      element.classList.remove('holding');
      openParent();
    }, 1000);
  };
  const cancel = () => {
    clearTimeout(longPressTimer);
    element.classList.remove('holding');
  };
  element.addEventListener('touchstart', start, { passive: true });
  element.addEventListener('touchend', cancel);
  element.addEventListener('touchcancel', cancel);
  element.addEventListener('touchmove', cancel, { passive: true });
  element.addEventListener('mousedown', start);
  element.addEventListener('mouseup', cancel);
  element.addEventListener('mouseleave', cancel);
  element.addEventListener('click', event => event.preventDefault());
}

armLongPress(parentEntry);

function openParent() {
  parentEntry.classList.add('hint-seen');
  try { localStorage.setItem('talking-album-parent-hint-seen', '1'); } catch (_) {}
  stopPlayback();
  big.classList.remove('on');
  parent.classList.add('on');
  setStatus('');
  renderList().catch(() => setStatus('写真を読み込めませんでした'));
}

document.getElementById('emptyOpen').addEventListener('click', openParent);

document.getElementById('close').addEventListener('click', async () => {
  if (activeRecording) stopRecording();
  parent.classList.remove('on');
  await renderGrid();
});

// --- 写真追加（スマホ写真を保存前に縮小して容量を抑える） ---
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像を開けません')); };
    image.src = url;
  });
}

async function prepareImage(file) {
  if (!file.type.startsWith('image/')) throw new Error('画像ではないファイルです');
  const image = await loadImage(file);
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0, width, height);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.84));
  if (!blob) throw new Error('画像を変換できません');
  return blob;
}

async function requestPersistentStorage() {
  if (!navigator.storage || !navigator.storage.persist) return;
  try { await navigator.storage.persist(); } catch (_) { /* 対応外でも利用は継続 */ }
}

document.getElementById('pick').addEventListener('change', async event => {
  const input = event.target;
  const files = [...input.files];
  input.value = '';
  const existing = await db.all();
  const available = Math.max(0, MAX_ITEMS - existing.length);
  if (!available) {
    setStatus(`写真は${MAX_ITEMS}枚までです`);
    return;
  }

  const selected = files.slice(0, available);
  setStatus(`${selected.length}枚を準備しています…`);
  let added = 0;
  for (const file of selected) {
    try {
      await db.add({ image: await prepareImage(file), audio: null, name: '', voice: { ...DEFAULT_VOICE } });
      added += 1;
    } catch (_) {
      setStatus('開けない写真がありました');
    }
  }
  await requestPersistentStorage();
  await renderList();
  setStatus(`${added}枚追加しました${files.length > available ? `（上限${MAX_ITEMS}枚）` : ''}`);
});

// --- 親モードの一覧・録音 ---
async function renderList() {
  revokeAll(listUrls);
  const items = await db.all();
  listEl.innerHTML = '';
  parentCount.textContent = `${items.length} / ${MAX_ITEMS}枚`;

  if (!items.length) {
    const emptyList = document.createElement('div');
    emptyList.className = 'list-empty';
    emptyList.textContent = 'まだ写真がありません。\n「写真を追加」から、まず1枚選んでください。';
    listEl.appendChild(emptyList);
    return;
  }

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'item';
    const image = document.createElement('img');
    image.src = objectUrl(item.image, listUrls);
    image.alt = '';
    row.appendChild(image);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const voiceState = document.createElement('span');
    voiceState.className = `voice-state${item.audio ? ' has-voice' : ''}`;
    voiceState.textContent = item.audio ? '声を録音済み' : '声はまだありません';
    meta.appendChild(voiceState);
    row.appendChild(meta);

    const controls = document.createElement('div');
    controls.className = 'controls';

    if (item.audio) {
      const listen = document.createElement('button');
      listen.textContent = '▶ 声を聞く';
      listen.dataset.idleLabel = '▶ 声を聞く';
      listen.className = 'play-button';
      listen.addEventListener('click', () => togglePlayback(item.audio, listen, voiceOf(item)));
      controls.appendChild(listen);

      const voicePlay = document.createElement('button');
      voicePlay.textContent = '✨ 声のあそび';
      voicePlay.className = 'voice-play';
      voicePlay.addEventListener('click', () => openVoiceSheet(item));
      controls.appendChild(voicePlay);
    }

    const record = document.createElement('button');
    record.textContent = item.audio ? '● 録り直す' : '● 声を録音';
    record.addEventListener('click', () => beginRecording(item));
    controls.appendChild(record);

    if (item.audio) {
      const removeVoice = document.createElement('button');
      removeVoice.textContent = '声だけ削除';
      removeVoice.className = 'voice-remove';
      removeVoice.addEventListener('click', async () => {
        if (!window.confirm('録音した声だけを削除しますか？\n写真は残ります。')) return;
        stopPlayback();
        item.audio = null;
        await db.put(item);
        await renderList();
        setStatus('声だけ削除しました。写真は残っています');
      });
      controls.appendChild(removeVoice);
    }

    const removePhoto = document.createElement('button');
    removePhoto.textContent = '写真ごと削除';
    removePhoto.className = 'photo-remove';
    removePhoto.addEventListener('click', async () => {
      if (!window.confirm('この写真を削除しますか？\n録音した声も一緒に削除されます。')) return;
      stopPlayback();
      await db.del(item.id);
      await renderList();
      setStatus('写真と声を削除しました');
    });
    controls.appendChild(removePhoto);
    row.appendChild(controls);
    listEl.appendChild(row);
  }
}

function togglePlayback(blob, button, settings = DEFAULT_VOICE) {
  if (!blob) return;
  if (activePlaybackButton === button && ((audio && !audio.paused) || activeSources.length)) {
    stopPlayback();
    return;
  }
  stopPlayback();
  activePlaybackButton = button;
  button.textContent = '■ 停止';
  button.classList.add('playing-audio');
  playVoice(blob, settings, stopPlayback).catch(() => {
    stopPlayback();
    setStatus('声を再生できませんでした');
  });
}

// --- 声の高さ・速さ・再生パターン ---
const voiceSheet = document.getElementById('voiceSheet');
const voicePitch = document.getElementById('voicePitch');
const voiceRate = document.getElementById('voiceRate');
const voicePitchValue = document.getElementById('voicePitchValue');
const voiceRateValue = document.getElementById('voiceRateValue');
const voiceTry = document.getElementById('voiceTry');
const voiceSave = document.getElementById('voiceSave');
const voiceCancel = document.getElementById('voiceCancel');
let voiceEditingItem = null;
let voiceDraft = { ...DEFAULT_VOICE };

const VOICE_PRESETS = {
  normal: { rate: 1, pitch: 0, pattern: 'once' },
  tiny: { rate: 1.18, pitch: 4, pattern: 'twice' },
  big: { rate: .84, pitch: -4, pattern: 'once' },
  slow: { rate: .72, pitch: 0, pattern: 'once' },
};

function pitchLabel(value) {
  const number = Number(value);
  return number === 0 ? 'ふつう' : number > 0 ? `高め +${number}` : `低め ${number}`;
}

function rateLabel(value) {
  const number = Number(value);
  if (Math.abs(number - 1) < .01) return 'ふつう';
  return number > 1 ? `はやめ ×${number.toFixed(2)}` : `ゆっくり ×${number.toFixed(2)}`;
}

function renderVoiceControls() {
  voicePitch.value = voiceDraft.pitch;
  voiceRate.value = voiceDraft.rate;
  voicePitchValue.textContent = pitchLabel(voiceDraft.pitch);
  voiceRateValue.textContent = rateLabel(voiceDraft.rate);
  document.querySelectorAll('.preset').forEach(button => {
    button.classList.toggle('selected', button.dataset.preset === voiceDraft.preset);
  });
  document.querySelectorAll('.pattern').forEach(button => {
    button.classList.toggle('selected', button.dataset.pattern === voiceDraft.pattern);
  });
}

function openVoiceSheet(item) {
  stopPlayback();
  voiceEditingItem = item;
  voiceDraft = voiceOf(item);
  renderVoiceControls();
  voiceSheet.classList.add('on');
}

function closeVoiceSheet() {
  stopPlayback();
  voiceSheet.classList.remove('on');
  voiceEditingItem = null;
}

document.querySelectorAll('.preset').forEach(button => button.addEventListener('click', () => {
  const preset = button.dataset.preset;
  voiceDraft = { ...voiceDraft, ...VOICE_PRESETS[preset], preset };
  renderVoiceControls();
}));

document.querySelectorAll('.pattern').forEach(button => button.addEventListener('click', () => {
  voiceDraft.pattern = button.dataset.pattern;
  voiceDraft.preset = 'custom';
  renderVoiceControls();
}));

voicePitch.addEventListener('input', () => {
  voiceDraft.pitch = Number(voicePitch.value);
  voiceDraft.preset = 'custom';
  renderVoiceControls();
});

voiceRate.addEventListener('input', () => {
  voiceDraft.rate = Number(voiceRate.value);
  voiceDraft.preset = 'custom';
  renderVoiceControls();
});

voiceTry.addEventListener('click', () => {
  if (!voiceEditingItem?.audio) return;
  voiceTry.dataset.idleLabel = '▶ ためす';
  togglePlayback(voiceEditingItem.audio, voiceTry, voiceDraft);
});

voiceSave.addEventListener('click', async () => {
  if (!voiceEditingItem) return;
  voiceEditingItem.voice = { ...voiceDraft };
  await db.put(voiceEditingItem);
  closeVoiceSheet();
  await renderList();
  setStatus('声のあそびを保存しました');
});

voiceCancel.addEventListener('click', closeVoiceSheet);

function pickMime() {
  const candidates = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'];
  for (const mime of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return '';
}

const recordingSheet = document.getElementById('recordingSheet');
const recordingLabel = document.getElementById('recordingLabel');
const recordingTitle = document.getElementById('recordingTitle');
const recordingTimer = document.getElementById('recordingTimer');
const recordStop = document.getElementById('recordStop');
const recordPreview = document.getElementById('recordPreview');
const recordRetry = document.getElementById('recordRetry');
const recordSave = document.getElementById('recordSave');
const recordCancel = document.getElementById('recordCancel');
let activeRecording = null;
let recordingDraft = null;

function formatDuration(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  return `00:${String(seconds).padStart(2, '0')}`;
}

function closeRecordingSheet() {
  stopPlayback();
  recordingSheet.classList.remove('on', 'recording', 'review');
  recordingDraft = null;
}

function stopRecording() {
  if (activeRecording && activeRecording.recorder.state !== 'inactive') {
    activeRecording.recorder.stop();
  }
}

async function beginRecording(item) {
  if (activeRecording) return;
  stopPlayback();
  recordingDraft = null;
  if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) {
    setStatus('このスマホでは録音機能を使えません');
    return;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (_) {
    setStatus('マイクを使えません。Safariの設定で許可してください');
    return;
  }

  const mime = pickMime();
  let recorder;
  try {
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  } catch (_) {
    stream.getTracks().forEach(track => track.stop());
    setStatus('録音を開始できませんでした');
    return;
  }

  const chunks = [];
  const startedAt = Date.now();
  recordingLabel.textContent = '録音中';
  recordingTitle.textContent = '名前を話してください';
  recordingTimer.textContent = '00:00';
  recordingSheet.classList.remove('review');
  recordingSheet.classList.add('on', 'recording');
  const ticker = setInterval(() => {
    recordingTimer.textContent = formatDuration(Date.now() - startedAt);
  }, 200);
  const timeout = setTimeout(() => stopRecording(), RECORDING_LIMIT_MS);
  activeRecording = { recorder, stream, item, chunks, timeout, ticker, startedAt, discard: false };

  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
  recorder.onerror = () => {
    setStatus('録音中にエラーが起きました');
  };
  recorder.onstop = async () => {
    clearTimeout(timeout);
    clearInterval(ticker);
    stream.getTracks().forEach(track => track.stop());
    const shouldDiscard = activeRecording?.discard;
    recordingTimer.textContent = formatDuration(Date.now() - startedAt);
    activeRecording = null;
    if (shouldDiscard) {
      closeRecordingSheet();
      return;
    }
    if (!chunks.length) {
      closeRecordingSheet();
      setStatus('声を録音できませんでした。もう一度お試しください');
      return;
    }
    recordingDraft = { item, blob: new Blob(chunks, { type: recorder.mimeType || 'audio/mp4' }) };
    recordingLabel.textContent = '録音できました';
    recordingTitle.textContent = '声を確認してください';
    recordPreview.textContent = '▶ 声を聞く';
    recordPreview.dataset.idleLabel = '▶ 声を聞く';
    recordingSheet.classList.remove('recording');
    recordingSheet.classList.add('review');
  };
  recorder.start();
}

recordStop.addEventListener('click', stopRecording);
recordPreview.addEventListener('click', () => {
  if (recordingDraft) togglePlayback(recordingDraft.blob, recordPreview);
});
recordRetry.addEventListener('click', () => {
  if (!recordingDraft) return;
  const item = recordingDraft.item;
  closeRecordingSheet();
  beginRecording(item);
});
recordSave.addEventListener('click', async () => {
  if (!recordingDraft) return;
  recordingDraft.item.audio = recordingDraft.blob;
  await db.put(recordingDraft.item);
  closeRecordingSheet();
  await renderList();
  setStatus('声を保存しました。「声を聞く」で確認できます');
});
recordCancel.addEventListener('click', () => {
  if (activeRecording) {
    activeRecording.discard = true;
    stopRecording();
  } else {
    closeRecordingSheet();
  }
});

// --- 端末内データのバックアップ／復元 ---
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(value) {
  if (typeof value !== 'string' || !value.startsWith('data:')) throw new Error('不正なデータです');
  return (await fetch(value)).blob();
}

document.getElementById('backup').addEventListener('click', async () => {
  const items = await db.all();
  if (!items.length) {
    setStatus('バックアップする写真がありません');
    return;
  }
  setStatus('バックアップを作っています…');
  const records = [];
  for (const item of items) {
    records.push({
      image: await blobToDataUrl(item.image),
      audio: item.audio ? await blobToDataUrl(item.audio) : null,
      name: item.name || '',
      voice: voiceOf(item),
    });
  }
  const payload = JSON.stringify({ app: 'talking-album', version: 1, createdAt: new Date().toISOString(), items: records });
  const file = new File([payload], `zukan-backup-${new Date().toISOString().slice(0, 10)}.json`, { type: 'application/json' });

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ title: 'ずかんのバックアップ', files: [file] });
      setStatus('バックアップを共有しました');
      return;
    } catch (error) {
      if (error.name === 'AbortError') { setStatus('バックアップを中止しました'); return; }
    }
  }
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus('バックアップを保存しました');
});

document.getElementById('restore').addEventListener('change', async event => {
  const input = event.target;
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  if (!window.confirm('今ある写真と声を、バックアップの内容に置き換えますか？')) return;
  setStatus('バックアップを確認しています…');
  try {
    const payload = JSON.parse(await file.text());
    if (payload.app !== 'talking-album' || payload.version !== 1 || !Array.isArray(payload.items)) {
      throw new Error('このアプリのバックアップではありません');
    }
    if (payload.items.length > MAX_ITEMS) throw new Error(`写真は${MAX_ITEMS}枚までです`);
    const restored = [];
    for (const item of payload.items) {
      restored.push({
        image: await dataUrlToBlob(item.image),
        audio: item.audio ? await dataUrlToBlob(item.audio) : null,
        name: typeof item.name === 'string' ? item.name : '',
        voice: item.voice && typeof item.voice === 'object' ? { ...DEFAULT_VOICE, ...item.voice } : { ...DEFAULT_VOICE },
      });
    }
    await db.clear();
    for (const item of restored) await db.add(item);
    await requestPersistentStorage();
    await renderList();
    setStatus(`${restored.length}枚をもどしました`);
  } catch (error) {
    setStatus(error.message || 'バックアップをもどせませんでした');
  }
});

// --- 起動 ---
renderGrid().catch(() => {
  empty.hidden = false;
  empty.textContent = '写真を読み込めませんでした。ページを開き直してください。';
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
