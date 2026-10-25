// Editor visual del recorrido. Solo se descarga cuando la dirección lleva ?editar.
import {
  $, esc, estado, ganchos, motor, escena, actual, nuevoId, irA, refrescarPuntos, renderListas, aviso,
  etiquetaPunto, abrirPanel, cerrarPanel, prepararTour, NOMBRES_TIPO, actualizarBotonSonido, detenerAudiosPunto,
} from "./app.js";

const CLAVE_BORRADOR = "recorrido360-borrador";
const normalizarYaw = y => ((y % 360) + 540) % 360 - 180;
let servidor = false, sinGuardar = false, colocando = null, ultimoDestino = null, tipoNuevo = "escena";

export async function iniciarEditor() {
  try { const r = await fetch("api/estado"); servidor = r.ok && (await r.json()).editable; } catch {}
  try {
    const borrador = localStorage.getItem(CLAVE_BORRADOR);
    if (borrador && borrador !== JSON.stringify(estado.tour) &&
        confirm("Hay cambios sin guardar de una sesión anterior. ¿Quieres recuperarlos?")) {
      estado.tour = prepararTour(JSON.parse(borrador));
      sinGuardar = true;
      renderListas();
    } else localStorage.removeItem(CLAVE_BORRADOR);
  } catch {}

  $("#b-editar").classList.remove("oculto");
  $("#b-editar").onclick = () => document.body.classList.contains("editando") ? cerrarPanel("editor") : entrar();
  $("#b-guardar").onclick = guardar;
  $("#b-cancelar-colocar").onclick = cancelarColocar;
  ganchos.escena = () => { if (document.body.classList.contains("editando")) render(); };
  ganchos.cerrarEditor = salir;
  ganchos.clic = (yaw, pitch) => { if (!colocando) return false; colocarEn(+pitch.toFixed(2), +yaw.toFixed(2)); return true; };
  ganchos.clicPunto = () => !!colocando;
  ganchos.teclado = ev => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") { ev.preventDefault(); guardar(); return true; }
    if (ev.key === "Escape" && colocando) { cancelarColocar(); return true; }
    if (ev.key.toLowerCase() === "e" && !ev.ctrlKey && !ev.metaKey) { $("#b-editar").click(); return true; }
    return false;
  };
  addEventListener("beforeunload", ev => { if (sinGuardar) { ev.preventDefault(); ev.returnValue = ""; } });
  entrar();
  if (sinGuardar) marcarCambios();
}

function entrar() {
  document.body.classList.add("editando");
  motor.autorotar = false;
  $("#b-editar").classList.add("activo");
  $("#mira").classList.remove("oculto");
  abrirPanel("editor");
  render();
}

function salir() {
  document.body.classList.remove("editando");
  $("#b-editar").classList.remove("activo");
  $("#mira").classList.add("oculto");
  cancelarColocar();
  motor.autorotar = estado.rotar;
}

/* ---------- guardar ---------- */
function marcarCambios() {
  sinGuardar = true;
  const el = $("#estado-guardado");
  el.textContent = "Cambios sin guardar";
  el.classList.add("pendiente");
  try { localStorage.setItem(CLAVE_BORRADOR, JSON.stringify(estado.tour)); } catch {}
}

function marcarGuardado(texto) {
  sinGuardar = false;
  const el = $("#estado-guardado");
  el.textContent = texto;
  el.classList.remove("pendiente");
  try { localStorage.removeItem(CLAVE_BORRADOR); } catch {}
}

