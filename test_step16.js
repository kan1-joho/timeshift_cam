// test_step16.js
//
// STEP16(保存済み射 x 保存済み射「2画面比較」同期機能)のうち、Node.jsで検証可能な範囲を
// テストする。DOM(canvas等)に依存する部分は実際のindex.htmlでは動かせないため、
// test_step15.jsと同じ考え方で「チャンネル(A/B)ごとの状態管理ロジック」を、実際の
// bufferEngine.js/playbackEngine.jsを使ったプレーンなオブジェクトとして再現する。
// ロジック自体はindex.html内のsetComparisonTime()/setComparisonSync()/comparisonLoop()の
// 同期ブランチと同じ考え方(Aを駆動チャンネルとして前進させ、その結果をBへクランプ適用する)
// を用いている。index.html側を変更した場合はここも合わせて更新すること。
//
// 19節の注意事項の通り、24fpsのbuildFrameBuffer()は必ずしも「ちょうど◯◯ms」になるとは
// 限らない(浮動小数点の積み上げにより最終フレームが名目値よりわずかに小さくなることがある)ため、
// 固定値への依存を避け、実際のframe.time / channel.durationMsを基準にテストする。
//
// 既存テスト(test_coordinateEngine.js / test_step11.js〜test_step15.js)は本ファイルの対象外。
// 別途そのまま実行し、回帰がないことを確認すること。

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { PlaybackEngine } = require("./playbackEngine.js");
const BufferEngine = require("./bufferEngine.js");
const CoordinateEngine = require("./coordinateEngine.js");

let passCount = 0;
function check(name, fn) {
  try {
    fn();
    passCount++;
    console.log("  OK  " + name);
  } catch (e) {
    console.log("  NG  " + name);
    console.log("      " + e.message);
    process.exitCode = 1;
  }
}

const REVIEW_TIME_HEADROOM_MS = 1e7;
const REVIEW_DELAY_SECONDS = 0.001;
const DEFAULT_SLOW_RATE = 1 / 3;
const DEFAULT_SLOW_WINDOW_SEC = 5;
const SEEK_STEP_SEC = 5;

function buildFrameBuffer(durationMs, fps) {
  const frames = [];
  const step = 1000 / fps;
  for (let t = 0; t <= durationMs; t += step) frames.push({ time: Math.round(t), bitmap: { width: 640, height: 360 } });
  return frames;
}
function makeShot(id, durationSec) {
  return { id: id, createdAt: Date.now(), durationMs: durationSec * 1000 };
}

// ---------------------------------------------------------------
// index.htmlのcreateComparisonChannel()/loadShotIntoChannel()と同じ考え方(DOM抜き)
// ---------------------------------------------------------------
function createFakeChannel(label) {
  return {
    label: label,
    shotId: null,
    frameBuffer: null,
    durationMs: 0,
    playback: null,
    markings: [],
    markingMode: false,
    slowRate: DEFAULT_SLOW_RATE,
    slowWindowSec: DEFAULT_SLOW_WINDOW_SEC,
    clockBase: null,
  };
}
function comparisonNow(channel, realNow) {
  if (channel.clockBase === null) channel.clockBase = realNow;
  return REVIEW_TIME_HEADROOM_MS + (realNow - channel.clockBase);
}
function clampComparisonTime(channel, t) {
  return Math.max(0, Math.min(channel.durationMs, t));
}
function visibleComparisonMarkings(channel) {
  if (!channel.frameBuffer || !channel.frameBuffer.length || !channel.playback) return [];
  const frame = BufferEngine.findFrameAt(channel.frameBuffer, channel.playback.playbackTime);
  if (!frame) return [];
  return channel.markings.filter((m) => m.relTime === frame.time);
}
function loadShotIntoChannel(channel, shot, frameBuffer, markings) {
  channel.shotId = shot.id;
  channel.frameBuffer = frameBuffer;
  channel.durationMs = frameBuffer[frameBuffer.length - 1].time;
  channel.markings = markings || [];
  channel.markingMode = false;
  channel.slowRate = DEFAULT_SLOW_RATE;
  channel.slowWindowSec = DEFAULT_SLOW_WINDOW_SEC;
  channel.clockBase = null;
  channel.playback = new PlaybackEngine({ delaySeconds: REVIEW_DELAY_SECONDS });
  channel.playback.update(comparisonNow(channel, performance.now()), 0);
  channel.playback.seekToTime(0);
  channel.playback.playbackTime = clampComparisonTime(channel, channel.playback.playbackTime);
  channel.playback.pause();
}
function advanceComparisonChannel(channel, realNow) {
  if (!channel.playback || !channel.frameBuffer) return;
  const t = channel.playback.update(comparisonNow(channel, realNow), 0);
  channel.playback.playbackTime = clampComparisonTime(channel, t);
}

