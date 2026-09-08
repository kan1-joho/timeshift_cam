// test_coordinateEngine.js
// coordinateEngine.js のテスト。STEP10指示書「19. 座標変換の自動テスト」のテスト1〜6と、
// マーキングデータ構造のテストを行う。

const assert = require("assert");
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

function closeTo(a, b, eps) {
  eps = eps || 0.001;
  return Math.abs(a - b) < eps;
}

console.log("\n[テスト1] 四隅・中央のマッピング(映像とコンテナが同アスペクト比の場合)");

check("(0,0) → 正規化(0,0)、(1,1)側の画面座標 → 正規化(1,1)、中央 → (0.5,0.5)", () => {
  // コンテナと映像が同じ比率(640x360)なので余白なし
  const cw = 640, ch = 360, vw = 640, vh = 360;
  assert.deepStrictEqual(CoordinateEngine.screenToNormalizedPoint(0, 0, cw, ch, vw, vh), { x: 0, y: 0 });
  const br = CoordinateEngine.screenToNormalizedPoint(640, 360, cw, ch, vw, vh);
  assert.ok(closeTo(br.x, 1) && closeTo(br.y, 1));
  const center = CoordinateEngine.screenToNormalizedPoint(320, 180, cw, ch, vw, vh);
  assert.ok(closeTo(center.x, 0.5) && closeTo(center.y, 0.5));
});

check("normalizedToScreenPoint と screenToNormalizedPoint は互いに逆変換になる(往復一致)", () => {
  const cw = 800, ch = 450, vw = 640, vh = 360; // 同比率
  const original = { x: 0.3, y: 0.7 };
  const screen = CoordinateEngine.normalizedToScreenPoint(original.x, original.y, cw, ch, vw, vh);
  const back = CoordinateEngine.screenToNormalizedPoint(screen.x, screen.y, cw, ch, vw, vh);
  assert.ok(closeTo(back.x, original.x) && closeTo(back.y, original.y));
});

console.log("\n[テスト2] 画面サイズが変わってもnormalized座標の意味が変わらない");

check("同じ正規化座標(0.25,0.75)が、異なるコンテナサイズでも映像内の同じ相対位置を指す", () => {
  const vw = 640, vh = 360; // 同比率のコンテナで確認
  const sizes = [
    { cw: 640, ch: 360 },
    { cw: 1280, ch: 720 },
    { cw: 960, ch: 540 },
  ];
  const results = sizes.map((s) => {
    const p = CoordinateEngine.normalizedToScreenPoint(0.25, 0.75, s.cw, s.ch, vw, vh);
    return { relX: p.x / s.cw, relY: p.y / s.ch };
  });
  results.forEach((r) => {
    assert.ok(closeTo(r.relX, 0.25) && closeTo(r.relY, 0.75));
  });
});

console.log("\n[テスト3] object-fit:containの余白(レターボックス)を正しく考慮する");

check("横長コンテナに縦長映像(左右に余白) → 余白部分はクランプされ、映像内部は正しく変換される", () => {
  const cw = 1000, ch = 500; // 横長コンテナ(2:1)
  const vw = 360, vh = 640; // 縦長映像(9:16程度)
  const rect = CoordinateEngine.computeContainRect(cw, ch, vw, vh);
  // 高さ基準でフィットするはず(コンテナ高さ500 = 映像の描画高さ)
  assert.ok(closeTo(rect.height, 500));
  assert.ok(rect.width < cw); // 左右に余白ができる
  assert.ok(rect.x > 0);

  // 余白(左端x=0)をタップした場合 → 映像外なので0にクランプされる
  const leftMargin = CoordinateEngine.screenToNormalizedPoint(0, 250, cw, ch, vw, vh);
  assert.strictEqual(leftMargin.x, 0);

  // 映像矩形の中心をタップした場合 → 正規化(0.5, 0.5)になる
  const centerScreen = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  const centerNorm = CoordinateEngine.screenToNormalizedPoint(centerScreen.x, centerScreen.y, cw, ch, vw, vh);
  assert.ok(closeTo(centerNorm.x, 0.5) && closeTo(centerNorm.y, 0.5));
});

check("縦長コンテナに横長映像(上下に余白) → 余白部分の座標も破綻しない", () => {
  const cw = 400, ch = 900; // 縦長コンテナ
  const vw = 1280, vh = 720; // 横長映像
  const rect = CoordinateEngine.computeContainRect(cw, ch, vw, vh);
  assert.ok(closeTo(rect.width, 400)); // 幅基準でフィット
  assert.ok(rect.height < ch);
  assert.ok(rect.y > 0);

  // 上端の余白(y=0)をタップ → 0にクランプ
  const topMargin = CoordinateEngine.screenToNormalizedPoint(200, 0, cw, ch, vw, vh);
  assert.strictEqual(topMargin.y, 0);
});

