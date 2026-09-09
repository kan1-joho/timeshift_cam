// storageEngine.js
// 「射」を端末内(IndexedDB)に保存・一覧・再生用読込・削除するための層。
//
// 責務分離:
//   Buffer Engine    : ライブ映像の一時バッファ(変更なし)
//   Playback Engine  : 再生位置・速度の管理(変更なし。保存済み射の再生にもそのまま使う)
//   Storage Engine(本ファイル): 保存・一覧・読込・削除。IndexedDBとのやり取りだけを担当する。
//
// 将来のExport Engine(MP4変換・共有等)は、本ファイルの上位に別モジュールとして追加する想定。
// 本ファイルはExport Engineの存在を知らない。
//
// データ構造:
//   shots (メタデータ) ........ { id, createdAt, durationMs, delaySecondsAtCapture, frameCount }
//   shotFrames (映像本体) ..... { shotId, relTime, blob }  ※shotIdごとに複数
// 「映像」と「映像に付随する情報」を別ストアに分離しているのは、将来マーキング等の
// メタデータだけを追記・更新したい場合に、画像データ本体へ触れずに済むようにするため。
//
// 純粋関数部分(generateShotId/selectFramesInRange/computeSaveRange/buildFrameRecords/
// buildShotMetadata/validateShotMetadata)はNode.jsから直接requireしてテストできる。
// IndexedDBを使う部分(openDb/saveShot/listShots/loadShotFrames/deleteShot)はブラウザ専用。
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.StorageEngine = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DB_NAME = "kyudoShotStorage";
  const DB_VERSION = 1;
  const SHOTS_STORE = "shots";
  const FRAMES_STORE = "shotFrames";

  // 将来「70%/75%/85%へ変更しやすいように」定数化する。
  const DEFAULT_JPEG_QUALITY = 0.8;

  // ---------------------------------------------------------------
  // 純粋関数（Node.jsでテスト可能。DOM/IndexedDBに依存しない）
  // ---------------------------------------------------------------

  let _idCounter = 0;
  // 時刻+連番+乱数で一意性を担保する。nowは注入可能(テスト用)。
  function generateShotId(now) {
    now = now != null ? now : Date.now();
    _idCounter = (_idCounter + 1) % 1000000;
    const rand = Math.random().toString(36).slice(2, 8);
    return "shot_" + now + "_" + _idCounter + "_" + rand;
  }

  // frameBuffer([{time,...}] time昇順)からstartTime<=time<=endTimeの範囲を抽出する。
  // Buffer Engineの内部実装(insertSorted/findFrameAt)には触れず、読み取るだけ。
  function selectFramesInRange(frameBuffer, startTime, endTime) {
    if (!frameBuffer.length) return [];
    const lo = lowerBound(frameBuffer, startTime);
    const hi = upperBound(frameBuffer, endTime);
    return frameBuffer.slice(lo, hi);
  }
  function lowerBound(frameBuffer, time) {
    let lo = 0, hi = frameBuffer.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (frameBuffer[mid].time < time) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  function upperBound(frameBuffer, time) {
    let lo = 0, hi = frameBuffer.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (frameBuffer[mid].time <= time) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // 保存対象の時間範囲を計算する。「保存操作時点(playbackTime)から過去windowSec秒」を基本とし、
  // バッファの最古時刻(oldestAvailableTime)より前にはならないようクランプする。
  function computeSaveRange(playbackTime, windowSec, oldestAvailableTime) {
    const idealStart = playbackTime - windowSec * 1000;
    const startTime =
      oldestAvailableTime != null ? Math.max(idealStart, oldestAvailableTime) : idealStart;
    return { startTime: startTime, endTime: playbackTime };
  }

  // 抽出したフレーム列に、先頭フレームからの相対時刻(relTime)を付与する。
  // 「24fpsだから計算で求める」のではなく、実際の撮影時刻(frame.time)の差分をそのまま使う。
  function buildFrameRecords(frames) {
    if (!frames.length) return [];
    const baseTime = frames[0].time;
    return frames.map((f) => ({ relTime: f.time - baseTime, bitmap: f.bitmap }));
  }

  const REQUIRED_SHOT_FIELDS = ["id", "createdAt", "durationMs", "delaySecondsAtCapture", "frameCount"];
  function validateShotMetadata(meta) {
    const missing = REQUIRED_SHOT_FIELDS.filter((k) => meta[k] === undefined || meta[k] === null);
    return { valid: missing.length === 0, missing: missing };
  }

  // 全フレームレコードから指定shotIdに属するものだけを抽出する。
  // 実際のdeleteShot()はIndexedDBの"byShotId"インデックスのカーソルで同じ絞り込みを行う。
  // ここでは削除対象の整合性(=shotIdでの絞り込みが正しく機能すること)をNode.jsでも
  // 検証できるよう、同じロジックを純粋関数として切り出す。
  function frameRecordsForShot(allFrameRecords, shotId) {
    return allFrameRecords.filter((r) => r.shotId === shotId);
  }

  // frameRecords: buildFrameRecordsの戻り値([{relTime,...}])
  function buildShotMetadata(opts) {
    const frameRecords = opts.frameRecords || [];
    const durationMs = frameRecords.length ? frameRecords[frameRecords.length - 1].relTime : 0;
    return {
      id: opts.id,
      createdAt: opts.createdAt,
      durationMs: durationMs,
      delaySecondsAtCapture: opts.delaySecondsAtCapture,
      frameCount: frameRecords.length,
    };
  }

  const api = {
    DEFAULT_JPEG_QUALITY: DEFAULT_JPEG_QUALITY,
    REQUIRED_SHOT_FIELDS: REQUIRED_SHOT_FIELDS,
    generateShotId: generateShotId,
    selectFramesInRange: selectFramesInRange,
    computeSaveRange: computeSaveRange,
    buildFrameRecords: buildFrameRecords,
    validateShotMetadata: validateShotMetadata,
    buildShotMetadata: buildShotMetadata,
    frameRecordsForShot: frameRecordsForShot,
  };

  // ---------------------------------------------------------------
  // IndexedDBを使う部分(ブラウザ専用)。
  // Node.js環境ではindexedDBが存在しないため、この先は定義しない
  // (Node側は上記の純粋関数だけをテストする)。
  // ---------------------------------------------------------------
  if (typeof indexedDB === "undefined") {
    return api;
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (ev) => {
        const db = ev.target.result;
        if (!db.objectStoreNames.contains(SHOTS_STORE)) {
          db.createObjectStore(SHOTS_STORE, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(FRAMES_STORE)) {
          const store = db.createObjectStore(FRAMES_STORE, { keyPath: ["shotId", "relTime"] });
          store.createIndex("byShotId", "shotId", { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function putShot(db, meta) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(SHOTS_STORE, "readwrite");
      tx.objectStore(SHOTS_STORE).put(meta);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function putFrame(db, record) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(FRAMES_STORE, "readwrite");
      tx.objectStore(FRAMES_STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * 射を保存する。フレームは1枚ずつJPEG化してIndexedDBへ書き込む逐次処理とし、
   * 10秒分すべてのJPEG Blobを配列にためてから一括保存する、といった実装は避ける
   * (メモリに大量のBlobを同時保持しないため)。
   *
   * @param {Array} frameBuffer ライブのframeBuffer配列(読み取り専用として扱う)
   * @param {Object} opts { playbackTime, windowSec, oldestAvailableTime, delaySecondsAtCapture,
   *                        jpegQuality, onProgress(done,total) }
   * @returns {Promise<Object|null>} 保存したshotのメタデータ。保存対象が0件ならnull。
   */
  async function saveShot(frameBuffer, opts) {
    const jpegQuality = opts.jpegQuality != null ? opts.jpegQuality : DEFAULT_JPEG_QUALITY;
    const { startTime, endTime } = computeSaveRange(
      opts.playbackTime,
      opts.windowSec,
      opts.oldestAvailableTime
    );
    const selected = selectFramesInRange(frameBuffer, startTime, endTime);
    if (!selected.length) return null;

    const baseTime = selected[0].time;
    const id = generateShotId();
    const db = await openDb();

    // 描画用canvasは使い回す(フレームごとに新規生成しない)
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { alpha: false });
    let sized = false;
    const frameRecordsForMeta = [];

    for (let i = 0; i < selected.length; i++) {
      const frame = selected[i];
      const bmp = frame.bitmap;
      if (!sized) {
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        sized = true;
      }
      ctx.drawImage(bmp, 0, 0);
      const relTime = frame.time - baseTime;
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", jpegQuality));
      await putFrame(db, { shotId: id, relTime: relTime, blob: blob });
      frameRecordsForMeta.push({ relTime: relTime });
      if (opts.onProgress) opts.onProgress(i + 1, selected.length);
      // このフレームのblobはすでにIndexedDBへ書き込み済みなので、ここでは参照を保持しない
    }

    const meta = buildShotMetadata({
      id: id,
      createdAt: Date.now(),
      frameRecords: frameRecordsForMeta,
      delaySecondsAtCapture: opts.delaySecondsAtCapture,
    });
    await putShot(db, meta);
    db.close();
    return meta;
  }

  /** 保存済みのshot一覧をcreatedAt昇順で返す */
  async function listShots() {
    const db = await openDb();
    const result = await new Promise((resolve, reject) => {
      const tx = db.transaction(SHOTS_STORE, "readonly");
      const req = tx.objectStore(SHOTS_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    db.close();
    result.sort((a, b) => a.createdAt - b.createdAt);
    return result;
  }

  /**
   * 指定shotの全フレームを読み込み、Playback Engine/Buffer Engineがそのまま扱える
   * {time, bitmap} 形状の配列にして返す(time=relTimeをそのまま使う。0起点の独立した時間軸)。
   */
  async function loadShotFrames(shotId) {
    const db = await openDb();
    const records = await new Promise((resolve, reject) => {
      const tx = db.transaction(FRAMES_STORE, "readonly");
      const index = tx.objectStore(FRAMES_STORE).index("byShotId");
      const req = index.getAll(IDBKeyRange.only(shotId));
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    db.close();
    records.sort((a, b) => a.relTime - b.relTime);
    const frames = [];
    for (const r of records) {
      const bitmap = await createImageBitmap(r.blob);
      frames.push({ time: r.relTime, bitmap: bitmap });
    }
    return frames;
  }

  /** shotのメタデータと、それに紐づく全フレームを削除する */
  async function deleteShot(shotId) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction([SHOTS_STORE, FRAMES_STORE], "readwrite");
      tx.objectStore(SHOTS_STORE).delete(shotId);
      const frameStore = tx.objectStore(FRAMES_STORE);
      const index = frameStore.index("byShotId");
      const cursorReq = index.openCursor(IDBKeyRange.only(shotId));
      cursorReq.onsuccess = (ev) => {
        const cursor = ev.target.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  api.saveShot = saveShot;
  api.listShots = listShots;
  api.loadShotFrames = loadShotFrames;
  api.deleteShot = deleteShot;
  return api;
});