async function guardar() {
  const json = JSON.stringify(estado.tour, null, 2);
  if (servidor) {
    try {
      const r = await fetch("api/guardar", { method: "POST", headers: { "Content-Type": "application/json" }, body: json });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      marcarGuardado("Guardado " + new Date().toLocaleTimeString());
      return aviso("Cambios guardados en tour.json");
    } catch (e) { aviso("No se pudo guardar: " + e.message + ". Se descargará el archivo."); }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  a.download = "tour.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  marcarGuardado("Descargado: reemplaza sitio/tour.json con este archivo");
}

/* ---------- colocar puntos ---------- */
function iniciarColocar(opciones, texto) {
  colocando = opciones;
  document.body.classList.add("colocando");
  $("#colocando-texto").textContent = texto;
  $("#colocando").classList.remove("oculto");
  if (innerWidth < 700) $("#editor").classList.remove("abierto");
}

function cancelarColocar() {
  colocando = null;
  document.body.classList.remove("colocando");
  $("#colocando").classList.add("oculto");
  if (document.body.classList.contains("editando")) abrirPanel("editor");
}

const PLANTILLAS = {
  info: () => ({ texto: "Información", descripcion: "" }),
  audio: () => ({ texto: "Audio", audio: "", espacial: true, bucle: false, volumen: 1, alEntrar: false }),
  banner: () => ({ texto: "Título del banner", descripcion: "Escribe aquí la información.", ancho: 3, estilo: "oscuro" }),
};

function colocarEn(pitch, yaw) {
  const e = actual(), op = colocando;
  cancelarColocar();
  if (op.puntoId) Object.assign(e.puntos.find(p => p.id === op.puntoId), { pitch, yaw });
  else {
    const p = { id: nuevoId(), tipo: op.tipo, pitch, yaw };
    if (op.tipo === "escena") p.destino = op.destino;
    else Object.assign(p, PLANTILLAS[op.tipo]());
    e.puntos.push(p);
    render.nuevo = p.id;
    if (op.tipo === "escena" && op.regreso) {
      const d = escena(op.destino);
      if (d && !d.puntos.some(q => q.tipo === "escena" && q.destino === e.id))
        d.puntos.push({ id: nuevoId(), tipo: "escena", destino: e.id, pitch, yaw: +normalizarYaw(yaw + 180).toFixed(2) });
    }
    aviso(`${NOMBRES_TIPO[op.tipo]} creado` + (op.regreso ? " (con regreso)" : ""));
  }
  refrescarPuntos();
  marcarCambios();
  render();
}

/* ---------- subir archivos ---------- */
function elegirArchivo(accept, multiple = false) {
  return new Promise(res => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => res([...input.files]);
    input.click();
  });
}

async function subir(ruta, archivo) {
  const r = await fetch(ruta, { method: "POST", headers: { "X-Nombre": encodeURIComponent(archivo.name) }, body: archivo });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error);
  return d;
}

async function subirMedio(tipo) {
  const [f] = await elegirArchivo(tipo === "audio" ? "audio/*" : "image/*");
  if (!f) return null;
  aviso(`Subiendo ${f.name}…`, 60000);
  try { const d = await subir("api/medio", f); aviso("Archivo listo"); return d.url; }
  catch (e) { aviso("Error: " + e.message, 5000); return null; }
}

async function subirFotos() {
  const archivos = await elegirArchivo("image/jpeg,image/png,image/webp", true);
  if (!archivos.length) return;
  const barra = $("#subida-progreso");
  barra.classList.remove("oculto");
  let hechas = 0, ultima;
  for (const f of archivos) {
    aviso(`Procesando ${f.name} (${hechas + 1}/${archivos.length})… puede tardar ~30 s`, 120000);
    try {
      const { escena: e } = await subir("api/subir", f);
      e.puntos ||= [];
      if (!escena(e.id)) estado.tour.escenas.push(e);
      else Object.assign(escena(e.id), { cubo: e.cubo, miniatura: e.miniatura });
      ultima = e.id;
    } catch (err) { aviso(`Error con ${f.name}: ${err.message}`, 5000); }
    hechas++;
    barra.firstElementChild.style.width = (hechas / archivos.length * 100) + "%";
  }
  barra.classList.add("oculto");
  marcarCambios();
  renderListas();
  if (ultima) { await irA(ultima); aviso(`${hechas} foto(s) agregadas. Recuerda Guardar.`); }
}

