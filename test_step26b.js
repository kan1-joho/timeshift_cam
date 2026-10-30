// test_step26b.js
// STEP26-B(端末非依存・機能適応型のカメラ機能検出/ズーム/カメラ選択)のテスト。
// index.html内のSTEP26B-BEGIN〜ENDの純粋ロジックをそのまま取り出して検証する(実装とテストの乖離防止)。
// 実機(iPad Safari)でしか確認できない項目は末尾の注記を参照。
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
function extract(begin, end) {
  const a = html.indexOf(begin), b = html.indexOf(end);
  assert.ok(a >= 0 && b > a, begin + " 範囲が見つからない");
  return html.slice(a + begin.length, b);
}
const pureSrc = extract("// STEP26B-BEGIN", "// STEP26B-END");
const uiSrc = extract("// STEP26B-UI-BEGIN", "// STEP26B-UI-END");
const L = new Function(
  pureSrc +
    "; return {normalizeZoomCapability, zoomSliderStep, zoomButtonStep, zoomTolerance, normalizeVideoInputs," +
    " selectableVideoInputs, describeCameraOption, detectCameraFeatures, applyZoom, restoreInitialZoom," +
    " formatZoomStatus, formatZoomRestoreFailure, decideCameraSwitchRecovery, readZoomSetting};"
)();

let passCount = 0;
const tests = [];
function check(name, fn) { tests.push({ name, fn }); }

// ---- フェイク環境 ----
function fakeTrack(o) {
  o = o || {};
  const t = {
    readyState: o.readyState || "live",
    _settings: Object.assign({}, o.settings),
    applied: [],
  };
  if (o.caps !== "absent") t.getCapabilities = () => { if (o.capsThrows) throw new Error("caps"); return o.caps; };
  if (o.settingsApi !== "absent") t.getSettings = () => { if (o.settingsThrows) throw new Error("set"); return t._settings; };
  if (o.apply !== "absent") {
    t.applyConstraints = async (c) => {
      t.applied.push(c);
      if (o.applyRejects) throw new Error("OverconstrainedError");
      const z = c.advanced && c.advanced[0] && c.advanced[0].zoom;
      if (o.snapTo != null) t._settings.zoom = o.snapTo; // 端末が別の値へ丸める
      else if (o.noZoomReport) delete t._settings.zoom;
      else if (z != null) t._settings.zoom = z;
    };
  }
  return t;
}
function fakeMD(o) {
  o = o || {};
  const md = {};
  if (o.supported !== "absent") md.getSupportedConstraints = () => { if (o.supThrows) throw new Error("s"); return o.supported || {}; };
  if (o.enumerate !== "absent") {
    md.enumerateDevices = async () => { if (o.enumThrows) throw new Error("e"); return o.devices || []; };
  }
  return md;
}
const cam = (id, label) => ({ kind: "videoinput", deviceId: id, label: label });

// ---- 1. ズームの対応/非対応 ----
check("ズーム対応: 取得したcapabilitiesのmin/max/stepがそのまま使われる(固定値でない)", async () => {
  const t = fakeTrack({ caps: { zoom: { min: 2.5, max: 7.5, step: 0.5 } }, settings: { zoom: 3 } });
  const f = await L.detectCameraFeatures({ mediaDevices: fakeMD(), track: t });
  assert.deepStrictEqual(f.zoom, { min: 2.5, max: 7.5, step: 0.5 });
  assert.strictEqual(f.initialZoom, 3);
});
check("ズーム非対応: capabilitiesにzoomが無い→zoom=null(エラーにしない)", async () => {
  const t = fakeTrack({ caps: { width: { min: 1, max: 2 } }, settings: {} });
  const f = await L.detectCameraFeatures({ mediaDevices: fakeMD(), track: t });
  assert.strictEqual(f.zoom, null);
});
check("min>=max や数値でないzoomは無効として扱う", () => {
  assert.strictEqual(L.normalizeZoomCapability({ zoom: { min: 1, max: 1, step: 0.1 } }), null);
  assert.strictEqual(L.normalizeZoomCapability({ zoom: { min: 3, max: 1 } }), null);
  assert.strictEqual(L.normalizeZoomCapability({ zoom: { min: "1", max: "5" } }), null);
  assert.strictEqual(L.normalizeZoomCapability({ zoom: {} }), null);
  assert.strictEqual(L.normalizeZoomCapability({ zoom: null }), null);
});
check("stepが無い/0のとき、刻みは取得した範囲から導出される(任意の固定値でない)", () => {
  const cap = L.normalizeZoomCapability({ zoom: { min: 1, max: 11 } });
  assert.strictEqual(cap.step, null);
  assert.ok(Math.abs(L.zoomSliderStep(cap) - 0.1) < 1e-9);
  assert.ok(Math.abs(L.zoomButtonStep(cap) - 0.5) < 1e-9);
  const cap2 = L.normalizeZoomCapability({ zoom: { min: 1, max: 2, step: 0 } });
  assert.strictEqual(cap2.step, null);
});
check("getSupportedConstraintsがzoom:falseを明示した場合のみzoomを無効にする(キー無しは影響しない)", async () => {
  const caps = { zoom: { min: 1, max: 3, step: 0.1 } };
  const f1 = await L.detectCameraFeatures({ mediaDevices: fakeMD({ supported: { zoom: false } }), track: fakeTrack({ caps }) });
  assert.strictEqual(f1.zoom, null);
  const f2 = await L.detectCameraFeatures({ mediaDevices: fakeMD({ supported: { width: true } }), track: fakeTrack({ caps }) });
  assert.ok(f2.zoom);
});

