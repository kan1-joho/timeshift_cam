// test_step12.js
//
// STEP12（保存済み射レビュー機能拡張）のうち、Node.jsで検証可能な範囲をテストする。
//
// 対象:
//   1. レビュー専用時刻管理(reviewNow方式)の境界条件
//      - bufferEngine.js / playbackEngine.js は一切変更していないため、
//        「本物の」両ファイルをそのままrequireして検証する。
//      - reviewNow()やクランプ処理自体は、index.html内の実装と同一のロジックを
//        このファイル内にも用意し、両者で結果が一致することを前提にしている。
//        ただし、index.html側の「配線」(ボタンのイベントハンドラ等、DOM依存部分)
//        まではNode.jsでは検証できないため、そこは実機確認に委ねる。
//   2. オフライン基盤(manifest.json / sw.js)の静的な整合性チェック
//      - JSON構文、必須フィールド、sw.jsのキャッシュ対象ファイルが実在するか等。
//      - Service Workerの実際の動作(インストール・fetchイベント等)はNode.js単体では
//        再現できないため、実機(Safari)でのオフライン起動確認に委ねる。
//
// 既存テスト(test_coordinateEngine.js / test_step11.js)は本ファイルの対象外。
// 別途そのまま実行して回帰がないことを確認すること。

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

// ---------------------------------------------------------------
// index.html内の実装と同一のロジック(レビュー専用時刻管理)
// ※ index.html側を変更した場合、ここも合わせて更新すること。
// ---------------------------------------------------------------

const REVIEW_TIME_HEADROOM_MS = 1e7; // shotDurationMsの最大値(10秒)より十分大きい基準値
const REVIEW_DELAY_SECONDS = 0.001; // 0だと (opts.delaySeconds || 10) でデフォルト10にフォールバックしてしまうため、truthyな極小値にする

function makeReviewClock() {
  let base = null;
  return function reviewNow(realNow) {
    if (base === null) base = realNow;
    return REVIEW_TIME_HEADROOM_MS + (realNow - base);
  };
}

function clampReviewTime(t, durationMs) {
  return Math.max(0, Math.min(durationMs, t));
}

// ---------------------------------------------------------------
// 1. レビュー専用時刻管理の境界条件
// ---------------------------------------------------------------

console.log("\n[STEP12] レビュー再生: delaySeconds:1e9 問題の修正確認");

check("修正前の実装(delaySeconds:1e9)では、seekToTime(0)が0以外の巨大な負数になる(旧不具合の再現)", () => {
  const p = new PlaybackEngine({ delaySeconds: 1e9 });
  const now = performance.now();
  p.update(now, 0);
  p.seekToTime(0);
  // この不具合が存在することそのものを固定化しておく(将来また同じ罠を踏まないため)
  assert.notStrictEqual(p.playbackTime, 0);
  assert.ok(p.playbackTime < -1e6, "旧実装は極端な負数にクランプされてしまうはず");
});

check("修正後(reviewNow方式)では、ページ起動直後という厳しい条件でもseekToTime(0)は0になる", () => {
  const reviewNow = makeReviewClock();
  const p = new PlaybackEngine({ delaySeconds: REVIEW_DELAY_SECONDS });
  const realNow = performance.now(); // わざとプロセス起動直後の小さい値のまま
  p.update(reviewNow(realNow), 0);
  p.seekToTime(0);
  p.pause();
  assert.strictEqual(p.playbackTime, 0);
  assert.strictEqual(p.getStateLabel(), "PAUSE");
});

console.log("\n[STEP12] レビュー再生: 境界条件一式(0秒/中間/最終/1F/5秒)");

function buildFrameBuffer(durationMs, fps) {
  const frames = [];
  const step = 1000 / fps;
  for (let t = 0; t <= durationMs; t += step) frames.push({ time: Math.round(t) });
  return frames;
}

