// sw.js
// 「射タイムシフトカメラ」オフライン起動用 Service Worker。
//
// 目的:
//   アプリ本体(index.html・4つのエンジンJS・アイコン・manifest)だけをキャッシュし、
//   ネットワークが無い環境でもアプリ自体を起動できるようにする。
//
// 意図的にやらないこと(このファイルの責務外):
//   ・カメラ映像そのものの保存/キャッシュは行わない(そもそもfetch/HTTPを経由しないため対象外)。
//   ・保存済み射(shots/shotFrames)のIndexedDBには一切関与しない。
//     Storage Engine(storageEngine.js)の仕組み・挙動はこのファイルの追加によって変化しない。
//   ・bufferEngine.js / playbackEngine.js / storageEngine.js / coordinateEngine.js の
//     内容そのものには手を加えない(このファイルはそれらを「そのまま」キャッシュするだけ)。
//
// キャッシュ戦略:
//   ネットワーク優先(network-first)。オンライン時は常に最新のレスポンスを返すため、
//   Service Worker導入前と体感できる違いは生まれない。ネットワーク取得に失敗した場合
//   (=オフライン)だけ、キャッシュ済みのレスポンスにフォールバックする。
//
// バージョン管理:
//   CACHE_VERSIONを変更するとCACHE_NAMEが変わり、activate時に旧バージョンのキャッシュを
//   自動的に破棄する。新しいエンジンファイルが増えた場合等はAPP_SHELL_FILESと合わせて
//   このバージョン文字列を更新すること。

const CACHE_VERSION = "v1";
const CACHE_NAME = "kyudo-cam-shell-" + CACHE_VERSION;

// アプリの「起動」に必要な最小限のファイルのみを対象にする。
// (このアプリは外部CDN等を一切使わない自己完結構成のため、これで全体をカバーできる)
const APP_SHELL_FILES = [
  "./",
  "./index.html",
  "./bufferEngine.js",
  "./playbackEngine.js",
  "./storageEngine.js",
  "./coordinateEngine.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-512-maskable.png",
  "./apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL_FILES))
      .catch((err) => {
        // addAll()は1件でも404等で失敗すると全体が失敗する。
        // ここで失敗しても、インストール自体(=SWの導入)は継続させる。
        // (通常のオンライン動作を妨げないことを優先するため)
        console.warn("[sw] 事前キャッシュに失敗しました:", err);
      })
  );
  // 新しいSWをすぐに有効化する(更新時に古いバージョンが居座らないようにするため)。
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME) // 古いバージョンのキャッシュだけを対象にする
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // GET以外(このアプリでは基本的に発生しない)はService Workerを介さず素通りさせる。
  if (req.method !== "GET") return;

  event.respondWith(
    fetch(req)
      .then((networkResponse) => {
        // オンライン時は常にネットワークの応答をそのまま返す(挙動は無変更)。
        // 併せてキャッシュも最新の内容に更新しておく(次回オフライン時のため)。
        const responseCopy = networkResponse.clone();
        caches
          .open(CACHE_NAME)
          .then((cache) => cache.put(req, responseCopy))
          .catch(() => {
            /* キャッシュ更新の失敗は無視してよい(致命的ではないため) */
          });
        return networkResponse;
      })
      .catch(() =>
        caches.match(req).then((cached) => {
          if (cached) return cached;
          // キャッシュにも無い場合のみ、素直にオフラインである旨を返す。
          return new Response(
            "オフラインのため読み込めませんでした。一度オンライン環境でアプリを開き直してください。",
            {
              status: 503,
              statusText: "Offline",
              headers: { "Content-Type": "text/plain; charset=utf-8" },
            }
          );
        })
      )
  );
});
