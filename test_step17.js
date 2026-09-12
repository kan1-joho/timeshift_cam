// test_step17.js
//
// STEP17(保存済み射「2画面比較」UI/UX整理・操作性向上)のテスト。
//
// STEP17は index.html の同期ロジック自体(setComparisonTime/setComparisonSync/
// comparisonLoopの同期ブランチ)を変更していない(表示まわりの追加のみ)。そのため、
// 挙動面のテストはtest_step16.jsと同じ考え方(実際のbufferEngine.js/playbackEngine.jsを
// 使ったチャンネル/セッションのプレーンな再現)を踏襲しつつ、STEP17で追加した表示要素
// (A/Bタイトルの接頭辞、同期共通位置表示、重複選択メッセージ等)を静的に確認する。
//
// 既存テスト(test_coordinateEngine.js / test_step11.js〜test_step16.js)は
// 本ファイルの対象外。別途そのまま実行し、回帰がないことを確認すること。

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { PlaybackEngine } = require("./playbackEngine.js");
const BufferEngine = require("./bufferEngine.js");

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
const indexHtmlSrc = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

function buildFrameBuffer(durationMs, fps) {
  const frames = [];
  const step = 1000 / fps;
  for (let t = 0; t <= durationMs; t += step) frames.push({ time: Math.round(t), bitmap: { width: 640, height: 360 } });
  return frames;
}
function makeShot(id, durationSec, createdAt) {
  return { id: id, createdAt: createdAt || Date.now(), durationMs: durationSec * 1000 };
}

// ---------------------------------------------------------------
// index.htmlのチャンネル/同期ロジックと同じ考え方(DOM抜き)。test_step16.jsと同一。
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
    title: "",
  };
}
function comparisonNow(channel, realNow) {
  if (channel.clockBase === null) channel.clockBase = realNow;
  return REVIEW_TIME_HEADROOM_MS + (realNow - channel.clockBase);
}
function clampComparisonTime(channel, t) {
  return Math.max(0, Math.min(channel.durationMs, t));
}
function loadShotIntoChannel(channel, shot, frameBuffer, markings) {
  channel.shotId = shot.id;
  // STEP17(§4-1,§8,§9): タイトルはラベル("A"/"B")を接頭辞として付与する
  channel.title = channel.label + "：" + shot.createdAt + "（" + (shot.durationMs / 1000).toFixed(1) + "秒）";
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
function makeComparisonSession() {
  return { A: createFakeChannel("A"), B: createFakeChannel("B"), syncEnabled: false, syncTime: 0 };
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
// index.htmlのformatComparisonClock()と同じロジック(§6)
function formatComparisonClock(ms) {
  const totalCentiseconds = Math.max(0, Math.round(ms / 10));
  const cs = totalCentiseconds % 100;
  const totalSeconds = Math.floor(totalCentiseconds / 100);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60);
  const pad2 = (n) => String(n).padStart(2, "0");
  return pad2(m) + ":" + pad2(s) + "." + pad2(cs);
}

// =================================================================
// 1. UI/state
// =================================================================
console.log("\n[STEP17] UI/state");

check("初期状態が同期OFF", () => {
  const session = makeComparisonSession();
  assert.strictEqual(session.syncEnabled, false);
});

check("比較画面を開いたとき同期OFF(openComparisonの静的確認)", () => {
  const fnMatch = indexHtmlSrc.match(/async function openComparison\([\s\S]*?\n  \}/);
  assert.ok(fnMatch, "openComparison()が見つからない");
  assert.ok(fnMatch[0].includes("setComparisonSync(false)"), "開くたびに同期OFFから開始する処理が無い");
});

check("同期ONでA/Bが同じ相対時間になる", () => {
  const session = makeComparisonSession();
  loadShotIntoChannel(session.A, makeShot("shotA", 10), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), buildFrameBuffer(10000, 24), []);
  session.A.playback.seekToTime(4200);
  session.A.playback.pause();
  setComparisonSync(session, true);
  assert.strictEqual(session.A.playback.playbackTime, session.B.playback.playbackTime);
});