// ---------------------------------------------------------------
// index.htmlのsetComparisonTime()/setComparisonSync()/handleSyncedComparisonAction()/
// comparisonLoop()の同期ブランチと同じロジック
// ---------------------------------------------------------------
function makeComparisonSession() {
  const session = {
    A: createFakeChannel("A"),
    B: createFakeChannel("B"),
    syncEnabled: false,
    syncTime: 0,
  };
  return session;
}

function setComparisonTime(session, timeMs, pauseAfter) {
  session.syncTime = timeMs;
  [session.A, session.B].forEach((channel) => {
    if (!channel.playback) return;
    const t = clampComparisonTime(channel, timeMs);
    channel.playback.seekToTime(t);
    channel.playback.playbackTime = t;
    if (pauseAfter) channel.playback.pause();
  });
}

function setComparisonSync(session, on) {
  session.syncEnabled = on;
  if (!on) {
    // index.htmlの修正と同じ: 同期中はB.playback.update()を呼んでいないため、Bの内部時計が
    // 止まったままになる。OFFに戻す瞬間、表示位置(playbackTime)は変えずに内部時計だけを
    // 現在時刻へ再同期しておく(でないと次のupdate()で溜め込んだdtが一気に適用されてしまう)。
    if (session.B.playback) {
      const keepTime = session.B.playback.playbackTime;
      session.B.playback.update(comparisonNow(session.B, performance.now()), 0);
      session.B.playback.playbackTime = keepTime;
    }
    return;
  }
  if (!session.A.playback || !session.B.playback) return;
  session.A.playback.pause();
  session.B.playback.pause();
  session.B.slowRate = session.A.slowRate;
  session.B.slowWindowSec = session.A.slowWindowSec;
  setComparisonTime(session, session.A.playback.playbackTime, false);
}

function handleSyncedAction(session, sourceLabel, act) {
  const source = sourceLabel === "A" ? session.A : session.B;
  switch (act) {
    case "seekBack":
      setComparisonTime(session, session.syncTime - SEEK_STEP_SEC * 1000, false);
      break;
    case "seekFwd":
      setComparisonTime(session, session.syncTime + SEEK_STEP_SEC * 1000, false);
      break;
    case "stepBack": {
      const t = BufferEngine.getPreviousFrameTime(source.frameBuffer, source.playback.playbackTime);
      if (t == null) return;
      setComparisonTime(session, t, true);
      break;
    }
    case "stepFwd": {
      const t = BufferEngine.getNextFrameTime(source.frameBuffer, source.playback.playbackTime);
      if (t == null || t > source.durationMs) return;
      setComparisonTime(session, t, true);
      break;
    }
    case "playPause": {
      const shouldResume = source.playback.getStateLabel() === "PAUSE";
      [session.A, session.B].forEach((ch) => {
        if (!ch.playback) return;
        if (shouldResume) ch.playback.resume();
        else ch.playback.pause();
      });
      break;
    }
    case "slowCheck": {
      const rate = session.A.slowRate;
      const windowSec = session.A.slowWindowSec;
      // index.htmlの修正と同じ: Bは毎フレームAの結果をそのまま反映するだけなので、
      // B自身にplayRecentWindow()を発行しない(Bの_slowEndTime等が消費されずに残ることを防ぐ)。
      session.A.playback.playRecentWindow(windowSec, rate, () => {
        session.A.playback.pause();
        session.B.playback.pause();
      });
      break;
    }
  }
}

function setComparisonSlowRate(session, channel, rate) {
  if (session.syncEnabled) {
    session.A.slowRate = rate;
    session.B.slowRate = rate;
  } else {
    channel.slowRate = rate;
  }
}
function setComparisonSlowWindow(session, channel, sec) {
  if (session.syncEnabled) {
    session.A.slowWindowSec = sec;
    session.B.slowWindowSec = sec;
  } else {
    channel.slowWindowSec = sec;
  }
}

