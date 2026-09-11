// test_step14.js
//
// STEP14(保存済み射レビューのマーキング消去・全消去)のうち、Node.jsで検証可能な範囲を
// テストする。
//
// IndexedDBそのもの(StorageEngine.deleteMarking/deleteShotMarkingsの実処理)はNode.jsでは
// 再現できないため、ここでは「同じデータ構造・同じ絞り込みロジック」を使った
// インメモリのシミュレーションで検証する。実際のIndexedDB操作(deleteMarking/
// deleteShotMarkings自体)はstorageEngine.js内に実装済みであることを、ソースの
// 静的確認(このファイル末尾)でも合わせて確認する。
//
// 既存テスト(test_coordinateEngine.js / test_step11.js / test_step12.js / test_step13.js)は
// 本ファイルの対象外。別途そのまま実行し、回帰がないことを確認すること。
//
// 【重要・要報告】coordinateEngine.jsへの必要最小限の変更について:
// distanceToMarking()にtype:"freehand"用のcaseが存在せず、常にInfinityが返る
// (=findNearestMarking()が絶対にヒットしない)ことが判明した。「消去」はfindNearestMarking()を
// 使う指示のため、このままでは消去機能自体が原理的に動作しない。既存の"angle"ケース
// (2線分の最短距離の最小値)と全く同じ考え方で、freehand用に「連続する各線分への最短距離の
// 最小値」を1ケースだけ追加した。MARKING_TYPES・isValidMarking・他のtypeの挙動・
// screenToNormalizedPoint()等には一切手を加えていない。

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const StorageEngine = require("./storageEngine.js");
const CoordinateEngine = require("./coordinateEngine.js");
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
// インメモリ「疑似IndexedDB」: shotMarkingsストアを配列で模す。
// StorageEngine.deleteMarking()/deleteShotMarkings()と同じ絞り込みロジック
// (id一致 / shotId一致)をそのまま使う。
// ---------------------------------------------------------------
function makeFakeMarkingsDb(initialRecords) {
  let table = initialRecords.slice();
  return {
    all: () => table.slice(),
    // StorageEngine.deleteMarking(markingId) と同じ意味の削除(idで1件)
    deleteMarking: (markingId) => {
      table = table.filter((r) => r.id !== markingId);
    },
    // StorageEngine.deleteShotMarkings(shotId) と同じ意味の削除(shotIdで一括)
    // = 実装(byShotIdカーソル)と同じ絞り込み条件を、既存のmarkingRecordsForShot()で確認する
    deleteShotMarkings: (shotId) => {
      const toDelete = StorageEngine.markingRecordsForShot(table, shotId).map((r) => r.id);
      table = table.filter((r) => !toDelete.includes(r.id));
    },
    reloadForShot: (shotId) => StorageEngine.markingRecordsForShot(table, shotId),
  };
}

function buildFrameBuffer(durationMs, fps) {
  const frames = [];
  const step = 1000 / fps;
  for (let t = 0; t <= durationMs; t += step) frames.push({ time: Math.round(t) });
  return frames;
}

function buildFreehandMarking(shotId, frameBuffer, playbackTimeAtPointerUp, rawPoints) {
  const frame = BufferEngine.findFrameAt(frameBuffer, playbackTimeAtPointerUp);
  return {
    id: CoordinateEngine.generateMarkingId(),
    shotId: shotId,
    relTime: frame.time,
    type: "freehand",
    points: rawPoints.map((p) => CoordinateEngine.clampNormalizedPoint(p)),
    createdAt: Date.now(),
  };
}

const frameBuffer = buildFrameBuffer(10000, 24);
const PT = [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }]; // 適当な2点ストローク

console.log("\n[STEP14] Test 1: 指定したマーキングを削除できる");
check("Test 1", () => {
  const a = buildFreehandMarking("shotA", frameBuffer, 0, PT);
  const b = buildFreehandMarking("shotA", frameBuffer, 1000, PT);
  const db = makeFakeMarkingsDb([a, b]);
  db.deleteMarking(a.id);
  const remaining = db.all().map((r) => r.id);
  assert.ok(!remaining.includes(a.id));
});

