// Descarga del recorrido al dispositivo (celular, gafas VR o PC) para verlo sin conexión.
// Guarda las teselas y medios en el almacenamiento del navegador (Cache Storage); el
// service worker (sw.js) los entrega cuando no hay internet.
import { urlTesela } from "./motor.js";

const DATOS = "recorrido-datos";
const CLAVE = "recorrido360-descarga";
const CONCURRENCIA = 6;
export const CALIDADES = { estandar: 2, maxima: 99 };  // nivel máximo de teselas (2 = 2048 px por cara)
const ARCHIVOS_APP = ["./", "index.html", "css/estilos.css", "js/app.js", "js/motor.js", "js/lienzo.js", "js/offline.js",
  "vendor/three.module.min.js", "manifest.webmanifest", "tour.json", "iconos/icono-192.png", "iconos/icono-512.png"];

export const disponible = () => "caches" in window && "serviceWorker" in navigator && isSecureContext;

export function registrar() {
  if (!disponible()) return;
  navigator.serviceWorker.register("sw.js").catch(e => console.warn("Sin modo sin conexión:", e));
}

/** Lista de archivos y peso aproximado para una calidad. */
export function listaArchivos(tour, calidad) {
  const nivelMax = CALIDADES[calidad] ?? 2;
  const urls = new Set();
  let bytes = 0;
  const medio = u => { if (u && !/^[a-z]+:/i.test(u)) urls.add(u); };
  for (const e of tour.escenas) {
    medio(e.miniatura);
    medio(e.ambiente);
    e.puntos.forEach(p => { medio(p.imagen); medio(p.audio); });
    const c = e.cubo;
    if (!c) continue;
    c.niveles.forEach((tam, nivel) => {
      if (nivel > nivelMax) return;
      const n = Math.max(1, Math.round(tam / c.tesela));
      for (const cara of "fbudlr") for (let ty = 0; ty < n; ty++) for (let tx = 0; tx < n; tx++) urls.add(urlTesela(c, nivel, cara, ty, tx));
      bytes += c.pesos?.[nivel] || 0;
    });
  }
  return { urls: [...urls].map(u => new URL(u, location.href).href), bytes };
}

export function guardado() {
  try { return JSON.parse(localStorage.getItem(CLAVE)) || null; } catch { return null; }
}

/** ¿Qué hay guardado y qué falta? (p. ej. si se agregaron escenas después de descargar) */
export async function estado(tour) {
  const g = guardado();
  if (!g || !disponible()) return { descargado: false };
  const cache = await caches.open(DATOS);
  const hay = new Set((await cache.keys()).map(r => r.url));
  const { urls } = listaArchivos(tour, g.calidad);
  const faltan = urls.filter(u => !hay.has(u)).length;
  return { descargado: true, calidad: g.calidad, fecha: g.fecha, faltan, total: urls.length };
}

export async function espacio() {
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usado: usage, libre: quota - usage };
  } catch { return null; }
}

/** Descarga todo lo que falte. alProgreso(hechos, total, bytes). señal: AbortSignal para cancelar. */
export async function descargar(tour, calidad, alProgreso, señal) {
  try { await navigator.storage?.persist?.(); } catch {}   // evita que el sistema lo borre por falta de espacio
  const cache = await caches.open(DATOS);
  const hay = new Set((await cache.keys()).map(r => r.url));
  const { urls } = listaArchivos(tour, calidad);
  const app = ARCHIVOS_APP.map(u => new URL(u, location.href).href);
  const pendientes = [...app, ...urls.filter(u => !hay.has(u))];
  const total = pendientes.length;
  let hechos = 0, bytes = 0, errores = 0, i = 0;

  async function trabajador() {
    while (i < pendientes.length) {
      if (señal?.aborted) return;
      const u = pendientes[i++];
      for (let intento = 0; intento < 3; intento++) {
        try {
          const res = await fetch(u, { cache: "no-cache", signal: señal });
          if (!res.ok) throw new Error(res.status);
          const datos = await res.blob();
          await cache.put(u, new Response(datos, { headers: { "Content-Type": res.headers.get("Content-Type") || "" } }));
          bytes += datos.size;
          break;
        } catch (e) {
          if (señal?.aborted) return;
          if (e.name === "QuotaExceededError") throw new Error("No hay espacio suficiente en el dispositivo");
          if (intento === 2) errores++;
          else await new Promise(r => setTimeout(r, 800 * (intento + 1)));
        }
      }
      hechos++;
      alProgreso?.(hechos, total, bytes);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCIA }, trabajador));
  if (señal?.aborted) return { cancelado: true };
  // Si se bajó a calidad estándar, libera el espacio de las teselas más finas
  const nivelMax = CALIDADES[calidad] ?? 2;
  for (const r of await cache.keys()) {
    const m = /\/escenas\/[^/]+\/(\d+)\//.exec(new URL(r.url).pathname);
    if (m && +m[1] > nivelMax) await cache.delete(r);
  }
  localStorage.setItem(CLAVE, JSON.stringify({ calidad, fecha: Date.now() }));
  return { errores, bytes };
}

export async function borrar() {
  await caches.delete(DATOS);
  localStorage.removeItem(CLAVE);
}

export const instalada = () => matchMedia("(display-mode: standalone), (display-mode: fullscreen)").matches || navigator.standalone === true;
export const esIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const esQuest = () => /OculusBrowser|Quest/i.test(navigator.userAgent);
