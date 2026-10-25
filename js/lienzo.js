// Dibujo en canvas de todo lo que se muestra DENTRO del panorama 3D:
// iconos de puntos (VR/Cardboard), banners, paneles de información y menú VR.
import * as THREE from "three";

export const FUENTE = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
export const ESTILOS = {
  oscuro: { fondo: "rgba(13,17,23,.9)", texto: "#e5e7eb", titulo: "#ffc94d", borde: "rgba(255,255,255,.22)" },
  claro: { fondo: "rgba(255,255,255,.95)", texto: "#1f2937", titulo: "#0d1117", borde: "rgba(0,0,0,.14)" },
  acento: { fondo: "rgba(255,201,77,.96)", texto: "#2a1d00", titulo: "#1a1200", borde: "rgba(0,0,0,.12)" },
};
export const ICONOS = {
  escena: "M12 19V5M5 12l7-7 7 7",
  info: "M12 11v6M12 7h.01",
  audio: "M11 5 6 9H2v6h4l5 4V5ZM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14",
  pausa: "M9 6v12M15 6v12",
  banner: "M4 5h16v11H4zM8 20h8M12 16v4",
  menu: "M4 6h16M4 12h16M4 18h16",
};

const cacheImagenes = new Map();
export function cargarImagen(url) {
  if (!url) return Promise.resolve(null);
  if (!cacheImagenes.has(url)) cacheImagenes.set(url, new Promise(res => {
    const i = new Image();
    i.crossOrigin = "anonymous";
    i.onload = () => res(i);
    i.onerror = () => res(null);
    i.src = url;
  }));
  return cacheImagenes.get(url);
}