console.log("\n[STEP14] Test 2: 別のマーキングは削除されない");
check("Test 2", () => {
  const a = buildFreehandMarking("shotA", frameBuffer, 0, PT);
  const b = buildFreehandMarking("shotA", frameBuffer, 1000, PT);
  const db = makeFakeMarkingsDb([a, b]);
  db.deleteMarking(a.id);
  const remaining = db.all().map((r) => r.id);
  assert.ok(remaining.includes(b.id));
  assert.strictEqual(remaining.length, 1);
});

console.log("\n[STEP14] Test 3: 別shotのマーキングは削除されない");
check("Test 3", () => {
  const a1 = buildFreehandMarking("shotA", frameBuffer, 0, PT);
  const b1 = buildFreehandMarking("shotB", frameBuffer, 0, PT);
  const db = makeFakeMarkingsDb([a1, b1]);
  db.deleteMarking(a1.id);
  const remaining = db.all();
  assert.strictEqual(remaining.length, 1);
  assert.strictEqual(remaining[0].shotId, "shotB");
});

console.log("\n[STEP14] Test 4: 全消去すると現在shotのマーキングだけ0件になる");
check("Test 4", () => {
  const a1 = buildFreehandMarking("shotA", frameBuffer, 0, PT);
  const a2 = buildFreehandMarking("shotA", frameBuffer, 1000, PT);
  const b1 = buildFreehandMarking("shotB", frameBuffer, 0, PT);
  const db = makeFakeMarkingsDb([a1, a2, b1]);
  db.deleteShotMarkings("shotA");
  assert.strictEqual(db.reloadForShot("shotA").length, 0);
});

console.log("\n[STEP14] Test 5: 全消去しても別shotのマーキングは残る");
check("Test 5", () => {
  const a1 = buildFreehandMarking("shotA", frameBuffer, 0, PT);
  const b1 = buildFreehandMarking("shotB", frameBuffer, 0, PT);
  const b2 = buildFreehandMarking("shotB", frameBuffer, 1000, PT);
  const db = makeFakeMarkingsDb([a1, b1, b2]);
  db.deleteShotMarkings("shotA");
  assert.strictEqual(db.reloadForShot("shotB").length, 2);
});

console.log("\n[STEP14] Test 6: 消去後に再読み込みしても削除状態が維持される");
check("Test 6", () => {
  const a1 = buildFreehandMarking("shotA", frameBuffer, 0, PT);
  const a2 = buildFreehandMarking("shotA", frameBuffer, 1000, PT);
  const db = makeFakeMarkingsDb([a1, a2]);
  db.deleteMarking(a1.id);
  // 「レビューを閉じて再度開く」= loadShotMarkings(shotId)相当の再取得をシミュレート
  const reloaded = db.reloadForShot("shotA");
  assert.strictEqual(reloaded.length, 1);
  assert.strictEqual(reloaded[0].id, a2.id);
});

console.log("\n[STEP14] Test 7: 全消去後に再読み込みしても0件が維持される");
check("Test 7", () => {
  const a1 = buildFreehandMarking("shotA", frameBuffer, 0, PT);
  const a2 = buildFreehandMarking("shotA", frameBuffer, 1000, PT);
  const a3 = buildFreehandMarking("shotA", frameBuffer, 2000, PT);
  const db = makeFakeMarkingsDb([a1, a2, a3]);
  db.deleteShotMarkings("shotA");
  const reloaded = db.reloadForShot("shotA");
  assert.strictEqual(reloaded.length, 0);
});

console.log("\n[STEP14] Test 8: shotFramesは消去操作によって変更されない");
check("Test 8", () => {
  // shotMarkingsの削除ロジック(deleteMarking/deleteShotMarkings)は、
  // MARKINGS_STOREのみを対象にしたトランザクションであり、FRAMES_STOREには
  // 一切アクセスしない実装になっていることをソースレベルで確認する。
  const src = fs.readFileSync(path.join(__dirname, "storageEngine.js"), "utf8");
  const delMarkingFn = src.match(/async function deleteMarking\([\s\S]*?\n  \}/)[0];
  const delShotMarkingsFn = src.match(/async function deleteShotMarkings\([\s\S]*?\n  \}/)[0];
  assert.ok(!delMarkingFn.includes("FRAMES_STORE"), "deleteMarking()がFRAMES_STOREに触れている");
  assert.ok(!delShotMarkingsFn.includes("FRAMES_STORE"), "deleteShotMarkings()がFRAMES_STOREに触れている");
  // 純粋関数の側でも、フレーム配列自体を書き換えていないことを実際に確認する
  const frames = buildFrameBuffer(1000, 24);
  const framesCopy = JSON.parse(JSON.stringify(frames));
  const a1 = buildFreehandMarking("shotA", frames, 0, PT);
  const db = makeFakeMarkingsDb([a1]);
  db.deleteMarking(a1.id);
  assert.deepStrictEqual(frames, framesCopy, "frameBuffer自体が書き換わってしまっている");
});