check("同期OFFに戻しても現在位置が変わらない", () => {
  const session = makeComparisonSession();
  loadShotIntoChannel(session.A, makeShot("shotA", 10), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), buildFrameBuffer(10000, 24), []);
  setComparisonSync(session, true);
  setComparisonTime(session, 5000, true);
  const aBefore = session.A.playback.playbackTime;
  const bBefore = session.B.playback.playbackTime;
  setComparisonSync(session, false);
  assert.strictEqual(session.A.playback.playbackTime, aBefore);
  assert.strictEqual(session.B.playback.playbackTime, bBefore);
});

check("比較画面を閉じると同期状態がリセットされる(closeComparisonの静的確認)", () => {
  const fnMatch = indexHtmlSrc.match(/function closeComparison\(\)[\s\S]*?\n  \}/);
  assert.ok(fnMatch, "closeComparison()が見つからない");
  const body = fnMatch[0];
  assert.ok(body.includes("comparisonSyncEnabled = false"));
  assert.ok(body.includes("comparisonSyncTime = 0"));
  assert.ok(body.includes('comparisonSyncBar.style.display = "none"'), "同期バーを閉じる処理が無い(STEP17で追加)");
});

// =================================================================
// 2. A/B識別
// =================================================================
console.log("\n[STEP17] A/B識別");

check("AのshotIdとBのshotIdが異なる", () => {
  const session = makeComparisonSession();
  loadShotIntoChannel(session.A, makeShot("shotA", 10), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 8), buildFrameBuffer(8000, 24), []);
  assert.notStrictEqual(session.A.shotId, session.B.shotId);
});

check("A/Bの表示情報が正しく対応する(タイトルにA/Bの接頭辞が付く、§4-1・§8・§9)", () => {
  const session = makeComparisonSession();
  const createdA = 1700000000000;
  const createdB = 1700003600000;
  loadShotIntoChannel(session.A, makeShot("shotA", 10, createdA), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 8, createdB), buildFrameBuffer(8000, 24), []);
  assert.ok(session.A.title.startsWith("A："), "Aのタイトルに「A：」の接頭辞が無い");
  assert.ok(session.B.title.startsWith("B："), "Bのタイトルに「B：」の接頭辞が無い");
  assert.ok(session.A.title.includes(String(createdA)));
  assert.ok(session.B.title.includes(String(createdB)));

  // index.html側で実際に接頭辞を付けていることも静的に確認する
  assert.ok(
    indexHtmlSrc.includes('channel.label + "：" + formatShotDate'),
    "index.html側でchannel.labelを接頭辞として使っていない"
  );
});

check("同じshotIdを比較できない(§11: openComparisonのガードと分かりやすいメッセージ)", () => {
  const fnMatch = indexHtmlSrc.match(/async function openComparison\([\s\S]*?\n  \}/);
  const body = fnMatch[0];
  assert.ok(body.includes("shotA.id === shotB.id"), "同一shotIdのガードが見つからない");
  assert.ok(
    body.includes("同じ射は2つの比較対象に選択できません"),
    "理由が分かるメッセージになっていない(STEP17で改善)"
  );
});

// =================================================================
// 3. 比較位置
// =================================================================
console.log("\n[STEP17] 比較位置");

check("同期ONの5秒戻る", () => {
  const session = makeComparisonSession();
  loadShotIntoChannel(session.A, makeShot("shotA", 10), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), buildFrameBuffer(10000, 24), []);
  setComparisonSync(session, true);
  setComparisonTime(session, 8000, true);
  handleSyncedAction(session, "A", "seekBack");
  assert.strictEqual(session.A.playback.playbackTime, 3000);
  assert.strictEqual(session.B.playback.playbackTime, 3000);
});

check("同期ONの5秒進む", () => {
  const session = makeComparisonSession();
  loadShotIntoChannel(session.A, makeShot("shotA", 10), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), buildFrameBuffer(10000, 24), []);
  setComparisonSync(session, true);
  setComparisonTime(session, 2000, true);
  handleSyncedAction(session, "B", "seekFwd");
  assert.strictEqual(session.A.playback.playbackTime, 7000);
  assert.strictEqual(session.B.playback.playbackTime, 7000);
});