console.log("\n[テスト4] 0°/90°/180°/270°相当(映像の幅と高さが入れ替わる)でも座標変換が破綻しない");

check("横向き(1280x720)と縦向き相当(720x1280, 90°/270°回転で幅高さが入れ替わった状態)の両方で中央が正しく求まる", () => {
  // coordinateEngineは screen.orientation.angle を直接扱わず、既に回転補正済みの
  // displayCanvasのwidth/height(=videoW/videoH)を受け取るだけでよい、という設計を確認する。
  const cases = [
    { vw: 1280, vh: 720 }, // 0°または180°相当
    { vw: 720, vh: 1280 }, // 90°または270°相当(幅と高さが入れ替わっている)
  ];
  cases.forEach(({ vw, vh }) => {
    const cw = 1000, ch = 1000; // 正方形コンテナで確認
    const rect = CoordinateEngine.computeContainRect(cw, ch, vw, vh);
    const centerScreen = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    const centerNorm = CoordinateEngine.screenToNormalizedPoint(centerScreen.x, centerScreen.y, cw, ch, vw, vh);
    assert.ok(closeTo(centerNorm.x, 0.5) && closeTo(centerNorm.y, 0.5), "vw=" + vw + " vh=" + vh);
  });
});

console.log("\n[テスト5] 映像の縦横比が変わっても正しく変換できる");

check("複数の解像度・アスペクト比で、正規化(0.1,0.9)の往復変換が一致する", () => {
  const combos = [
    { vw: 640, vh: 360 },
    { vw: 1280, vh: 720 },
    { vw: 1920, vh: 1080 },
    { vw: 480, vh: 640 }, // 縦長
    { vw: 1000, vh: 300 }, // 極端な横長
  ];
  combos.forEach(({ vw, vh }) => {
    const cw = 900, ch = 700;
    const original = { x: 0.1, y: 0.9 };
    const screen = CoordinateEngine.normalizedToScreenPoint(original.x, original.y, cw, ch, vw, vh);
    const back = CoordinateEngine.screenToNormalizedPoint(screen.x, screen.y, cw, ch, vw, vh);
    assert.ok(closeTo(back.x, original.x) && closeTo(back.y, original.y), "vw=" + vw + " vh=" + vh);
  });
});

console.log("\n[テスト6] 範囲外の座標は0〜1にクランプされる");

check("clampNormalizedPointは範囲外の値を0〜1に丸める", () => {
  assert.deepStrictEqual(CoordinateEngine.clampNormalizedPoint({ x: -0.5, y: 1.8 }), { x: 0, y: 1 });
  assert.deepStrictEqual(CoordinateEngine.clampNormalizedPoint({ x: 0.4, y: -3 }), { x: 0.4, y: 0 });
});

check("余白の外側(コンテナ全体の隅)をタップしても正規化座標は0〜1に収まる", () => {
  const cw = 1000, ch = 500;
  const vw = 360, vh = 640;
  const farOutside = CoordinateEngine.screenToNormalizedPoint(-500, -500, cw, ch, vw, vh);
  assert.ok(farOutside.x >= 0 && farOutside.x <= 1);
  assert.ok(farOutside.y >= 0 && farOutside.y <= 1);
  const farOutside2 = CoordinateEngine.screenToNormalizedPoint(cw + 500, ch + 500, cw, ch, vw, vh);
  assert.ok(farOutside2.x >= 0 && farOutside2.x <= 1);
  assert.ok(farOutside2.y >= 0 && farOutside2.y <= 1);
});

console.log("\n[マーキングデータ構造] 生成・妥当性検証");

check("点マーキングは範囲外の値もクランプされて生成される", () => {
  const m = CoordinateEngine.createPointMarking({ x: 1.5, y: -0.2, timeMs: 1234 });
  assert.strictEqual(m.type, "point");
  assert.strictEqual(m.x, 1);
  assert.strictEqual(m.y, 0);
  assert.strictEqual(m.timeMs, 1234);
  assert.ok(CoordinateEngine.isValidMarking(m));
});

check("縦線マーキングはx座標のみを保持する(2点保存ではない)", () => {
  const v = CoordinateEngine.createVerticalMarking({ x: 0.5 });
  assert.strictEqual(v.type, "vertical");
  assert.strictEqual(v.x, 0.5);
  assert.strictEqual(v.start, undefined, "縦線はstart/endを持たない");
  assert.ok(CoordinateEngine.isValidMarking(v));
});

check("横線マーキングはy座標のみを保持する(2点保存ではない)", () => {
  const h = CoordinateEngine.createHorizontalMarking({ y: 0.5 });
  assert.strictEqual(h.type, "horizontal");
  assert.strictEqual(h.y, 0.5);
  assert.ok(CoordinateEngine.isValidMarking(h));
});