/** comparisonLoop()の同期ブランチと同じ考え方: Aを駆動チャンネルとして前進させ、Bへ適用する。 */
function tickSyncedFrame(session, realNow) {
  if (session.syncEnabled) {
    advanceComparisonChannel(session.A, realNow);
    session.syncTime = session.A.playback.playbackTime;
    if (session.B.playback) {
      session.B.playback.playbackTime = clampComparisonTime(session.B, session.syncTime);
      session.B.playback.playbackRate = session.A.playback.playbackRate;
    }
  } else {
    advanceComparisonChannel(session.A, realNow);
    advanceComparisonChannel(session.B, realNow);
  }
}

// =================================================================
// テスト本体
// =================================================================

console.log("\n[STEP16] 基本");

check("初期状態は同期OFF", () => {
  const session = makeComparisonSession();
  assert.strictEqual(session.syncEnabled, false);
});

check("同期ON/OFFを切り替えられる", () => {
  const session = makeComparisonSession();
  loadShotIntoChannel(session.A, makeShot("shotA", 10), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), buildFrameBuffer(10000, 24), []);
  setComparisonSync(session, true);
  assert.strictEqual(session.syncEnabled, true);
  setComparisonSync(session, false);
  assert.strictEqual(session.syncEnabled, false);
});

check("同期ON時にA/Bの時間が一致する", () => {
  const session = makeComparisonSession();
  loadShotIntoChannel(session.A, makeShot("shotA", 10), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), buildFrameBuffer(10000, 24), []);
  session.A.playback.seekToTime(3500);
  session.A.playback.pause();
  setComparisonSync(session, true);
  assert.strictEqual(session.A.playback.playbackTime, session.B.playback.playbackTime);
});

check("同期ONにした瞬間、BがAの時間へ移動する(Aを基準にする、4節)", () => {
  const session = makeComparisonSession();
  loadShotIntoChannel(session.A, makeShot("shotA", 10), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), buildFrameBuffer(10000, 24), []);
  session.A.playback.seekToTime(2400);
  session.A.playback.pause();
  session.B.playback.seekToTime(6800);
  session.B.playback.pause();
  setComparisonSync(session, true);
  assert.strictEqual(session.A.playback.playbackTime, 2400);
  assert.strictEqual(session.B.playback.playbackTime, 2400, "Bの位置がAに合わせられていない");
});

console.log("\n[STEP16] 5秒操作");

check("Aの5秒戻るがBにも反映される", () => {
  const session = makeComparisonSession();
  loadShotIntoChannel(session.A, makeShot("shotA", 10), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), buildFrameBuffer(10000, 24), []);
  setComparisonSync(session, true); // 0秒同期状態から開始
  setComparisonTime(session, 6000, false);
  handleSyncedAction(session, "A", "seekBack");
  assert.strictEqual(session.A.playback.playbackTime, 1000);
  assert.strictEqual(session.B.playback.playbackTime, 1000);
});

check("Bの5秒戻るがAにも反映される", () => {
  const session = makeComparisonSession();
  loadShotIntoChannel(session.A, makeShot("shotA", 10), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), buildFrameBuffer(10000, 24), []);
  setComparisonSync(session, true);
  setComparisonTime(session, 6000, false);
  handleSyncedAction(session, "B", "seekBack");
  assert.strictEqual(session.A.playback.playbackTime, 1000);
  assert.strictEqual(session.B.playback.playbackTime, 1000);
});

check("Aの5秒進むがBにも反映される", () => {
  const session = makeComparisonSession();
  loadShotIntoChannel(session.A, makeShot("shotA", 10), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), buildFrameBuffer(10000, 24), []);
  setComparisonSync(session, true);
  setComparisonTime(session, 1000, false);
  handleSyncedAction(session, "A", "seekFwd");
  assert.strictEqual(session.A.playback.playbackTime, 6000);
  assert.strictEqual(session.B.playback.playbackTime, 6000);
});

check("Bの5秒進むがAにも反映される", () => {
  const session = makeComparisonSession();
  loadShotIntoChannel(session.A, makeShot("shotA", 10), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), buildFrameBuffer(10000, 24), []);
  setComparisonSync(session, true);
  setComparisonTime(session, 1000, false);
  handleSyncedAction(session, "B", "seekFwd");
  assert.strictEqual(session.A.playback.playbackTime, 6000);
  assert.strictEqual(session.B.playback.playbackTime, 6000);
});