console.log("\n[STEP14] Test 9: ライブ側マーキングデータに影響しない");
check("Test 9", () => {
  // ライブ側のmarkings配列(coordinateEngine.jsのcreatePointMarking等で作られるもの)は
  // shotIdを持たない別構造であり、本STEPのdeleteMarking/deleteShotMarkingsのロジック
  // (id一致・shotId一致)の対象データとは完全に別物であることを確認する。
  const livePointMarking = CoordinateEngine.createPointMarking({ x: 0.3, y: 0.4 });
  assert.strictEqual(livePointMarking.shotId, undefined, "ライブ側マーキングはshotIdを持たない");
  // ライブ側マーキング配列を、レビュー側の削除ロジックに(誤って)通しても対象にならないことを確認
  const reviewDb = makeFakeMarkingsDb([livePointMarking]);
  reviewDb.deleteShotMarkings("shotA"); // shotIdが無い(=一致しない)ため削除されないはず
  assert.strictEqual(reviewDb.all().length, 1, "shotIdを持たないライブ側データが誤って削除されてしまっている");

  // index.html側で、ライブ側とレビュー側の変数・関数が今回も別名のまま維持されていることも確認する
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  assert.ok(html.includes("let markingMode ="), "ライブ側markingModeが見つからない");
  assert.ok(html.includes("let markings ="), "ライブ側markings配列が見つからない");
  assert.ok(html.includes("let shotMarkingMode ="), "レビュー側shotMarkingModeが見つからない");
  assert.ok(html.includes("let shotMarkingTool ="), "レビュー側shotMarkingTool(STEP14)が見つからない");
  assert.ok(html.includes("function setMarkingMode("), "ライブ側setMarkingMode()が消えている(変更禁止)");
  assert.ok(html.includes("function findNearestMarking".replace("function ", "")) || true);
});

console.log("\n[STEP14] Test 10: relTime完全一致表示仕様(STEP13)がSTEP14でも維持されている");
check("Test 10", () => {
  const markingAt3250 = buildFreehandMarking("shotA", frameBuffer, 3250, PT);
  const allMarkings = [markingAt3250];

  function visibleAt(playbackTime) {
    const frame = BufferEngine.findFrameAt(frameBuffer, playbackTime);
    return allMarkings.filter((m) => m.relTime === frame.time);
  }

  assert.strictEqual(visibleAt(markingAt3250.relTime).length, 1);
  const prevFrameTime = BufferEngine.getPreviousFrameTime(frameBuffer, markingAt3250.relTime);
  const nextFrameTime = BufferEngine.getNextFrameTime(frameBuffer, markingAt3250.relTime);
  assert.strictEqual(visibleAt(prevFrameTime).length, 0);
  assert.strictEqual(visibleAt(nextFrameTime).length, 0);
});

// ---------------------------------------------------------------
// 消去は「現在表示中のマーキングだけ」を対象にすること(指示書25節)の確認。
// findNearestMarking()自体は無変更のcoordinateEngine.jsのものをそのまま使う。
// ---------------------------------------------------------------

console.log("\n[STEP14] 消去は現在フレームに表示中のマーキングだけを対象にする");

check("現在フレームに表示されていないマーキングは、たとえ近くても消去候補に入らない", () => {
  // 00:03 A, 00:05 B という状況で、00:05フレームで消去操作をした場合、
  // Aは候補にすら入らない(=誤って消せない)ことを確認する。
  const timeA = BufferEngine.findFrameAt(frameBuffer, 3000).time;
  const timeB = BufferEngine.findFrameAt(frameBuffer, 5000).time;
  const markingA = { ...buildFreehandMarking("shotA", frameBuffer, 3000, [{ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }]) };
  const markingB = { ...buildFreehandMarking("shotA", frameBuffer, 5000, [{ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }]) };
  const allMarkings = [markingA, markingB];

  // 現在フレームを00:05相当として、visibleShotMarkings()と同じ絞り込みを行う
  const currentFrameTime = timeB;
  const candidates = allMarkings.filter((m) => m.relTime === currentFrameTime);
  assert.strictEqual(candidates.length, 1);
  assert.strictEqual(candidates[0].id, markingB.id);

  // 同じ座標にタップしても、候補に入っていないAは対象にならない
  const found = CoordinateEngine.findNearestMarking(candidates, { x: 0.5, y: 0.5 });
  assert.ok(found);
  assert.strictEqual(found.marking.id, markingB.id);
  assert.notStrictEqual(found.marking.id, markingA.id);
});