// ---- 2. capabilitiesが空/失敗/一部API不在 ----
check("capabilitiesが空オブジェクト: zoom=null、例外なし", async () => {
  const f = await L.detectCameraFeatures({ mediaDevices: fakeMD(), track: fakeTrack({ caps: {}, settings: {} }) });
  assert.strictEqual(f.zoom, null);
});
check("getCapabilitiesが例外: zoom=null、他の検出は継続", async () => {
  const f = await L.detectCameraFeatures({
    mediaDevices: fakeMD({ devices: [cam("a", "A"), cam("b", "B")] }),
    track: fakeTrack({ capsThrows: true, settings: { deviceId: "a" } }),
  });
  assert.strictEqual(f.zoom, null);
  assert.strictEqual(f.canSelectDevice, true);
  assert.ok(f.notes.some((n) => n.indexOf("getCapabilities失敗") >= 0));
});
check("getCapabilities自体が存在しない(古いSafari想定): zoom=null", async () => {
  const f = await L.detectCameraFeatures({ mediaDevices: fakeMD(), track: fakeTrack({ caps: "absent", settings: {} }) });
  assert.strictEqual(f.zoom, null);
});
check("getSettingsが例外/不在: initialZoom=null、currentDeviceId空、例外なし", async () => {
  const caps = { zoom: { min: 1, max: 3, step: 0.1 } };
  const f1 = await L.detectCameraFeatures({ mediaDevices: fakeMD(), track: fakeTrack({ caps, settingsThrows: true }) });
  assert.strictEqual(f1.initialZoom, null);
  assert.strictEqual(f1.currentDeviceId, "");
  const f2 = await L.detectCameraFeatures({ mediaDevices: fakeMD(), track: fakeTrack({ caps, settingsApi: "absent" }) });
  assert.strictEqual(f2.initialZoom, null);
});
check("mediaDevices・trackがnull/未指定でも例外を出さず、全機能なしを返す", async () => {
  for (const env of [undefined, {}, { mediaDevices: null, track: null }]) {
    const f = await L.detectCameraFeatures(env);
    assert.strictEqual(f.zoom, null);
    assert.strictEqual(f.canSelectDevice, false);
    assert.deepStrictEqual(f.videoInputs, []);
  }
});
check("enumerateDevices/getSupportedConstraintsが不在または例外: 空として扱い続行", async () => {
  const caps = { zoom: { min: 1, max: 2, step: 0.1 } };
  const f1 = await L.detectCameraFeatures({ mediaDevices: fakeMD({ enumerate: "absent", supported: "absent" }), track: fakeTrack({ caps }) });
  assert.ok(f1.zoom);
  assert.strictEqual(f1.canSelectDevice, false);
  const f2 = await L.detectCameraFeatures({ mediaDevices: fakeMD({ enumThrows: true, supThrows: true }), track: fakeTrack({ caps }) });
  assert.ok(f2.zoom);
  assert.strictEqual(f2.canSelectDevice, false);
});

// ---- 3. カメラ台数・deviceId/label ----
check("カメラ1台: 選択UI対象外(canSelectDevice=false)→既存の前面/背面切替のみ", async () => {
  const f = await L.detectCameraFeatures({ mediaDevices: fakeMD({ devices: [cam("a", "Back")] }), track: fakeTrack({ caps: {}, settings: {} }) });
  assert.strictEqual(f.canSelectDevice, false);
});
check("カメラ複数台(N台): 台数は固定されず、取得した数だけ選択肢になる", async () => {
  for (const n of [2, 3, 5]) {
    const devices = Array.from({ length: n }, (_, i) => cam("id" + i, "Cam" + i));
    const f = await L.detectCameraFeatures({ mediaDevices: fakeMD({ devices }), track: fakeTrack({ caps: {}, settings: {} }) });
    assert.strictEqual(f.canSelectDevice, true);
    assert.strictEqual(f.selectableInputs.length, n);
  }
});
check("deviceIdが空(権限前など): 選択肢にしない。複数台でも選択UI無効", async () => {
  const f = await L.detectCameraFeatures({ mediaDevices: fakeMD({ devices: [cam("", ""), cam("", "")] }), track: fakeTrack({ caps: {}, settings: {} }) });
  assert.strictEqual(f.videoInputs.length, 2);
  assert.strictEqual(f.canSelectDevice, false);
});
check("一部だけdeviceIdが空: 取得できたものだけが選択肢。2件未満なら選択UI無効", async () => {
  const f = await L.detectCameraFeatures({ mediaDevices: fakeMD({ devices: [cam("a", "A"), cam("", "B")] }), track: fakeTrack({ caps: {}, settings: {} }) });
  assert.strictEqual(f.selectableInputs.length, 1);
  assert.strictEqual(f.canSelectDevice, false);
});
check("deviceIdの重複は1件にまとめる", () => {
  const out = L.selectableVideoInputs(L.normalizeVideoInputs([cam("a", "A"), cam("a", "A2"), cam("b", "B")]));
  assert.strictEqual(out.length, 2);
});
check("videoinput以外・不正な要素は無視する", () => {
  const out = L.normalizeVideoInputs([{ kind: "audioinput", deviceId: "m", label: "mic" }, null, cam("a", "A"), { kind: "videoinput" }]);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(L.normalizeVideoInputs("x").length, 0);
});
check("labelが空なら連番表示。labelからレンズ種別は推定しない(表示名はlabelそのまま)", () => {
  assert.strictEqual(L.describeCameraOption({ deviceId: "a", label: "" }, 0), "カメラ 1");
  assert.strictEqual(L.describeCameraOption({ deviceId: "b", label: "Back Ultra Wide Camera" }, 1), "Back Ultra Wide Camera");
  assert.strictEqual(L.describeCameraOption({ deviceId: "c", label: "なんでも" }, 2), "なんでも");
});