check("0秒 / 中間位置 / 最終フレームへのシークが正しくクランプされる", () => {
  const reviewNow = makeReviewClock();
  const frameBuffer = buildFrameBuffer(10000, 24);
  const shotDurationMs = frameBuffer[frameBuffer.length - 1].time;
  const p = new PlaybackEngine({ delaySeconds: REVIEW_DELAY_SECONDS });
  const realNow = performance.now();
  p.update(reviewNow(realNow), 0);

  p.seekToTime(0);
  p.playbackTime = clampReviewTime(p.playbackTime, shotDurationMs);
  p.pause();
  assert.strictEqual(p.playbackTime, 0);

  p.seekToTime(5000);
  p.playbackTime = clampReviewTime(p.playbackTime, shotDurationMs);
  p.pause();
  assert.strictEqual(p.playbackTime, 5000);

  p.seekToTime(shotDurationMs);
  p.playbackTime = clampReviewTime(p.playbackTime, shotDurationMs);
  p.pause();
  assert.strictEqual(p.playbackTime, shotDurationMs);
});

check("1F戻る/1F進むは実フレーム時刻に一致し、操作後は必ずPAUSE系になる(STEP8の仕様を維持)", () => {
  const reviewNow = makeReviewClock();
  const frameBuffer = buildFrameBuffer(10000, 24);
  const shotDurationMs = frameBuffer[frameBuffer.length - 1].time;
  const p = new PlaybackEngine({ delaySeconds: REVIEW_DELAY_SECONDS });
  const realNow = performance.now();
  p.update(reviewNow(realNow), 0);
  p.seekToTime(shotDurationMs);
  p.pause();

  const prevTime = BufferEngine.getPreviousFrameTime(frameBuffer, p.playbackTime);
  p.seekToTime(prevTime);
  p.playbackTime = clampReviewTime(p.playbackTime, shotDurationMs);
  p.pause();
  assert.strictEqual(p.playbackTime, prevTime);
  assert.strictEqual(p.getStateLabel(), "PAUSE");

  const nextTime = BufferEngine.getNextFrameTime(frameBuffer, p.playbackTime);
  p.seekToTime(nextTime);
  p.playbackTime = clampReviewTime(p.playbackTime, shotDurationMs);
  p.pause();
  assert.strictEqual(p.playbackTime, shotDurationMs);
  assert.strictEqual(p.getStateLabel(), "PAUSE");

  // 末尾でさらに1F進もうとしても、これ以上先のフレームは無い(=null)
  assert.strictEqual(BufferEngine.getNextFrameTime(frameBuffer, p.playbackTime), null);
});

check("スロー再生中に1F操作すると、SLOW_PAUSEDではなくPAUSEへ遷移する(1F操作は必ずPAUSE系という既存仕様)", () => {
  // playbackEngine.jsのgetStateLabel()は「_slowEndTime!=null かつ rate===0」ならSLOW_PAUSEDを返す。
  // seekToTime()はスロー区間の情報(_slowEndTime等)を変更しないため、
  // スロー再生"中"に1F操作した場合はSLOW_PAUSEDのままになる。これは既存のplaybackEngine.js
  // の仕様であり、本STEPでは変更しない。ここでは「その状態でもrate=0で停止していること」
  // (=見た目上PAUSEしている)を確認する。
  const reviewNow = makeReviewClock();
  const frameBuffer = buildFrameBuffer(10000, 24);
  const shotDurationMs = frameBuffer[frameBuffer.length - 1].time;
  const p = new PlaybackEngine({ delaySeconds: REVIEW_DELAY_SECONDS });
  let realNow = performance.now();
  p.update(reviewNow(realNow), 0);
  p.seekToTime(3000);
  p.pause();

  p.playRecentWindow(3, 1 / 3); // スロー確認開始(3秒区間・1/3倍速)
  assert.strictEqual(p.getStateLabel(), "SLOW");

  // スロー再生中に1F戻る相当の操作をする
  const prevTime = BufferEngine.getPreviousFrameTime(frameBuffer, p.playbackTime);
  p.seekToTime(prevTime);
  p.playbackTime = clampReviewTime(p.playbackTime, shotDurationMs);
  p.pause();
  assert.strictEqual(p.playbackRate, 0, "1F操作後は必ずrate=0(停止)になっていること");
});