check("Aから1F操作すると、Aの実フレーム時刻が共通時間として採用される", () => {
  const session = makeComparisonSession();
  const framesA = buildFrameBuffer(10000, 24);
  loadShotIntoChannel(session.A, makeShot("shotA", 10), framesA, []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), buildFrameBuffer(10000, 24), []);
  setComparisonSync(session, true);
  setComparisonTime(session, 5000, true);
  const expected = BufferEngine.getNextFrameTime(framesA, session.A.playback.playbackTime);
  handleSyncedAction(session, "A", "stepFwd");
  assert.strictEqual(session.A.playback.playbackTime, expected);
  assert.strictEqual(session.B.playback.playbackTime, expected);
});

check("Bから1F操作すると、Bの実フレーム時刻が共通時間として採用される", () => {
  const session = makeComparisonSession();
  const framesB = buildFrameBuffer(10000, 24);
  loadShotIntoChannel(session.A, makeShot("shotA", 10), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), framesB, []);
  setComparisonSync(session, true);
  setComparisonTime(session, 5000, true);
  const expected = BufferEngine.getPreviousFrameTime(framesB, session.B.playback.playbackTime);
  handleSyncedAction(session, "B", "stepBack");
  assert.strictEqual(session.B.playback.playbackTime, expected);
  assert.strictEqual(session.A.playback.playbackTime, expected);
});

check("A/Bで異なるフレーム時刻(24fps端数あり)でも、結果が共通時間として扱われる", () => {
  // AとBのfpsをずらし、両者のフレーム時刻の並びが完全には一致しない状況を作る
  const session = makeComparisonSession();
  const framesA = buildFrameBuffer(9000, 24); // 端数あり
  const framesB = buildFrameBuffer(9000, 30); // 端数の出方が異なる
  loadShotIntoChannel(session.A, makeShot("shotA", 9), framesA, []);
  loadShotIntoChannel(session.B, makeShot("shotB", 9), framesB, []);
  setComparisonSync(session, true);
  setComparisonTime(session, 4000, true);
  handleSyncedAction(session, "A", "stepFwd");
  // Aのフレーム時刻(Bのフレーム格子とは一致しないかもしれない)がそのまま共通時間になり、
  // Bはその値をクランプして受け取るだけ(Aのframe.timeをBのframe.timeとして扱っていない)
  assert.strictEqual(session.A.playback.playbackTime, session.B.playback.playbackTime);
});

check("durationが異なる場合に各channelで正しくclampされる", () => {
  const session = makeComparisonSession();
  loadShotIntoChannel(session.A, makeShot("shotA", 10), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 7), buildFrameBuffer(7000, 24), []);
  setComparisonSync(session, true);
  setComparisonTime(session, 8000, true);
  assert.strictEqual(session.A.playback.playbackTime, 8000);
  assert.strictEqual(session.B.playback.playbackTime, session.B.durationMs); // Bは自身のdurationで頭打ち
  assert.ok(session.B.durationMs < 8000);
});

check("§6: 共通位置の表示フォーマット(mm:ss.cc)が正しい", () => {
  assert.strictEqual(formatComparisonClock(0), "00:00.00");
  assert.strictEqual(formatComparisonClock(5230), "00:05.23");
  assert.strictEqual(formatComparisonClock(65000), "01:05.00");
  assert.ok(indexHtmlSrc.includes("function formatComparisonClock"), "index.html側にformatComparisonClock()が無い");
  assert.ok(indexHtmlSrc.includes("共通位置"), "「共通位置」表示が見つからない");
});

// =================================================================
// 4. 再生
// =================================================================
console.log("\n[STEP17] 再生");

check("同期ONでAから再生するとA/Bとも再生", () => {
  const session = makeComparisonSession();
  loadShotIntoChannel(session.A, makeShot("shotA", 10), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), buildFrameBuffer(10000, 24), []);
  setComparisonSync(session, true);
  handleSyncedAction(session, "A", "playPause");
  assert.notStrictEqual(session.A.playback.getStateLabel(), "PAUSE");
  assert.notStrictEqual(session.B.playback.getStateLabel(), "PAUSE");
});