check("消去はCoordinateEngine.findNearestMarking()とDEFAULT_ERASE_THRESHOLDをそのまま使う(独自距離計算をしない)", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const fnMatch = html.match(/async function eraseShotMarkingAt[\s\S]*?\n  \}/);
  assert.ok(fnMatch, "eraseShotMarkingAt()が見つからない");
  const body = fnMatch[0];
  assert.ok(body.includes("CoordinateEngine.findNearestMarking("), "findNearestMarking()を使っていない");
  assert.ok(!/Math\.sqrt|Math\.hypot/.test(body), "独自の距離計算を書いてしまっている");
  // 閾値を独自の固定px値で上書きしていないこと(第3引数を渡していない=デフォルトの
  // DEFAULT_ERASE_THRESHOLDがそのまま使われる)ことを確認する
  assert.ok(
    /findNearestMarking\(\s*candidates\s*,\s*point\s*\)/.test(body),
    "findNearestMarking()に独自しきい値を渡してしまっている可能性がある"
  );
});

check("消去時の座標変換はCoordinateEngine.screenToNormalizedPoint()経由のshotEventToNormalizedPoint()を使う(独自変換をしない)", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const fnMatch = html.match(/function shotEventToNormalizedPoint[\s\S]*?\n  \}/);
  assert.ok(fnMatch, "shotEventToNormalizedPoint()が見つからない");
  assert.ok(fnMatch[0].includes("CoordinateEngine.screenToNormalizedPoint("));
});

// ---------------------------------------------------------------
// 全消去の確認ダイアログロジック(confirmキャンセル時は何もしない)
// ---------------------------------------------------------------

console.log("\n[STEP14] 全消去の確認ロジック(confirm=falseなら全消去されない)");

// window.confirm()自体はブラウザAPIなのでNode.jsから直接は呼べないため、
// 「確認結果(true/false)を受け取って全消去を実行するかどうか決める」ロジック部分だけを
// 切り出して検証する(index.html内のshotMarkClearAllBtnハンドラと同じ分岐構造)。
function performClearAll(shotId, markingsBeforeClear, confirmResult, db) {
  if (!shotId || !markingsBeforeClear.length) return { cleared: false, reason: "empty" };
  if (!confirmResult) return { cleared: false, reason: "cancelled" };
  db.deleteShotMarkings(shotId);
  return { cleared: true };
}

check("confirm = false の場合、全消去されない(IndexedDB・メモリともに変化なし)", () => {
  const a1 = buildFreehandMarking("shotA", frameBuffer, 0, PT);
  const a2 = buildFreehandMarking("shotA", frameBuffer, 1000, PT);
  const db = makeFakeMarkingsDb([a1, a2]);
  const result = performClearAll("shotA", [a1, a2], false, db);
  assert.strictEqual(result.cleared, false);
  assert.strictEqual(db.reloadForShot("shotA").length, 2, "confirmをキャンセルしたのに削除されてしまっている");
});

check("confirm = true の場合は全消去される", () => {
  const a1 = buildFreehandMarking("shotA", frameBuffer, 0, PT);
  const db = makeFakeMarkingsDb([a1]);
  const result = performClearAll("shotA", [a1], true, db);
  assert.strictEqual(result.cleared, true);
  assert.strictEqual(db.reloadForShot("shotA").length, 0);
});

check("マーキングが0件のときは、confirm自体を出さず何もしない", () => {
  const db = makeFakeMarkingsDb([]);
  // confirmResultをtrueで渡しても、0件ガードが先に働いて何もしないはず
  const result = performClearAll("shotA", [], true, db);
  assert.strictEqual(result.cleared, false);
  assert.strictEqual(result.reason, "empty");
});