// ---- 4. ズーム適用・実値再確認 ----
check("ズーム適用: applyConstraints後にgetSettings()の実値を返す(matched)", async () => {
  const t = fakeTrack({ caps: {}, settings: { zoom: 1 } });
  const cap = { min: 1, max: 5, step: 0.5 };
  const r = await L.applyZoom(t, 2.5, cap);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.reason, "matched");
  assert.strictEqual(r.actual, 2.5);
  assert.deepStrictEqual(t.applied[0], { advanced: [{ zoom: 2.5 }] });
});
check("要求値が範囲外なら取得済みの範囲にクランプして適用する", async () => {
  const t = fakeTrack({ caps: {}, settings: { zoom: 1 } });
  const r = await L.applyZoom(t, 99, { min: 1, max: 5, step: 0.5 });
  assert.strictEqual(r.requested, 5);
  assert.strictEqual(t._settings.zoom, 5);
});
check("端末が別の値へ丸めた場合: adjustedとして実値を正確に返す", async () => {
  const t = fakeTrack({ caps: {}, settings: { zoom: 1 }, snapTo: 2 });
  const r = await L.applyZoom(t, 3, { min: 1, max: 5, step: 0.5 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.reason, "adjusted");
  assert.strictEqual(r.actual, 2);
  assert.ok(L.formatZoomStatus(r).indexOf("実際 2.00") >= 0);
});
check("実値が取得できない場合: unreadable。値を偽らない表示になる", async () => {
  const t = fakeTrack({ caps: {}, settings: { zoom: 1 }, noZoomReport: true });
  const r = await L.applyZoom(t, 2, { min: 1, max: 5, step: 0.5 });
  assert.strictEqual(r.reason, "unreadable");
  assert.strictEqual(r.actual, null);
  assert.ok(L.formatZoomStatus(r).indexOf("取得できません") >= 0);
});
check("制約適用が失敗(reject): 例外を投げず、ok=false・現在の実値を返す", async () => {
  const t = fakeTrack({ caps: {}, settings: { zoom: 1.5 }, applyRejects: true });
  const r = await L.applyZoom(t, 3, { min: 1, max: 5, step: 0.5 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "rejected");
  assert.strictEqual(r.actual, 1.5);
  assert.ok(L.formatZoomStatus(r).indexOf("変更できませんでした") >= 0);
});
check("applyConstraints自体が不在: unsupported、例外なし", async () => {
  const t = fakeTrack({ caps: {}, settings: { zoom: 1 }, apply: "absent" });
  const r = await L.applyZoom(t, 2, { min: 1, max: 5, step: 0.5 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "unsupported");
});

// ---- 5. 起動時のズームに戻す ----
check("起動時実測値が現在のカメラの範囲内なら復元できる", async () => {
  const t = fakeTrack({ caps: { zoom: { min: 1, max: 4, step: 0.1 } }, settings: { zoom: 3 } });
  const r = await L.restoreInitialZoom(t, 1.5);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(t._settings.zoom, 1.5);
});
check("起動時の値が現在の範囲外: 復元せず(applyConstraintsを呼ばず)失敗理由を返す。1.0を勝手に指定しない", async () => {
  const t = fakeTrack({ caps: { zoom: { min: 2, max: 4, step: 0.1 } }, settings: { zoom: 3 } });
  const r = await L.restoreInitialZoom(t, 1.0);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "out-of-range");
  assert.strictEqual(t.applied.length, 0);
  assert.ok(L.formatZoomRestoreFailure(r.reason).length > 0);
});
check("起動時の値が未取得(null) / 現在のcapabilities取得不可: 復元せず失敗理由を返す", async () => {
  const t1 = fakeTrack({ caps: { zoom: { min: 1, max: 4, step: 0.1 } }, settings: { zoom: 2 } });
  const r1 = await L.restoreInitialZoom(t1, null);
  assert.strictEqual(r1.reason, "no-initial");
  assert.strictEqual(t1.applied.length, 0);
  const t2 = fakeTrack({ caps: {}, settings: { zoom: 2 } });
  const r2 = await L.restoreInitialZoom(t2, 1.5);
  assert.strictEqual(r2.reason, "no-capability");
  assert.strictEqual(t2.applied.length, 0);
});

// ---- 6. カメラ切替後に設定値が変わる/復旧判断 ----
check("カメラ切替後: 新しいトラックから再検出すると、古い能力ではなく新しい値になる", async () => {
  const md = fakeMD({ devices: [cam("a", "A"), cam("b", "B")] });
  const f1 = await L.detectCameraFeatures({ mediaDevices: md, track: fakeTrack({ caps: { zoom: { min: 1, max: 10, step: 0.1 } }, settings: { deviceId: "a", zoom: 1 } }) });
  const f2 = await L.detectCameraFeatures({ mediaDevices: md, track: fakeTrack({ caps: {}, settings: { deviceId: "b" } }) });
  assert.ok(f1.zoom && f1.currentDeviceId === "a");
  assert.strictEqual(f2.zoom, null);
  assert.strictEqual(f2.currentDeviceId, "b");
  assert.strictEqual(f2.initialZoom, null);
});
check("切替取得に失敗: 元トラックがliveなら維持(keep)、それ以外/不明ならrestart", () => {
  assert.strictEqual(L.decideCameraSwitchRecovery("live"), "keep");
  assert.strictEqual(L.decideCameraSwitchRecovery("ended"), "restart");
  assert.strictEqual(L.decideCameraSwitchRecovery(null), "restart");
  assert.strictEqual(L.decideCameraSwitchRecovery(undefined), "restart");
});

// ---- 7. index.htmlの静的確認(配線・安全性・固定値なし) ----
check("ハードコード無し: UI/ロジック部にdeviceId・レンズ名・ズーム数値プリセットが無い", () => {
  const code = (pureSrc + uiSrc).replace(/\/\/.*$/gm, "");
  assert.ok(!/超広角|望遠|ultra|telephoto|0\.5\s*[x×]|["']広角["']/i.test(code), "レンズ種別・数値プリセットの記述がある");
  assert.ok(!/localStorage/.test(code), "ズーム/カメラ選択をlocalStorageへ保存している");
});
check("UI追加分は既定で非表示(検出できなければ何も出ない)", () => {
  assert.ok(html.includes('id="cameraFeatureBlock" style="display:none"'));
  assert.ok(html.includes('id="zoomBlock" style="display:none"'));
  assert.ok(html.includes('id="cameraSelectBlock" style="display:none"'));
});
check("ボタン表示は「起動時のズームに戻す」(「標準に戻す」ではない)", () => {
  assert.ok(html.includes("起動時のズームに戻す"));
  assert.ok(!html.includes("標準に戻す"));
});
check("既存の前面/背面切替(flipCamera)が維持されている", () => {
  assert.ok(html.includes('id="flipCamera"'));
  assert.ok(/flipBtn\.addEventListener\("click"[\s\S]*?facingMode = facingMode === "environment"/.test(html));
});
check("保存中はカメラ切替・ズーム・カメラ選択がすべて無効化される(isSavingを参照)", () => {
  const fn = uiSrc.match(/function updateCameraControlsEnabled\(\) \{[\s\S]*?\n  \}/)[0];
  assert.ok(fn.includes("isSaving"));
  ["flipBtn.disabled", "zoomSlider.disabled", "zoomMinusBtn.disabled", "zoomPlusBtn.disabled", "zoomResetBtn.disabled", "cameraDeviceRow"].forEach((k) =>
    assert.ok(fn.includes(k), k + "が無効化対象に入っていない")
  );
  const save = html.match(/saveShotBtn\.addEventListener\("click"[\s\S]*?\n  \}\);/)[0];
  assert.ok(save.indexOf("flipBtn.disabled = true;") < save.indexOf("updateCameraControlsEnabled();"));
  assert.ok(/flipBtn\.disabled = false;\s*\n\s*updateCameraControlsEnabled\(\);/.test(save), "保存終了後の再評価が無い");
  assert.ok(/async function requestZoom[\s\S]*?if \(isSaving/.test(uiSrc), "requestZoomに保存中ガードが無い");
  assert.ok(/async function switchToDevice[\s\S]*?if \(isSaving/.test(uiSrc), "switchToDeviceに保存中ガードが無い");
});
check("startCameraが旧トラックの検出結果を破棄し、成功後に新トラックから再検出する", () => {
  const sc = html.match(/async function startCamera\(opts\) \{[\s\S]*?\n  \}\n/)[0];
  assert.ok(sc.includes("resetCameraFeatures()"));
  assert.ok(sc.includes("refreshCameraFeatures()"));
  assert.ok(sc.indexOf("running = true;") < sc.indexOf("refreshCameraFeatures()"));
  assert.ok(sc.includes("preAcquiredStream"));
});
check("検出結果の適用時、トラックが変わっていれば古い結果を捨てる(トラック照合)", () => {
  assert.ok(/track !== currentVideoTrack\(\)\) return;\s*\n\s*cameraFeatures = f;/.test(uiSrc));
});
check("切替失敗時は元映像維持/既存startCamera()での復旧の2経路がある", () => {
  assert.ok(uiSrc.includes('decideCameraSwitchRecovery'));
  assert.ok(/=== "keep"[\s\S]*?else \{\s*\n\s*await startCamera\(\);/.test(uiSrc));
});
check("ズーム変更はバッファを破棄しない(clearBuffer/goLiveを呼ばない)", () => {
  const code = uiSrc.replace(/\/\/.*$/gm, "");
  const zoomPart = code.slice(code.indexOf("async function requestZoom"), code.indexOf("async function switchToDevice"));
  assert.ok(!/clearBuffer|goLive/.test(zoomPart));
});
check("4 Engine / manifest.json / sw.js はSTEP26-Bで変更していない(index.htmlのみ)", () => {
  assert.ok(!/STEP26/.test(fs.readFileSync(path.join(__dirname, "sw.js"), "utf8")));
  ["bufferEngine.js", "playbackEngine.js", "storageEngine.js", "coordinateEngine.js"].forEach((f) =>
    assert.ok(!/STEP26/.test(fs.readFileSync(path.join(__dirname, f), "utf8")), f)
  );
});

// =================================================================
// STEP26-C: 画角パネル(設定パネルから分離した、映像を見ながら調整できる薄いバー)
// =================================================================
function makeEl(id) {
  const cls = new Set();
  return {
    id: id, style: {}, dataset: {}, textContent: "", innerHTML: "", title: "", value: "", min: "", max: "", step: "", disabled: false,
    listeners: {},
    classList: {
      add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c),
      toggle: (c, force) => { const on = force === undefined ? !cls.has(c) : !!force; on ? cls.add(c) : cls.delete(c); return on; },
    },
    addEventListener(ev, fn) { this.listeners[ev] = fn; },
    appendChild() {},
    querySelectorAll() { return []; },
  };
}
function makeUI(initial) {
  const els = {};
  const document = {
    getElementById: (id) => els[id] || (els[id] = makeEl(id)),
    createElement: () => makeEl("btn"),
  };
  const env = { stream: initial.stream || null, isSaving: !!initial.isSaving };
  const factory = new Function(
    "document", "navigator", "env",
    pureSrc +
      "\nlet stream = env.stream; let isSaving = env.isSaving;" +
      "\nconst flipBtn = document.getElementById('flipCamera');" +
      "\nconst secondaryControls = document.getElementById('secondaryControls');" +
      "\nconst settingsToggleBtn = document.getElementById('settingsToggle');" +
      "\nconst appEl = document.getElementById('app');\n" +
      uiSrc +
      "\nreturn { openAnglePanel, closeAnglePanel, refreshCameraFeatures, resetCameraFeatures, renderCameraControls," +
      " setStream(s) { stream = s; }, setSaving(v) { isSaving = v; updateCameraControlsEnabled(); }," +
      " get angleOpen() { return angleOpen; } };"
  );
  const api = factory(document, initial.navigator || { mediaDevices: fakeMD() }, env);
  api.els = els;
  api.$ = (id) => document.getElementById(id);
  return api;
}
function streamOf(track) { return { getVideoTracks: () => [track] }; }
const ZOOM_CAPS = { zoom: { min: 1, max: 4, step: 0.1 } };

check("C: 設定パネル(#secondaryControls)の中にズーム/カメラ選択の要素が残っていない", () => {
  const a = html.indexOf('<div id="secondaryControls">');
  const b = html.indexOf("</footer>");
  const sheet = html.slice(a, b);
  ["zoomSlider", "zoomMinus", "zoomPlus", "zoomReset", "cameraDeviceRow", "cameraFeatureBlock", "cameraNotice"].forEach((id) =>
    assert.ok(!sheet.includes('id="' + id + '"'), id + " が設定パネル内に残っている")
  );
});
check("C: 画角パネルは映像(#stage)の中に置かれ、必要な要素をすべて持つ", () => {
  const a = html.indexOf('<div id="stage">');
  const b = html.indexOf("<footer>");
  const stageHtml = html.slice(a, b);
  ["cameraFeatureBlock", "cameraDeviceRow", "zoomSlider", "zoomMinus", "zoomPlus", "zoomReset", "zoomStatus", "angleClose"].forEach((id) =>
    assert.ok(stageHtml.includes('id="' + id + '"'), id + " が#stage内に無い")
  );
});
check("C: パネルは「1〜2行」(.angle-rowが2つ以下)で、設定パネルのような大きな面を持たない", () => {
  const a = html.indexOf('<div id="cameraFeatureBlock"');
  const b = html.indexOf("<!-- 全画面時のみ表示される最小限のオーバーレイ操作パネル -->");
  const panelHtml = html.slice(a, b);
  const rows = (panelHtml.match(/class="angle-row"/g) || []).length;
  assert.ok(rows >= 1 && rows <= 2, "行数=" + rows);
  const css = html.match(/#cameraFeatureBlock \{[^}]*\}/)[0];
  assert.ok(/position: absolute/.test(css) && /bottom: 8px/.test(css) && /rgba\(/.test(css), "下端の半透明バーになっていない");
  assert.ok(!/max-height|height:/.test(css), "固定の高さ指定がある");
});
check("C: 「画角」ボタンは既定で非表示、ヘッダーにある", () => {
  assert.ok(/<button id="angleToggle" style="display:none">画角<\/button>/.test(html));
  const header = html.slice(html.indexOf("<header>"), html.indexOf("</header>"));
  assert.ok(header.includes('id="angleToggle"'));
});
check("C: 全画面中は画角パネルを表示しない(CSS)", () => {
  assert.ok(/#app\.pseudo-fullscreen #cameraFeatureBlock \{ display: none !important; \}/.test(html));
  assert.ok(/#stage:fullscreen #cameraFeatureBlock/.test(html));
});
check("C(挙動): 機能が検出されると「画角」ボタンが出て、開くとパネルが表示され、設定パネルは閉じる", async () => {
  const track = fakeTrack({ caps: ZOOM_CAPS, settings: { zoom: 2, deviceId: "a" } });
  const ui = makeUI({ stream: streamOf(track), navigator: { mediaDevices: fakeMD({ devices: [cam("a", "A")] }) } });
  ui.$("secondaryControls").classList.add("open");
  ui.$("settingsToggle").classList.add("on");
  await ui.refreshCameraFeatures();
  assert.strictEqual(ui.$("angleToggle").style.display, "", "機能ありなのに画角ボタンが出ない");
  assert.strictEqual(ui.$("cameraFeatureBlock").style.display, "none", "開く前にパネルが出ている");
  ui.openAnglePanel();
  assert.strictEqual(ui.$("cameraFeatureBlock").style.display, "block");
  assert.strictEqual(ui.$("secondaryControls").classList.contains("open"), false, "設定パネルが開いたまま(相互排他でない)");
  assert.strictEqual(ui.$("settingsToggle").classList.contains("on"), false);
  assert.strictEqual(ui.$("zoomBlock").style.display, "block");
  assert.ok(/範囲 1\.00〜4\.00/.test(ui.$("zoomLabel").textContent));
});
check("C(挙動): 閉じるとパネルが完全に非表示になり、通常の撮影画面に戻る", async () => {
  const track = fakeTrack({ caps: ZOOM_CAPS, settings: { zoom: 2 } });
  const ui = makeUI({ stream: streamOf(track) });
  await ui.refreshCameraFeatures();
  ui.openAnglePanel();
  assert.strictEqual(ui.$("cameraFeatureBlock").style.display, "block");
  ui.$("angleClose").listeners.click();
  assert.strictEqual(ui.$("cameraFeatureBlock").style.display, "none");
  assert.strictEqual(ui.angleOpen, false);
  assert.strictEqual(ui.$("angleToggle").classList.contains("on"), false);
  // 画角ボタンでも開閉できる
  ui.$("angleToggle").listeners.click();
  assert.strictEqual(ui.$("cameraFeatureBlock").style.display, "block");
  ui.$("angleToggle").listeners.click();
  assert.strictEqual(ui.$("cameraFeatureBlock").style.display, "none");
});
check("C(挙動): 設定パネルを開く側の処理(closeAnglePanel)で画角パネルが閉じる(相互排他の逆向き)", async () => {
  const track = fakeTrack({ caps: ZOOM_CAPS, settings: { zoom: 2 } });
  const ui = makeUI({ stream: streamOf(track) });
  await ui.refreshCameraFeatures();
  ui.openAnglePanel();
  ui.closeAnglePanel(); // index.htmlの設定ボタンハンドラが、開くときに呼ぶ関数
  assert.strictEqual(ui.$("cameraFeatureBlock").style.display, "none");
  const handler = html.match(/settingsToggleBtn\.addEventListener\("click", \(\) => \{[\s\S]*?\n  \}\);/)[0];
  assert.ok(/if \(open\) closeAnglePanel\(\);/.test(handler), "設定ボタンのハンドラが画角パネルを閉じていない");
});
check("C(挙動): ズーム・複数カメラとも無い端末では「画角」ボタンもパネルも出ない(開いていても閉じる)", async () => {
  const ui = makeUI({ stream: streamOf(fakeTrack({ caps: {}, settings: {} })) });
  await ui.refreshCameraFeatures();
  assert.strictEqual(ui.$("angleToggle").style.display, "none");
  assert.strictEqual(ui.$("cameraFeatureBlock").style.display, "none");
  // APIが一切ない端末
  const ui2 = makeUI({ stream: streamOf(fakeTrack({ caps: "absent", settingsApi: "absent", apply: "absent" })), navigator: { mediaDevices: {} } });
  await ui2.refreshCameraFeatures();
  assert.strictEqual(ui2.$("angleToggle").style.display, "none");
  // 開いた状態で、機能の無いトラックへ切り替わった場合は閉じた状態に戻る
  const ui3 = makeUI({ stream: streamOf(fakeTrack({ caps: ZOOM_CAPS, settings: { zoom: 2 } })) });
  await ui3.refreshCameraFeatures();
  ui3.openAnglePanel();
  ui3.setStream(streamOf(fakeTrack({ caps: {}, settings: {} })));
  await ui3.refreshCameraFeatures();
  assert.strictEqual(ui3.angleOpen, false);
  assert.strictEqual(ui3.$("cameraFeatureBlock").style.display, "none");
});
check("C(挙動): カメラのみ選択可能(ズーム無し)の場合も画角ボタンが出て、ズーム行は出ない", async () => {
  const ui = makeUI({
    stream: streamOf(fakeTrack({ caps: {}, settings: { deviceId: "a" } })),
    navigator: { mediaDevices: fakeMD({ devices: [cam("a", "A"), cam("b", "B")] }) },
  });
  await ui.refreshCameraFeatures();
  ui.openAnglePanel();
  assert.strictEqual(ui.$("angleToggle").style.display, "");
  assert.strictEqual(ui.$("cameraSelectBlock").style.display, "block");
  assert.strictEqual(ui.$("zoomBlock").style.display, "none");
});
check("C: カメラ切替中の一時的なリセットでは、開いていたパネルの開閉状態を保持する(切替後に再表示される)", async () => {
  const ui = makeUI({ stream: streamOf(fakeTrack({ caps: ZOOM_CAPS, settings: { zoom: 2 } })) });
  await ui.refreshCameraFeatures();
  ui.openAnglePanel();
  ui.resetCameraFeatures(); // startCamera()冒頭の処理
  assert.strictEqual(ui.angleOpen, true);
  assert.strictEqual(ui.$("cameraFeatureBlock").style.display, "none"); // 検出前は出さない
  await ui.refreshCameraFeatures();
  assert.strictEqual(ui.$("cameraFeatureBlock").style.display, "block");
});
check("C: 保存中の排他制御は維持(パネル内のズーム・カメラ選択・切替が無効)", async () => {
  const ui = makeUI({ stream: streamOf(fakeTrack({ caps: ZOOM_CAPS, settings: { zoom: 2 } })), isSaving: true });
  await ui.refreshCameraFeatures();
  ui.openAnglePanel();
  ["zoomSlider", "zoomMinus", "zoomPlus", "zoomReset", "flipCamera"].forEach((id) =>
    assert.strictEqual(ui.$(id).disabled, true, id + "が保存中に有効のまま")
  );
  ui.setSaving(false);
  assert.strictEqual(ui.$("zoomSlider").disabled, false);
  assert.strictEqual(ui.$("flipCamera").disabled, false);
});
check("C: 画角パネルを開いている間はUIを薄くしない(最初のタップが無効化されないため)", () => {
  assert.ok(/if \(angleOpen\) return;[\s\S]{0,80}ui-dim/.test(html));
});
check("C: 検出・ズーム適用・切替・復旧の各ロジックはSTEP26-Bのまま(関数が全て存在)", () => {
  ["detectCameraFeatures", "applyZoom", "restoreInitialZoom", "decideCameraSwitchRecovery"].forEach((f) =>
    assert.ok(pureSrc.includes("function " + f), f)
  );
  ["requestZoom", "switchToDevice", "refreshCameraFeatures"].forEach((f) => assert.ok(uiSrc.includes("function " + f), f));
});


check("C2: 画角パネルを開くと下部操作(footer)を隠すクラスが付き、閉じると外れる", async () => {
  const ui = makeUI({ stream: streamOf(fakeTrack({ caps: ZOOM_CAPS, settings: { zoom: 2 } })) });
  await ui.refreshCameraFeatures();
  assert.strictEqual(ui.$("app").classList.contains("angle-adjusting"), false);
  ui.openAnglePanel();
  assert.strictEqual(ui.$("app").classList.contains("angle-adjusting"), true);
  ui.$("angleClose").listeners.click();
  assert.strictEqual(ui.$("app").classList.contains("angle-adjusting"), false);
});
check("C2: 設定パネルを開く(closeAnglePanel)と、隠していた下部操作が元に戻る", async () => {
  const ui = makeUI({ stream: streamOf(fakeTrack({ caps: ZOOM_CAPS, settings: { zoom: 2 } })) });
  await ui.refreshCameraFeatures();
  ui.openAnglePanel();
  ui.closeAnglePanel();
  assert.strictEqual(ui.$("app").classList.contains("angle-adjusting"), false);
});
check("C2: カメラ切替中の一時リセットでは下部操作を再表示しない(画面が揺れない)。機能なしトラックへ切り替わったら元に戻る", async () => {
  const ui = makeUI({ stream: streamOf(fakeTrack({ caps: ZOOM_CAPS, settings: { zoom: 2 } })) });
  await ui.refreshCameraFeatures();
  ui.openAnglePanel();
  ui.resetCameraFeatures();
  assert.strictEqual(ui.$("app").classList.contains("angle-adjusting"), true);
  ui.setStream(streamOf(fakeTrack({ caps: {}, settings: {} })));
  await ui.refreshCameraFeatures();
  assert.strictEqual(ui.$("app").classList.contains("angle-adjusting"), false);
});
check("C2(静的): 隠す対象はfooter(5秒戻る/進む・スロー確認・再生/現在へを含む)で、ヘッダーと画角パネルは隠さない", () => {
  assert.ok(/#app\.angle-adjusting footer \{ display: none; \}/.test(html));
  assert.ok(!/angle-adjusting header|angle-adjusting #stage|angle-adjusting #cameraFeatureBlock/.test(html));
  const footer = html.slice(html.indexOf("<footer>"), html.indexOf("</footer>"));
  ["act-seek-back", "act-slow-check", "act-seek-fwd", "act-play-pause", "act-go-live"].forEach((c) =>
    assert.ok(footer.includes(c), c + "がfooter内に無い")
  );
  const header = html.slice(html.indexOf("<header>"), html.indexOf("</header>"));
  assert.ok(header.includes('id="angleToggle"'));
});

// =================================================================
// STEP26-D: 案A(footer全体を退避)の正式採用。実装はSTEP26-C2のまま、不足していた観点だけ追加する。
// =================================================================
check("D: 通常状態(画角パネルが閉じている)ではangle-adjustingが付いていない(footerは通常表示)", async () => {
  const ui = makeUI({ stream: streamOf(fakeTrack({ caps: ZOOM_CAPS, settings: { zoom: 2 } })) });
  assert.strictEqual(ui.$("app").classList.contains("angle-adjusting"), false);
  await ui.refreshCameraFeatures();
  assert.strictEqual(ui.$("app").classList.contains("angle-adjusting"), false);
  assert.strictEqual(ui.angleOpen, false);
});
check("D: 開閉を繰り返しても、angle-adjustingと画角パネルの表示が常に一致する", async () => {
  const ui = makeUI({ stream: streamOf(fakeTrack({ caps: ZOOM_CAPS, settings: { zoom: 2 } })) });
  await ui.refreshCameraFeatures();
  for (let i = 0; i < 5; i++) {
    ui.openAnglePanel();
    assert.strictEqual(ui.$("app").classList.contains("angle-adjusting"), true);
    assert.strictEqual(ui.$("cameraFeatureBlock").style.display, "block");
    ui.closeAnglePanel();
    assert.strictEqual(ui.$("app").classList.contains("angle-adjusting"), false);
    assert.strictEqual(ui.$("cameraFeatureBlock").style.display, "none");
  }
});
check("D: 設定→画角: 設定パネルが閉じ、footerを隠す(2つのパネルが重ならない)", async () => {
  const ui = makeUI({ stream: streamOf(fakeTrack({ caps: ZOOM_CAPS, settings: { zoom: 2 } })) });
  await ui.refreshCameraFeatures();
  ui.$("secondaryControls").classList.add("open");
  ui.$("settingsToggle").classList.add("on");
  ui.openAnglePanel();
  assert.strictEqual(ui.$("secondaryControls").classList.contains("open"), false);
  assert.strictEqual(ui.$("app").classList.contains("angle-adjusting"), true);
});
check("D(静的): 設定ボタンのハンドラは、開くときcloseAnglePanel()を呼ぶ(画角→設定の相互排他)", () => {
  const m = html.match(/settingsToggleBtn\.addEventListener\("click",[\s\S]*?\n  \}\);/);
  assert.ok(m, "設定ボタンのハンドラが見つからない");
  assert.ok(/if \(open\) closeAnglePanel\(\)/.test(m[0]));
});
check("D(静的): マーキングモード・全画面の処理はSTEP26-Dで変更していない(angle関連の記述が混入していない)", () => {
  const mm = html.match(/function setMarkingMode\(mode\) \{[\s\S]*?\n  \}/);
  assert.ok(mm && !/angle(Open|-adjusting)|closeAnglePanel/.test(mm[0]));
  const fs2 = html.match(/function toggleFullscreen\(\) \{[\s\S]*?\n  \}/);
  assert.ok(fs2 && !/angle(Open|-adjusting)|closeAnglePanel/.test(fs2[0]));
});

(async () => {
  for (const t of tests) {
    try {
      await t.fn();
      passCount++;
      console.log("  OK  " + t.name);
    } catch (e) {
      console.log("  NG  " + t.name);
      console.log("      " + e.message);
      process.exitCode = 1;
    }
  }
  console.log("\n" + passCount + "/" + tests.length + " 件成功" + (process.exitCode ? " / 失敗あり" : " / 全て成功"));
  console.log(
    "\n[注記] 以下はNode.jsでは検証できず、iPad実機確認が必要です:\n" +
      "  - 実際のiPadがgetCapabilities().zoomを返すか、applyConstraints({advanced:[{zoom}]})が効くか\n" +
      "  - enumerateDevices()のlabel/deviceIdが権限付与後に取得できるか、複数カメラが列挙されるか\n" +
      "  - deviceId指定の切替で元トラックがendedになるか(Safariでの挙動)\n" +
      "  - ズーム変更時の見た目、設定パネル内スライダーの操作感、画角が変わったフレームの混在\n" +
      "  - 「実際に広い画角が得られるか」は検出できない(物理レンズ・画角は断定しない)\n"
  );
})();