console.log("\n[STEP16] 1F操作");

check("Aの1F戻るでBも同期する(Aのフレーム時刻を共通時間として採用)", () => {
  const session = makeComparisonSession();
  const framesA = buildFrameBuffer(10000, 24);
  const framesB = buildFrameBuffer(10000, 24);
  loadShotIntoChannel(session.A, makeShot("shotA", 10), framesA, []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), framesB, []);
  setComparisonSync(session, true);
  setComparisonTime(session, 5000, true);
  const expected = BufferEngine.getPreviousFrameTime(framesA, session.A.playback.playbackTime);
  handleSyncedAction(session, "A", "stepBack");
  assert.strictEqual(session.A.playback.playbackTime, expected);
  assert.strictEqual(session.B.playback.playbackTime, clampComparisonTime(session.B, expected));
  assert.strictEqual(session.A.playback.getStateLabel(), "PAUSE");
  assert.strictEqual(session.B.playback.getStateLabel(), "PAUSE");
});

check("Bの1F戻るでAも同期する", () => {
  const session = makeComparisonSession();
  const framesA = buildFrameBuffer(10000, 24);
  const framesB = buildFrameBuffer(10000, 24);
  loadShotIntoChannel(session.A, makeShot("shotA", 10), framesA, []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), framesB, []);
  setComparisonSync(session, true);
  setComparisonTime(session, 5000, true);
  const expected = BufferEngine.getPreviousFrameTime(framesB, session.B.playback.playbackTime);
  handleSyncedAction(session, "B", "stepBack");
  assert.strictEqual(session.B.playback.playbackTime, expected);
  assert.strictEqual(session.A.playback.playbackTime, clampComparisonTime(session.A, expected));
});

check("Aの1F進むでBも同期する", () => {
  const session = makeComparisonSession();
  const framesA = buildFrameBuffer(10000, 24);
  const framesB = buildFrameBuffer(10000, 24);
  loadShotIntoChannel(session.A, makeShot("shotA", 10), framesA, []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), framesB, []);
  setComparisonSync(session, true);
  setComparisonTime(session, 5000, true);
  const expected = BufferEngine.getNextFrameTime(framesA, session.A.playback.playbackTime);
  handleSyncedAction(session, "A", "stepFwd");
  assert.strictEqual(session.A.playback.playbackTime, expected);
  assert.strictEqual(session.B.playback.playbackTime, clampComparisonTime(session.B, expected));
});

check("Bの1F進むでAも同期する", () => {
  const session = makeComparisonSession();
  const framesA = buildFrameBuffer(10000, 24);
  const framesB = buildFrameBuffer(10000, 24);
  loadShotIntoChannel(session.A, makeShot("shotA", 10), framesA, []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), framesB, []);
  setComparisonSync(session, true);
  setComparisonTime(session, 5000, true);
  const expected = BufferEngine.getNextFrameTime(framesB, session.B.playback.playbackTime);
  handleSyncedAction(session, "B", "stepFwd");
  assert.strictEqual(session.B.playback.playbackTime, expected);
  assert.strictEqual(session.A.playback.playbackTime, clampComparisonTime(session.A, expected));
});

console.log("\n[STEP16] 再生/停止");

check("Aの再生でA/B両方が再生になる", () => {
  const session = makeComparisonSession();
  loadShotIntoChannel(session.A, makeShot("shotA", 10), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), buildFrameBuffer(10000, 24), []);
  setComparisonSync(session, true);
  handleSyncedAction(session, "A", "playPause"); // 両方PAUSEの状態からトグル→両方再生
  assert.strictEqual(session.A.playback.getStateLabel(), "REPLAY");
  assert.strictEqual(session.B.playback.getStateLabel(), "REPLAY");
});

check("Bの再生でA/B両方が再生になる", () => {
  const session = makeComparisonSession();
  loadShotIntoChannel(session.A, makeShot("shotA", 10), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), buildFrameBuffer(10000, 24), []);
  setComparisonSync(session, true);
  handleSyncedAction(session, "B", "playPause");
  assert.strictEqual(session.A.playback.getStateLabel(), "REPLAY");
  assert.strictEqual(session.B.playback.getStateLabel(), "REPLAY");
});

