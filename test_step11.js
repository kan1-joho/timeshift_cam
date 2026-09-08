// test_step11.js
// STEP11: 消去モード(distancePointToPoint / distancePointToSegment / findNearestMarking)のテスト。
// 点・縦線・横線・角度・矢それぞれの生成とtimeMs保持は test_coordinateEngine.js で
// 既にカバーされているため、ここでは消去まわりに絞る。

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

console.log("\n[STEP11] 消去モード: 距離判定");

check("distancePointToPoint: 単純なユークリッド距離", () => {
  assert.strictEqual(CoordinateEngine.distancePointToPoint({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
});

check("distancePointToSegment: 線分の垂線の足が区間内にある場合", () => {
  const d = CoordinateEngine.distancePointToSegment({ x: 0.5, y: 0.5 }, { x: 0, y: 0 }, { x: 1, y: 0 });
  assert.ok(Math.abs(d - 0.5) < 1e-9);
});

check("distancePointToSegment: 垂線の足が区間外の場合、端点までの距離になる", () => {
  const d = CoordinateEngine.distancePointToSegment({ x: 2, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 });
  assert.ok(Math.abs(d - 1) < 1e-9); // 端点(1,0)までの距離
});

check("distancePointToSegment: 始点と終点が同一点(縮退)の場合は点との距離になる", () => {
  const d = CoordinateEngine.distancePointToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 });
  assert.strictEqual(d, 5);
});

console.log("\n[STEP11] 消去モード: 最近傍マーキング探索");

check("点マーキングのうち最も近いものを見つける", () => {
  const markings = [
    CoordinateEngine.createPointMarking({ x: 0.1, y: 0.1 }),
    CoordinateEngine.createPointMarking({ x: 0.5, y: 0.5 }),
    CoordinateEngine.createPointMarking({ x: 0.9, y: 0.9 }),
  ];
  const result = CoordinateEngine.findNearestMarking(markings, { x: 0.51, y: 0.49 });
  assert.ok(result);
  assert.strictEqual(result.marking.x, 0.5);
});

check("縦線: x座標との距離で判定する(y位置に関わらず線分全体が対象)", () => {
  const v = CoordinateEngine.createVerticalMarking({ x: 0.3 });
  const result = CoordinateEngine.findNearestMarking([v], { x: 0.31, y: 0.9 }); // 下の方をタップ
  assert.ok(result, "縦線は上端から下端まで伸びているので、どのy位置でも近ければヒットするはず");
  assert.strictEqual(result.marking.id, v.id);
});

check("横線: y座標との距離で判定する", () => {
  const h = CoordinateEngine.createHorizontalMarking({ y: 0.7 });
  const result = CoordinateEngine.findNearestMarking([h], { x: 0.05, y: 0.705 });
  assert.ok(result);
  assert.strictEqual(result.marking.id, h.id);
});

check("角度: 2本の線分(p1-p2, p2-p3)のうち近い方との距離で判定する", () => {
  const angle = CoordinateEngine.createAngleMarking({
    points: [
      { x: 0.2, y: 0.5 },
      { x: 0.5, y: 0.5 },
      { x: 0.5, y: 0.2 },
    ],
  });
  // p1-p2線分(横方向)の中点付近をタップ
  const result = CoordinateEngine.findNearestMarking([angle], { x: 0.35, y: 0.505 });
  assert.ok(result);
  assert.strictEqual(result.marking.id, angle.id);
});

check("矢飛び出し位置マーキングも点として距離判定できる", () => {
  const arrow = CoordinateEngine.createArrowReleaseMarking({ x: 0.62, y: 0.41, timeMs: 5000 });
  const result = CoordinateEngine.findNearestMarking([arrow], { x: 0.615, y: 0.412 });
  assert.ok(result);
  assert.strictEqual(result.marking.id, arrow.id);
});

check("閾値(デフォルト)を超える距離のマーキングはヒットしない(nullを返す)", () => {
  const p = CoordinateEngine.createPointMarking({ x: 0.1, y: 0.1 });
  const result = CoordinateEngine.findNearestMarking([p], { x: 0.9, y: 0.9 });
  assert.strictEqual(result, null);
});

check("閾値は将来調整できるよう引数で上書きできる", () => {
  const p = CoordinateEngine.createPointMarking({ x: 0.1, y: 0.1 });
  const nearButOutsideDefault = { x: 0.1 + CoordinateEngine.DEFAULT_ERASE_THRESHOLD * 2, y: 0.1 };
  const resultDefault = CoordinateEngine.findNearestMarking([p], nearButOutsideDefault);
  assert.strictEqual(resultDefault, null);
  const resultWithBiggerThreshold = CoordinateEngine.findNearestMarking(
    [p],
    nearButOutsideDefault,
    CoordinateEngine.DEFAULT_ERASE_THRESHOLD * 3
  );
  assert.ok(resultWithBiggerThreshold);
});

check("マーキングが空配列の場合はnullを返す", () => {
  assert.strictEqual(CoordinateEngine.findNearestMarking([], { x: 0.5, y: 0.5 }), null);
});

check("複数種類が混在していても、最も近い1件だけを返す(境界条件)", () => {
  const point = CoordinateEngine.createPointMarking({ x: 0.5, y: 0.1 }); // タップ位置からは遠い
  const vertical = CoordinateEngine.createVerticalMarking({ x: 0.501 }); // タップ位置に非常に近い縦線
  const result = CoordinateEngine.findNearestMarking([point, vertical], { x: 0.5005, y: 0.5 });
  assert.ok(result);
  assert.strictEqual(result.marking.type, "vertical");
});

console.log("\n" + passCount + " 件成功" + (process.exitCode ? " / 失敗あり" : " / 全て成功"));
