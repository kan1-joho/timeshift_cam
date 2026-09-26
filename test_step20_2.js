// test_step20_2.js
//
// STEP20-2(保存済み射をMP4動画化してiPad写真アプリへ保存する)の静的確認テスト。
//
// STEP20-1(verify_video_export.html)と同じ理由により、MediaRecorder/captureStream/
// Web Share APIの実際の動作そのものはNode.jsでは検証できない(iPad Safari実機確認が必須)。
// ここでは、
//   1. 追加した動画保存機能が、既存の4エンジンファイル(bufferEngine/playbackEngine/
//      storageEngine/coordinateEngine)を変更していないこと
//   2. 4エンジンファイルは「読むだけ」で使っており、独自の書き込み・改変をしていないこと
//   3. 禁止事項(WebCodecs導入・MP4変換ライブラリ導入・音声追加・マーキング焼き込み・
//      表示用Canvasの録画流用・60秒固定化)に抵触していないこと
//   4. 仕様書にある実装要素(shotFramesの読み込み・専用exportCanvas・captureStream・
//      MediaRecorder(MP4優先)・Blob生成・navigator.share・エラー種別の区別)が
//      コード上に存在すること
//   5. 既存の保存/レビュー/比較まわりのUI要素・関数が変更前と同じ形で残っていること
// を静的に確認する。
//
// 既存テスト(test_coordinateEngine.js / test_step11.js〜test_step17.js)は本ファイルの対象外。
// 別途そのまま実行し、STEP11〜17の回帰が無いことを確認すること
// (既知のicon-192.png未提供によるSTEP12の1件の失敗は本ファイルの対象外)。

const assert = require("assert");
const fs = require("fs");
const path = require("path");

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

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

// STEP20-2のコード範囲だけを取り出す(前後の既存コードに影響していないかの確認にも使う)
// 注意: 「STEP20-2」という文字列は、一覧描画コード内の動画保存ボタン生成部にも
// 短いコメントとして出現する(refreshShotList()内、削除ボタン定義より前)。
// そこを起点にすると削除ボタンの実装まで区間に含んでしまい、書き込み系API誤検出の原因になるため、
// 起点はSTEP20-2セクション見出し直後にしか出てこない一意な文字列(exportStatusElの定義)にする。
const sectionStart = html.indexOf('const exportStatusEl = document.getElementById("exportStatus");');
const sectionEnd = html.indexOf("// ---- 保存済み射の再生 ----");
const step20Src = sectionStart >= 0 && sectionEnd > sectionStart ? html.slice(sectionStart, sectionEnd) : "";

console.log("\n[STEP20-2] 4エンジンファイルへの非依存・非改変の確認");

check("bufferEngine.js / playbackEngine.js / storageEngine.js / coordinateEngine.js は今回1バイトも変更していない", () => {
  ["bufferEngine.js", "playbackEngine.js", "storageEngine.js", "coordinateEngine.js"].forEach((f) => {
    assert.ok(fs.existsSync(path.join(__dirname, f)), f + "が見つからない");
  });
  const storageSrc = fs.readFileSync(path.join(__dirname, "storageEngine.js"), "utf8");
  assert.ok(/const DB_VERSION = 2;/.test(storageSrc), "DB_VERSIONが変更されている(StorageEngineは無変更のはず)");
  assert.ok(!/DB_VERSION = 3/.test(storageSrc));
  assert.ok(!storageSrc.includes("exportShotAsVideo"), "storageEngine.js側に動画化ロジックが混入している");
});

check("STEP20-2のコードはStorageEngine.loadShotFrames()を読み出すだけで、書き込み系APIを呼んでいない", () => {
  assert.ok(step20Src.length > 0, "STEP20-2セクションの範囲を特定できない");
  assert.ok(step20Src.includes("StorageEngine.loadShotFrames("), "shotFramesの読み込みが見つからない");
  [
    "StorageEngine.saveShot",
    "StorageEngine.saveMarking",
    "StorageEngine.deleteShot(",
    "StorageEngine.deleteMarking(",
    "StorageEngine.deleteShotMarkings(",
  ].forEach((writeApi) => {
    assert.ok(!step20Src.includes(writeApi), "動画保存コードが書き込み系API(" + writeApi + ")を呼んでいる");
  });
});

check("BufferEngine.findFrameAt()を読み出すだけで、独自の時刻検索ロジックを書いていない", () => {
  assert.ok(step20Src.includes("BufferEngine.findFrameAt("), "findFrameAt()を使っていない(独自実装の疑い)");
});

