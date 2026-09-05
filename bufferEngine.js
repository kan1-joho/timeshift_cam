// bufferEngine.js
// フレームバッファの中核ロジック（時刻順挿入・時刻検索）。
// ブラウザ(<script>)とNode.js(require)の両方から同一コードを利用することで、
// 実装とテストの間にロジックの差異が生じないようにする。
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.BufferEngine = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // time昇順を保った挿入。非同期完了順が撮影順と一致しない場合の対策。
  // frame: { time: number, bitmap: any }
  function insertSorted(frameBuffer, frame) {
    const n = frameBuffer.length;
    if (n === 0 || frame.time >= frameBuffer[n - 1].time) {
      frameBuffer.push(frame);
      return frameBuffer.length - 1;
    }
    let lo = 0, hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (frameBuffer[mid].time < frame.time) lo = mid + 1;
      else hi = mid;
    }
    frameBuffer.splice(lo, 0, frame);
    return lo;
  }

  // targetTime以下で最大のtimeを持つフレームを二分探索で返す
  function findFrameAt(frameBuffer, targetTime) {
    const n = frameBuffer.length;
    if (n === 0) return null;
    if (frameBuffer[0].time > targetTime) return frameBuffer[0];
    if (frameBuffer[n - 1].time <= targetTime) return frameBuffer[n - 1];

    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (frameBuffer[mid].time <= targetTime) lo = mid;
      else hi = mid - 1;
    }
    return frameBuffer[lo];
  }

  // 参照実装（線形探索）。テストでの正しさの突き合わせ用。
  function findFrameAtLinear(frameBuffer, targetTime) {
    for (let i = frameBuffer.length - 1; i >= 0; i--) {
      if (frameBuffer[i].time <= targetTime) return frameBuffer[i];
    }
    return frameBuffer.length ? frameBuffer[0] : null;
  }

  // 配列がtime昇順になっているかを検証
  function isSortedAscending(frameBuffer) {
    for (let i = 1; i < frameBuffer.length; i++) {
      if (frameBuffer[i].time < frameBuffer[i - 1].time) return false;
    }
    return true;
  }

  // ---- STEP8: コマ送り用のフレーム時刻問い合わせAPI ----
  // frameBufferの内部管理方法(insertSorted/findFrameAtの実装)には一切手を加えず、
  // 「指定時刻の前後に実際に存在するフレームの時刻」を返すだけの純粋関数として追加する。

  // time未満で最大のtimeを持つインデックスの直後(=time以上の最小インデックス)を返す
  function bisectLeft(frameBuffer, time) {
    let lo = 0, hi = frameBuffer.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (frameBuffer[mid].time < time) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // time以下の要素数(=timeより大きい最小インデックス)を返す
  function bisectRight(frameBuffer, time) {
    let lo = 0, hi = frameBuffer.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (frameBuffer[mid].time <= time) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // 指定時刻より前に実際に存在する直前のフレーム時刻。無ければnull(=それ以上戻れない)。
  function getPreviousFrameTime(frameBuffer, time) {
    const idx = bisectLeft(frameBuffer, time) - 1;
    return idx >= 0 ? frameBuffer[idx].time : null;
  }

  // 指定時刻より後に実際に存在する直後のフレーム時刻。無ければnull(=それ以上進めない)。
  function getNextFrameTime(frameBuffer, time) {
    const idx = bisectRight(frameBuffer, time);
    return idx < frameBuffer.length ? frameBuffer[idx].time : null;
  }

  return {
    insertSorted,
    findFrameAt,
    findFrameAtLinear,
    isSortedAscending,
    getPreviousFrameTime,
    getNextFrameTime,
  };
});