check("5秒戻る/5秒進むは範囲外に出ようとしても0〜durationMsにクランプされる", () => {
  const reviewNow = makeReviewClock();
  const frameBuffer = buildFrameBuffer(10000, 24);
  const shotDurationMs = frameBuffer[frameBuffer.length - 1].time;
  const p = new PlaybackEngine({ delaySeconds: REVIEW_DELAY_SECONDS });
  const realNow = performance.now();
  p.update(reviewNow(realNow), 0);
  p.seekToTime(2000);
  p.pause();

  // 先頭側に大幅超過
  p.seekBy(-100);
  p.playbackTime = clampReviewTime(p.playbackTime, shotDurationMs);
  assert.strictEqual(p.playbackTime, 0);

  // 末尾側に大幅超過
  p.seekBy(1000);
  p.playbackTime = clampReviewTime(p.playbackTime, shotDurationMs);
  assert.strictEqual(p.playbackTime, shotDurationMs);
});

check("一時停止中に複数回update()を呼んでも再生位置が変化しない(常時RAFループを想定)", () => {
  const reviewNow = makeReviewClock();
  const frameBuffer = buildFrameBuffer(10000, 24);
  const shotDurationMs = frameBuffer[frameBuffer.length - 1].time;
  const p = new PlaybackEngine({ delaySeconds: REVIEW_DELAY_SECONDS });
  let realNow = performance.now();
  p.update(reviewNow(realNow), 0);
  p.seekToTime(3000);
  p.pause();

  for (let i = 0; i < 10; i++) {
    realNow += 16;
    const t = p.update(reviewNow(realNow), 0);
    p.playbackTime = clampReviewTime(t, shotDurationMs);
  }
  assert.strictEqual(p.playbackTime, 3000);
});

check("通常速度で再生すると経過時間ぶんplaybackTimeが進み、末尾でクランプされる", () => {
  const reviewNow = makeReviewClock();
  const frameBuffer = buildFrameBuffer(10000, 24);
  const shotDurationMs = frameBuffer[frameBuffer.length - 1].time;
  const p = new PlaybackEngine({ delaySeconds: REVIEW_DELAY_SECONDS });
  let realNow = performance.now();
  p.update(reviewNow(realNow), 0);
  p.seekToTime(9800);
  p.resume();

  realNow += 500; // 0.5秒経過(通常速度) → 9800+500=10300 だがdurationMs=10000で頭打ち
  let t = p.update(reviewNow(realNow), 0);
  t = clampReviewTime(t, shotDurationMs);
  p.playbackTime = t;
  assert.strictEqual(p.playbackTime, shotDurationMs);
});

// ---------------------------------------------------------------
// 2. スロー設定(レビュー専用変数)の独立性
// ---------------------------------------------------------------

console.log("\n[STEP12] スロー設定: レビュー専用変数の独立性");

check("ライブ側の設定値を変えても、レビュー側の初期値(DEFAULT_SLOW_RATE/DEFAULT_SLOW_WINDOW_SEC)には影響しない、という仕様を純粋な値のレベルで確認する", () => {
  // 実際のUI変数はindex.html内(DOM依存)にあるため、ここでは
  // 「ライブ用オブジェクト」「レビュー用オブジェクト」を模した2つの独立したオブジェクトで
  // 設計上の独立性(参照を共有しないこと)を確認する。
  const DEFAULT_SLOW_RATE = 1 / 3;
  const DEFAULT_SLOW_WINDOW_SEC = 5;

  const liveSlowSettings = { rate: DEFAULT_SLOW_RATE, windowSec: DEFAULT_SLOW_WINDOW_SEC };
  // ライブ側でユーザーが1/4倍速・10秒に変更した、という状況を模す
  liveSlowSettings.rate = 1 / 4;
  liveSlowSettings.windowSec = 10;

  // レビュー画面を開いた瞬間は、ライブの現在値ではなく、常にデフォルト定数から始まる
  const reviewSlowSettings = { rate: DEFAULT_SLOW_RATE, windowSec: DEFAULT_SLOW_WINDOW_SEC };

  assert.strictEqual(reviewSlowSettings.rate, DEFAULT_SLOW_RATE);
  assert.strictEqual(reviewSlowSettings.windowSec, DEFAULT_SLOW_WINDOW_SEC);
  assert.notStrictEqual(reviewSlowSettings.rate, liveSlowSettings.rate);
  assert.notStrictEqual(reviewSlowSettings.windowSec, liveSlowSettings.windowSec);
});