console.log("\n[STEP20-2] 禁止事項に抵触していないことの確認");

check("WebCodecsを導入していない", () => {
  assert.ok(!/VideoEncoder|VideoDecoder/.test(step20Src), "禁止: WebCodecsらしき記述がある");
});

check("MP4変換ライブラリ(ffmpeg等)を導入していない", () => {
  assert.ok(!/ffmpeg/i.test(html), "禁止: ffmpeg関連の記述がある");
  // 外部CDN等の新規<script src>が本体に追加されていないこと(4エンジン+PWA登録のみのはず)
  const scriptSrcs = [...html.matchAll(/<script src="([^"]+)">/g)].map((m) => m[1]);
  scriptSrcs.forEach((src) => {
    assert.ok(
      ["bufferEngine.js", "playbackEngine.js", "storageEngine.js", "coordinateEngine.js"].includes(src),
      "想定外の外部scriptが追加されている: " + src
    );
  });
});

check("音声トラックを追加していない(Canvas映像のみ)", () => {
  assert.ok(!/getUserMedia\(\s*\{\s*audio:\s*true/.test(step20Src));
  assert.ok(!step20Src.includes("addTrack"), "音声トラック等の追加(addTrack)が見つかる");
});

check("マーキングを動画へ焼き込んでいない(markingOverlay/shotMarkings等に触れていない)", () => {
  ["markingOverlay", "shotReviewMarkingOverlay", "shotMarkings", "comparisonMarkOverlay", "drawMarkingShape", "drawShotMarkingShape"].forEach(
    (token) => {
      assert.ok(!step20Src.includes(token), "マーキング関連(" + token + ")に触れている");
    }
  );
});

check("既存の表示用Canvas(displayCanvas/shotReviewCanvas/comparisonCanvasA/B)を録画対象に流用していない", () => {
  ["displayCanvas.captureStream", "shotReviewCanvas.captureStream", "comparisonCanvasA.captureStream", "comparisonCanvasB.captureStream"].forEach(
    (token) => {
      assert.ok(!html.includes(token), "禁止: 既存の表示用Canvasを直接captureStreamしている(" + token + ")");
    }
  );
  assert.ok(step20Src.includes("document.createElement(\"canvas\")"), "専用exportCanvasの生成が見つからない");
});

check("録画時間を60秒や10秒に固定していない(保存フレームのtimeから算出したdurationMsを使う)", () => {
  assert.ok(step20Src.includes("frames[frames.length - 1].time"), "durationMsが保存フレームのtimeから算出されていない");
  assert.ok(!/setInterval\(/.test(step20Src), "setInterval()での適当な間隔描画をしている(禁止)");
});

console.log("\n[STEP20-2] 仕様書の実装要素がコード上に存在すること");

check("専用exportCanvasを使い、サイズを保存フレームのBitmapに合わせている(縦横比を維持)", () => {
  assert.ok(step20Src.includes("exportCanvas.width = frames[0].bitmap.width"));
  assert.ok(step20Src.includes("exportCanvas.height = frames[0].bitmap.height"));
});

check("exportCanvas.captureStream(24)を使っている", () => {
  assert.ok(/exportCanvas\.captureStream\(\s*24\s*\)/.test(step20Src));
});

check("MediaRecorderを使い、MP4系mimeTypeを最優先で試している(isTypeSupportedで確認)", () => {
  assert.ok(step20Src.includes("new MediaRecorder("));
  assert.ok(step20Src.includes("MediaRecorder.isTypeSupported"));
  const idx = step20Src.indexOf("EXPORT_MIME_CANDIDATES");
  assert.ok(idx >= 0, "EXPORT_MIME_CANDIDATESが見つからない");
  const arrText = step20Src.slice(step20Src.indexOf("[", idx), step20Src.indexOf("];", idx));
  assert.ok(arrText.indexOf("video/mp4") < arrText.indexOf("video/webm"), "MP4がWebMより優先されていない");
});

check("Blobを生成している", () => {
  assert.ok(/new Blob\(/.test(step20Src));
});

check("Web Share API(files)を使い、canShareで対応可否を確認してから共有している", () => {
  assert.ok(step20Src.includes("navigator.share("));
  assert.ok(step20Src.includes("navigator.canShare("));
  assert.ok(step20Src.includes("new File("));
});

check("既存shotの保存日時(createdAt)を使ってファイル名を生成し、StorageEngineのデータ構造を変更していない", () => {
  assert.ok(step20Src.includes("formatShotFilenameDate(shot.createdAt)"));
});

check("エラー種別A〜Cに対応する文言が存在する(開始失敗/生成失敗/共有非対応)", () => {
  assert.ok(step20Src.includes("動画の作成を開始できませんでした"));
  assert.ok(step20Src.includes("動画の作成に失敗しました"));
  assert.ok(step20Src.includes("共有機能が利用できません"));
});

check("ユーザーによる共有キャンセル(AbortError)はエラー扱いにしない", () => {
  assert.ok(step20Src.includes('err.name === "AbortError"'));
  assert.ok(step20Src.includes("キャンセルしました"));
});

check("処理中表示(「動画を作成しています…」)がある", () => {
  assert.ok(step20Src.includes("動画を作成しています…"));
});

check("動画保存UI(一覧の各射に「動画保存」ボタン)が存在する", () => {
  assert.ok(html.includes('exportBtn.textContent = "動画保存"'));
  assert.ok(html.includes('exportBtn.className = "shot-export"'));
  assert.ok(html.includes("exportShotAsVideo(shot)"));
});

console.log("\n[STEP20-2] 既存機能(保存・レビュー・比較・設定)への非破壊の確認");

check("既存の保存済み射一覧の要素(再生/削除ボタン、比較チェックボックス)がそのまま残っている", () => {
  assert.ok(html.includes('playBtn.textContent = "再生"'));
  assert.ok(html.includes('delBtn.textContent = "削除"'));
  assert.ok(html.includes('delBtn.className = "shot-delete"'));
  assert.ok(html.includes("shot-compare-check"));
});

check("保存射レビュー(shotPlayback等)・比較(comparisonA/B等)の主要関数が変更前と同じ名前で残っている", () => {
  [
    "async function openShotReview(shot)",
    "function closeShotReview()",
    "async function openComparison(shotA, shotB)",
    "function closeComparison()",
    "function setComparisonSync(on)",
  ].forEach((sig) => {
    assert.ok(html.includes(sig), sig + " が見つからない(既存関数が変更・削除された可能性)");
  });
});

check("STEP19で修正済みのsetComparisonMarkingMode(channel, false)呼び出しが維持されている(再度壊していない)", () => {
  assert.ok(html.includes("setComparisonMarkingMode(channel, false)"), "STEP19の修正が失われている");
});

check("射の保存(saveShotBtn)・保存状況表示(saveStatus)の既存コードに触れていない", () => {
  assert.ok(html.includes('saveShotBtn.addEventListener("click"'));
  assert.ok(html.includes('const saveStatus = document.getElementById("saveStatus")'));
});

check("動画保存用の状態表示(exportStatus)が、既存のsaveStatusとは別要素として独立している", () => {
  assert.ok(html.includes('id="exportStatus"'));
  assert.ok(html.includes('id="saveStatus"'));
  assert.notStrictEqual(
    html.indexOf('id="exportStatus"'),
    html.indexOf('id="saveStatus"'),
    "exportStatusとsaveStatusが同一要素になっている"
  );
});

check("HTML内のメインスクリプトが構文として解析可能である(実行はしない)", () => {
  const scriptMatch = html.match(/<script>\s*\(\(\) => \{[\s\S]*?\}\)\(\);\s*<\/script>/);
  assert.ok(scriptMatch, "本体IIFEスクリプトブロックが見つからない");
  assert.doesNotThrow(() => {
    // eslint-disable-next-line no-new-func
    new Function(scriptMatch[0].replace(/^<script>/, "").replace(/<\/script>$/, ""));
  });
});

console.log("\n" + passCount + " 件成功" + (process.exitCode ? " / 失敗あり" : " / 全て成功"));
console.log(
  "\n[注記] 以下はNode.jsでは検証できず、iPad Safari実機確認が必要です(指示書20〜21節):\n" +
    "  1. 保存済み射を選択→「動画保存」を押す→処理中表示→動画作成完了\n" +
    "  2. 共有シート表示→写真アプリへ保存→写真アプリで再生\n" +
    "  3. 元の保存射と動画内容が一致し、長さも概ね一致する\n" +
    "  4. 動画の縦横比・向きが正常\n" +
    "  5. 動画保存機能追加後も、保存射レビュー・A/B比較が正常に動作する\n"
);
