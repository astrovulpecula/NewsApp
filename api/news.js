// api/news.js — 48h ROBUSTO (debug + fallback + traducción + 5–10 líneas + imágenes)
// Compatible con runtimes Node 18+ (Next.js / Vercel / Express middleware estilo handler)
// Hace crawling sobre GDELT (gratis) y usa r.jina.ai para extraer el texto del artículo.
// Requisitos de negocio cubiertos:
//  - Ventana por defecto: últimas 48h (timelimit configurable via ?hours=)
//  - Resumen 5–10 líneas
//  - Español primero; las noticias en inglés van al final y marcan (ENG)
//  - Fallback de imagen (placeholder por categoría)
//  - De-dupe por URL/título
//  - Modo DEBUG con trazas y cabeceras X-Debug-*
//  - Normalización robusta de categorías y sinónimos
//  - Si una categoría no encuentra nada, se reintenta ampliando criterios en la misma ventana temporal

export default async function handler(req, res) {
  try {
    // --- CORS sencillo ---
    if (req.method === 'OPTIONS') {
      return res
        .setHeader('Access-Control-Allow-Origin', '*')
        .setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS')
        .setHeader('Access-Control-Allow-Headers', 'Content-Type')
        .status(200)
        .end();
    }
    res.setHeader('Access-Control-Allow-Origin', '*');

    const startTS = Date.now();

    const rawCat = (req.query?.category || req.query?.cat || '').toString().trim();
    const { limit: limitParam, q: extraQ, hours: hoursParam } = req.query || {};
    const limit = clampInt(parseInt(limitParam, 10) || 20, 5, 50);
    const hours = clampInt(parseInt(hoursParam, 10) || 48, 6, 168); // 6h–168h (1 semana máx)
    const minutesWindow = hours * 60;

    const norm = normalizeCategory(rawCat);
    const qterms = buildQueryTerms(norm, extraQ);

    // Buscamos en GDELT en la ventana solicitada (por defecto 48h)
    let results = await fetchFromGDELT(qterms, minutesWindow, limit * 3); // pedimos más para filtrar/dedup

    // Fallback: si no hay nada, reintentamos sin restricción de idioma (para rescatar lo que sea relevante)
    if (!results.length) {
      results = await fetchFromGDELT(qterms, minutesWindow, limit * 3, { anyLang: true });
    }

    // Dedupe básico por URL y título (case-insensitive)
    const deduped = dedupeArticles(results);

    // Enriquecer: bajar cuerpo con r.jina.ai (hasta N = limit)
    const enriched = await enrichArticles(deduped.slice(0, limit), norm.key);

    // Ordenar: Español primero, luego inglés
    const ordered = enriched.sort((a, b) => {
      const la = a.language === 'es' ? 0 : 1;
      const lb = b.language === 'es' ? 0 : 1;
      if (la !== lb) return la - lb;
      // si mismo idioma, más reciente primero
      return (b.publishedAt || 0) - (a.publishedAt || 0);
    });

    // Si no hay resultados, devolvemos estructura vacía pero con debugging explícito
    if (!ordered.length) {
      const dbg = {
        note: `Sin resultados en ${hours}h para la categoría dada. Revise el slug o pruebe sinónimos.`,
        received_category: rawCat || '(vacío)',
        normalized_key: norm.key,
        synonyms: qterms.synonyms,
        hours,
      };
      res
        .setHeader('X-Debug-Note', encodeURIComponent(JSON.stringify(dbg)))
        .status(200)
        .json({ ok: true, category: norm, items: [], debug: dbg });
      return;
    }

    const elapsed = Date.now() - startTS;
    res
      .setHeader('X-Debug-Category', norm.key)
      .setHeader('X-Debug-Synonyms', encodeURIComponent(qterms.synonyms.join(',')))
      .setHeader('X-Debug-Count', String(ordered.length))
      .setHeader('X-Debug-TimeMs', String(elapsed))
      .setHeader('X-Debug-Hours', String(hours))
      .status(200)
      .json({ ok: true, category: norm, items: ordered });
  } catch (err) {
    console.error('[api/news] Fatal:', err);
    res.status(500).json({ ok: false, error: 'INTERNAL_ERROR', message: String(err?.message || err) });
  }
}