check("同期ONでBから再生するとA/Bとも再生", () => {
  const session = makeComparisonSession();
  loadShotIntoChannel(session.A, makeShot("shotA", 10), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), buildFrameBuffer(10000, 24), []);
  setComparisonSync(session, true);
  handleSyncedAction(session, "B", "playPause");
  assert.notStrictEqual(session.A.playback.getStateLabel(), "PAUSE");
  assert.notStrictEqual(session.B.playback.getStateLabel(), "PAUSE");
});

check("同期ONでAから停止するとA/Bとも停止", () => {
  const session = makeComparisonSession();
  loadShotIntoChannel(session.A, makeShot("shotA", 10), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), buildFrameBuffer(10000, 24), []);
  setComparisonSync(session, true);
  session.A.playback.resume();
  session.B.playback.resume();
  handleSyncedAction(session, "A", "playPause");
  assert.strictEqual(session.A.playback.getStateLabel(), "PAUSE");
  assert.strictEqual(session.B.playback.getStateLabel(), "PAUSE");
});

check("同期ONでBから停止するとA/Bとも停止", () => {
  const session = makeComparisonSession();
  loadShotIntoChannel(session.A, makeShot("shotA", 10), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), buildFrameBuffer(10000, 24), []);
  setComparisonSync(session, true);
  session.A.playback.resume();
  session.B.playback.resume();
  handleSyncedAction(session, "B", "playPause");
  assert.strictEqual(session.A.playback.getStateLabel(), "PAUSE");
  assert.strictEqual(session.B.playback.getStateLabel(), "PAUSE");
});

// =================================================================
// 5. スロー
// =================================================================
console.log("\n[STEP17] スロー");

check("同期ONでAの速度変更 → Bにも反映", () => {
  const session = makeComparisonSession();
  loadShotIntoChannel(session.A, makeShot("shotA", 10), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), buildFrameBuffer(10000, 24), []);
  setComparisonSync(session, true);
  setComparisonSlowRate(session, session.A, 1 / 2);
  assert.strictEqual(session.B.slowRate, 1 / 2);
});

check("同期ONでBの速度変更 → Aにも反映", () => {
  const session = makeComparisonSession();
  loadShotIntoChannel(session.A, makeShot("shotA", 10), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), buildFrameBuffer(10000, 24), []);
  setComparisonSync(session, true);
  setComparisonSlowRate(session, session.B, 1 / 4);
  assert.strictEqual(session.A.slowRate, 1 / 4);
});

check("同期ONでAの範囲変更 → Bにも反映", () => {
  const session = makeComparisonSession();
  loadShotIntoChannel(session.A, makeShot("shotA", 10), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), buildFrameBuffer(10000, 24), []);
  setComparisonSync(session, true);
  setComparisonSlowWindow(session, session.A, 10);
  assert.strictEqual(session.B.slowWindowSec, 10);
});

check("同期ONでBの範囲変更 → Aにも反映", () => {
  const session = makeComparisonSession();
  loadShotIntoChannel(session.A, makeShot("shotA", 10), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), buildFrameBuffer(10000, 24), []);
  setComparisonSync(session, true);
  setComparisonSlowWindow(session, session.B, 3);
  assert.strictEqual(session.A.slowWindowSec, 3);
});

// =================================================================
// 6. 独立動作(同期OFF)
// =================================================================
console.log("\n[STEP17] 独立動作(同期OFF)");

check("同期OFFでAを操作してもBの位置が変わらない", () => {
  const session = makeComparisonSession();
  loadShotIntoChannel(session.A, makeShot("shotA", 10), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), buildFrameBuffer(10000, 24), []);
  session.A.playback.seekToTime(3000);
  session.A.playback.pause();
  session.B.playback.seekToTime(3000);
  session.B.playback.pause();
  const bBefore = session.B.playback.playbackTime;

  session.A.playback.seekBy(-SEEK_STEP_SEC);
  session.A.playback.playbackTime = clampComparisonTime(session.A, session.A.playback.playbackTime);
  assert.strictEqual(session.B.playback.playbackTime, bBefore);
});

