// playbackEngine.js
// 「再生位置(playbackTime)」と「再生速度(playbackRate)」の2つの状態だけを操作する層。
// Buffer Engine(frameBuffer配列・insertSorted・findFrameAt)には一切触れない。
// フレームの実体取得は、呼び出し側が BufferEngine.findFrameAt(frameBuffer, playbackTime) を
// 使って行う。このモジュールは「どのtimestampを表示すべきか」だけを返す。
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PlaybackEngine = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MODE_FOLLOW = "follow"; // 通常の遅延再生（常に「今 - 遅延秒数」を追従）
  const MODE_MANUAL = "manual"; // ユーザー操作によって現在から切り離された状態

  class PlaybackEngine {
    /**
     * @param {Object} opts
     * @param {number} opts.delaySeconds 初期遅延秒数
     */
    constructor(opts) {
      opts = opts || {};
      this.delaySeconds = opts.delaySeconds || 10;

      this.mode = MODE_FOLLOW;
      this.playbackRate = 1;

      // 直近のupdate()呼び出しで計算された値のキャッシュ。
      // ボタン操作(seekBy等)はこのキャッシュを起点に状態を更新し、
      // 次のupdate()で正式に前進・クランプされる。
      this._lastNow = null;
      this._lastOldest = null;
      this._lastNewestAllowed = null;
      this.playbackTime = null;

      // スロー再生用: 終了時刻・速度・完了時コールバック
      this._slowEndTime = null;
      this._slowRate = null;
      this._onSlowComplete = null;
    }

    setDelaySeconds(sec) {
      this.delaySeconds = sec;
    }

    /**
     * 毎フレーム呼び出す。playbackTimeを前進・追従させ、bufferの範囲でクランプする。
     * @param {number} nowMs 現在時刻(performance.now()等、bufferEngineと同じ時間軸)
     * @param {number} oldestAvailableTime バッファ内最古フレームの時刻(バッファが空ならnowMsでよい)
     * @returns {number} 表示すべきplaybackTime
     */
    update(nowMs, oldestAvailableTime) {
      const newestAllowed = nowMs - this.delaySeconds * 1000;

      if (this.mode === MODE_FOLLOW) {
        this.playbackTime = newestAllowed;
      } else {
        const lastNow = this._lastNow != null ? this._lastNow : nowMs;
        const dt = nowMs - lastNow;
        if (this.playbackTime == null) this.playbackTime = newestAllowed;
        this.playbackTime += this.playbackRate * dt;

        // スロー再生の終了判定（時間経過に応じてplaybackTimeが進み、終了位置に到達したら復帰）
        if (this._slowEndTime != null && this.playbackRate > 0 && this.playbackTime >= this._slowEndTime) {
          this.playbackTime = this._slowEndTime;
          const cb = this._onSlowComplete;
          this._slowEndTime = null;
          this._slowRate = null;
          this._onSlowComplete = null;
          if (cb) cb(); // 通常は goLive() が呼ばれる想定
        }

        // クランプ: バッファ範囲より前 / 現在の遅延位置より先には行けない
        const lo = oldestAvailableTime != null ? oldestAvailableTime : newestAllowed;
        if (this.playbackTime < lo) this.playbackTime = lo;
        if (this.playbackTime > newestAllowed) this.playbackTime = newestAllowed;
      }

      this._lastNow = nowMs;
      this._lastOldest = oldestAvailableTime;
      this._lastNewestAllowed = newestAllowed;
      return this.playbackTime;
    }

    /** 現在、通常の遅延追従(DELAY)状態かどうか */
    isFollowing() {
      return this.mode === MODE_FOLLOW;
    }

    /** 一時停止：現在位置で停止する（スロー再生中の場合、スロー区間の情報は維持する） */
    pause() {
      this._enterManual();
      this.playbackRate = 0;
    }

    /**
     * 再生再開：現在位置から進める。
     * スロー区間の途中で一時停止していた場合は、1/3倍速(元のスロー速度)のまま再開する。
     */
    resume() {
      this._enterManual();
      this.playbackRate = this._slowEndTime != null ? (this._slowRate || 1) : 1;
    }

    /**
     * 指定秒数だけ再生位置を移動する（正で進む、負で戻る）。
     * スロー再生中に呼ばれた場合は、スロー状態を解除して通常速度の手動再生(REPLAY)へ移行する。
     */
    seekBy(deltaSec) {
      this._enterManual();
      this.playbackTime += deltaSec * 1000;
      if (this._lastOldest != null && this.playbackTime < this._lastOldest) {
        this.playbackTime = this._lastOldest;
      }
      if (this._lastNewestAllowed != null && this.playbackTime > this._lastNewestAllowed) {
        this.playbackTime = this._lastNewestAllowed;
      }
      if (this._slowEndTime != null) {
        // スロー再生中の5秒戻る/進むは、スロー状態を解除して通常速度の手動再生へ移行する
        this._slowEndTime = null;
        this._slowRate = null;
        this._onSlowComplete = null;
        this.playbackRate = 1;
      }
    }

    /** 通常の遅延追従(DELAY)へ復帰する。スロー再生中であれば即座に打ち切る。 */
    goLive() {
      this.mode = MODE_FOLLOW;
      this.playbackRate = 1;
      this._slowEndTime = null;
      this._slowRate = null;
      this._onSlowComplete = null;
    }

    /**
     * 「現在表示している再生位置」を基準に、その直前windowSec秒間をrate倍速で再生する（スロー確認）。
     * 基準はnowMsの直接計算ではなく、現在のplaybackTime（follow中ならnow-delay、既にmanual/slow中なら
     * その時点の表示位置）を使う。そのため、スロー再生中にもう一度呼び出すと、
     * 「その時点の表示位置から新しいスロー区間を開始する」形で自然に連打対策になる。
     */
    playRecentWindow(windowSec, rate, onComplete) {
      const referenceTime = this.playbackTime != null ? this.playbackTime : this._lastNewestAllowed;
      this._enterManual();

      const endTime = referenceTime;
      const startTime = endTime - windowSec * 1000;
      const lo = this._lastOldest != null ? this._lastOldest : startTime;
      this.playbackTime = Math.max(startTime, lo);
      this.playbackRate = rate;
      this._slowRate = rate;
      this._slowEndTime = endTime;
      this._onSlowComplete = onComplete || (() => this.goLive());
    }

    _enterManual() {
      if (this.mode === MODE_FOLLOW && this.playbackTime == null && this._lastNewestAllowed != null) {
        this.playbackTime = this._lastNewestAllowed;
      }
      this.mode = MODE_MANUAL;
    }

    /**
     * UI表示用の状態ラベルを導出する。状態を別途持たず、mode/playbackRate/_slowEndTimeから毎回計算する。
     * DELAY / PAUSE / REPLAY / SLOW / SLOW_PAUSED のいずれか。
     */
    getStateLabel() {
      if (this.mode === MODE_FOLLOW) return "DELAY";
      if (this._slowEndTime != null) return this.playbackRate === 0 ? "SLOW_PAUSED" : "SLOW";
      if (this.playbackRate === 0) return "PAUSE";
      return "REPLAY";
    }
  }

  return { PlaybackEngine, MODE_FOLLOW, MODE_MANUAL };
});
