// test_step8.js
// STEP8: 高精度再生機能のテスト。
//   - bufferEngine.js に追加した getPreviousFrameTime / getNextFrameTime (純粋関数)
//   - playbackEngine.js に追加した seekToTime / getNewestAllowed (薄いプリミティブ)
//   - 上記2つをUI層と同じ形で組み合わせた「1フレーム戻る/進む」の統合的な挙動
//   - 可変スロー速度(1/2, 1/3, 1/4) / 可変スロー範囲(3, 5, 10秒)
// bufferEngine.js の insertSorted / findFrameAt 自体は変更していないため再テストしない
// (test.js の既存テストでカバー済み)。

const assert = require("assert");
const BufferEngine = require("./bufferEngine.js");
const { PlaybackEngine } = require("./playbackEngine.js");

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

function makeBuffer(times) {
  return times.map((t) => ({ time: t }));
}

// index.htmlのstepFrame()と同じ組み立て方をNode側でも再現する。
// (Playback EngineはframeBufferを持たないため、UI層と同じ橋渡しをここで行う)
function stepFrame(playback, frameBuffer, direction) {
  let t;
  if (direction < 0) {
    t = BufferEngine.getPreviousFrameTime(frameBuffer, playback.playbackTime);
  } else {
    t = BufferEngine.getNextFrameTime(frameBuffer, playback.playbackTime);
    const bound = playback.getNewestAllowed();
    if (t != null && bound != null && t > bound) t = null;
  }
  if (t == null) return false;
  playback.seekToTime(t);
  playback.pause();
  return true;
}

console.log("\n[STEP8-A] bufferEngine: getPreviousFrameTime / getNextFrameTime");

check("ちょうどフレームと同じ時刻から前後を正しく取得できる", () => {
  const buf = makeBuffer([0, 42, 84, 126, 168]);
  assert.strictEqual(BufferEngine.getPreviousFrameTime(buf, 84), 42);
  assert.strictEqual(BufferEngine.getNextFrameTime(buf, 84), 126);
});

check("フレームの間の時刻からも正しく前後を取得できる", () => {
  const buf = makeBuffer([0, 42, 84, 126, 168]);
  assert.strictEqual(BufferEngine.getPreviousFrameTime(buf, 100), 84);
  assert.strictEqual(BufferEngine.getNextFrameTime(buf, 100), 126);
});

check("最古フレームで前を問い合わせるとnull(それ以上戻れない)", () => {
  const buf = makeBuffer([0, 42, 84]);
  assert.strictEqual(BufferEngine.getPreviousFrameTime(buf, 0), null);
});

check("最新フレームで後を問い合わせるとnull(それ以上進めない)", () => {
  const buf = makeBuffer([0, 42, 84]);
  assert.strictEqual(BufferEngine.getNextFrameTime(buf, 84), null);
});

check("空バッファはどちらもnullを返す", () => {
  assert.strictEqual(BufferEngine.getPreviousFrameTime([], 100), null);
  assert.strictEqual(BufferEngine.getNextFrameTime([], 100), null);
});

console.log("\n[STEP8-B] playbackEngine: seekToTime / getNewestAllowed");

check("seekToTimeで指定時刻へ移動し、範囲外はクランプされる", () => {
  const pe = new PlaybackEngine({ delaySeconds: 10 });
  pe.update(100000, 50000); // playbackTime=90000, oldest=50000, newestAllowed=90000
  pe.seekToTime(60000);
  assert.strictEqual(pe.playbackTime, 60000);
  pe.seekToTime(10000); // oldest(50000)未満 -> クランプ
  assert.strictEqual(pe.playbackTime, 50000);
  pe.seekToTime(999999); // newestAllowed(90000)超過 -> クランプ
  assert.strictEqual(pe.playbackTime, 90000);
});

check("getNewestAllowedは直近のupdate()時点のnow-delayを返す", () => {
  const pe = new PlaybackEngine({ delaySeconds: 10 });
  pe.update(100000, 0);
  assert.strictEqual(pe.getNewestAllowed(), 90000);
  pe.update(150000, 0);
  assert.strictEqual(pe.getNewestAllowed(), 140000);
});

console.log("\n[STEP8-C] 1フレーム戻る/進む(統合)");

check("1フレーム戻る/進むで隣接する実フレームへ正確に移動する", () => {
  const pe = new PlaybackEngine({ delaySeconds: 10 });
  const buf = makeBuffer([80000, 84000, 88000, 92000, 96000]);
  pe.update(100000, buf[0].time); // playbackTime=90000
  // 90000ちょうどのフレームは無いが、現在位置は90000。最も近い実フレームからではなく
  // 「現在のplaybackTime」を起点に前後を辿る仕様どおりに動作するかを確認する。
  pe.seekToTime(92000); // まず実フレームの上に乗せる(UIでは通常findFrameAtで表示中の実フレームに一致している)
  assert.ok(stepFrame(pe, buf, -1));
  assert.strictEqual(pe.playbackTime, 88000);
  assert.ok(stepFrame(pe, buf, -1));
  assert.strictEqual(pe.playbackTime, 84000);
  assert.ok(stepFrame(pe, buf, 1));
  assert.strictEqual(pe.playbackTime, 88000);
});

check("最古フレームで1フレーム戻ると位置が変わらない", () => {
  const pe = new PlaybackEngine({ delaySeconds: 10 });
  const buf = makeBuffer([80000, 84000, 88000]);
  pe.update(100000, buf[0].time);
  pe.seekToTime(80000);
  const before = pe.playbackTime;
  const moved = stepFrame(pe, buf, -1);
  assert.strictEqual(moved, false);
  assert.strictEqual(pe.playbackTime, before);
});

