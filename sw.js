// Service worker: permite abrir el recorrido sin conexión (celular, gafas VR y PC).
// - Código (html, js, css): primero la red (siempre actualizado); sin conexión, la copia guardada.
// - Fotos y medios: primero lo guardado (rápido); si no está, de la red y se guarda.
const APP = "recorrido-app-v1";
const DATOS = "recorrido-datos";   // lo descargado con el botón «Descargar» y lo ya visitado
const ARCHIVOS_APP = [
  "./", "index.html", "css/estilos.css", "js/app.js", "js/motor.js", "js/lienzo.js", "js/offline.js",
  "vendor/three.module.min.js", "manifest.webmanifest", "tour.json",
  "iconos/icono-192.png", "iconos/icono-512.png", "iconos/favicon.png",
];

self.addEventListener("install", ev => {
  ev.waitUntil(caches.open(APP).then(c => c.addAll(ARCHIVOS_APP)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", ev => {
  ev.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("recorrido-app-") && k !== APP) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", ev => {
  const req = ev.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.includes("/api/")) return;
  if (/\/(escenas|medios)\//.test(url.pathname)) ev.respondWith(primeroGuardado(req));
  else if (!url.pathname.endsWith(".zip")) ev.respondWith(primeroRed(req));
});

async function primeroGuardado(req) {
  const guardada = await caches.match(req.url, { ignoreVary: true });
  if (guardada) return req.headers.has("range") ? rango(req, guardada) : guardada;
  const res = await fetch(req);
  if (res.status === 200 && !req.headers.has("range")) {
    const copia = res.clone();
    caches.open(DATOS).then(c => c.put(req.url, copia)).catch(() => {});
  }
  return res;
}

async function primeroRed(req) {
  try {
    const res = await Promise.race([fetch(req), new Promise((_, no) => setTimeout(() => no(new Error("lenta")), 5000))]);
    if (res.ok) { const copia = res.clone(); caches.open(APP).then(c => c.put(req, copia)).catch(() => {}); }
    return res;
  } catch (e) {
    const guardada = await caches.match(req, { ignoreSearch: true })
      || (req.mode === "navigate" && await caches.match("index.html", { ignoreSearch: true }));
    if (guardada) return guardada;
    throw e;
  }
}

// Los audios piden trozos (Range); se recortan de la copia guardada.
async function rango(req, res) {
  const datos = await res.blob();
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get("range") || "");
  const inicio = m && m[1] ? +m[1] : 0;
  const fin = m && m[2] ? Math.min(+m[2], datos.size - 1) : datos.size - 1;
  return new Response(datos.slice(inicio, fin + 1), {
    status: 206,
    headers: {
      "Content-Type": res.headers.get("Content-Type") || "application/octet-stream",
      "Content-Range": `bytes ${inicio}-${fin}/${datos.size}`,
      "Content-Length": String(fin - inicio + 1),
      "Accept-Ranges": "bytes",
    },
  });
}
