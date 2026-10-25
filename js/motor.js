// Motor 360: panorama en cubo con teselas multirresolución, controles de PC/táctiles,
// giroscopio, Cardboard (pantalla dividida + mirada) y WebXR (Meta Quest, etc.).
import * as THREE from "three";
import { lienzoPunto, lienzoTarjeta, lienzoMenu, textura } from "./lienzo.js";

export const R_CUBO = 10, R_PUNTO = 6, R_BANNER = 7;
const { degToRad: rad, radToDeg: grados, clamp } = THREE.MathUtils;
const EJE_Y = new THREE.Vector3(0, 1, 0);
const TIEMPO_MIRADA = 1600; // ms mirando un punto para activarlo (Cardboard)
export const esMovil = matchMedia("(pointer: coarse)").matches || /Android|iPhone|iPad/i.test(navigator.userAgent);
/** Celulares con poca memoria o pocos núcleos: menos teselas en memoria y menor resolución en VR. */
export const equipoModesto = esMovil && ((navigator.deviceMemory || 4) <= 4 || (navigator.hardwareConcurrency || 4) <= 4);
// Teselas finas que se mantienen en memoria de video (cada una ~1 MB) y nivel máximo en VR/Cardboard
// En VR/Cardboard el máximo es 2K por cara (nivel 2): nítido con lentes y estable en celulares y Quest
const PERFIL = !esMovil ? { teselas: 420, teselasVR: 110, nivelVR: 2, dpr: 2, dprVR: 1 }
  : equipoModesto ? { teselas: 50, teselasVR: 44, nivelVR: 2, dpr: 1.25, dprVR: 1 }
  : { teselas: 90, teselasVR: 70, nivelVR: 2, dpr: 1.5, dprVR: 1.5 };
const ESPERA_TESELA = 8000;  // ms; si una foto no llega, se sigue sin ella en vez de quedar en negro
// Decodificar los JPG fuera del hilo principal (ImageBitmap) evita que la imagen se congele al cambiar
// de escena. Safari/iOS no soporta bien la opción de volteo, así que allí se usa el cargador normal.
const USAR_BITMAP = typeof createImageBitmap === "function" && !/iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
const SUBIDAS_POR_CUADRO = esMovil ? 2 : 6;  // texturas que se envían a la GPU en cada cuadro

/** yaw: grados a la derecha; pitch: grados hacia arriba. yaw 0 = centro de la foto original. */
export function vectorDesde(yaw, pitch, r = 1) {
  const y = rad(yaw), p = rad(pitch);
  return new THREE.Vector3(Math.cos(p) * Math.sin(y) * r, Math.sin(p) * r, -Math.cos(p) * Math.cos(y) * r);
}
export function anguloDe(v) {
  const n = v.clone().normalize();
  return { yaw: grados(Math.atan2(n.x, -n.z)), pitch: grados(Math.asin(clamp(n.y, -1, 1))) };
}
const normalizar = y => ((y % 360) + 540) % 360 - 180;

/** URL de una tesela; ?v= cambia si la foto se regenera, para que la copia sin conexión se actualice. */
export const urlTesela = (cubo, nivel, cara, ty, tx) => `${cubo.ruta}/${nivel}/${cara}${ty}_${tx}.jpg${cubo.v ? "?v=" + cubo.v : ""}`;

// Mismo convenio que optimizar.py → direccion()
const DIR = {
  f: (a, b) => [a, -b, -1], b: (a, b) => [-a, -b, 1],
  r: (a, b) => [1, -b, a], l: (a, b) => [-1, -b, -a],
  u: (a, b) => [a, 1, -b], d: (a, b) => [a, -1, b],
};

/* ------------------------------------------------------------------ teselas */
class Panorama {
  constructor(cubo, cargador, alCambiar) {
    this.grupo = new THREE.Group();
    this.niveles = cubo.niveles;
    this.cargador = cargador;
    this.alCambiar = alCambiar;
    this.teselas = [];
    this.porNivel = cubo.niveles.map(() => []);
    this.cola = [];
    this.activas = 0;
    this.porSubir = [];  // mallas listas que esperan turno para entrar a la GPU
    cubo.niveles.forEach((tam, nivel) => {
      const n = Math.max(1, Math.round(tam / cubo.tesela));
      for (const cara of "fbudlr") for (let ty = 0; ty < n; ty++) for (let tx = 0; tx < n; tx++) {
        const a0 = -1 + 2 * tx / n, a1 = -1 + 2 * (tx + 1) / n, b0 = -1 + 2 * ty / n, b1 = -1 + 2 * (ty + 1) / n;
        const centro = new THREE.Vector3(...DIR[cara]((a0 + a1) / 2, (b0 + b1) / 2)).normalize();
        const t = { nivel, cara, a0, a1, b0, b1, centro, estado: 0, mesh: null, uso: 0,
          radio: centro.angleTo(new THREE.Vector3(...DIR[cara](a0, b0))),
          url: urlTesela(cubo, nivel, cara, ty, tx) };
        this.teselas.push(t);
        this.porNivel[nivel].push(t);
      }
    });
  }