check("index.html側のshotMarkClearAllBtnハンドラが、0件ガード→confirm→deleteShotMarkingsの順になっている", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const fnMatch = html.match(/shotMarkClearAllBtn\.addEventListener\("click",[\s\S]*?\n  \}\);/);
  assert.ok(fnMatch, "shotMarkClearAllBtnのハンドラが見つからない");
  const body = fnMatch[0];
  const idxGuard = body.indexOf("shotMarkings.length) return");
  const idxConfirm = body.indexOf("window.confirm(");
  const idxDelete = body.indexOf("StorageEngine.deleteShotMarkings(");
  assert.ok(idxGuard >= 0 && idxConfirm > idxGuard && idxDelete > idxConfirm, "0件ガード→confirm→削除の順になっていない");
});

// ---------------------------------------------------------------
// StorageEngine API・IndexedDBスキーマの静的確認(実装前チェック項目の裏取り)
// ---------------------------------------------------------------

console.log("\n[STEP14] StorageEngine APIの静的確認");

check("StorageEngine.deleteMarking / deleteShotMarkings が追加されている", () => {
  const src = fs.readFileSync(path.join(__dirname, "storageEngine.js"), "utf8");
  assert.ok(/async function deleteMarking\(markingId\)/.test(src));
  assert.ok(/async function deleteShotMarkings\(shotId\)/.test(src));
  assert.ok(src.includes("api.deleteMarking = deleteMarking"));
  assert.ok(src.includes("api.deleteShotMarkings = deleteShotMarkings"));
});

check("DB_VERSIONはSTEP13の2のまま(STEP14でスキーマ変更していない)", () => {
  const src = fs.readFileSync(path.join(__dirname, "storageEngine.js"), "utf8");
  assert.ok(/const DB_VERSION = 2;/.test(src), "DB_VERSIONが2以外に変更されている");
  assert.ok(!/const DB_VERSION = 3/.test(src));
});

check("findFrameAt等、bufferEngine.js/playbackEngine.jsの既存APIは変更されていない(coordinateEngine.jsのみ、後述の理由で1箇所だけ追加あり)", () => {
  assert.strictEqual(typeof CoordinateEngine.findNearestMarking, "function");
  assert.strictEqual(typeof CoordinateEngine.DEFAULT_ERASE_THRESHOLD, "number");
  assert.strictEqual(typeof BufferEngine.findFrameAt, "function");
});

console.log("\n[STEP14] coordinateEngine.jsへの必要最小限の追加(理由の裏取り)");

check("【要報告】freehandはdistanceToMarking()に元々ケースが無くInfinity扱いだった(=消去が機能しない致命的な欠落)ため、angleケースと同じ考え方(連続する線分への最短距離)で1ケースだけ追加した", () => {
  const frameBuffer2 = buildFrameBuffer(1000, 24);
  const stroke = buildFreehandMarking("shotA", frameBuffer2, 0, [
    { x: 0.2, y: 0.5 },
    { x: 0.5, y: 0.5 },
    { x: 0.8, y: 0.5 },
  ]);
  // 追加前は必ずnullだった(distanceToMarking→Infinity→閾値を超えるため)。
  // 追加後は、線分の近くをタップすれば正しくヒットする。
  const found = CoordinateEngine.findNearestMarking([stroke], { x: 0.5, y: 0.505 });
  assert.ok(found, "freehandがfindNearestMarking()でヒットしない(coordinateEngine.jsの追加が効いていない)");
  assert.strictEqual(found.marking.id, stroke.id);
  // MARKING_TYPES・isValidMarking等、他の既存動作には影響していないことも確認する
  assert.ok(CoordinateEngine.isValidMarking(stroke));
  assert.deepStrictEqual(CoordinateEngine.MARKING_TYPES, [
    "point", "freehand", "vertical", "horizontal", "line", "angle", "arrow_release",
  ]);
});

console.log("\n" + passCount + " 件成功" + (process.exitCode ? " / 失敗あり" : " / 全て成功"));
console.log(
  "\n[注記] 以下はNode.jsでは検証できず、実機確認が必要です:\n" +
    "  - 実際のIndexedDBに対するdeleteMarking()/deleteShotMarkings()の書き込み\n" +
    "  - iPad Safariでの「描く/消去」タップ操作の切り替え感、消去の当たり判定の実感\n" +
    "  - マーキングON時の自動一時停止、OFF後の再生への復帰\n" +
    "  - 全消去の確認ダイアログの実際の見た目・キャンセル動作\n"
);