/* ---------- panel ---------- */
const opcionesEscenas = (sel, excluir) => estado.tour.escenas.filter(e => e.id !== excluir)
  .map(e => `<option value="${esc(e.id)}" ${e.id === sel ? "selected" : ""}>${esc(e.titulo)}${e.grupo ? " · " + esc(e.grupo) : ""}</option>`).join("");

function campoMedio(etiqueta, atributo, valor, tipo) {
  return `<label class="campo">${etiqueta}<div class="medio">
    <input type="text" ${atributo} value="${esc(valor || "")}" placeholder="${servidor ? "Sube un archivo o pega una URL" : "medios/archivo… o URL"}">
    ${servidor ? `<button class="btn mini-btn" type="button" data-subir="${tipo}">Subir</button>` : ""}
    ${valor ? `<button class="btn mini-btn" type="button" data-quitar>✕</button>` : ""}</div></label>`;
}

function camposPunto(p, e) {
  const t = (k, l, ph = "") => `<label class="campo">${l}<input data-pcampo="${k}" value="${esc(p[k] || "")}" placeholder="${esc(ph)}"></label>`;
  const area = (k, l) => `<label class="campo">${l}<textarea data-pcampo="${k}">${esc(p[k] || "")}</textarea></label>`;
  const check = (k, l) => `<label class="check"><input type="checkbox" data-pcheck="${k}" ${p[k] ? "checked" : ""}> ${l}</label>`;
  switch (p.tipo) {
    case "escena": return `<label class="campo">Lleva a<select data-pcampo="destino">${opcionesEscenas(p.destino, e.id)}</select></label>
      ${t("texto", "Texto (opcional)", etiquetaPunto({ ...p, texto: "" }))}`;
    case "info": return t("texto", "Título") + area("descripcion", "Descripción")
      + campoMedio("Imagen (opcional)", 'data-pcampo="imagen"', p.imagen, "imagen")
      + campoMedio("Narración en audio (opcional)", 'data-pcampo="audio"', p.audio, "audio")
      + t("enlace", "Enlace (opcional)", "https://…");
    case "audio": return t("texto", "Título") + campoMedio("Archivo de audio", 'data-pcampo="audio"', p.audio, "audio")
      + `<label class="campo">Volumen<input type="range" min="0" max="1" step="0.05" data-pcampo="volumen" value="${p.volumen ?? 1}"></label>`
      + check("espacial", "Sonido 3D (se oye desde el punto)") + check("bucle", "Repetir en bucle") + check("alEntrar", "Reproducir al entrar a la escena");
    case "banner": return t("texto", "Título") + area("descripcion", "Texto")
      + campoMedio("Imagen (opcional)", 'data-pcampo="imagen"', p.imagen, "imagen")
      + t("enlace", "Enlace (opcional)", "https://…")
      + `<label class="campo">Tamaño<input type="range" min="1" max="8" step="0.25" data-pcampo="ancho" value="${p.ancho || 3}"></label>
      <label class="campo">Estilo<select data-pcampo="estilo">${["oscuro", "claro", "acento"].map(s => `<option ${p.estilo === s ? "selected" : ""}>${s}</option>`).join("")}</select></label>`;
  }
  return "";
}

function escenasSinConexion() {
  const entrantes = new Set(estado.tour.escenas.flatMap(e => e.puntos.filter(p => p.tipo === "escena").map(p => p.destino)));
  return estado.tour.escenas.filter(e => !entrantes.has(e.id) && !e.puntos.some(p => p.tipo === "escena"));
}