export function textura(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function lineas(ctx, texto, ancho) {
  const salida = [];
  for (const parrafo of String(texto || "").split("\n")) {
    let linea = "";
    for (const palabra of parrafo.split(/\s+/)) {
      const prueba = linea ? linea + " " + palabra : palabra;
      if (ctx.measureText(prueba).width > ancho && linea) { salida.push(linea); linea = palabra; }
      else linea = prueba;
    }
    salida.push(linea);
  }
  return salida;
}

function rectRedondo(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function dibujarIcono(ctx, tipo, cx, cy, tam, color) {
  ctx.save();
  ctx.translate(cx - tam / 2, cy - tam / 2);
  ctx.scale(tam / 24, tam / 24);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.4;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke(new Path2D(ICONOS[tipo] || ICONOS.info));
  ctx.restore();
}

/** Icono redondo con etiqueta, para los puntos en modo VR/Cardboard. */
export function lienzoPunto(tipo, etiqueta, sonando = false) {
  const c = document.createElement("canvas");
  c.width = 512; c.height = 300;
  const ctx = c.getContext("2d");
  const claro = tipo === "info" || tipo === "audio";
  ctx.beginPath();
  ctx.arc(256, 104, 88, 0, Math.PI * 2);
  ctx.fillStyle = claro ? "rgba(255,201,77,.95)" : "rgba(13,17,23,.6)";
  ctx.fill();
  ctx.lineWidth = 9;
  ctx.strokeStyle = "#fff";
  ctx.stroke();
  dibujarIcono(ctx, sonando ? "pausa" : tipo, 256, 104, 96, claro ? "#1a1200" : "#fff");
  if (etiqueta) {
    ctx.font = `600 34px ${FUENTE}`;
    let texto = etiqueta;
    while (ctx.measureText(texto).width > 460 && texto.length > 4) texto = texto.slice(0, -2);
    if (texto !== etiqueta) texto = texto.trimEnd() + "…";
    const w = ctx.measureText(texto).width + 36;
    rectRedondo(ctx, 256 - w / 2, 214, w, 58, 14);
    ctx.fillStyle = "rgba(13,17,23,.85)";
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(texto, 256, 244);
  }
  return c;
}

/** Tarjeta con imagen, título y texto: banners y paneles de información. */
export async function lienzoTarjeta({ titulo, texto, imagen, estilo = "oscuro", pie, ancho = 1024, maxLineas = 16 }) {
  const e = ESTILOS[estilo] || ESTILOS.oscuro;
  const img = await cargarImagen(imagen);
  const P = 52, interior = ancho - 2 * P;
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d");
  ctx.font = `700 54px ${FUENTE}`;
  const lt = titulo ? lineas(ctx, titulo, interior).slice(0, 3) : [];
  ctx.font = `400 38px ${FUENTE}`;
  let lx = texto ? lineas(ctx, texto, interior) : [];
  if (lx.length > maxLineas) { lx = lx.slice(0, maxLineas); lx[maxLineas - 1] += " …"; }
  const altoImg = img ? Math.min(interior * img.height / img.width, 720) : 0;
  const alto = P + (img ? altoImg + (lt.length || lx.length ? 34 : 0) : 0) + lt.length * 64
    + (lt.length && lx.length ? 14 : 0) + lx.length * 52 + (pie ? 66 : 0) + P;
  c.width = ancho;
  c.height = Math.max(150, Math.ceil(alto));

  rectRedondo(ctx, 3, 3, c.width - 6, c.height - 6, 34);
  ctx.fillStyle = e.fondo; ctx.fill();
  ctx.lineWidth = 4; ctx.strokeStyle = e.borde; ctx.stroke();
  let y = P;
  if (img) {
    const w = Math.min(interior, altoImg * img.width / img.height);
    ctx.save();
    rectRedondo(ctx, (c.width - w) / 2, y, w, altoImg, 18);
    ctx.clip();
    ctx.drawImage(img, (c.width - w) / 2, y, w, altoImg);
    ctx.restore();
    y += altoImg + (lt.length || lx.length ? 34 : 0);
  }
  ctx.textBaseline = "top";
  ctx.font = `700 54px ${FUENTE}`; ctx.fillStyle = e.titulo;
  lt.forEach(l => { ctx.fillText(l, P, y); y += 64; });
  if (lt.length && lx.length) y += 14;
  ctx.font = `400 38px ${FUENTE}`; ctx.fillStyle = e.texto;
  lx.forEach(l => { ctx.fillText(l, P, y); y += 52; });
  if (pie) {
    ctx.font = `500 30px ${FUENTE}`; ctx.globalAlpha = .7;
    ctx.fillText(pie, P, y + 22);
    ctx.globalAlpha = 1;
  }
  return c;
}

/** Menú de escenas para VR: una sola textura con cuadrícula y zonas clicables (en coordenadas 0..1). */
export async function lienzoMenu(escenas, actualId, pagina, porPagina = 12) {
  const W = 2048, H = 1320, COLS = 4, FILAS = 3;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  const zonas = [];
  rectRedondo(ctx, 4, 4, W - 8, H - 8, 40);
  ctx.fillStyle = "rgba(13,17,23,.94)"; ctx.fill();
  ctx.lineWidth = 5; ctx.strokeStyle = "rgba(255,255,255,.2)"; ctx.stroke();
  const paginas = Math.max(1, Math.ceil(escenas.length / porPagina));
  ctx.textBaseline = "middle";
  ctx.font = `700 64px ${FUENTE}`; ctx.fillStyle = "#ffc94d";
  ctx.fillText("Escenas", 70, 90);
  ctx.font = `400 40px ${FUENTE}`; ctx.fillStyle = "#9ca3af";
  ctx.fillText(`Página ${pagina + 1} de ${paginas}`, 380, 94);

  const items = escenas.slice(pagina * porPagina, (pagina + 1) * porPagina);
  const cw = (W - 140 - (COLS - 1) * 30) / COLS, ch = 300;
  const imagenes = await Promise.all(items.map(e => cargarImagen(e.miniatura)));
  items.forEach((e, i) => {
    const x = 70 + (i % COLS) * (cw + 30), y = 170 + Math.floor(i / COLS) * (ch + 34);
    ctx.save();
    rectRedondo(ctx, x, y, cw, ch, 22); ctx.clip();
    ctx.fillStyle = "#111"; ctx.fillRect(x, y, cw, ch);
    const img = imagenes[i];
    if (img) { const s = Math.max(cw / img.width, ch / img.height); ctx.drawImage(img, x + (cw - img.width * s) / 2, y + (ch - img.height * s) / 2, img.width * s, img.height * s); }
    const g = ctx.createLinearGradient(0, y + ch - 110, 0, y + ch);
    g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,.9)");
    ctx.fillStyle = g; ctx.fillRect(x, y + ch - 110, cw, 110);
    ctx.font = `600 36px ${FUENTE}`; ctx.fillStyle = "#fff";
    let t = e.titulo; while (ctx.measureText(t).width > cw - 36 && t.length > 4) t = t.slice(0, -2);
    ctx.fillText(t === e.titulo ? t : t + "…", x + 18, y + ch - 36);
    ctx.restore();
    if (e.id === actualId) { rectRedondo(ctx, x, y, cw, ch, 22); ctx.lineWidth = 8; ctx.strokeStyle = "#ffc94d"; ctx.stroke(); }
    zonas.push({ x0: x / W, y0: y / H, x1: (x + cw) / W, y1: (y + ch) / H, accion: "ir", id: e.id });
  });

  const boton = (texto, x, w, accion, activo = true) => {
    rectRedondo(ctx, x, H - 150, w, 100, 50);
    ctx.fillStyle = activo ? "rgba(255,255,255,.12)" : "rgba(255,255,255,.04)"; ctx.fill();
    ctx.font = `600 42px ${FUENTE}`; ctx.fillStyle = activo ? "#fff" : "#555"; ctx.textAlign = "center";
    ctx.fillText(texto, x + w / 2, H - 100); ctx.textAlign = "left";
    if (activo) zonas.push({ x0: x / W, y0: (H - 150) / H, x1: (x + w) / W, y1: (H - 50) / H, accion });
  };
  boton("‹ Anterior", 70, 380, "anterior", pagina > 0);
  boton("Cerrar", W / 2 - 190, 380, "cerrar");
  boton("Siguiente ›", W - 450, 380, "siguiente", pagina < paginas - 1);
  return { canvas: c, zonas, paginas };
}
