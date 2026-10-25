// Recorrido 360: interfaz, navegación, audios y banners. El editor se carga aparte (editor.js) solo con ?editar.
import * as THREE from "three";
import { Motor, R_PUNTO, vectorDesde, esMovil, urlTesela } from "./motor.js";
import { ICONOS } from "./lienzo.js";
import * as offline from "./offline.js";

export const $ = s => document.querySelector(s);
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const svg = (tipo, grosor = 2.4) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${grosor}" stroke-linecap="round" stroke-linejoin="round"><path d="${ICONOS[tipo]}"/></svg>`;

export const estado = { tour: null, actualId: null, rotar: true, silencio: false };
export const ganchos = {};  // el editor engancha aquí: clic(yaw, pitch) → true si lo usó
export let motor;

/* ---------- datos ---------- */
export const escena = id => estado.tour.escenas.find(e => e.id === id);
export const actual = () => escena(estado.actualId);
export const nuevoId = () => "p" + Math.random().toString(36).slice(2, 9);
export const NOMBRES_TIPO = { escena: "Enlace", info: "Información", audio: "Audio", banner: "Banner" };

export function prepararTour(t) {
  t.escenas ||= [];
  t.escenas.forEach(e => { e.puntos ||= []; e.puntos.forEach(p => p.id ||= nuevoId()); });
  if (!t.escenas.some(e => e.id === t.inicio) && t.escenas[0]) t.inicio = t.escenas[0].id;
  return t;
}

export function etiquetaPunto(p) {
  if (p.texto) return p.texto;
  if (p.tipo === "escena") return "Ir a: " + (escena(p.destino)?.titulo || "¿?");
  if (p.tipo === "menu") return "Escenas";
  return NOMBRES_TIPO[p.tipo] || "";
}

const puntoValido = p => p.tipo !== "escena" || escena(p.destino);