check("縦線・横線のx/yも範囲外ならクランプされる", () => {
  assert.strictEqual(CoordinateEngine.createVerticalMarking({ x: 1.5 }).x, 1);
  assert.strictEqual(CoordinateEngine.createHorizontalMarking({ y: -0.3 }).y, 0);
});

check("汎用の線マーキング(createLineMarking)はstart/endを持つ", () => {
  const line = CoordinateEngine.createLineMarking({ start: { x: 0.2, y: 0.3 }, end: { x: 0.8, y: 0.9 } });
  assert.strictEqual(line.type, "line");
  assert.ok(CoordinateEngine.isValidMarking(line));
});

check("角度マーキングは3点を保存し、角度そのものは保存しない(表示時に再計算する)", () => {
  const points = [
    { x: 0.4, y: 0.5 },
    { x: 0.5, y: 0.3 },
    { x: 0.6, y: 0.5 },
  ];
  const m = CoordinateEngine.createAngleMarking({ points });
  assert.strictEqual(m.type, "angle");
  assert.strictEqual(m.points.length, 3);
  assert.strictEqual(m.angle, undefined, "角度の数値そのものはオブジェクトに保存しない");
  assert.ok(CoordinateEngine.isValidMarking(m));
});

check("computeAngleDegreesは3点から角度を再計算できる(直角の例)", () => {
  const points = [
    { x: 0.5, y: 0.4 }, // 頂点の上
    { x: 0.5, y: 0.5 }, // 頂点
    { x: 0.6, y: 0.5 }, // 頂点の右
  ];
  const deg = CoordinateEngine.computeAngleDegrees(points);
  assert.ok(closeTo(deg, 90, 0.5));
});

check("角度マーキングは3点ちょうどでないとエラーになる", () => {
  assert.throws(() => {
    CoordinateEngine.createAngleMarking({ points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] });
  });
});

check("矢飛び出し位置マーキングはtimeMsと紐づけて保存できる", () => {
  const m = CoordinateEngine.createArrowReleaseMarking({ x: 0.62, y: 0.41, timeMs: 5000 });
  assert.strictEqual(m.type, "arrow_release");
  assert.strictEqual(m.timeMs, 5000);
  assert.ok(CoordinateEngine.isValidMarking(m));
});

check("arrow_releaseのtimeMsは、playback.playbackTimeのような小数を含む値でも丸められずそのまま保持される", () => {
  const playbackTimeLike = 123456.789;
  const m = CoordinateEngine.createArrowReleaseMarking({ x: 0.5, y: 0.5, timeMs: playbackTimeLike });
  assert.strictEqual(m.timeMs, playbackTimeLike);
});

console.log("\n[削除] 1件削除・全消去(マーキング配列操作の基本パターン)");

check("「最後に追加したものを削除」は配列の末尾要素を取り除くだけで実現できる", () => {
  const markings = [
    CoordinateEngine.createPointMarking({ x: 0.1, y: 0.1 }),
    CoordinateEngine.createPointMarking({ x: 0.2, y: 0.2 }),
    CoordinateEngine.createPointMarking({ x: 0.3, y: 0.3 }),
  ];
  const removed = markings.pop();
  assert.strictEqual(markings.length, 2);
  assert.strictEqual(removed.x, 0.3);
  assert.ok(markings.every((m) => m.x !== 0.3));
});

check("全消去は配列を空にするだけで、他の状態(idカウンタ等)に影響しない", () => {
  let markings = [
    CoordinateEngine.createPointMarking({ x: 0.1, y: 0.1 }),
    CoordinateEngine.createHorizontalMarking({ y: 0.5 }),
  ];
  markings = [];
  assert.strictEqual(markings.length, 0);
  // クリア後も新規生成は問題なく行える
  const next = CoordinateEngine.createPointMarking({ x: 0.9, y: 0.9 });
  assert.ok(CoordinateEngine.isValidMarking(next));
});

check("マーキングIDは大量生成しても重複しない", () => {
  const ids = new Set();
  for (let i = 0; i < 2000; i++) {
    ids.add(CoordinateEngine.generateMarkingId());
  }
  assert.strictEqual(ids.size, 2000);
});

check("不正な構造のマーキングはisValidMarkingでfalseになる", () => {
  assert.strictEqual(CoordinateEngine.isValidMarking(null), false);
  assert.strictEqual(CoordinateEngine.isValidMarking({ type: "unknown_type", id: "x" }), false);
  assert.strictEqual(CoordinateEngine.isValidMarking({ type: "point", id: "x", x: NaN, y: 0.5 }), false);
  assert.strictEqual(CoordinateEngine.isValidMarking({ type: "line", id: "x", start: { x: 0, y: 0 } }), false); // endが無い
  assert.strictEqual(
    CoordinateEngine.isValidMarking({ type: "angle", id: "x", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }),
    false
  ); // 2点しかない
});

console.log("\n" + passCount + " 件成功" + (process.exitCode ? " / 失敗あり" : " / 全て成功"));