check("Aの停止でA/B両方が停止になる", () => {
  const session = makeComparisonSession();
  loadShotIntoChannel(session.A, makeShot("shotA", 10), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), buildFrameBuffer(10000, 24), []);
  setComparisonSync(session, true);
  handleSyncedAction(session, "A", "playPause"); // 再生
  handleSyncedAction(session, "A", "playPause"); // 停止
  assert.strictEqual(session.A.playback.getStateLabel(), "PAUSE");
  assert.strictEqual(session.B.playback.getStateLabel(), "PAUSE");
});

check("Bの停止でA/B両方が停止になる", () => {
  const session = makeComparisonSession();
  loadShotIntoChannel(session.A, makeShot("shotA", 10), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), buildFrameBuffer(10000, 24), []);
  setComparisonSync(session, true);
  handleSyncedAction(session, "B", "playPause"); // 再生
  handleSyncedAction(session, "B", "playPause"); // 停止
  assert.strictEqual(session.A.playback.getStateLabel(), "PAUSE");
  assert.strictEqual(session.B.playback.getStateLabel(), "PAUSE");
});

console.log("\n[STEP16] スロー設定・スロー確認");

check("Aで速度変更するとBにも反映される", () => {
  const session = makeComparisonSession();
  loadShotIntoChannel(session.A, makeShot("shotA", 10), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), buildFrameBuffer(10000, 24), []);
  setComparisonSync(session, true);
  setComparisonSlowRate(session, session.A, 1 / 4);
  assert.strictEqual(session.A.slowRate, 1 / 4);
  assert.strictEqual(session.B.slowRate, 1 / 4);
});

check("Bで速度変更するとAにも反映される", () => {
  const session = makeComparisonSession();
  loadShotIntoChannel(session.A, makeShot("shotA", 10), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), buildFrameBuffer(10000, 24), []);
  setComparisonSync(session, true);
  setComparisonSlowRate(session, session.B, 1 / 2);
  assert.strictEqual(session.A.slowRate, 1 / 2);
  assert.strictEqual(session.B.slowRate, 1 / 2);
});

check("Aのスロー確認でBも同じ速度で追従する", () => {
  const session = makeComparisonSession();
  loadShotIntoChannel(session.A, makeShot("shotA", 10), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), buildFrameBuffer(10000, 24), []);
  setComparisonSync(session, true);
  setComparisonTime(session, 6000, true);
  handleSyncedAction(session, "A", "slowCheck");
  // 実際にスロー区間の状態(_slowEndTime等)を持つのは、駆動側であるAだけ
  // (Bは毎フレームAのplaybackRateをそのまま反映するだけで、B自身はplayRecentWindow()を
  // 発行しない設計にした。詳細はcomparisonSyncSlowCheck()のコメントを参照)。
  assert.strictEqual(session.A.playback.getStateLabel(), "SLOW");
  assert.ok(session.A.playback.playbackRate > 0 && session.A.playback.playbackRate < 1);

  // Bへのレート反映はcomparisonLoop(=tickSyncedFrame)の次回tickで行われる
  // (index.html側もRAFの次フレームで反映される設計のため、これは実装と一致する)。
  let realNow = performance.now();
  const beforeA = session.A.playback.playbackTime;
  const beforeB = session.B.playback.playbackTime;
  realNow += 16;
  tickSyncedFrame(session, realNow);

  assert.strictEqual(session.B.playback.playbackRate, session.A.playback.playbackRate, "BのレートがAに追従していない");
  assert.ok(session.A.playback.playbackTime > beforeA, "Aが前進していない");
  assert.strictEqual(session.B.playback.playbackTime, session.A.playback.playbackTime, "Bのplaybackが同期していない");
  assert.notStrictEqual(session.B.playback.playbackTime, beforeB, "Bが前進していない");
});

check("Bのスロー確認でもAが駆動され、Bが追従する", () => {
  const session = makeComparisonSession();
  loadShotIntoChannel(session.A, makeShot("shotA", 10), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), buildFrameBuffer(10000, 24), []);
  setComparisonSync(session, true);
  setComparisonTime(session, 6000, true);
  // Bのボタンから操作しても、同期中は常にAが駆動側になる(comparisonSyncSlowCheck()の設計)
  handleSyncedAction(session, "B", "slowCheck");
  assert.strictEqual(session.A.playback.getStateLabel(), "SLOW");

  const realNow = performance.now() + 16;
  tickSyncedFrame(session, realNow);
  assert.strictEqual(session.B.playback.playbackRate, session.A.playback.playbackRate);
});