function render() {
  const e = actual();
  if (!e || !$("#editor").classList.contains("abierto") && !document.body.classList.contains("editando")) return;
  const tour = estado.tour, i = tour.escenas.indexOf(e);
  const grupos = [...new Set(tour.escenas.map(x => x.grupo).filter(Boolean))];
  const sueltas = escenasSinConexion();
  const destino = ultimoDestino && escena(ultimoDestino) && ultimoDestino !== e.id ? ultimoDestino : tour.escenas[(i + 1) % tour.escenas.length]?.id;
  const abiertos = new Set([...document.querySelectorAll(".punto-item[open]")].map(d => d.dataset.puntoId));

  $("#editor-cuerpo").innerHTML = `
  <div class="seccion">
    <h3>Escena actual ${tour.inicio === e.id ? '<span class="aviso-txt">· inicio</span>' : ""}</h3>
    <label class="campo">Título<input data-campo="titulo" value="${esc(e.titulo)}"></label>
    <label class="campo">Grupo / piso<input data-campo="grupo" value="${esc(e.grupo || "")}" list="lista-grupos"></label>
    <datalist id="lista-grupos">${grupos.map(g => `<option value="${esc(g)}">`).join("")}</datalist>
    ${campoMedio("Sonido ambiente (opcional)", 'data-campo="ambiente"', e.ambiente, "audio")}
    ${e.ambiente ? `<label class="campo">Volumen del ambiente<input type="range" min="0" max="1" step="0.05" data-campo="volumenAmbiente" value="${e.volumenAmbiente ?? 0.5}"></label>` : ""}
    <div class="fila">
      <button class="btn" data-accion="vista">Usar vista actual al entrar</button>
      <button class="btn" data-accion="inicio" ${tour.inicio === e.id ? "disabled" : ""}>Hacer escena de inicio</button>
    </div>
    <div class="fila" style="margin-top:6px">
      <button class="btn" data-accion="subir-orden" ${i === 0 ? "disabled" : ""}>↑ Antes</button>
      <button class="btn" data-accion="bajar-orden" ${i === tour.escenas.length - 1 ? "disabled" : ""}>↓ Después</button>
      <span class="nota" style="margin:0">Posición ${i + 1} de ${tour.escenas.length}</span>
      <span style="flex:1"></span>
      <button class="btn peligro" data-accion="quitar-escena">Quitar</button>
    </div>
  </div>

  <div class="seccion">
    <h3>Agregar punto</h3>
    <div class="tipos">
      ${Object.entries(NOMBRES_TIPO).map(([k, n]) => `<button class="btn ${tipoNuevo === k ? "primario" : ""}" data-tipo="${k}">${n}</button>`).join("")}
    </div>
    ${tipoNuevo === "escena" ? `
      <div class="fila" style="margin-top:8px"><select id="nuevo-destino" aria-label="Escena de destino">${opcionesEscenas(destino, e.id)}</select></div>
      <label class="check"><input type="checkbox" id="nuevo-regreso" checked> Crear también el enlace de regreso</label>` : ""}
    <div class="fila" style="margin-top:8px"><button class="btn primario" data-accion="nuevo">+ Colocar ${NOMBRES_TIPO[tipoNuevo].toLowerCase()}</button></div>
    <p class="nota">${{
      escena: "Haz clic en la puerta o el pasillo que lleva a la otra escena.",
      info: "Un ícono «i» que abre una ventana con texto, imagen, narración y enlace.",
      audio: "Un parlante que reproduce un sonido al tocarlo; en 3D se oye desde esa dirección.",
      banner: "Un cartel fijo dentro de la foto (con imagen y texto), visible también en VR.",
    }[tipoNuevo]}</p>
  </div>

  <div class="seccion">
    <h3>Puntos en esta escena · ${e.puntos.length}</h3>
    ${e.puntos.length ? "" : '<p class="nota">Aún no hay puntos.</p>'}
    ${e.puntos.map(p => `
      <details class="punto-item" data-punto-id="${p.id}" ${abiertos.has(p.id) || p.id === render.nuevo ? "open" : ""}>
        <summary><span class="tipo">${NOMBRES_TIPO[p.tipo]}</span> · ${esc(etiquetaPunto(p))}</summary>
        ${camposPunto(p, e)}
        <div class="fila">
          <button class="btn mini-btn" data-paccion="ver">Ver</button>
          <button class="btn mini-btn" data-paccion="mover">Mover</button>
          ${p.tipo === "escena" ? '<button class="btn mini-btn" data-paccion="ir">Ir ›</button>' : ""}
          <span style="flex:1"></span>
          <button class="btn mini-btn peligro" data-paccion="borrar">Borrar</button>
        </div>
      </details>`).join("")}
  </div>

  <div class="seccion">
    <h3>Recorrido</h3>
    <label class="campo">Nombre del recorrido<input data-tour="titulo" value="${esc(tour.titulo || "")}"></label>
    <label class="check"><input type="checkbox" data-tour-check="autorotar" ${tour.autorotar !== false ? "checked" : ""}> Giro automático al abrir</label>
    ${sueltas.length ? `<p class="nota aviso-txt">${sueltas.length} escena(s) sin ningún enlace:</p>
      <ul class="lista-sin">${sueltas.slice(0, 40).map(s => `<li><a data-ir="${esc(s.id)}">${esc(s.titulo)}</a></li>`).join("")}</ul>`
      : '<p class="nota">Todas las escenas tienen al menos un enlace. ✔</p>'}
  </div>

  <div class="seccion">
    <h3>Fotos 360 nuevas</h3>
    ${servidor ? `<button class="btn" data-accion="fotos">Subir fotos…</button>
      <p class="nota">Se convierten en teselas multirresolución (calidad original, carga rápida). Las originales no se tocan.</p>
      <div id="subida-progreso" class="progreso oculto"><div></div></div>` :
      `<p class="nota">Para subir fotos, audios e imágenes abre el editor con <b>iniciar.bat</b>. Aquí «Guardar» descarga <b>tour.json</b>.</p>`}
  </div>`;
  render.nuevo = null;
}