  geometria(t) {
    // Los niveles finos quedan un poco más cerca: la prueba de profundidad descarta los gruesos que
    // tapan, así cada píxel se pinta una sola vez (antes 3-4 veces, y en VR el doble)
    const r = R_CUBO * (1 - 0.004 * t.nivel);
    const v = [[t.a0, t.b0], [t.a1, t.b0], [t.a0, t.b1], [t.a1, t.b1]].flatMap(([a, b]) => DIR[t.cara](a, b).map(x => x * r));
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute([0, 1, 1, 1, 0, 0, 1, 0], 2));
    g.setIndex([0, 2, 1, 1, 2, 3]);
    return g;
  }

  cargar(t) {
    t.estado = 1;
    return new Promise(listo => {
      const limite = setTimeout(() => { if (t.estado === 1) { t.estado = 3; listo(); } }, ESPERA_TESELA);
      this.cargador.load(t.url, dato => {
      clearTimeout(limite);
      const tex = dato.isTexture ? dato : new THREE.Texture(dato);
      if (this.destruido || t.estado !== 1) { liberarTextura(tex); return listo(); }
      if (!dato.isTexture) { tex.flipY = false; tex.needsUpdate = true; }  // el bitmap ya viene volteado
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.minFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      const m = new THREE.Mesh(this.geometria(t), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
      m.renderOrder = 10 - t.nivel;  // de la más fina a la más gruesa: lo tapado ni se pinta
      this.porSubir.push(m);
      Object.assign(t, { mesh: m, estado: 2, uso: performance.now(), error: false });
      this.alCambiar();
      listo();
      }, undefined, () => { clearTimeout(limite); if (t.estado === 1) { t.estado = 3; t.error = true; } listo(); });
    });
  }

  /** Las 6 caras básicas; las que fallan se reintentan una vez. */
  async cargarBase() {
    await Promise.all(this.porNivel[0].map(t => this.cargar(t)));
    const fallidas = this.porNivel[0].filter(t => t.estado === 3 && t.error);  // por tiempo no se reintenta
    if (fallidas.length && !this.destruido) await Promise.all(fallidas.map(t => this.cargar(t)));
  }

  /** Pide las teselas visibles hasta nivelMax, de la más gruesa y central a la más fina. */
  actualizar(dir, semiFov, nivelMax, maxTeselas) {
    const ahora = performance.now(), pendientes = [];
    for (let nivel = 1; nivel < this.porNivel.length; nivel++) {
      for (const t of this.porNivel[nivel]) {
        if (t.mesh) t.mesh.visible = nivel <= nivelMax;  // evita parpadeo al alejar el zoom
        if (nivel > nivelMax) continue;
        const ang = t.centro.angleTo(dir);
        if (ang < semiFov + t.radio) {
          t.uso = ahora;
          if (t.estado === 0) pendientes.push([nivel, ang, t]);
        }
      }
    }
    pendientes.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    this.cola = this.detenido ? [] : pendientes.map(p => p[2]);
    this.bombear();
    const cargadas = this.teselas.filter(t => t.nivel > 0 && t.estado === 2);
    if (cargadas.length > maxTeselas) {
      cargadas.sort((a, b) => a.uso - b.uso).slice(0, cargadas.length - maxTeselas)
        .forEach(t => { if (ahora - t.uso > 2000) this.liberar(t); });
    }
    return this.cola.length + this.activas;
  }

  bombear() {
    if (this.detenido) return;
    while (this.activas < 6 && this.cola.length) {
      const t = this.cola.shift();
      if (t.estado !== 0) continue;
      this.activas++;
      this.cargar(t).then(() => { this.activas--; this.bombear(); });
    }
  }

  /** Agrega a la escena unas pocas mallas por cuadro para no trabar el dibujo. */
  integrar(max) {
    let n = 0;
    while (n < max && this.porSubir.length) { this.grupo.add(this.porSubir.shift()); n++; }
    return n;
  }

  liberar(t) {
    this.grupo.remove(t.mesh);
    this.porSubir = this.porSubir.filter(m => m !== t.mesh);
    t.mesh.geometry.dispose();
    liberarTextura(t.mesh.material.map);
    t.mesh.material.dispose();
    t.mesh = null;
    t.estado = 0;
  }

  /** Deja de pedir teselas (al salir de la escena) para no competir con la siguiente. */
  detener() {
    this.detenido = true;
    this.cola = [];
  }

  destruir() {
    this.detener();
    this.destruido = true;
    this.teselas.forEach(t => t.mesh && this.liberar(t));
  }
}

function liberarTextura(tex) {
  tex.dispose();
  tex.image?.close?.();  // ImageBitmap: libera la memoria de inmediato
}

function desechar(obj) {
  obj.traverse(o => {
    o.geometry?.dispose();
    if (o.material) { o.material.map?.dispose(); o.material.dispose(); }
  });
  obj.removeFromParent();
}