console.log("\n[STEP16] duration差・終端安全性");

check("A/Bのdurationが異なる場合、短い側を超えない", () => {
  const session = makeComparisonSession();
  loadShotIntoChannel(session.A, makeShot("shotA", 10), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 7), buildFrameBuffer(7000, 24), []);
  setComparisonSync(session, true);
  setComparisonTime(session, 8000, false); // 3節の例(比較時間8.0秒 → A 8.0秒, B 7.0秒)と同じ状況
  assert.strictEqual(session.A.playback.playbackTime, 8000);
  assert.strictEqual(session.B.playback.playbackTime, session.B.durationMs);
  assert.ok(session.B.playback.playbackTime <= session.B.durationMs);
});

check("片方の終端に達しても、通常再生中に範囲外へ行かない(comparisonLoopの同期ブランチ)", () => {
  const session = makeComparisonSession();
  loadShotIntoChannel(session.A, makeShot("shotA", 10), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 6), buildFrameBuffer(6000, 24), []);
  setComparisonSync(session, true);
  setComparisonTime(session, 5500, false);
  session.A.playback.resume();
  session.B.playback.playbackRate = session.A.playback.playbackRate;

  let realNow = performance.now();
  for (let i = 0; i < 30; i++) {
    realNow += 33; // 約1秒分
    tickSyncedFrame(session, realNow);
  }
  assert.ok(session.A.playback.playbackTime <= session.A.durationMs);
  assert.ok(session.B.playback.playbackTime <= session.B.durationMs);
  assert.strictEqual(session.B.playback.playbackTime, session.B.durationMs, "Bは自分のdurationで頭打ちになっているはず");
});

console.log("\n[STEP16] 同期OFF後の独立性");

check("同期OFF後はA/Bが独立して操作できる", () => {
  const session = makeComparisonSession();
  loadShotIntoChannel(session.A, makeShot("shotA", 10), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), buildFrameBuffer(10000, 24), []);
  setComparisonSync(session, true);
  setComparisonTime(session, 5000, false);
  setComparisonSync(session, false);
  assert.strictEqual(session.syncEnabled, false);
  // 同期OFF後は、A/Bそれぞれ独立にseekBy等を呼べる(STEP15の独立動作へ戻る)
  session.A.playback.seekBy(-SEEK_STEP_SEC);
  session.A.playback.playbackTime = clampComparisonTime(session.A, session.A.playback.playbackTime);
  assert.strictEqual(session.A.playback.playbackTime, 0);
  assert.strictEqual(session.B.playback.playbackTime, 5000, "Bは変化しないはず");
});

check("同期OFF後のA操作がBへ影響しない", () => {
  const session = makeComparisonSession();
  loadShotIntoChannel(session.A, makeShot("shotA", 10), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), buildFrameBuffer(10000, 24), []);
  setComparisonSync(session, true);
  setComparisonTime(session, 3000, false);
  setComparisonSync(session, false);
  session.A.playback.seekBy(SEEK_STEP_SEC);
  session.A.playback.playbackTime = clampComparisonTime(session.A, session.A.playback.playbackTime);
  assert.strictEqual(session.A.playback.playbackTime, 8000);
  assert.strictEqual(session.B.playback.playbackTime, 3000);
});

check("同期OFF後のB操作がAへ影響しない", () => {
  const session = makeComparisonSession();
  loadShotIntoChannel(session.A, makeShot("shotA", 10), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), buildFrameBuffer(10000, 24), []);
  setComparisonSync(session, true);
  setComparisonTime(session, 3000, false);
  setComparisonSync(session, false);
  session.B.playback.seekBy(SEEK_STEP_SEC);
  session.B.playback.playbackTime = clampComparisonTime(session.B, session.B.playback.playbackTime);
  assert.strictEqual(session.B.playback.playbackTime, 8000);
  assert.strictEqual(session.A.playback.playbackTime, 3000);
});

console.log("\n[STEP16] マーキング表示への非影響(STEP13のA方式を維持)");