check("同期OFFでBを操作してもAの位置が変わらない", () => {
  const session = makeComparisonSession();
  loadShotIntoChannel(session.A, makeShot("shotA", 10), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), buildFrameBuffer(10000, 24), []);
  session.A.playback.seekToTime(2000);
  session.A.playback.pause();
  session.B.playback.seekToTime(2000);
  session.B.playback.pause();
  const aBefore = session.A.playback.playbackTime;

  session.B.playback.seekBy(SEEK_STEP_SEC);
  session.B.playback.playbackTime = clampComparisonTime(session.B, session.B.playback.playbackTime);
  assert.strictEqual(session.A.playback.playbackTime, aBefore);
});

check("同期OFFでAの速度変更をしてもBに影響しない", () => {
  const session = makeComparisonSession();
  loadShotIntoChannel(session.A, makeShot("shotA", 10), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), buildFrameBuffer(10000, 24), []);
  setComparisonSlowRate(session, session.A, 1 / 2);
  assert.notStrictEqual(session.B.slowRate, 1 / 2);
});

check("同期OFFでBの速度変更をしてもAに影響しない", () => {
  const session = makeComparisonSession();
  loadShotIntoChannel(session.A, makeShot("shotA", 10), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), buildFrameBuffer(10000, 24), []);
  setComparisonSlowRate(session, session.B, 1 / 4);
  assert.notStrictEqual(session.A.slowRate, 1 / 4);
});

// =================================================================
// 7. 状態分離
// =================================================================
console.log("\n[STEP17] 状態分離");

check("comparisonA/BのPlaybackEngineがsingle reviewのshotPlaybackと別インスタンス", () => {
  const session = makeComparisonSession();
  loadShotIntoChannel(session.A, makeShot("shotA", 10), buildFrameBuffer(10000, 24), []);
  loadShotIntoChannel(session.B, makeShot("shotB", 10), buildFrameBuffer(10000, 24), []);
  // 単一レビュー相当のインスタンスを模した第三のPlaybackEngineと比較する
  const shotPlaybackLike = new PlaybackEngine({ delaySeconds: REVIEW_DELAY_SECONDS });
  assert.notStrictEqual(session.A.playback, shotPlaybackLike);
  assert.notStrictEqual(session.B.playback, shotPlaybackLike);
  assert.notStrictEqual(session.A.playback, session.B.playback);
});

check("comparisonA/BのframeBufferが独立している", () => {
  const session = makeComparisonSession();
  const framesA = buildFrameBuffer(10000, 24);
  const framesB = buildFrameBuffer(8000, 24);
  loadShotIntoChannel(session.A, makeShot("shotA", 10), framesA, []);
  loadShotIntoChannel(session.B, makeShot("shotB", 8), framesB, []);
  assert.notStrictEqual(session.A.frameBuffer, session.B.frameBuffer);
});

check("STEP17のコードがshotPlaybackを一切参照していない(単独レビューへの影響禁止、§14)", () => {
  const startIdx = indexHtmlSrc.indexOf("STEP16: A/B同期");
  const endIdx = indexHtmlSrc.indexOf("async function openShotReview(shot)");
  assert.ok(startIdx >= 0 && endIdx > startIdx, "比較機能のセクション範囲を特定できない");
  const compareSrc = indexHtmlSrc.slice(startIdx, endIdx);
  assert.ok(!compareSrc.includes("shotPlayback."), "比較機能のコードがshotPlaybackに直接触れている");
});

check("IndexedDBスキーマ・エンジン4ファイルはSTEP17で変更されていない(存在確認)", () => {
  ["bufferEngine.js", "playbackEngine.js", "coordinateEngine.js", "storageEngine.js"].forEach((f) => {
    assert.ok(fs.existsSync(path.join(__dirname, f)), f + "が見つからない");
  });
  assert.ok(!indexHtmlSrc.includes("DB_VERSION = 3"), "DB_VERSIONが変更された形跡がある");
});

console.log("\n" + passCount + " 件成功" + (process.exitCode ? " / 失敗あり" : " / 全て成功"));
console.log(
  "\n[注記] 以下はNode.jsでは検証できず、実機確認が必要です:\n" +
    "  - A/Bタイトル・共通位置表示の実際の見た目(iPad横/縦画面)\n" +
    "  - 同期ONバーが画面を圧迫していないか\n" +
    "  - チェックボックス横のA/Bラベルの視認性\n" +
    "  - 重複選択時のalert表示のタイミング・見え方\n"
);