/* ------------------------------------------------------------------ motor */
export class Motor {
  constructor(contenedor) {
    this.contenedor = contenedor;
    this.al = {};  // callbacks: activar(punto), clic({yaw,pitch,punto}), vista(), modo(modo), menuVR(), interaccion()
    const r = this.renderer = new THREE.WebGLRenderer({ antialias: !esMovil, powerPreference: "high-performance" });
    r.setPixelRatio(Math.min(devicePixelRatio, PERFIL.dpr));
    // En celulares WebXR dibuja a la resolución nativa (muy alta); un poco menos basta con lentes
    if (esMovil) r.xr.setFramebufferScaleFactor?.(equipoModesto ? 0.7 : 0.85);
    r.xr.enabled = true;
    r.xr.setReferenceSpaceType("local");
    r.xr.setFoveation?.(0.3);
    contenedor.appendChild(r.domElement);
    r.domElement.style.touchAction = "none";

    this.escena3d = new THREE.Scene();
    this.escena3d.background = new THREE.Color(0x0d1117);
    this.camara = new THREE.PerspectiveCamera(75, 1, 0.05, 100);
    this.camara.rotation.order = "YXZ";
    this.escena3d.add(this.camara);
    this.mundo = new THREE.Group();
    this.capaPuntos = new THREE.Group();
    this.capaBanners = new THREE.Group();
    this.mundo.add(this.capaPuntos, this.capaBanners);
    this.escena3d.add(this.mundo);

    this.cargador = USAR_BITMAP
      ? new THREE.ImageBitmapLoader().setOptions({ imageOrientation: "flipY", premultiplyAlpha: "none" })
      : new THREE.TextureLoader();
    this.raycaster = new THREE.Raycaster();
    this.yaw = 0; this.pitch = 0; this.hfov = 100;
    this.modo = "normal";              // normal | giroscopio | cardboard | vr
    this.autorotar = true;
    this.velAutorotar = 3;             // grados por segundo
    this.ultimaInteraccion = 0;
    this.inercia = { yaw: 0, pitch: 0 };
    this.sucio = true;
    this.tokenPuntos = 0;
    this.nivelMaximo = Infinity;

    this.crearFundido();
    this.crearReticula();
    this.iniciarPunteros();
    this.iniciarControladores();
    new ResizeObserver(() => this.redimensionar()).observe(contenedor);
    this.redimensionar();
    addEventListener("orientationchange", () => { this.sucio = true; });
    // Si el celular se queda sin memoria de video, el navegador pierde el contexto WebGL (pantalla negra).
    // Se pide recuperarlo y se vuelve a cargar la escena.
    r.domElement.addEventListener("webglcontextlost", ev => { ev.preventDefault(); this.contextoPerdido = true; this.al.contexto?.(false); });
    r.domElement.addEventListener("webglcontextrestored", () => { this.contextoPerdido = false; this.al.contexto?.(true); });
    r.setAnimationLoop(t => {
      if (this.contextoPerdido) return;
      try { this.cuadro(t); }
      catch (e) { if (!this.errorMostrado) { this.errorMostrado = true; console.error("Error al dibujar:", e); } }
    });
  }

  /* ---------- escena ---------- */
  async cargarEscena(e, { vista } = {}) {
    const anterior = this.panorama;
    anterior?.detener();
    if (anterior) await this.fundir(1, 180);
    // Libera la escena anterior ANTES de cargar la nueva: en celulares modestos no caben las dos
    if (anterior) { anterior.destruir(); anterior.grupo.removeFromParent(); this.panorama = null; }
    this.cerrarMenuVR();
    const nuevo = new Panorama(e.cubo, this.cargador, () => { this.sucio = true; });
    await nuevo.cargarBase();
    nuevo.integrar(Infinity);
    this.panorama = nuevo;
    this.mundo.add(nuevo.grupo);
    this.cerrarPanel3D();
    const v = vista || { yaw: e.yaw || 0, pitch: e.pitch || 0, hfov: e.hfov || 100 };
    if (this.modo === "vr") {
      // El usuario sigue mirando hacia donde estaba; giramos el mundo para que vea la vista inicial.
      const cabeza = anguloDe(this.camara.getWorldDirection(new THREE.Vector3()));
      this.mundo.rotation.y = rad(v.yaw - cabeza.yaw);
    } else if (this.modo === "normal") {
      Object.assign(this, { yaw: v.yaw, pitch: v.pitch, hfov: v.hfov });
    } else {
      this.alinearOrientacion = v.yaw;
    }
    this.inercia = { yaw: 0, pitch: 0 };
    this.ultimoTeselado = 0;
    this.sucio = true;
    await this.fundir(0, 350);
  }

  fundir(hasta, ms) {
    this.animFundido?.listo();
    return new Promise(listo => {
      this.animFundido = { desde: this.fundido.material.opacity, hasta, t0: performance.now(), ms, listo };
      // por si el ciclo de dibujo está en pausa (pestaña oculta), no quedar esperando
      setTimeout(() => { if (this.animFundido?.listo === listo) { this.fundido.material.opacity = hasta; this.fundido.visible = hasta > 0; this.animFundido = null; listo(); } }, ms + 1500);
    });
  }