check("relTime === currentFrame.time の表示条件は同期ONでも変わらない", () => {
  const session = makeComparisonSession();
  const framesA = buildFrameBuffer(10000, 24);
  const markingA = {
    id: CoordinateEngine.generateMarkingId(),
    shotId: "shotA",
    relTime: BufferEngine.findFrameAt(framesA, 3250).time,
    type: "freehand",
    points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }],
    createdAt: Date.now(),
  };
  loadShotIntoChannel(session.A, makeShot("shotA", 10), framesA, [markingA]);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), buildFrameBuffer(10000, 24), []);
  session.A.markingMode = true;
  setComparisonSync(session, true);
  setComparisonTime(session, markingA.relTime, true);
  assert.strictEqual(visibleComparisonMarkings(session.A).length, 1);
  const prevFrameTime = BufferEngine.getPreviousFrameTime(framesA, markingA.relTime);
  setComparisonTime(session, prevFrameTime, true);
  assert.strictEqual(visibleComparisonMarkings(session.A).length, 0, "1つ前のフレームでは表示されない(B方式=常時表示ではない)");
});

console.log("\n[STEP16] セッション・単一レビューへの非影響");

check("比較画面を閉じると同期状態がリセットされる(index.htmlのcloseComparison静的確認)", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const fnMatch = html.match(/function closeComparison\(\)[\s\S]*?\n  \}/);
  assert.ok(fnMatch, "closeComparison()が見つからない");
  const body = fnMatch[0];
  assert.ok(body.includes("comparisonSyncEnabled = false"), "closeComparison()内で同期状態をリセットしていない");
  assert.ok(body.includes("comparisonSyncTime = 0"));
});

check("再度比較画面を開くと同期OFFから始まる(index.htmlのopenComparison静的確認)", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const fnMatch = html.match(/async function openComparison\([\s\S]*?\n  \}/);
  assert.ok(fnMatch, "openComparison()が見つからない");
  assert.ok(fnMatch[0].includes("setComparisonSync(false)"), "openComparison()内でsetComparisonSync(false)を呼んでいない");
});

check("単一射レビューのshotPlaybackに影響しない(index.htmlの静的確認: STEP16のコードがshotPlaybackを一切参照していない)", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const startIdx = html.indexOf("STEP16: A/B同期");
  const endIdx = html.indexOf("async function openShotReview(shot)");
  assert.ok(startIdx >= 0 && endIdx > startIdx, "STEP16セクションの範囲を特定できない");
  const step16Src = html.slice(startIdx, endIdx);
  assert.ok(!step16Src.includes("shotPlayback"), "STEP16のコードが単一レビューのshotPlaybackに触れている");
});

check("同期処理がIndexedDBへ書き込みを行わない(既存の書き込み系APIを一切呼んでいない)", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const startIdx = html.indexOf("STEP16: A/B同期");
  const endIdx = html.indexOf("async function openShotReview(shot)");
  const step16Src = html.slice(startIdx, endIdx);
  ["StorageEngine.saveShot", "StorageEngine.saveMarking", "StorageEngine.deleteShot", "StorageEngine.deleteMarking", "StorageEngine.deleteShotMarkings"].forEach(
    (writeApi) => {
      assert.ok(!step16Src.includes(writeApi), "同期関連コードが書き込み系API(" + writeApi + ")を呼んでいる");
    }
  );
});

check("PlaybackEngine/BufferEngineは変更されていない(同期はA/B独立エンジンの上に実装されている)", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  assert.ok(html.includes("comparisonA.playback"));
  assert.ok(html.includes("comparisonB.playback"));
  assert.ok(!html.includes("comparisonPlayback ="), "A/B共通のPlaybackEngineに統合していないことの確認(単一の共通変数を作っていないか)");
});

console.log("\n" + passCount + " 件成功" + (process.exitCode ? " / 失敗あり" : " / 全て成功"));
console.log(
  "\n[注記] 以下はNode.jsでは検証できず、実機確認が必要です:\n" +
    "  - 同期ON/OFFボタンの見た目・タップ反応\n" +
    "  - 同期中の2画面が実際に視覚的にズレなく揃って見えるか\n" +
    "  - 同期中のスロー確認の見た目\n" +
    "  - 長時間の同期再生でA/Bの見た目に微小なズレが蓄積しないか\n"
);