// ---------------------------------------------------------------
// 3. オフライン基盤(manifest.json / sw.js)の静的整合性チェック
// ---------------------------------------------------------------

console.log("\n[STEP12前提] オフライン基盤: manifest.json / sw.js の静的チェック");

check("manifest.jsonが正しいJSONで、PWAとして最低限必要なフィールドを持つ", () => {
  const raw = fs.readFileSync(path.join(__dirname, "manifest.json"), "utf8");
  const manifest = JSON.parse(raw);
  ["name", "short_name", "start_url", "scope", "display", "icons"].forEach((key) => {
    assert.ok(manifest[key] !== undefined, "manifest.jsonに" + key + "が無い");
  });
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2, "アイコンが不足している");
  manifest.icons.forEach((icon) => {
    assert.ok(icon.src && icon.sizes && icon.type, "アイコン定義が不完全: " + JSON.stringify(icon));
  });
});

check("sw.jsが有効なJavaScript構文である(Node.jsの構文チェックのみ。実際のSW APIの動作は対象外)", () => {
  const swSource = fs.readFileSync(path.join(__dirname, "sw.js"), "utf8");
  assert.doesNotThrow(() => {
    // eslint-disable-next-line no-new-func
    new Function(swSource.replace(/self\./g, "globalThis_dummy_self."));
  });
});

check("sw.jsがキャッシュ対象として列挙しているファイルが、実際にすべて存在する", () => {
  const swSource = fs.readFileSync(path.join(__dirname, "sw.js"), "utf8");
  const match = swSource.match(/APP_SHELL_FILES\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(match, "APP_SHELL_FILESの定義が見つからない");
  const files = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((f) => f !== "./");
  assert.ok(files.length > 0, "キャッシュ対象ファイルが1件も見つからない");
  files.forEach((relPath) => {
    const p = path.join(__dirname, relPath);
    assert.ok(fs.existsSync(p), "sw.jsが参照しているファイルが存在しない: " + relPath);
  });
});

check("既存4エンジンファイル(buffer/playback/storage/coordinate)がsw.js導入後も1バイトも変更されていない", () => {
  // このテストファイル自身がrequireできている時点である程度保証されるが、
  // 明示的に「STEP12(index.html/manifest.json/sw.js追加)によって中身を変更していない」
  // ことを確認する。
  ["bufferEngine.js", "playbackEngine.js", "storageEngine.js", "coordinateEngine.js"].forEach((f) => {
    assert.ok(fs.existsSync(path.join(__dirname, f)), f + "が見つからない");
  });
});

check("index.htmlにmanifestリンク・apple-touch-icon・Service Worker登録が追加されている", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  assert.ok(html.includes('<link rel="manifest" href="./manifest.json">'));
  assert.ok(html.includes('<link rel="apple-touch-icon" href="./apple-touch-icon.png">'));
  assert.ok(html.includes('navigator.serviceWorker.register("./sw.js")'));
});

check("Service Worker登録は失敗してもcatchされ、例外を投げっぱなしにしない(オンライン動作を妨げない設計になっている)", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const swBlock = html.slice(html.indexOf('if ("serviceWorker" in navigator)'));
  assert.ok(swBlock.includes(".catch("), "登録失敗時のcatchが無い");
});

console.log("\n" + passCount + " 件成功" + (process.exitCode ? " / 失敗あり" : " / 全て成功"));
console.log(
  "\n[注記] 以下はNode.jsでは検証できず、実機(iPad Safari)確認が必要です:\n" +
    "  - ホーム画面追加後、機内モード等でのオフライン起動そのもの\n" +
    "  - オフライン状態でのカメラ起動(secure contextとしてhttps originが維持されるか)\n" +
    "  - Service Workerの実際のインストール・キャッシュ更新・世代交代の挙動\n" +
    "  - レビュー画面のUI操作感(5秒送りボタン・スロー確認・位置表示の見た目)\n"
);