/* ---------- eventos del panel ---------- */
let tRefresco;
function refrescarDiferido() { clearTimeout(tRefresco); tRefresco = setTimeout(refrescarPuntos, 250); }

function puntoDe(el) {
  const id = el.closest("[data-punto-id]")?.dataset.puntoId;
  return actual().puntos.find(p => p.id === id);
}

function aplicarCampo(t) {
  const e = actual();
  if (t.dataset.campo) {
    const k = t.dataset.campo;
    e[k] = t.type === "range" ? +t.value : t.value;
    if (!e[k] && k === "ambiente") delete e.ambiente;
    if (k === "titulo") { $("#escena-titulo").textContent = t.value; refrescarDiferido(); }
    if (k === "grupo") $("#escena-grupo").textContent = t.value;
    if (k === "titulo" || k === "grupo") { clearTimeout(aplicarCampo.t); aplicarCampo.t = setTimeout(renderListas, 300); }
    if (k === "ambiente" || k === "volumenAmbiente") { actualizarBotonSonido(); clearTimeout(aplicarCampo.a); aplicarCampo.a = setTimeout(() => irA(e.id, { forzar: true, vista: motor.vista }), 600); }
  } else if (t.dataset.tour) {
    estado.tour[t.dataset.tour] = t.value;
    $("#tour-titulo").textContent = t.value;
  } else if (t.dataset.tourCheck) {
    estado.tour[t.dataset.tourCheck] = t.checked;
  } else if (t.dataset.pcampo || t.dataset.pcheck) {
    const p = puntoDe(t), k = t.dataset.pcampo || t.dataset.pcheck;
    if (t.dataset.pcheck) p[k] = t.checked;
    else p[k] = t.type === "range" ? +t.value : t.value;
    if (!p[k] && t.type !== "checkbox" && t.type !== "range") delete p[k];
    if (k === "audio" || k === "espacial" || k === "bucle" || k === "volumen") { detenerAudiosPunto(); actualizarBotonSonido(); }
    refrescarDiferido();
    const resumen = t.closest("details")?.querySelector("summary");
    if (resumen) resumen.innerHTML = `<span class="tipo">${NOMBRES_TIPO[p.tipo]}</span> · ${esc(etiquetaPunto(p))}`;
  } else return;
  marcarCambios();
}