check("現在の遅延位置で1フレーム進むと位置が変わらない(バッファに新しいフレームがあっても)", () => {
  const pe = new PlaybackEngine({ delaySeconds: 10 });
  // バッファには「現在の遅延位置(90000)」より新しい95000のフレームも存在する状況
  // (カメラは録り続けているため、バッファの末尾はplaybackより先行し得る)
  const buf = makeBuffer([80000, 84000, 88000, 90000, 95000]);
  pe.update(100000, buf[0].time); // newestAllowed=90000
  pe.seekToTime(90000);
  const before = pe.playbackTime;
  const moved = stepFrame(pe, buf, 1);
  assert.strictEqual(moved, false, "現在の遅延位置より先のフレームには進めないはず");
  assert.strictEqual(pe.playbackTime, before);
});

check("一時停止中に1フレーム戻ってもPAUSEのまま", () => {
  const pe = new PlaybackEngine({ delaySeconds: 10 });
  const buf = makeBuffer([80000, 84000, 88000, 92000]);
  pe.update(100000, buf[0].time);
  pe.pause();
  pe.seekToTime(88000);
  assert.strictEqual(pe.getStateLabel(), "PAUSE");
  stepFrame(pe, buf, -1);
  assert.strictEqual(pe.getStateLabel(), "PAUSE");
  assert.strictEqual(pe.playbackTime, 84000);
});

check("スロー再生中に1フレーム戻るとSLOW_PAUSEDへ移行し、スロー区間情報は保持される", () => {
  const pe = new PlaybackEngine({ delaySeconds: 10 });
  const buf = makeBuffer([80000, 84000, 88000, 92000, 96000, 100000]);
  pe.update(110000, buf[0].time); // playbackTime=100000
  pe.playRecentWindow(10, 1 / 4); // 90000 -> 100000 を1/4倍速で
  pe.update(112000, buf[0].time); // 少し進める
  assert.strictEqual(pe.getStateLabel(), "SLOW");
  const moved = stepFrame(pe, buf, -1);
  assert.ok(moved);
  assert.strictEqual(pe.getStateLabel(), "SLOW_PAUSED");
  // resumeすると元のスロー速度(1/4)で再開する
  pe.resume();
  assert.strictEqual(pe.getStateLabel(), "SLOW");
  assert.strictEqual(pe.playbackRate, 0.25);
});

check("現在へを押すとフレーム送り後の状態からも即座にDELAYへ復帰する", () => {
  const pe = new PlaybackEngine({ delaySeconds: 10 });
  const buf = makeBuffer([80000, 84000, 88000, 92000]);
  pe.update(100000, buf[0].time);
  pe.seekToTime(88000);
  pe.pause();
  stepFrame(pe, buf, -1);
  pe.goLive();
  const t = pe.update(100000, buf[0].time);
  assert.strictEqual(pe.getStateLabel(), "DELAY");
  assert.strictEqual(t, 90000);
});

console.log("\n[STEP8-D] 可変スロー速度・可変スロー範囲");

check("1/2倍速: 3秒の映像を約6秒で再生する", () => {
  const pe = new PlaybackEngine({ delaySeconds: 10 });
  let now = 100000;
  pe.update(now, 0);
  pe.playRecentWindow(3, 1 / 2);
  let elapsed = 0;
  while (pe.getStateLabel() === "SLOW") {
    now += 50;
    elapsed += 50;
    pe.update(now, 0);
    if (elapsed > 15000) throw new Error("終了しなかった");
  }
  assert.ok(Math.abs(elapsed - 6000) < 100, "所要時間: " + elapsed + "ms");
});

check("1/4倍速: 10秒の映像を約40秒で再生する", () => {
  const pe = new PlaybackEngine({ delaySeconds: 15 });
  let now = 100000;
  pe.update(now, 0);
  pe.playRecentWindow(10, 1 / 4);
  let elapsed = 0;
  while (pe.getStateLabel() === "SLOW") {
    now += 100;
    elapsed += 100;
    pe.update(now, 0);
    if (elapsed > 60000) throw new Error("終了しなかった");
  }
  assert.ok(Math.abs(elapsed - 40000) < 200, "所要時間: " + elapsed + "ms");
});

check("3秒/5秒/10秒いずれも「終了位置-範囲」を開始位置とする", () => {
  [3, 5, 10].forEach((windowSec) => {
    const pe = new PlaybackEngine({ delaySeconds: 20 });
    pe.update(100000, 0); // playbackTime=80000(基準点)
    pe.playRecentWindow(windowSec, 1 / 3);
    assert.strictEqual(pe.playbackTime, 80000 - windowSec * 1000);
  });
});

check("スロー速度・範囲の選択を連打(頻繁に変更)してもエンジン状態は破綻しない", () => {
  const pe = new PlaybackEngine({ delaySeconds: 10 });
  const rates = [0.5, 1 / 3, 0.25];
  const windows = [3, 5, 10];
  let now = 100000;
  pe.update(now, 0);
  for (let i = 0; i < 30; i++) {
    const rate = rates[i % rates.length];
    const windowSec = windows[i % windows.length];
    now += 50;
    pe.update(now, 0);
    pe.playRecentWindow(windowSec, rate);
    assert.ok(Number.isFinite(pe.playbackTime));
    assert.strictEqual(pe.getStateLabel(), "SLOW");
  }
});

console.log("\n" + passCount + " 件成功" + (process.exitCode ? " / 失敗あり" : " / 全て成功"));
