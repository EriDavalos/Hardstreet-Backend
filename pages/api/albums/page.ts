import type { NextApiRequest, NextApiResponse } from "next";
import { albumTheme, publicAlbum, AlbumRow } from "../../../lib/albums";

// ==================================================================
// PÁGINA DEL ÁLBUM DIGITAL -> /album/<liga> (rewrite del sitio)
//
// No guarda la lista de fotos: el HTML es el mismo para todos y el navegador
// pide /api/albums/public?slug=... al abrir. Así, cuando el estudio sube o
// borra algo de la carpeta del Drive, la liga lo refleja al instante.
//
// Temáticas: `boda` (marfil y oro), `xv` (rosa) y `clasico` (papel neutro).
// ==================================================================

const SLUG_SAFE = /^[a-z0-9]{6,40}$/i;

function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const MONTHS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

function dateLabel(raw: string): string {
  const s = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return `${d.getDate()} de ${MONTHS[d.getMonth()]} de ${d.getFullYear()}`;
  }
  return s;
}

function notice(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${esc(title)}</title>
<style>
  *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:26px;
  background:#f6efe3;color:#3b352c;font-family:Georgia,'Times New Roman',serif;text-align:center}
  .card{max-width:440px;padding:38px 28px;border:1px solid rgba(185,154,99,.4);background:#fffdf8}
  h1{margin:0 0 10px;font-size:24px;font-weight:500}
  p{margin:0;font-size:15px;line-height:1.7;color:#7d7263}
</style></head><body><div class="card"><h1>${esc(title)}</h1><p>${esc(message)}</p></div></body></html>`;
}

function albumHtml(album: AlbumRow): string {
  const slug = String(album.slug || "");
  const theme = albumTheme(album.theme);
  const title = String(album.title || "Nuestro álbum");
  const date = dateLabel(String(album.event_date || ""));

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="referrer" content="no-referrer" />
<meta name="robots" content="noindex" />
<title>${esc(title)} · Álbum digital</title>
<meta name="description" content="Álbum digital de ${esc(title)}" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;0,600;0,700;1,300;1,400&family=Italiana&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet" />
<style>
  :root {
    --bg: #f7f0e4;
    --bg-2: #efe4d1;
    --ink: #3b352c;
    --soft: #7d7263;
    --accent: #b99a63;
    --accent-deep: #9a7c48;
    --paper: #fffcf6;
    --line: rgba(185, 154, 99, .38);
    --radius: 3px;
    --serif: 'Cormorant Garamond', Georgia, serif;
    --display: 'Italiana', 'Cormorant Garamond', Georgia, serif;
    --sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  body.theme-xv {
    --bg: #fbefF2;
    --bg-2: #f5dfe4;
    --ink: #4a3036;
    --soft: #8b6a73;
    --accent: #c98a96;
    --accent-deep: #a96472;
    --paper: #fff9fa;
    --line: rgba(201, 138, 150, .4);
    --radius: 14px;
  }
  body.theme-clasico {
    --bg: #f4f4f1;
    --bg-2: #e9e9e4;
    --ink: #20262b;
    --soft: #66707a;
    --accent: #8a7a5e;
    --accent-deep: #6d5f47;
    --paper: #ffffff;
    --line: rgba(138, 122, 94, .32);
    --radius: 0px;
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0;
    min-height: 100vh;
    background:
      radial-gradient(ellipse at 50% -10%, rgba(255,255,255,.85), transparent 55%),
      linear-gradient(180deg, var(--bg), var(--bg-2));
    color: var(--ink);
    font-family: var(--serif);
    -webkit-font-smoothing: antialiased;
  }
  .wrap { width: min(1180px, 100%); margin: 0 auto; padding: 0 clamp(14px, 4vw, 38px) 80px; }

  /* ===== Portada del álbum ===== */
  .hero { position: relative; text-align: center; padding: clamp(54px, 9vw, 104px) 0 clamp(26px, 4vw, 44px); }
  .hero::before {
    content: ''; position: absolute; left: 50%; top: clamp(22px, 3.5vw, 42px);
    width: 1px; height: clamp(20px, 3vw, 34px); transform: translateX(-50%);
    background: linear-gradient(180deg, transparent, var(--accent));
  }
  .eyebrow {
    margin: 0 0 14px; color: var(--accent-deep); font-family: var(--sans);
    font-size: .62rem; font-weight: 600; letter-spacing: .34em; text-transform: uppercase;
  }
  .hero h1 {
    margin: 0; font-family: var(--display); font-weight: 400;
    font-size: clamp(2.5rem, 8vw, 5rem); line-height: 1.04; letter-spacing: .01em;
  }
  .hero .date {
    margin: 16px 0 0; color: var(--soft); font-size: clamp(1rem, 2.4vw, 1.18rem);
    font-style: italic; letter-spacing: .04em;
  }
  .hero .rule {
    display: flex; align-items: center; justify-content: center; gap: 12px;
    margin: 22px auto 0; width: min(280px, 60%);
  }
  .hero .rule::before, .hero .rule::after {
    content: ''; height: 1px; flex: 1;
    background: linear-gradient(90deg, transparent, var(--line));
  }
  .hero .rule::after { transform: scaleX(-1); }
  .hero .rule span { color: var(--accent); font-size: .7rem; }
  .stats {
    display: flex; align-items: center; justify-content: center; gap: 10px;
    margin-top: 18px; color: var(--soft); font-family: var(--sans);
    font-size: .58rem; font-weight: 500; letter-spacing: .2em; text-transform: uppercase;
  }
  .stats i { width: 3px; height: 3px; border-radius: 50%; background: var(--accent); }

  /* ===== Filtros ===== */
  .filters {
    display: flex; flex-wrap: wrap; align-items: center; justify-content: center;
    gap: 8px; margin: 6px 0 clamp(22px, 4vw, 36px);
    position: sticky; top: 0; z-index: 20; padding: 12px 0;
    background: linear-gradient(180deg, var(--bg) 62%, transparent);
  }
  .filters button {
    appearance: none; cursor: pointer; border: 1px solid var(--line);
    background: rgba(255,255,255,.55); color: var(--soft);
    padding: .58rem 1.05rem; border-radius: 999px;
    font-family: var(--sans); font-size: .58rem; font-weight: 600;
    letter-spacing: .18em; text-transform: uppercase;
    transition: color .25s, background .25s, border-color .25s, transform .25s;
  }
  .filters button:hover { transform: translateY(-1px); color: var(--ink); }
  .filters button.active {
    background: var(--accent); border-color: var(--accent); color: #fffdf8;
    box-shadow: 0 10px 22px -14px var(--accent-deep);
  }

  /* ===== Cuadrícula ===== */
  .grid { columns: 3; column-gap: clamp(10px, 1.6vw, 16px); }
  @media (max-width: 900px) { .grid { columns: 2; } }
  @media (max-width: 520px) { .grid { columns: 2; column-gap: 9px; } }
  .card {
    position: relative; break-inside: avoid; margin: 0 0 clamp(10px, 1.6vw, 16px);
    overflow: hidden; border-radius: var(--radius); background: var(--paper);
    border: 1px solid var(--line); box-shadow: 0 18px 34px -30px rgba(60, 44, 24, .55);
    cursor: zoom-in; opacity: 0; transform: translateY(14px);
    transition: opacity .55s ease, transform .55s cubic-bezier(.2,.8,.2,1), box-shadow .35s;
  }
  .card.in { opacity: 1; transform: translateY(0); }
  .card:hover { box-shadow: 0 24px 44px -28px rgba(60, 44, 24, .55); }
  .card img {
    display: block; width: 100%; height: auto; background: var(--bg-2);
    transition: transform .7s cubic-bezier(.2,.8,.2,1), filter .5s;
  }
  .card:hover img { transform: scale(1.035); }
  .card .fallback {
    width: 100%; aspect-ratio: 4 / 5; display: grid; place-items: center;
    background: linear-gradient(145deg, var(--paper), var(--bg-2));
    color: var(--accent); font-size: 1.6rem;
  }
  .card .veil {
    position: absolute; inset: 0; display: flex; flex-direction: column;
    justify-content: flex-end; gap: 4px; padding: 14px;
    background: linear-gradient(180deg, transparent 48%, rgba(30, 24, 16, .55));
    opacity: 0; transition: opacity .35s;
  }
  .card:hover .veil { opacity: 1; }
  .card .veil b { color: #fffdf8; font-family: var(--sans); font-size: .6rem; font-weight: 600; letter-spacing: .14em; text-transform: uppercase; }
  .card .play {
    position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none;
  }
  .card .play span {
    display: grid; place-items: center; width: 46px; height: 46px; border-radius: 50%;
    border: 1px solid rgba(255,255,255,.7); background: rgba(20,16,10,.34);
    color: #fff; font-size: .8rem; backdrop-filter: blur(4px);
    transition: transform .35s, background .35s;
  }
  .card:hover .play span { transform: scale(1.08); background: rgba(20,16,10,.5); }
  .card.video::after {
    content: 'Vídeo'; position: absolute; top: 10px; left: 10px;
    padding: 4px 8px; border-radius: 999px;
    background: rgba(20,16,10,.5); color: #fffdf8;
    font-family: var(--sans); font-size: .48rem; font-weight: 600;
    letter-spacing: .16em; text-transform: uppercase; backdrop-filter: blur(4px);
  }

  .empty {
    padding: 70px 20px; text-align: center; color: var(--soft);
    font-style: italic; font-size: 1.15rem;
  }
  .empty[hidden] { display: none; }
  .loading { padding: 40px 0 10px; text-align: center; color: var(--soft); font-family: var(--sans); font-size: .6rem; letter-spacing: .22em; text-transform: uppercase; }
  .loading[hidden] { display: none; }

  /* ===== Visor ===== */
  .lb {
    position: fixed; inset: 0; z-index: 90; display: none;
    background: rgba(18, 15, 11, .93); backdrop-filter: blur(6px);
    color: #fffdf8;
  }
  .lb.open { display: grid; grid-template-rows: 1fr auto; }
  .lb-stage { display: grid; place-items: center; padding: 46px clamp(12px, 4vw, 70px) 10px; overflow: hidden; }
  .lb-stage img, .lb-stage video {
    max-width: 100%; max-height: calc(100vh - 130px); display: block;
    object-fit: contain; box-shadow: 0 30px 80px -30px rgba(0,0,0,.8);
    background: #000;
  }
  .lb-bar {
    display: flex; align-items: center; justify-content: space-between; gap: 16px;
    padding: 14px clamp(16px, 4vw, 30px) 22px;
    font-family: var(--sans); font-size: .62rem; letter-spacing: .16em; text-transform: uppercase;
    color: rgba(255,253,248,.72);
  }
  .lb-bar a { color: #fffdf8; text-decoration: none; border-bottom: 1px solid rgba(255,255,255,.35); padding-bottom: 2px; }
  .lb-btn {
    position: absolute; z-index: 2; appearance: none; cursor: pointer;
    border: 1px solid rgba(255,255,255,.28); background: rgba(255,255,255,.08);
    color: #fffdf8; width: 44px; height: 44px; border-radius: 50%;
    font-size: 1.1rem; display: grid; place-items: center;
    transition: background .25s, transform .25s;
  }
  .lb-btn:hover { background: rgba(255,255,255,.18); transform: scale(1.05); }
  .lb-close { top: 16px; right: 16px; }
  .lb-prev { left: 14px; top: 50%; margin-top: -22px; }
  .lb-next { right: 14px; top: 50%; margin-top: -22px; }

  @media (max-width: 600px) {
    .hero { padding-top: 52px; }
    .lb-prev { left: 8px; }
    .lb-next { right: 8px; }
    .lb-bar { font-size: .54rem; }
  }
</style>
</head>
<body class="theme-${theme}">
<div class="wrap">
  <header class="hero">
    <p class="eyebrow">Álbum digital</p>
    <h1>${esc(title)}</h1>
    ${date ? `<p class="date">${esc(date)}</p>` : ""}
    <div class="rule" aria-hidden="true"><span>✦</span></div>
    <p class="stats" id="stats">Fotos y vídeos del evento</p>
  </header>

  <nav class="filters" aria-label="Filtrar el álbum">
    <button type="button" data-filter="all" class="active">Todo</button>
    <button type="button" data-filter="image">Fotos</button>
    <button type="button" data-filter="video">Vídeos</button>
  </nav>

  <p class="loading" id="loading">Cargando recuerdos…</p>
  <main class="grid" id="grid"></main>
  <p class="empty" id="empty" hidden>Este álbum todavía no tiene fotos ni vídeos.</p>
</div>

<div class="lb" id="lb" role="dialog" aria-modal="true" aria-hidden="true">
  <button class="lb-btn lb-close" type="button" aria-label="Cerrar">×</button>
  <button class="lb-btn lb-prev" type="button" aria-label="Anterior">‹</button>
  <button class="lb-btn lb-next" type="button" aria-label="Siguiente">›</button>
  <div class="lb-stage" id="lb-stage"></div>
  <div class="lb-bar"><span id="lb-name"></span><a id="lb-download" href="#" download>Descargar</a></div>
</div>

<script>
(function () {
  var SLUG = ${JSON.stringify(slug)};
  var items = [];
  var visible = [];
  var filter = 'all';
  var index = 0;
  var grid = document.getElementById('grid');
  var empty = document.getElementById('empty');
  var loading = document.getElementById('loading');
  var stats = document.getElementById('stats');
  var lb = document.getElementById('lb');
  var stage = document.getElementById('lb-stage');
  var lbName = document.getElementById('lb-name');
  var lbDownload = document.getElementById('lb-download');

  function fmtSize(bytes) {
    var n = Number(bytes || 0);
    if (n > 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n > 1024) return Math.round(n / 1024) + ' KB';
    return '';
  }

  function mediaCard(item, i) {
    var card = document.createElement('figure');
    card.className = 'card' + (item.kind === 'video' ? ' video' : '');
    card.style.transitionDelay = Math.min(i, 10) * 0.035 + 's';
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', item.kind === 'video' ? 'Ver vídeo' : 'Ver foto');

    var img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = item.kind === 'video' ? 'Vídeo del evento' : 'Foto del evento';
    img.src = item.thumb;
    img.onerror = function () {
      img.remove();
      var fb = document.createElement('div');
      fb.className = 'fallback';
      fb.textContent = '✦';
      card.insertBefore(fb, card.firstChild);
    };
    card.appendChild(img);

    if (item.kind === 'video') {
      var play = document.createElement('div');
      play.className = 'play';
      var dot = document.createElement('span');
      dot.textContent = '▶';
      play.appendChild(dot);
      card.appendChild(play);
    }

    var veil = document.createElement('div');
    veil.className = 'veil';
    var name = document.createElement('b');
    name.textContent = fmtSize(item.size);
    veil.appendChild(name);
    card.appendChild(veil);

    function open() { openLightbox(i); }
    card.addEventListener('click', open);
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    return card;
  }

  function applyFilter() {
    grid.textContent = '';
    visible = items.filter(function (it) {
      return filter === 'all' || it.kind === filter;
    });
    visible.forEach(function (item, i) {
      grid.appendChild(mediaCard(item, i));
    });
    empty.hidden = visible.length > 0;
    requestAnimationFrame(function () {
      var cards = grid.querySelectorAll('.card');
      for (var c = 0; c < cards.length; c++) cards[c].classList.add('in');
    });
  }

  function openLightbox(i) {
    if (!visible.length) return;
    index = (i + visible.length) % visible.length;
    var item = visible[index];
    stage.textContent = '';
    if (item.kind === 'video') {
      var v = document.createElement('video');
      v.src = item.file;
      v.controls = true;
      v.autoplay = true;
      v.playsInline = true;
      stage.appendChild(v);
    } else {
      var img = document.createElement('img');
      img.src = item.file;
      img.alt = 'Foto del evento';
      stage.appendChild(img);
    }
    lbName.textContent = fmtSize(item.size) || (item.kind === 'video' ? 'Vídeo' : 'Foto');
    lbDownload.href = item.file;
    lbDownload.setAttribute('download', item.name);
    lb.classList.add('open');
    lb.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  }

  function closeLightbox() {
    lb.classList.remove('open');
    lb.setAttribute('aria-hidden', 'true');
    stage.textContent = '';
    document.body.style.overflow = '';
  }

  function move(delta) {
    if (!lb.classList.contains('open')) return;
    openLightbox(index + delta);
  }

  document.querySelectorAll('.filters button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      filter = btn.getAttribute('data-filter') || 'all';
      document.querySelectorAll('.filters button').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
      applyFilter();
    });
  });
  lb.querySelector('.lb-close').addEventListener('click', closeLightbox);
  lb.querySelector('.lb-prev').addEventListener('click', function (e) { e.stopPropagation(); move(-1); });
  lb.querySelector('.lb-next').addEventListener('click', function (e) { e.stopPropagation(); move(1); });
  lb.addEventListener('click', function (e) {
    if (e.target === lb || e.target === stage) closeLightbox();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft') move(-1);
    if (e.key === 'ArrowRight') move(1);
  });

  fetch('/api/albums/public?slug=' + encodeURIComponent(SLUG), { cache: 'no-store' })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (data) {
      loading.hidden = true;
      if (!data || !data.ok) {
        empty.textContent = 'No se pudo abrir el álbum. Vuelve a intentarlo en un momento.';
        empty.hidden = false;
        return;
      }
      items = Array.isArray(data.items) ? data.items : [];
      var photos = items.filter(function (i) { return i.kind === 'image'; }).length;
      var videos = items.filter(function (i) { return i.kind === 'video'; }).length;
      stats.textContent = photos + (photos === 1 ? ' foto' : ' fotos') + ' · ' +
        videos + (videos === 1 ? ' vídeo' : ' vídeos');
      applyFilter();
    })
    .catch(function () {
      loading.hidden = true;
      empty.textContent = 'No se pudo abrir el álbum. Vuelve a intentarlo en un momento.';
      empty.hidden = false;
    });
})();
</script>
</body>
</html>`;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    res.status(405).send(notice("No disponible", "Abre esta dirección en el navegador."));
    return;
  }
  const slug = String(req.query.slug ?? "").trim();
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("X-Robots-Tag", "noindex");
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (!SLUG_SAFE.test(slug)) {
    res.status(404).send(
      notice("Álbum no encontrado", "Revisa la liga: puede estar incompleta.")
    );
    return;
  }
  try {
    const album = await publicAlbum(slug);
    if (!album) {
      res.status(404).send(
        notice(
          "Este álbum no está disponible",
          "Puede que todavía no se haya publicado o que ya no esté activo. " +
            "Pídele a quien te lo compartió que te mande la liga de nuevo."
        )
      );
      return;
    }
    res.status(200).send(albumHtml(album));
  } catch (e) {
    console.error("[albums/page]", e);
    res.status(503).send(
      notice("No se pudo abrir el álbum", "Vuelve a intentarlo en un momento.")
    );
  }
}