/* ---------- navegación ---------- */
let navegando = null, siguienteNavegacion = null;
export async function irA(id, opciones = {}) {
  const e = escena(id);
  if (!e || (id === estado.actualId && !opciones.forzar)) return;
  if (navegando) { siguienteNavegacion = [id, opciones]; return navegando; }
  estado.actualId = id;
  detenerAudiosPunto();
  $("#modal").classList.add("oculto");
  $("#escena-titulo").textContent = e.titulo;
  $("#escena-grupo").textContent = e.grupo || "";
  document.title = `${e.titulo} · ${estado.tour.titulo}`;
  history.replaceState(null, "", location.pathname + location.search + "#" + id);
  document.querySelectorAll(".mini").forEach(m => m.classList.toggle("actual", m.dataset.id === id));
  $(`#tira-lista .mini[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  navegando = motor.cargarEscena(e, opciones).catch(err => aviso("No se pudo cargar la escena: " + err.message));
  await navegando;
  navegando = null;
  refrescarPuntos();
  audioAmbiente(e);
  e.puntos.filter(p => p.tipo === "audio" && p.alEntrar && p.audio).forEach(p => alternarAudio(p, true));
  precargarVecinas(e);
  ganchos.escena?.(e);
  $("#cargando").classList.add("listo");
  if (siguienteNavegacion) { const [s, o] = siguienteNavegacion; siguienteNavegacion = null; irA(s, o); }
}

const precargadas = new Set();
let tPrecarga;
function precargarVecinas(e) {
  // Espera a que la escena actual tenga su detalle antes de adelantar las vecinas (máx. 3)
  clearTimeout(tPrecarga);
  tPrecarga = setTimeout(() => {
    if (estado.actualId !== e.id) return;
    const i = estado.tour.escenas.indexOf(e);
    [...e.puntos.filter(p => p.tipo === "escena").map(p => p.destino), estado.tour.escenas[i + 1]?.id]
      .map(escena).filter(d => d && !precargadas.has(d.id)).slice(0, 3).forEach(d => {
        precargadas.add(d.id);
        for (const c of "fbudlr") new Image().src = urlTesela(d.cubo, 0, c, 0, 0);
      });
  }, 2500);
}

function moverEscena(paso) {
  const lista = estado.tour.escenas, n = lista.length;
  irA(lista[(lista.indexOf(actual()) + paso + n) % n].id);
}

/* ---------- puntos ---------- */
let puntosHTML = [];
export function refrescarPuntos() {
  const e = actual();
  if (!e) return;
  const visibles = e.puntos.filter(puntoValido);
  const menu = { id: "__menu", tipo: "menu", yaw: e.yaw || 0, pitch: -58 };  // botón de escenas a los pies (VR/Cardboard)
  motor.setPuntos([...visibles, menu], etiquetaPunto);
  const capa = $("#capa-puntos");
  capa.innerHTML = visibles.filter(p => p.tipo !== "banner").map(p =>
    `<button class="punto punto-${p.tipo}${audios.get(p.id)?.el.paused === false ? " sonando" : ""}" data-id="${p.id}" aria-label="${esc(etiquetaPunto(p))}">
      <span class="icono">${svg(audios.get(p.id)?.el.paused === false ? "pausa" : p.tipo, p.tipo === "info" ? 2.8 : 2.4)}</span>
      <span class="etiqueta">${esc(etiquetaPunto(p))}</span></button>`).join("");
  puntosHTML = [...capa.children].map(el => ({ el, p: visibles.find(p => p.id === el.dataset.id) }));
  posicionarPuntos();
}

function posicionarPuntos() {
  for (const { el, p } of puntosHTML) {
    const v = motor.proyectar(p.yaw, p.pitch);
    el.style.transform = `translate(${v.x.toFixed(1)}px, ${v.y.toFixed(1)}px)`;
    el.style.visibility = v.visible ? "" : "hidden";
  }
}

$("#capa-puntos").addEventListener("click", ev => {
  const b = ev.target.closest(".punto");
  if (!b) return;
  const p = actual().puntos.find(p => p.id === b.dataset.id);
  if (p && !ganchos.clicPunto?.(p)) activarPunto(p);
});

const inmersivo = () => motor.modo === "cardboard" || motor.modo === "vr";

export function activarPunto(p) {
  if (p.tipo === "escena") return irA(p.destino);
  if (p.tipo === "audio") return alternarAudio(p);
  if (p.tipo === "menu") return alternarMenuVR();
  if (p.tipo === "info" || (p.tipo === "banner" && (p.enlace || inmersivo()))) {
    if (inmersivo()) {
      const narracion = p.audio ? reproducirNarracion(p.audio) : null;
      return motor.mostrarPanel3D({ titulo: p.texto, texto: p.descripcion, imagen: p.imagen, estilo: p.estilo },
        () => narracion?.pause());
    }
    abrirInfo(p);
  }
}

function alternarMenuVR() {
  if (motor.menuVR) motor.cerrarMenuVR();
  else motor.mostrarMenuVR(estado.tour.escenas, estado.actualId, id => irA(id));
}

/* ---------- ventana de información ---------- */
export function abrirInfo(p) {
  $("#modal-titulo").textContent = p.texto || "Información";
  $("#modal-texto").textContent = p.descripcion || "";
  const img = $("#modal-imagen");
  img.classList.toggle("oculto", !p.imagen);
  if (p.imagen) img.src = p.imagen;
  const a = $("#modal-enlace");
  a.classList.toggle("oculto", !p.enlace);
  if (p.enlace) a.href = p.enlace;
  const au = $("#modal-audio");
  au.classList.toggle("oculto", !p.audio);
  if (p.audio) { au.src = p.audio; au.muted = estado.silencio; au.play().catch(() => {}); }
  $("#modal").classList.remove("oculto");
}
function cerrarInfo() {
  $("#modal").classList.add("oculto");
  $("#modal-audio").pause();
}
$("#modal-cerrar").onclick = cerrarInfo;
$("#modal").onclick = ev => { if (ev.target.id === "modal") cerrarInfo(); };

/* ---------- audio ---------- */
let oyente = null;
const audios = new Map();        // id de punto → { el, nodo }
let ambiente = null;             // { url, el }

function obtenerOyente() {
  if (!oyente) { oyente = new THREE.AudioListener(); motor.camara.add(oyente); oyente.setMasterVolume(estado.silencio ? 0 : 1); }
  return oyente;
}

function desbloquearAudio() {
  oyente?.context.state === "suspended" && oyente.context.resume();
  if (ambiente?.el.paused && !estado.silencio) ambiente.el.play().catch(() => {});
}
addEventListener("pointerdown", desbloquearAudio);
addEventListener("keydown", desbloquearAudio);

function fundirVolumen(el, hasta, ms, alTerminar) {
  const desde = el.volume, t0 = performance.now();
  const paso = () => {
    const k = Math.min(1, (performance.now() - t0) / ms);
    el.volume = desde + (hasta - desde) * k;
    if (k < 1) requestAnimationFrame(paso); else alTerminar?.();
  };
  paso();
}

function audioAmbiente(e) {
  const url = e.ambiente || null, vol = e.volumenAmbiente ?? 0.5;
  if (ambiente?.url === url) { if (ambiente) fundirVolumen(ambiente.el, vol, 400); return; }
  if (ambiente) { const viejo = ambiente.el; fundirVolumen(viejo, 0, 600, () => viejo.pause()); }
  ambiente = null;
  if (!url) return;
  const el = new Audio(url);
  el.loop = true;
  el.volume = 0;
  el.muted = estado.silencio;
  ambiente = { url, el };
  el.play().then(() => fundirVolumen(el, vol, 900)).catch(() => { el.volume = vol; });  // se reintenta al primer toque
}

function reproducirNarracion(url) {
  const el = new Audio(url);
  el.muted = estado.silencio;
  el.play().catch(() => {});
  return el;
}

export function alternarAudio(p, soloIniciar = false) {
  if (!p.audio) return aviso("Este punto aún no tiene audio");
  let a = audios.get(p.id);
  if (!a) {
    const el = new Audio(p.audio);
    el.crossOrigin = "anonymous";
    el.loop = !!p.bucle;
    let nodo = null;
    if (p.espacial !== false) {
      // Sonido 3D: se escucha desde la dirección del punto y cambia al girar la cabeza
      nodo = new THREE.PositionalAudio(obtenerOyente());
      nodo.setMediaElementSource(el);
      nodo.setRefDistance(R_PUNTO);
      nodo.panner.panningModel = "HRTF";
      nodo.setVolume(p.volumen ?? 1);
      nodo.position.copy(vectorDesde(p.yaw, p.pitch, R_PUNTO));
      motor.mundo.add(nodo);
    } else {
      el.volume = p.volumen ?? 1;
      el.muted = estado.silencio;
    }
    const marcar = () => {
      const sonando = !el.paused;
      document.querySelector(`.punto[data-id="${p.id}"]`)?.classList.toggle("sonando", sonando);
      const icono = document.querySelector(`.punto[data-id="${p.id}"] .icono`);
      if (icono) icono.innerHTML = svg(sonando ? "pausa" : "audio");
      motor.marcarPunto(p.id, sonando, etiquetaPunto(p));
    };
    el.addEventListener("play", marcar);
    el.addEventListener("pause", marcar);
    el.addEventListener("ended", marcar);
    a = { el, nodo };
    audios.set(p.id, a);
  }
  oyente?.context.resume();
  if (a.el.paused) a.el.play().catch(() => aviso("Toca la pantalla para activar el sonido"));
  else if (!soloIniciar) a.el.pause();
}

export function detenerAudiosPunto() {
  for (const { el, nodo } of audios.values()) {
    el.pause();
    el.removeAttribute("src");
    if (nodo) { nodo.disconnect?.(); nodo.removeFromParent(); }
  }
  audios.clear();
}

function hayAudio() {
  return estado.tour.escenas.some(e => e.ambiente || e.puntos.some(p => p.audio));
}
export function actualizarBotonSonido() {
  $("#b-sonido").classList.toggle("oculto", !hayAudio());
}

$("#b-sonido").onclick = () => {
  estado.silencio = !estado.silencio;
  oyente?.setMasterVolume(estado.silencio ? 0 : 1);
  if (ambiente) { ambiente.el.muted = estado.silencio; if (!estado.silencio) ambiente.el.play().catch(() => {}); }
  for (const { el, nodo } of audios.values()) if (!nodo) el.muted = estado.silencio;
  $("#modal-audio").muted = estado.silencio;
  $("#b-sonido .ondas").classList.toggle("oculto", estado.silencio);
  $("#b-sonido .tachado").classList.toggle("oculto", !estado.silencio);
  $("#b-sonido").classList.toggle("activo", estado.silencio);
};

/* ---------- miniaturas y menú ---------- */
const miniatura = e => `<button class="mini" data-id="${esc(e.id)}" title="${esc(e.titulo)}"><img loading="lazy" src="${esc(e.miniatura)}" alt=""><span>${esc(e.titulo)}</span></button>`;

export function renderListas() {
  $("#tour-titulo").textContent = estado.tour.titulo || "";
  $("#tira-lista").innerHTML = estado.tour.escenas.map(miniatura).join("");
  const filtro = $("#buscar").value.trim().toLowerCase();
  const grupos = new Map();
  estado.tour.escenas.filter(e => !filtro || (e.titulo + " " + (e.grupo || "")).toLowerCase().includes(filtro))
    .forEach(e => { const g = e.grupo || "General"; grupos.has(g) || grupos.set(g, []); grupos.get(g).push(e); });
  $("#menu-lista").innerHTML = [...grupos].map(([g, es]) =>
    `<div class="grupo-titulo">${esc(g)} · ${es.length}</div><div class="rejilla">${es.map(miniatura).join("")}</div>`).join("")
    || '<p class="nota">No hay escenas con ese nombre.</p>';
  document.querySelectorAll(".mini").forEach(m => m.classList.toggle("actual", m.dataset.id === estado.actualId));
}

document.addEventListener("click", ev => {
  const m = ev.target.closest(".mini");
  if (m) { irA(m.dataset.id); if (m.closest("#menu") && innerWidth < 700) cerrarPanel("menu"); }
  const c = ev.target.closest("[data-cerrar]");
  if (c) cerrarPanel(c.dataset.cerrar);
});
$("#b-anterior").onclick = () => moverEscena(-1);
$("#b-siguiente").onclick = () => moverEscena(1);
$("#buscar").oninput = renderListas;

export function abrirPanel(id) { $("#" + id).classList.add("abierto"); }
export function cerrarPanel(id) {
  $("#" + id).classList.remove("abierto");
  if (id === "editor") ganchos.cerrarEditor?.();
}
$("#b-menu").onclick = () => $("#menu").classList.toggle("abierto");
$("#b-tira").onclick = () => $("#b-tira").classList.toggle("activo", $("#tira").classList.toggle("plegada"));

/* ---------- botones de modo ---------- */
$("#b-rotar").onclick = () => {
  estado.rotar = !estado.rotar;
  motor.autorotar = estado.rotar && !document.body.classList.contains("editando");
  $("#b-rotar").classList.toggle("activo", estado.rotar);
  aviso(estado.rotar ? "Giro automático activado" : "Giro automático desactivado");
};

$("#b-giro").onclick = async () => {
  try { await motor.activarGiroscopio(motor.modo !== "giroscopio"); }
  catch (e) { aviso(e.message || "Este dispositivo no permite usar el giroscopio"); }
};

$("#b-cardboard").onclick = async () => {
  try { await motor.entrarCardboard(); aviso("Mira un punto 1,5 s (o toca la pantalla) para activarlo. Mira al piso para ver las escenas.", 5000); }
  catch (e) { aviso(e.message || "No se pudo activar el modo Cardboard"); }
};

$("#b-vr").onclick = async () => {
  try { await motor.entrarVR(); }
  catch (e) { aviso("No se pudo iniciar la realidad virtual: " + e.message); }
};

$("#salir-inmersivo").onclick = () => motor.modo === "vr" ? motor.salirVR() : motor.salirModoOrientacion();
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement && motor.modo === "cardboard") motor.salirModoOrientacion();
});

function alCambiarModo(modo) {
  document.body.dataset.modo = modo;
  $("#b-giro").classList.toggle("activo", modo === "giroscopio");
  $("#salir-inmersivo").classList.toggle("oculto", modo !== "cardboard");
  if (modo === "normal") posicionarPuntos();
}

$("#b-pantalla").onclick = () => {
  const d = document;
  if (d.fullscreenElement || d.webkitFullscreenElement) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
  else { const el = d.documentElement; (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el); }
};

$("#b-compartir").onclick = async () => {
  const url = location.origin + location.pathname + "#" + estado.actualId;
  try {
    if (navigator.share) return await navigator.share({ title: actual()?.titulo || estado.tour.titulo, url });
    await navigator.clipboard.writeText(url);
    aviso("Enlace copiado: " + url);
  } catch (e) { if (e.name !== "AbortError") prompt("Copia este enlace:", url); }
};

/* ---------- usar sin conexión: guardar en el dispositivo e instalar como app ---------- */
const mb = b => b >= 1048576 ? `${Math.round(b / 1048576)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
let instalador = null, descargaEnCurso = null, estadoOffline = {};
addEventListener("beforeinstallprompt", ev => { ev.preventDefault(); instalador = ev; actualizarInstalar(); });
addEventListener("appinstalled", () => { instalador = null; aviso("App instalada"); actualizarInstalar(); });

function actualizarInstalar() {
  $("#sec-instalar").classList.toggle("oculto", offline.instalada());
  $("#b-instalar").classList.toggle("oculto", !instalador);
  $("#instalar-texto").innerHTML = instalador
    ? "Queda con su propio ícono y se abre en pantalla completa, sin la barra del navegador."
    : offline.esIOS() ? "En iPhone o iPad: toca <b>Compartir</b> y luego <b>Agregar a pantalla de inicio</b>."
    : offline.esQuest() ? "En el Quest: abre el menú del navegador (⋯) y elige <b>Instalar app</b>. Aparecerá en tu biblioteca de apps."
    : "Usa el menú del navegador (⋮) → <b>Instalar app</b> o <b>Agregar a pantalla de inicio</b>.";
}
$("#b-instalar").onclick = async () => {
  if (!instalador) return;
  instalador.prompt();
  await instalador.userChoice;
  instalador = null;
  actualizarInstalar();
};

const calidadElegida = () => document.querySelector("input[name=calidad]:checked").value;

async function actualizarDescarga() {
  if (!offline.disponible()) {
    $("#sec-guardar").classList.add("oculto");
    $("#sin-soporte").classList.remove("oculto");
    return;
  }
  for (const c of Object.keys(offline.CALIDADES))
    document.querySelector(`[data-peso="${c}"]`).textContent = mb(offline.listaArchivos(estado.tour, c).bytes);
  const e = estadoOffline = await offline.estado(estado.tour);
  const el = $("#descarga-estado");
  el.className = "estado-descarga" + (e.descargado && !e.faltan ? " ok" : "");
  el.textContent = !e.descargado ? ""
    : e.faltan ? `Hay contenido nuevo: faltan ${e.faltan} archivos. Pulsa «Actualizar».`
    : `✓ Guardado en este dispositivo (calidad ${e.calidad === "maxima" ? "máxima" : "estándar"}). Funciona sin internet.`;
  if (e.descargado && !descargaEnCurso) document.querySelector(`input[name=calidad][value="${e.calidad}"]`).checked = true;
  botonDescarga();
  $("#b-borrar-descarga").classList.toggle("oculto", !e.descargado || !!descargaEnCurso);
  $("#b-descargar").classList.toggle("listo", e.descargado && !e.faltan);
  const esp = await offline.espacio();
  $("#descarga-espacio").textContent = esp ? `Espacio disponible: ${mb(esp.libre)}` : "";
  aplicarNivelSinConexion();
}

function botonDescarga() {
  const e = estadoOffline, b = $("#b-iniciar-descarga");
  const otra = e.descargado && calidadElegida() !== e.calidad;
  b.textContent = !e.descargado ? "Descargar" : otra ? "Cambiar a esta calidad" : "Actualizar";
  b.classList.toggle("oculto", !!descargaEnCurso || (e.descargado && !e.faltan && !otra));
}
document.querySelectorAll("input[name=calidad]").forEach(r => r.addEventListener("change", botonDescarga));

// Sin internet y con descarga estándar, no se piden teselas que no están guardadas
function aplicarNivelSinConexion() {
  const g = offline.guardado();
  if (motor) motor.nivelMaximo = !navigator.onLine && g ? offline.CALIDADES[g.calidad] : Infinity;
}
addEventListener("online", aplicarNivelSinConexion);
addEventListener("offline", () => { aplicarNivelSinConexion(); aviso("Sin conexión: usando la copia guardada"); });

$("#b-iniciar-descarga").onclick = async () => {
  const calidad = calidadElegida();
  const { bytes } = offline.listaArchivos(estado.tour, calidad);
  const esp = await offline.espacio();
  if (esp && esp.libre < bytes * 1.05) return aviso(`No hay espacio suficiente: se necesitan ${mb(bytes)}`, 5000);
  descargaEnCurso = new AbortController();
  let bloqueoPantalla = null;
  try { bloqueoPantalla = await navigator.wakeLock?.request("screen"); } catch {}  // que no se apague la pantalla
  $("#descarga-progreso").classList.remove("oculto");
  $("#b-cancelar-descarga").classList.remove("oculto");
  $("#descarga-opciones").classList.add("oculto");
  $("#b-borrar-descarga").classList.add("oculto");
  botonDescarga();
  try {
    const r = await offline.descargar(estado.tour, calidad, (hechos, total, recibidos) => {
      $("#descarga-progreso .progreso div").style.width = (hechos / total * 100).toFixed(1) + "%";
      $("#descarga-texto").textContent = `${Math.floor(hechos / total * 100)} % · ${mb(recibidos)} descargados · no cierres esta página`;
    }, descargaEnCurso.signal);
    if (r.cancelado) aviso("Descarga pausada. Pulsa «Descargar» para continuar donde quedó.", 4000);
    else if (r.errores) aviso(`Terminó con ${r.errores} archivo(s) sin descargar. Pulsa «Actualizar» para reintentar.`, 5000);
    else aviso("¡Listo! Ya puedes usar el recorrido sin internet.", 4000);
  } catch (e) { aviso(e.message, 5000); }
  bloqueoPantalla?.release?.().catch(() => {});
  descargaEnCurso = null;
  $("#descarga-progreso").classList.add("oculto");
  $("#b-cancelar-descarga").classList.add("oculto");
  $("#descarga-opciones").classList.remove("oculto");
  actualizarDescarga();
};
$("#b-cancelar-descarga").onclick = () => descargaEnCurso?.abort();
$("#b-borrar-descarga").onclick = async () => {
  if (!confirm("¿Borrar el recorrido guardado en este dispositivo? Necesitarás internet para volver a verlo.")) return;
  await offline.borrar();
  aviso("Copia sin conexión borrada");
  actualizarDescarga();
};

async function revisarZip() {
  if (esMovil || !navigator.onLine || location.protocol === "file:") return;
  try {
    const r = await fetch("descarga/recorrido-360.zip", { method: "HEAD", cache: "no-store" });
    if (!r.ok) return;
    const bytes = +r.headers.get("Content-Length");
    $("#zip-tamano").textContent = bytes ? mb(bytes) : "ZIP";
    $("#sec-zip").classList.remove("oculto");
  } catch {}
}

$("#b-descargar").onclick = () => {
  actualizarDescarga();
  actualizarInstalar();
  $("#dialogo-descarga").classList.remove("oculto");
};
$("#dialogo-descarga").addEventListener("click", ev => {
  if (ev.target.id === "dialogo-descarga" || ev.target.closest("[data-cerrar-dialogo]")) $("#dialogo-descarga").classList.add("oculto");
});

function sugerirDescarga() {
  try {
    if (!esMovil || !offline.disponible() || offline.guardado() || localStorage.getItem("recorrido360-sugerido")) return;
    localStorage.setItem("recorrido360-sugerido", "1");
    setTimeout(() => aviso("Consejo: con el botón ⬇ puedes guardar el recorrido y verlo sin internet", 6000), 4000);
  } catch {}
}

let avisoTimer;
export function aviso(texto, ms = 2600) {
  const el = $("#aviso");
  el.textContent = texto;
  el.classList.add("visible");
  clearTimeout(avisoTimer);
  avisoTimer = setTimeout(() => el.classList.remove("visible"), ms);
}

/* ---------- teclado ---------- */
document.addEventListener("keydown", ev => {
  if (ev.target.matches("input, textarea, select")) return;
  if (ganchos.teclado?.(ev)) return;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (motor.teclado(ev)) return ev.preventDefault();
  const k = ev.key.toLowerCase();
  if (k === "escape") { cerrarInfo(); cerrarPanel("menu"); }
  else if (k === "m") $("#b-menu").click();
  else if (k === "f") $("#b-pantalla").click();
  else if (k === "r") $("#b-rotar").click();
  else if (k === "n" || k === "pagedown") moverEscena(1);
  else if (k === "p" || k === "pageup") moverEscena(-1);
});

/* ---------- arranque ---------- */
(async function iniciar() {
  try {
    estado.tour = prepararTour(await (await fetch("tour.json", { cache: "no-store" })).json());
  } catch {
    $("#escena-titulo").textContent = "No se pudo cargar tour.json";
    return $("#cargando").classList.add("listo");
  }
  motor = new Motor($("#visor"));
  motor.al.vista = posicionarPuntos;
  motor.al.modo = alCambiarModo;
  motor.al.activar = activarPunto;
  motor.al.menuVR = alternarMenuVR;
  motor.al.contexto = recuperado => {
    if (!recuperado) return aviso("Recuperando la imagen…", 4000);
    irA(estado.actualId, { forzar: true, vista: motor.modo === "normal" ? motor.vista : undefined });
  };
  motor.al.clic = ({ yaw, pitch, punto }) => {
    if (ganchos.clic?.(yaw, pitch)) return;
    if (punto) activarPunto(punto);
  };
  motor.autorotar = estado.rotar = estado.tour.autorotar !== false;
  $("#b-rotar").classList.toggle("activo", estado.rotar);

  if (esMovil) { $("#b-cardboard").classList.remove("oculto"); $("#b-giro").classList.remove("oculto"); }
  motor.soportaVR().then(si => $("#b-vr").classList.toggle("oculto", !si));
  actualizarBotonSonido();
  revisarZip();
  renderListas();

  const quiereEditar = new URLSearchParams(location.search).has("editar");
  if (!quiereEditar) {
    offline.registrar();
    actualizarDescarga().catch(() => {});
    sugerirDescarga();
  }
  if (quiereEditar) {
    const { iniciarEditor } = await import("./editor.js");
    await iniciarEditor();
  }
  const desdeEnlace = decodeURIComponent(location.hash.slice(1));
  await irA(escena(desdeEnlace) ? desdeEnlace : estado.tour.inicio, { forzar: true });
  addEventListener("hashchange", () => irA(decodeURIComponent(location.hash.slice(1))));
})();