$("#editor-cuerpo").addEventListener("input", ev => aplicarCampo(ev.target));
$("#editor-cuerpo").addEventListener("change", ev => {
  if (ev.target.id === "nuevo-destino") ultimoDestino = ev.target.value;
  if (ev.target.dataset.pcampo === "destino") render();
});

$("#editor-cuerpo").addEventListener("click", async ev => {
  const e = actual();
  const ir = ev.target.closest("[data-ir]");
  if (ir) return irA(ir.dataset.ir);
  const tipo = ev.target.closest("[data-tipo]");
  if (tipo) { tipoNuevo = tipo.dataset.tipo; return render(); }

  const sub = ev.target.closest("[data-subir]");
  if (sub) {
    const url = await subirMedio(sub.dataset.subir);
    const input = sub.parentElement.querySelector("input");
    if (url) { input.value = url; aplicarCampo(input); render(); }
    return;
  }
  if (ev.target.closest("[data-quitar]")) {
    const input = ev.target.closest(".medio").querySelector("input");
    input.value = "";
    aplicarCampo(input);
    return render();
  }

  const b = ev.target.closest("[data-accion], [data-paccion]");
  if (!b) return;
  const accion = b.dataset.accion;
  if (accion === "vista") {
    const v = motor.vista;
    Object.assign(e, { yaw: +v.yaw.toFixed(1), pitch: +v.pitch.toFixed(1), hfov: Math.round(v.hfov) });
    marcarCambios();
    return aviso("La escena empezará mirando hacia aquí");
  }
  if (accion === "inicio") { estado.tour.inicio = e.id; marcarCambios(); render(); return aviso("Escena de inicio actualizada"); }
  if (accion === "subir-orden" || accion === "bajar-orden") {
    const lista = estado.tour.escenas, i = lista.indexOf(e), j = i + (accion === "subir-orden" ? -1 : 1);
    [lista[i], lista[j]] = [lista[j], lista[i]];
    marcarCambios(); renderListas(); return render();
  }
  if (accion === "quitar-escena") return quitarEscena(e);
  if (accion === "fotos") return subirFotos();
  if (accion === "nuevo") {
    if (tipoNuevo === "escena") {
      const destino = $("#nuevo-destino").value;
      if (!destino) return aviso("Primero elige la escena de destino");
      ultimoDestino = destino;
      return iniciarColocar({ tipo: "escena", destino, regreso: $("#nuevo-regreso").checked }, `Clic donde irá el enlace a «${escena(destino).titulo}»`);
    }
    return iniciarColocar({ tipo: tipoNuevo }, `Clic donde irá el ${NOMBRES_TIPO[tipoNuevo].toLowerCase()}`);
  }

  const p = puntoDe(b);
  if (!p) return;
  const pa = b.dataset.paccion;
  if (pa === "ver") {
    motor.mirarA(p.yaw, p.pitch);
    const el = document.querySelector(`.punto[data-id="${p.id}"]`);
    el?.classList.add("resaltado");
    setTimeout(() => el?.classList.remove("resaltado"), 1500);
  } else if (pa === "mover") iniciarColocar({ puntoId: p.id }, "Clic en la nueva posición");
  else if (pa === "ir") irA(p.destino);
  else if (pa === "borrar") {
    e.puntos = e.puntos.filter(x => x !== p);
    detenerAudiosPunto();
    refrescarPuntos(); marcarCambios(); render();
  }
});

function quitarEscena(e) {
  const lista = estado.tour.escenas;
  if (lista.length < 2) return aviso("El recorrido necesita al menos una escena");
  if (!confirm(`¿Quitar «${e.titulo}» del recorrido?\n\nLas teselas no se borran; solo deja de aparecer. Los enlaces hacia esta escena también se eliminan.`)) return;
  const i = lista.indexOf(e);
  lista.splice(i, 1);
  lista.forEach(x => x.puntos = x.puntos.filter(p => p.destino !== e.id));
  if (estado.tour.inicio === e.id) estado.tour.inicio = lista[0].id;
  marcarCambios();
  renderListas();
  irA(lista[Math.min(i, lista.length - 1)].id);
}