  crearFundido() {
    this.fundido = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide, transparent: true, opacity: 1, depthTest: false }));
    this.fundido.renderOrder = 1000;
    this.camara.add(this.fundido);
  }

  crearReticula() {
    const g = new THREE.Group();
    const mat = c => new THREE.MeshBasicMaterial({ color: c, depthTest: false, transparent: true });
    const base = new THREE.Mesh(new THREE.RingGeometry(0.012, 0.018, 32), mat(0xffffff));
    this.progreso = new THREE.Mesh(new THREE.RingGeometry(0.02, 0.028, 32, 1, 0, 0.001), mat(0xffc94d));
    [base, this.progreso].forEach(m => { m.renderOrder = 1001; g.add(m); });
    g.position.z = -1;
    g.visible = false;
    this.reticula = g;
    this.camara.add(g);
  }

  /* ---------- puntos y banners ---------- */
  async setPuntos(puntos, etiqueta) {
    const token = ++this.tokenPuntos;
    const banners = await Promise.all(puntos.filter(p => p.tipo === "banner").map(async p => [p, await lienzoTarjeta({
      titulo: p.texto, texto: p.descripcion, imagen: p.imagen, estilo: p.estilo,
      pie: p.enlace ? "Selecciona para abrir el enlace" : "" })]));
    if (token !== this.tokenPuntos) return;
    [...this.capaPuntos.children, ...this.capaBanners.children].forEach(desechar);

    for (const [p, canvas] of banners) {
      const ancho = +p.ancho || 3;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(ancho, ancho * canvas.height / canvas.width),
        new THREE.MeshBasicMaterial({ map: textura(canvas), transparent: true, depthTest: false, side: THREE.DoubleSide }));
      m.position.copy(vectorDesde(p.yaw, p.pitch, R_BANNER));
      m.lookAt(0, 0, 0);
      m.renderOrder = 40;
      m.userData.punto = p;
      this.capaBanners.add(m);
    }
    for (const p of puntos.filter(p => p.tipo !== "banner")) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: textura(lienzoPunto(p.tipo, etiqueta(p))), depthTest: false }));
      s.scale.set(1.4, 1.4 * 300 / 512, 1);
      s.center.set(0.5, 1 - 104 / 300);  // el centro del círculo queda sobre la posición del punto
      s.position.copy(vectorDesde(p.yaw, p.pitch, R_PUNTO));
      s.renderOrder = 50;
      s.userData.punto = p;
      this.capaPuntos.add(s);
    }
    this.sucio = true;
  }

  /** Cambia el icono de un punto 3D (p. ej. audio sonando/pausado). */
  marcarPunto(id, sonando, etiqueta) {
    const s = this.capaPuntos.children.find(o => o.userData.punto.id === id);
    if (!s) return;
    s.material.map.dispose();
    s.material.map = textura(lienzoPunto(s.userData.punto.tipo, etiqueta, sonando));
    this.sucio = true;
  }

  /* ---------- paneles 3D (VR/Cardboard) ---------- */
  async mostrarPanel3D(datos, alCerrar) {
    const canvas = await lienzoTarjeta({ ...datos, pie: "Selecciona para cerrar" });
    this.cerrarPanel3D();
    this.panel3D = this.crearPanelFrente(canvas, 1.7, 2.4);
    this.panel3D.userData.alActivar = () => this.cerrarPanel3D();
    this.panel3D.userData.alCerrar = alCerrar;
  }

  cerrarPanel3D() {
    if (!this.panel3D) return;
    this.panel3D.userData.alCerrar?.();
    desechar(this.panel3D);
    this.panel3D = null;
    this.sucio = true;
  }

  async mostrarMenuVR(escenas, actualId, elegir, pagina = 0) {
    const porPagina = 12;
    if (pagina === 0 && actualId) pagina = Math.floor(Math.max(0, escenas.findIndex(e => e.id === actualId)) / porPagina);
    const { canvas, zonas } = await lienzoMenu(escenas, actualId, pagina, porPagina);
    const posicion = this.menuVR?.position.clone();
    this.cerrarMenuVR();
    this.menuVR = this.crearPanelFrente(canvas, 3, 2.6, posicion);
    this.menuVR.userData.alActivar = uv => {
      const x = uv.x, y = 1 - uv.y;
      const z = zonas.find(z => x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1);
      if (!z) return;
      if (z.accion === "ir") { this.cerrarMenuVR(); elegir(z.id); }
      else if (z.accion === "cerrar") this.cerrarMenuVR();
      else this.mostrarMenuVR(escenas, actualId, elegir, pagina + (z.accion === "siguiente" ? 1 : -1));
    };
  }

  cerrarMenuVR() {
    if (!this.menuVR) return;
    desechar(this.menuVR);
    this.menuVR = null;
    this.sucio = true;
  }

  crearPanelFrente(canvas, ancho, distancia, posicion) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(ancho, ancho * canvas.height / canvas.width),
      new THREE.MeshBasicMaterial({ map: textura(canvas), transparent: true, depthTest: false, side: THREE.DoubleSide }));
    const ojo = this.camara.getWorldPosition(new THREE.Vector3());
    if (posicion) m.position.copy(posicion);
    else {
      const dir = this.camara.getWorldDirection(new THREE.Vector3());
      dir.y = clamp(dir.y, -0.15, 0.25);  // a la altura de los ojos aunque se esté mirando al piso
      m.position.copy(ojo).addScaledVector(dir.normalize(), distancia);
    }
    m.lookAt(ojo);
    m.renderOrder = 900;
    this.escena3d.add(m);
    this.sucio = true;
    return m;
  }

  /* ---------- vista ---------- */
  get vista() { return { yaw: normalizar(this.yaw), pitch: this.pitch, hfov: this.hfov }; }

  mirarA(yaw, pitch, ms = 600) {
    if (this.modo !== "normal") return;
    const d = normalizar(yaw - this.yaw);
    this.animVista = { y0: this.yaw, p0: this.pitch, dy: d, dp: pitch - this.pitch, t0: performance.now(), ms };
  }

  zoom(factor) {
    this.hfov = clamp(this.hfov * factor, 30, 120);
    this.interaccion();
  }

  interaccion() {
    this.ultimaInteraccion = performance.now();
    this.animVista = null;
    this.sucio = true;
    this.al.interaccion?.();
  }

  /** Proyecta (yaw, pitch) a píxeles de pantalla para dibujar los puntos HTML en modo normal. */
  proyectar(yaw, pitch) {
    const v = this.mundo.localToWorld(vectorDesde(yaw, pitch, R_PUNTO)).project(this.camara);
    const { clientWidth: w, clientHeight: h } = this.renderer.domElement;
    return { x: (v.x + 1) / 2 * w, y: (1 - v.y) / 2 * h, visible: v.z < 1 && Math.abs(v.x) < 1.3 && Math.abs(v.y) < 1.3 };
  }

  /** Dirección (yaw, pitch) y objeto 3D bajo un punto de la pantalla. */
  enPantalla(x, y) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.raycaster.setFromCamera({ x: (x - rect.left) / rect.width * 2 - 1, y: -(y - rect.top) / rect.height * 2 + 1 }, this.camara);
    const local = this.raycaster.ray.direction.clone().applyQuaternion(this.mundo.quaternion.clone().invert());
    const hit = this.raycaster.intersectObjects(this.interactivos(), false)[0];
    return { ...anguloDe(local), objeto: hit?.object, uv: hit?.uv };
  }

  interactivos() {
    const lista = [...this.capaBanners.children];
    if (this.capaPuntos.visible) lista.push(...this.capaPuntos.children);
    if (this.panel3D) lista.push(this.panel3D);
    if (this.menuVR) lista.push(this.menuVR);
    return lista;
  }

  activar(obj, uv) {
    if (!obj) return;
    if (obj.userData.alActivar) obj.userData.alActivar(uv);
    else if (obj.userData.punto) this.al.activar?.(obj.userData.punto);
  }

  /* ---------- controles PC / táctil ---------- */
  iniciarPunteros() {
    const el = this.renderer.domElement;
    const punteros = new Map();
    let inicio = null, pellizco = null, ultimo = null;
    el.addEventListener("pointerdown", ev => {
      el.setPointerCapture(ev.pointerId);
      punteros.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      inicio = { x: ev.clientX, y: ev.clientY, t: performance.now(), yaw: this.yaw, pitch: this.pitch, desfase: this.desfaseGiro || 0 };
      ultimo = { x: ev.clientX, y: ev.clientY, t: performance.now() };
      this.inercia = { yaw: 0, pitch: 0 };
      if (punteros.size === 2) {
        const [a, b] = [...punteros.values()];
        pellizco = { d: Math.hypot(a.x - b.x, a.y - b.y), hfov: this.hfov };
      }
      this.interaccion();
    });
    el.addEventListener("pointermove", ev => {
      if (!punteros.has(ev.pointerId)) return;
      punteros.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (pellizco && punteros.size === 2) {
        const [a, b] = [...punteros.values()];
        this.hfov = clamp(pellizco.hfov * pellizco.d / Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), 30, 120);
      } else if (inicio && punteros.size === 1) {
        const k = this.hfov / el.clientWidth;
        const dx = ev.clientX - inicio.x, dy = ev.clientY - inicio.y;
        if (this.modo === "giroscopio") this.desfaseGiro = inicio.desfase - dx * k;
        else if (this.modo === "normal") {
          this.yaw = inicio.yaw - dx * k;
          this.pitch = clamp(inicio.pitch + dy * k, -90, 90);
          const t = performance.now(), dt = Math.max(1, t - ultimo.t);
          this.inercia = { yaw: -(ev.clientX - ultimo.x) * k / dt * 1000, pitch: (ev.clientY - ultimo.y) * k / dt * 1000 };
          ultimo = { x: ev.clientX, y: ev.clientY, t };
        }
      }
      this.interaccion();
    });
    const soltar = ev => {
      if (!punteros.has(ev.pointerId)) return;
      punteros.delete(ev.pointerId);
      if (punteros.size < 2) pellizco = null;
      if (performance.now() - (ultimo?.t || 0) > 80) this.inercia = { yaw: 0, pitch: 0 };
      const esClic = inicio && Math.hypot(ev.clientX - inicio.x, ev.clientY - inicio.y) < 7 && performance.now() - inicio.t < 600;
      if (esClic && ev.type === "pointerup") {
        if (this.modo === "cardboard") this.activar(this.objetivoMirada);   // botón del visor Cardboard
        else {
          const r = this.enPantalla(ev.clientX, ev.clientY);
          this.al.clic?.({ yaw: r.yaw, pitch: r.pitch, punto: r.objeto?.userData.punto, objeto: r.objeto, uv: r.uv });
        }
      }
      if (!punteros.size) inicio = null;
    };
    el.addEventListener("pointerup", soltar);
    el.addEventListener("pointercancel", soltar);
    el.addEventListener("wheel", ev => { ev.preventDefault(); this.zoom(Math.exp(ev.deltaY * 0.0012)); }, { passive: false });
  }

  teclado(ev) {
    const paso = ev.shiftKey ? 15 : 5;
    const acciones = {
      ArrowLeft: () => (this.yaw -= paso), ArrowRight: () => (this.yaw += paso),
      ArrowUp: () => (this.pitch = clamp(this.pitch + paso, -90, 90)), ArrowDown: () => (this.pitch = clamp(this.pitch - paso, -90, 90)),
      "+": () => this.zoom(0.85), "=": () => this.zoom(0.85), "-": () => this.zoom(1.18),
    };
    if (!acciones[ev.key] || this.modo !== "normal") return false;
    acciones[ev.key]();
    this.interaccion();
    return true;
  }

  /* ---------- giroscopio y Cardboard ---------- */
  async pedirOrientacion() {
    if (typeof DeviceOrientationEvent?.requestPermission === "function") {
      if (await DeviceOrientationEvent.requestPermission() !== "granted") throw new Error("Permiso de movimiento denegado");
    }
    if (!this.escuchaOrientacion) {
      this.escuchaOrientacion = ev => { if (ev.alpha != null) this.orientacion = ev; };
      addEventListener("deviceorientation", this.escuchaOrientacion);
    }
    this.alinearOrientacion = this.yaw;
    this.desfaseGiro = 0;
  }

  async activarGiroscopio(activo) {
    if (activo) { await this.pedirOrientacion(); this.cambiarModo("giroscopio"); }
    else this.salirModoOrientacion();
  }

  async entrarCardboard() {
    await this.pedirOrientacion();
    const raiz = document.documentElement;
    try { await (raiz.requestFullscreen || raiz.webkitRequestFullscreen)?.call(raiz); } catch {}
    try { await screen.orientation?.lock?.("landscape"); } catch {}
    this.cambiarModo("cardboard");
    this.redimensionar();
  }

  salirModoOrientacion() {
    const v = this.vista;
    this.cambiarModo("normal");
    Object.assign(this, { yaw: v.yaw, pitch: v.pitch });
    try { screen.orientation?.unlock?.(); } catch {}
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    this.redimensionar();
  }

  aplicarOrientacion() {
    const o = this.orientacion;
    if (!o) return false;
    const giroPantalla = rad(screen.orientation?.angle ?? window.orientation ?? 0);
    const q = (this._q ||= new THREE.Quaternion());
    q.setFromEuler(new THREE.Euler(rad(o.beta), rad(o.alpha), -rad(o.gamma), "YXZ"));
    q.multiply(new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2));   // la cámara mira por detrás del teléfono
    q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -giroPantalla));
    if (this.alinearOrientacion != null) {
      const rumbo = anguloDe(new THREE.Vector3(0, 0, -1).applyQuaternion(q)).yaw;
      this.ajusteRumbo = this.alinearOrientacion - rumbo;
      this.desfaseGiro = 0;
      this.alinearOrientacion = null;
    }
    const ajuste = new THREE.Quaternion().setFromAxisAngle(EJE_Y, -rad((this.ajusteRumbo || 0) + (this.desfaseGiro || 0)));
    this.camara.quaternion.copy(ajuste).multiply(q);
    return true;
  }

  /* ---------- WebXR (Meta Quest y otros visores) ---------- */
  async soportaVR() {
    try { return !!(await navigator.xr?.isSessionSupported("immersive-vr")); } catch { return false; }
  }

  async entrarVR() {
    const sesion = await navigator.xr.requestSession("immersive-vr", { optionalFeatures: ["local-floor", "hand-tracking"] });
    const v = this.vista;
    this.mundo.rotation.y = rad(v.yaw);  // lo que se estaba mirando queda al frente
    await this.renderer.xr.setSession(sesion);
    this.cambiarModo("vr");
    sesion.addEventListener("end", () => {
      const dir = this.camara.getWorldDirection(new THREE.Vector3()).applyQuaternion(this.mundo.quaternion.clone().invert());
      this.mundo.rotation.y = 0;
      this.cerrarMenuVR();
      this.cerrarPanel3D();
      this.cambiarModo("normal");
      Object.assign(this, anguloDe(dir));
      this.redimensionar();
    });
  }

  salirVR() { this.renderer.xr.getSession()?.end(); }

  iniciarControladores() {
    this.controladores = [0, 1].map(i => {
      const c = this.renderer.xr.getController(i);
      const linea = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),
        new THREE.LineBasicMaterial({ color: 0xffc94d }));
      linea.scale.z = 8;
      linea.visible = false;
      c.add(linea);
      c.userData.linea = linea;
      c.addEventListener("connected", ev => {
        c.userData.modo = ev.data.targetRayMode;
        c.userData.fuente = ev.data;
        linea.visible = ev.data.targetRayMode === "tracked-pointer";
      });
      c.addEventListener("disconnected", () => { c.userData.modo = null; linea.visible = false; });
      c.addEventListener("selectstart", () => {
        const hit = c.userData.modo === "tracked-pointer" ? this.rayoControlador(c) : null;
        if (hit) this.activar(hit.object, hit.uv);
        else if (c.userData.modo !== "tracked-pointer") this.activar(this.objetivoMirada);
      });
      c.addEventListener("squeezestart", () => this.al.menuVR?.());
      this.escena3d.add(c);
      return c;
    });
  }

  rayoControlador(c) {
    const m = new THREE.Matrix4().extractRotation(c.matrixWorld);
    this.raycaster.ray.origin.setFromMatrixPosition(c.matrixWorld);
    this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(m);
    this.raycaster.camera = this.camara;
    return this.raycaster.intersectObjects(this.interactivos(), false)[0];
  }

  actualizarControladores() {
    let hayPuntero = false;
    for (const c of this.controladores) {
      if (c.userData.modo !== "tracked-pointer") continue;
      hayPuntero = true;
      const hit = this.rayoControlador(c);
      c.userData.linea.scale.z = hit ? hit.distance : 8;
      if (hit) this.resaltados.add(hit.object);
    }
    // Giro por pasos con el joystick (30°)
    const sesion = this.renderer.xr.getSession();
    let eje = 0;
    for (const f of sesion?.inputSources || []) {
      const a = f.gamepad?.axes;
      if (a && Math.abs(a[2] || 0) > Math.abs(eje)) eje = a[2];
    }
    if (Math.abs(eje) > 0.7 && !this.giroBloqueado) { this.mundo.rotation.y += rad(eje > 0 ? -30 : 30); this.giroBloqueado = true; }
    if (Math.abs(eje) < 0.3) this.giroBloqueado = false;
    return hayPuntero;
  }

  /** Activar mirando fijamente (Cardboard o visores sin control). */
  actualizarMirada(ahora) {
    this.raycaster.setFromCamera({ x: 0, y: 0 }, this.camara);
    if (this.modo === "vr") {
      this.camara.getWorldPosition(this.raycaster.ray.origin);
      this.camara.getWorldDirection(this.raycaster.ray.direction);
    }
    const obj = this.raycaster.intersectObjects(this.interactivos(), false)[0]?.object || null;
    if (obj !== this.objetivoMirada) { this.objetivoMirada = obj; this.inicioMirada = ahora; }
    let p = 0;
    // Los banners sin enlace no se activan con la mirada (solo se leen)
    const activable = obj && (obj.userData.alActivar || obj.userData.punto?.tipo !== "banner" || obj.userData.punto?.enlace);
    if (activable) {
      this.resaltados.add(obj);
      p = Math.min(1, (ahora - this.inicioMirada) / TIEMPO_MIRADA);
      if (p >= 1) { this.inicioMirada = Infinity; this.activar(obj); p = 0; }
    }
    if (Math.abs(p - (this.progresoAnterior || 0)) > 0.02 || (p === 0 && this.progresoAnterior)) {
      this.progreso.geometry.dispose();
      this.progreso.geometry = new THREE.RingGeometry(0.02, 0.028, 32, 1, Math.PI / 2, -Math.max(0.001, p * Math.PI * 2));
      this.progresoAnterior = p;
    }
  }

  /* ---------- modos ---------- */
  cambiarModo(modo) {
    this.modo = modo;
    // En Cardboard se dibuja dos veces: menos píxeles para que el celular no se sature
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, modo === "cardboard" ? PERFIL.dprVR : PERFIL.dpr));
    const inmersivo = modo === "cardboard" || modo === "vr";
    this.capaPuntos.visible = inmersivo;
    this.reticula.visible = modo === "cardboard";
    this.sucio = true;
    this.al.modo?.(modo);
  }

  redimensionar() {
    const w = this.contenedor.clientWidth, h = this.contenedor.clientHeight;
    if (!this.renderer.xr.isPresenting) this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.sucio = true;
  }

  /* ---------- bucle ---------- */
  cuadro(t) {
    const dt = Math.min(0.1, (t - (this.tAnterior ?? t)) / 1000);
    this.tAnterior = t;
    const ahora = performance.now();
    const r = this.renderer, xr = r.xr.isPresenting;
    const tam = r.getDrawingBufferSize(this._tam ||= new THREE.Vector2());
    let animando = false;

    if (!xr) {
      if (this.modo === "normal") {
        if (this.animVista) {
          const a = this.animVista, k = Math.min(1, (ahora - a.t0) / a.ms), e = 1 - Math.pow(1 - k, 3);
          this.yaw = a.y0 + a.dy * e; this.pitch = a.p0 + a.dp * e;
          if (k >= 1) this.animVista = null;
          animando = true;
        } else if (Math.abs(this.inercia.yaw) + Math.abs(this.inercia.pitch) > 0.5) {
          this.yaw += this.inercia.yaw * dt;
          this.pitch = clamp(this.pitch + this.inercia.pitch * dt, -90, 90);
          const f = Math.pow(0.04, dt);
          this.inercia.yaw *= f; this.inercia.pitch *= f;
          animando = true;
        } else if (this.autorotar && ahora - this.ultimaInteraccion > 5000) {
          this.yaw += this.velAutorotar * dt;
          animando = true;
        }
        const aspecto = tam.x / Math.max(1, tam.y);
        const vfov = Math.min(120, grados(2 * Math.atan(Math.tan(rad(this.hfov) / 2) / aspecto)));
        this.camara.fov = vfov;
        this.camara.aspect = aspecto;
        this.camara.rotation.set(rad(this.pitch), -rad(this.yaw), 0);
      } else if (this.aplicarOrientacion()) {
        animando = true;
        const v = anguloDe(this.camara.getWorldDirection(new THREE.Vector3()));
        this.yaw = v.yaw; this.pitch = v.pitch;
        this.camara.fov = this.modo === "cardboard" ? 90 : grados(2 * Math.atan(Math.tan(rad(this.hfov) / 2) / (tam.x / tam.y)));
        this.camara.aspect = this.modo === "cardboard" ? (tam.x / 2) / tam.y : tam.x / tam.y;
      }
      this.camara.updateProjectionMatrix();
    }
    this.camara.updateMatrixWorld();

    if (this.animFundido) {
      const a = this.animFundido, k = Math.min(1, (ahora - a.t0) / a.ms);
      this.fundido.material.opacity = a.desde + (a.hasta - a.desde) * k;
      this.fundido.visible = this.fundido.material.opacity > 0.001;
      if (k >= 1) { this.animFundido = null; a.listo(); }
      animando = true;
    }

    if (this.panorama?.porSubir.length && this.panorama.integrar(SUBIDAS_POR_CUADRO)) this.sucio = true;

    // Teselas: nivel según cuántos píxeles por radián muestra la pantalla
    if (this.panorama && ahora - (this.ultimoTeselado || 0) > 120) {
      this.ultimoTeselado = ahora;
      const dir = this.camara.getWorldDirection(new THREE.Vector3()).applyQuaternion(this.mundo.quaternion.clone().invert());
      let pxRad, semiFov;
      if (xr) { pxRad = 900; semiFov = rad(70); }
      else {
        const vfov = rad(this.camara.fov), alto = tam.y;
        pxRad = (alto / 2) / Math.tan(vfov / 2);
        const tv = Math.tan(vfov / 2), th = tv * this.camara.aspect;
        semiFov = Math.atan(Math.hypot(tv, th)) + 0.15;
      }
      const tamanos = this.panorama.niveles;
      let nivel = tamanos.findIndex(n => n / 2 >= pxRad * 0.85);
      if (nivel < 0) nivel = tamanos.length - 1;
      const inmersivo = xr || this.modo === "cardboard";
      // Con lentes la imagen se amplía: en VR/Cardboard al menos el nivel 1, aunque cada ojo tenga pocos píxeles
      if (inmersivo) nivel = Math.max(nivel, 1);
      nivel = Math.min(nivel, this.nivelMaximo, inmersivo ? PERFIL.nivelVR : Infinity);
      const pendientes = this.panorama.actualizar(dir, semiFov, nivel, inmersivo ? PERFIL.teselasVR : PERFIL.teselas);
      if (pendientes) this.sucio = true;
    }

    this.resaltados = new Set();
    if (xr) {
      const hayPuntero = this.actualizarControladores();
      this.reticula.visible = !hayPuntero;
      if (!hayPuntero) this.actualizarMirada(ahora);
    } else if (this.modo === "cardboard") this.actualizarMirada(ahora);
    for (const o of this.interactivos()) {
      const base = o.userData.escalaBase ||= o.scale.clone();
      const objetivo = this.resaltados.has(o) ? 1.15 : 1;
      if (Math.abs(o.scale.x / base.x - objetivo) > 0.005) { o.scale.copy(base).multiplyScalar(objetivo); animando = true; }
    }

    if (!xr && this.modo === "normal" && !this.sucio && !animando) return;  // ahorra batería si nada cambia
    this.sucio = false;

    if (!xr && this.modo === "cardboard") {
      const w = r.domElement.clientWidth, h = r.domElement.clientHeight;
      r.setScissorTest(true);
      for (const ojo of [0, 1]) {
        r.setViewport(ojo * w / 2, 0, w / 2, h);
        r.setScissor(ojo * w / 2, 0, w / 2, h);
        r.render(this.escena3d, this.camara);
      }
      r.setScissorTest(false);
      r.setViewport(0, 0, w, h);
    } else {
      r.render(this.escena3d, this.camara);
    }
    if (!xr) this.al.vista?.();
  }
}
