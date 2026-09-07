// coordinateEngine.js
// 「画面上の座標」と「映像内部の座標」を分離するための独立モジュール。
// Buffer Engine / Playback Engine / Storage Engine のいずれにも依存せず、
// 逆にこれらから参照されることもない(完全に独立した純粋関数の集まり)。
//
// 採用する座標系:
//   normalized point = { x: 0.0〜1.0, y: 0.0〜1.0 }
//   左上を(0,0)、右下を(1,1)とする「映像そのもの」の座標。
//   画面サイズ・向き・object-fit:containの余白・全画面表示・保存済み映像の再生など、
//   表示条件が変わってもこの値は変化しない。
//
// 重要: 画面回転(screen.orientation.angle)には一切依存しない。
//   既存のbufferEngine.js/index.htmlは、回転補正を「バッファに格納する時点」で
//   videoの幅・高さそのものに反映済み(90°/270°ならwidth/heightが入れ替わった状態で
//   displayCanvasに描画される)。したがって本モジュールは常に「現在のdisplayCanvasの
//   width/height」を渡してもらうだけでよく、回転角度そのものを知る必要がない。
// これにより、マーキング座標は画面回転角度に依存しない値として保存できる。
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.CoordinateEngine = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------------------------------------------------------------
  // 座標変換
  // ---------------------------------------------------------------

  // 0〜1の範囲にクランプする
  function clampNormalizedPoint(p) {
    return {
      x: Math.min(1, Math.max(0, p.x)),
      y: Math.min(1, Math.max(0, p.y)),
    };
  }

  // object-fit: containで映像が実際に描画される矩形(コンテナ内でのオフセット・サイズ)を計算する。
  // videoW/videoHには、回転補正済みのdisplayCanvasのwidth/heightを渡す想定。
  function computeContainRect(containerW, containerH, videoW, videoH) {
    if (containerW <= 0 || containerH <= 0 || videoW <= 0 || videoH <= 0) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }
    const containerRatio = containerW / containerH;
    const videoRatio = videoW / videoH;
    let renderW, renderH;
    if (videoRatio > containerRatio) {
      // 映像の方が横長 → コンテナ幅いっぱいにフィットし、上下に余白ができる
      renderW = containerW;
      renderH = containerW / videoRatio;
    } else {
      // 映像の方が縦長(または同比率) → コンテナ高さいっぱいにフィットし、左右に余白ができる
      renderH = containerH;
      renderW = containerH * videoRatio;
    }
    return {
      x: (containerW - renderW) / 2,
      y: (containerH - renderH) / 2,
      width: renderW,
      height: renderH,
    };
  }

  // 画面(コンテナ)上のピクセル座標 → 映像内部のピクセル座標(0..videoW, 0..videoH)。
  // 余白部分にある場合は映像の範囲外の値になりうる(クランプはしない。呼び出し側の
  // screenToNormalizedPointが最終的に0〜1へクランプする)。
  function screenToVideoPoint(screenX, screenY, containerW, containerH, videoW, videoH) {
    const rect = computeContainRect(containerW, containerH, videoW, videoH);
    if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    return {
      x: ((screenX - rect.x) / rect.width) * videoW,
      y: ((screenY - rect.y) / rect.height) * videoH,
    };
  }

  // 映像内部のピクセル座標 → 画面(コンテナ)上のピクセル座標
  function videoToScreenPoint(videoX, videoY, containerW, containerH, videoW, videoH) {
    const rect = computeContainRect(containerW, containerH, videoW, videoH);
    if (videoW === 0 || videoH === 0) return { x: rect.x, y: rect.y };
    return {
      x: rect.x + (videoX / videoW) * rect.width,
      y: rect.y + (videoY / videoH) * rect.height,
    };
  }

  // 画面(コンテナ)上のピクセル座標 → 正規化座標(0〜1、クランプ済み)
  function screenToNormalizedPoint(screenX, screenY, containerW, containerH, videoW, videoH) {
    const vp = screenToVideoPoint(screenX, screenY, containerW, containerH, videoW, videoH);
    if (videoW === 0 || videoH === 0) return { x: 0, y: 0 };
    return clampNormalizedPoint({ x: vp.x / videoW, y: vp.y / videoH });
  }

  // 正規化座標 → 画面(コンテナ)上のピクセル座標
  function normalizedToScreenPoint(normX, normY, containerW, containerH, videoW, videoH) {
    return videoToScreenPoint(normX * videoW, normY * videoH, containerW, containerH, videoW, videoH);
  }

  // ---------------------------------------------------------------
  // マーキングデータ構造
  // ---------------------------------------------------------------
  // マーキングは元のJPEG画像には一切書き込まない。常に「映像本体とは別のデータ」として
  // 正規化座標のみで保持し、表示のたびに重ね描きする前提の構造にする。

  const MARKING_TYPES = ["point", "freehand", "vertical", "horizontal", "line", "angle", "arrow_release"];

  let _markingIdCounter = 0;
  function generateMarkingId(now) {
    now = now != null ? now : Date.now();
    _markingIdCounter = (_markingIdCounter + 1) % 1000000;
    const rand = Math.random().toString(36).slice(2, 8);
    return "mark_" + now + "_" + _markingIdCounter + "_" + rand;
  }

  function isFinitePoint(p) {
    return !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
  }

  // 点マーキング(将来の「矢飛び出し位置」以外の一般的な点)
  function createPointMarking({ x, y, timeMs, id, createdAt }) {
    const p = clampNormalizedPoint({ x, y });
    return {
      id: id || generateMarkingId(),
      type: "point",
      x: p.x,
      y: p.y,
      timeMs: timeMs != null ? timeMs : null,
      createdAt: createdAt != null ? createdAt : Date.now(),
    };
  }

  // 線マーキング(縦線・横線・自由な線を共通の{start,end}構造で表現する)
  function createLineMarking({ type, start, end, timeMs, id, createdAt }) {
    const lineType = type === "vertical" || type === "horizontal" ? type : "line";
    return {
      id: id || generateMarkingId(),
      type: lineType,
      start: clampNormalizedPoint(start),
      end: clampNormalizedPoint(end),
      timeMs: timeMs != null ? timeMs : null,
      createdAt: createdAt != null ? createdAt : Date.now(),
    };
  }

  // 角度マーキング: 角度そのものではなく3点を保存し、表示時に再計算する
  function createAngleMarking({ points, timeMs, id, createdAt }) {
    if (!Array.isArray(points) || points.length !== 3) {
      throw new Error("createAngleMarking: points must be an array of exactly 3 points");
    }
    return {
      id: id || generateMarkingId(),
      type: "angle",
      points: points.map(clampNormalizedPoint),
      timeMs: timeMs != null ? timeMs : null,
      createdAt: createdAt != null ? createdAt : Date.now(),
    };
  }

  // 矢飛び出し位置: 位置(x,y)とフレーム時刻(timeMs)を必ず紐づける
  function createArrowReleaseMarking({ x, y, timeMs, id, createdAt }) {
    const p = clampNormalizedPoint({ x, y });
    return {
      id: id || generateMarkingId(),
      type: "arrow_release",
      x: p.x,
      y: p.y,
      timeMs: timeMs != null ? timeMs : null,
      createdAt: createdAt != null ? createdAt : Date.now(),
    };
  }

  // 3点(角度マーキング)から、中央の点(points[1])を頂点とする角度(度)を計算する。
  // 保存時ではなく表示時に呼び出す想定(角度そのものは保存しない)。
  function computeAngleDegrees(points) {
    if (!Array.isArray(points) || points.length !== 3) return null;
    const [a, b, c] = points;
    const v1 = { x: a.x - b.x, y: a.y - b.y };
    const v2 = { x: c.x - b.x, y: c.y - b.y };
    const mag1 = Math.hypot(v1.x, v1.y);
    const mag2 = Math.hypot(v2.x, v2.y);
    if (mag1 === 0 || mag2 === 0) return null;
    const cos = Math.min(1, Math.max(-1, (v1.x * v2.x + v1.y * v2.y) / (mag1 * mag2)));
    return (Math.acos(cos) * 180) / Math.PI;
  }

  // マーキングオブジェクトの構造妥当性を検証する(型ごとに必須フィールドが揃っているか)
  function isValidMarking(m) {
    if (!m || typeof m !== "object") return false;
    if (MARKING_TYPES.indexOf(m.type) === -1) return false;
    if (!m.id) return false;
    switch (m.type) {
      case "point":
      case "arrow_release":
        return isFinitePoint(m);
      case "line":
      case "vertical":
      case "horizontal":
        return isFinitePoint(m.start) && isFinitePoint(m.end);
      case "angle":
        return Array.isArray(m.points) && m.points.length === 3 && m.points.every(isFinitePoint);
      case "freehand":
        return Array.isArray(m.points) && m.points.length > 0 && m.points.every(isFinitePoint);
      default:
        return false;
    }
  }

  return {
    // 座標変換
    computeContainRect,
    screenToVideoPoint,
    videoToScreenPoint,
    screenToNormalizedPoint,
    normalizedToScreenPoint,
    clampNormalizedPoint,
    // マーキングデータ構造
    MARKING_TYPES,
    generateMarkingId,
    createPointMarking,
    createLineMarking,
    createAngleMarking,
    createArrowReleaseMarking,
    computeAngleDegrees,
    isValidMarking,
  };
});