// ======================== Helpers ========================

function clampInt(n, min, max) { return Math.max(min, Math.min(max, n)); }

function normalizeCategory(input) {
  const s = (input || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // Claves canónicas que usa la API internamente
  const MAP = {
    portada: ['home','inicio','portada','principal','todas','top'],
    tecnologia: ['tech','tecnologia','tecnologia','ia','ai','gpt','openai','apple','google','microsoft'],
    ciencia: ['ciencia','science','cientifica'],
    astro: ['astro','astrofoto','astrofotografia','astrophotography','astronomia','astronomy','space','espacio','nasa','esa'],
    videojuegos: ['videojuegos','gaming','juegos','games'],
    deportes: ['deportes','sports','futbol','football'],
    economia: ['economia','economy','negocios','business','empresas'],
    cultura: ['cultura','arte','arte y cultura','cine','series'],
    salud: ['salud','health','medicina'],
    mundo: ['mundo','internacional','world'],
    espana: ['espana','españa','spain','nacional']
  };
  for (const key of Object.keys(MAP)) {
    if (key === s) return { key, raw: input };
    if (MAP[key].some(alias => s === alias)) return { key, raw: input };
  }
  // Por defecto, tecnología si viene vacío; así evitamos que el UI se quede sin titulares por slug erróneo
  return { key: s || 'tecnologia', raw: input };
}

function buildQueryTerms(norm, extraQ) {
  const baseSyn = {
    portada: ['breaking', 'trending'],
    tecnologia: ['inteligencia artificial','tecnologia','software','apple','google','microsoft','chip','semiconductor'],
    ciencia: ['ciencia','investigacion','descubrimiento','universidad'],
    astro: ['astronomia','espacio','nasa','esa','astrofotografia','astrophotography','telescopio','galaxia','nebula','cohete','spacex'],
    videojuegos: ['videojuegos','gaming','nintendo','playstation','xbox','steam'],
    deportes: ['deporte','futbol','tenis','baloncesto'],
    economia: ['economia','mercados','empresa','finanzas'],
    cultura: ['cine','series','musica','literatura','cultura'],
    salud: ['salud','medicina','farmacia'],
    mundo: ['internacional','geopolitica','conflicto','diplomacia'],
    espana: ['españa','congreso','gobierno','economia españa','deporte españa']
  };
  let synonyms = baseSyn[norm.key] || ['noticias'];
  if (extraQ) synonyms = [String(extraQ)].concat(synonyms);
  // eliminar duplicados
  synonyms = [...new Set(synonyms.map(s => s.trim()).filter(Boolean))];
  return { synonyms };
}

async function fetchFromGDELT(qterms, minutesWindow, maxRecords = 60, opts = {}) {
  // Construimos query OR con sinónimos
  const base = 'https://api.gdeltproject.org/api/v2/doc/doc';
  const enc = (s) => encodeURIComponent(s);

  const coreQuery = enc(qterms.synonyms.map(t => `(${t})`).join(' OR '));

  let urls = [];
  if (opts.anyLang) {
    const qAny = `${coreQuery}`; // sin filtro de idioma
    const urlAny = `${base}?query=${qAny}&mode=ArtList&maxrecords=${Math.min(maxRecords, 100)}&sort=DateDesc&format=json&timelimit=${minutesWindow}`;
    urls = [urlAny];
  } else {
    const qES = `${coreQuery}%20sourcelang:spa`;
    const qEN = `${coreQuery}%20sourcelang:eng`;
    urls = [
      `${base}?query=${qES}&mode=ArtList&maxrecords=${Math.min(maxRecords, 100)}&sort=DateDesc&format=json&timelimit=${minutesWindow}`,
      `${base}?query=${qEN}&mode=ArtList&maxrecords=${Math.min(maxRecords, 100)}&sort=DateDesc&format=json&timelimit=${minutesWindow}`,
    ];
  }

  const jsons = await Promise.all(urls.map(u => safeJsonFetch(u)));

  const collect = (json, langCode) => (json?.articles || []).map(a => ({
    title: a.title?.trim(),
    url: a.url,
    language: langCode || (a.language || 'en'),
    source: a.sourceCommonName || a.domain || a.source || '',
    publishedAt: a.seenDate ? Date.parse(a.seenDate) : (a.date ? Date.parse(a.date) : Date.now()),
    image: a.socialImage || a.image || null,
  }));

  if (opts.anyLang) {
    // cuando no filtramos idioma, intentamos inferir ES por heurística simple sobre título
    const any = collect(jsons[0], null).map(it => ({
      ...it,
      language: looksSpanish(it.title) ? 'es' : 'en',
    }));
    return any;
  }

  const esItems = collect(jsons[0], 'es');
  const enItems = collect(jsons[1], 'en');
  return esItems.concat(enItems);
}

function looksSpanish(text = '') {
  const t = text.toLowerCase();
  const hits = [' el ', ' la ', ' los ', ' las ', ' de ', ' en ', ' y ', ' con ', ' para ', ' españa', ' méxico', ' chile', ' argentina'];
  return hits.some(h => t.includes(h));
}

function dedupeArticles(items) {
  const seenUrl = new Set();
  const seenTitle = new Set();
  const out = [];
  for (const it of items) {
    const keyU = (it.url || '').toLowerCase();
    const keyT = (it.title || '').toLowerCase();
    if (!keyU && !keyT) continue;
    if (keyU && seenUrl.has(keyU)) continue;
    if (keyT && seenTitle.has(keyT)) continue;
    if (keyU) seenUrl.add(keyU);
    if (keyT) seenTitle.add(keyT);
    out.push(it);
  }
  return out;
}

async function enrichArticles(items, categoryKey) {
  const tasks = items.map(async (item) => {
    const text = await fetchReadableText(item.url);
    const summary = makeSummary(text, 8); // 8 líneas por defecto (entre 5 y 10)
    const img = item.image || fallbackImage(categoryKey, item.title);

    // Marcar ENG
    let title = item.title || '(Sin título)';
    if (item.language !== 'es') {
      title = title + ' (ENG)';
    }

    return {
      title,
      url: item.url,
      language: item.language,
      source: item.source,
      publishedAt: item.publishedAt,
      image: img,
      summary,
    };
  });
  return Promise.all(tasks);
}

async function safeJsonFetch(url, opts = {}) {
  try {
    const c = await fetch(url, { ...opts, headers: { 'User-Agent': 'NewsHub/1.0 (+app)' } });
    if (!c.ok) return {};
    return await c.json();
  } catch (_) { return {}; }
}

async function fetchReadableText(articleUrl) {
  if (!articleUrl) return '';
  const target = 'https://r.jina.ai/http://' + articleUrl.replace(/^https?:\/\//, '');
  try {
    const r = await fetch(target, { headers: { 'User-Agent': 'NewsHub/1.0 (+app)' } });
    if (!r.ok) return '';
    const txt = await r.text();
    // Quitar scripts/ruido básico si se colase HTML
    return txt
      .replace(/\s+/g, ' ')
      .replace(/\<script[\s\S]*?\<\/script\>/gi, ' ')
      .trim();
  } catch {
    return '';
  }
}

function makeSummary(text, targetLines = 8) {
  if (!text) return 'Resumen no disponible.';
  // Partimos en frases por puntos/!? respetando abreviaturas comunes
  const sentences = text
    .replace(/\(.*?\)/g, ' ')
    .split(/(?<=[\.!?])\s+(?=[A-ZÁÉÍÓÚÑÜ])/)
    .map(s => s.trim())
    .filter(s => s.length > 40 && s.length < 400)
    .slice(0, Math.max(5, Math.min(10, targetLines)));

  if (!sentences.length) return text.split(/\s+/).slice(0, 120).join(' ') + '…';
  // Unir como líneas
  return sentences.join('\n');
}

function fallbackImage(categoryKey, title = '') {
  const label = encodeURIComponent((title || categoryKey || 'News').slice(0, 40));
  // placeholder neutral (sin colores corporativos específicos)
  return `https://dummyimage.com/800x450/e9ecef/212529.jpg&text=${label}`;
}

// =========================================================
// Express.js soporte opcional (por si no usas serverless)
// Uso: app.get('/api/news', expressHandler(handler))
export function expressHandler(nextStyleHandler) {
  return async (req, res) => nextStyleHandler(req, res);
}
