// api/news.js — FINAL
// Ventana: 48h · Top 5 con cupos: 3 ES + 2 EN (rellena si falta) · Dedupe por URL/título
// Titulares: si la noticia es EN, se traduce SIEMPRE el titular al español
// Resúmenes: 5–10 líneas (una frase por línea); si EN, añade "fuente original en inglés"
// Imágenes: usa urlToImage; si falta y ENABLE_AI_IMAGES=1, genera con OpenAI; si no, placeholder

function normalizeTopic(s = '') {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function getTopicConfig(topicRaw) {
  const t = normalizeTopic(topicRaw);
  const TECNO = {
    q: '\"tecnologia\" OR tecnologia OR smartphone OR \"telefono inteligente\" OR Android OR iPhone OR Apple OR Google OR Microsoft OR software OR hardware OR gadget OR chip OR semiconductor OR ciberseguridad OR internet',
    include: [
      /tecnolog/i, /smartphone/i, /m[óo]vil|telefono inteligente/i,
      /android/i, /iphone|ios|apple/i, /microsoft|windows/i, /google|pixel/i,
      /software|hardware|gadget|chip|semiconductor|ciberseguridad|internet|router|wifi/i,
    ],
    exclude: [/f[úu]tbol|tenis|baloncesto|moda|celebridad|cocina|viajes/i],
  };
  const ASTRO = {
    q: 'astrofotografia OR astrophotography OR \"fotografia astronomica\" OR telescopio OR \"via lactea\" OR \"cielo profundo\" OR nebulosa OR cometa',
    include: [/astrofotograf|astrophotograph|fotografia astronom|via lactea|nebulosa|cometa|telescopi|cielo profundo/i],
  };
  const AI = {
    q: '\"inteligencia artificial\" OR IA OR \"machine learning\" OR \"aprendizaje automatico\" OR \"deep learning\" OR OpenAI OR ChatGPT OR LLM OR \"modelo generativo\" OR transformer',
    include: [/inteligencia artificial|\bIA\b|machine learning|aprendizaje automatico|deep learning|openai|chatgpt|modelo generativo|\bLLM\b|transformer/i],
  };
  if (/astro/.test(t)) return { name: 'Astrofotografía', ...ASTRO };
  if (/(^|\s)ai(\s|$)/.test(t) || /inteligencia artificial|aprendizaje|machine/.test(t)) return { name: 'Inteligencia Artificial', ...AI };
  if (/tecno/.test(t)) return { name: 'Tecnología', ...TECNO };
  return { name: topicRaw, q: topicRaw, include: [new RegExp(topicRaw, 'i')] };
}

function hoursAgo(iso) {
  const t = new Date(iso).getTime();
  if (!t) return 9999;
  return (Date.now() - t) / (1000 * 60 * 60);
}

function relevanceScore(cfg, a) {
  const title = (a.title || "");
  const desc = (a.description || "");
  let score = 0;
  if (cfg.include) {
    cfg.include.forEach((re) => {
      if (re.test(title)) score += 3; else if (re.test(desc)) score += 1.5;
    });
  }
  if (cfg.exclude) {
    cfg.exclude.forEach((re) => { if (re.test(title) || re.test(desc)) score -= 5; });
  }
  const h = hoursAgo(a.publishedAt);
  if (isFinite(h)) { const rec = Math.max(0, 48 - h) / 48; score += Math.max(0, rec) * 3; }
  return score;
}

function placeholderSVG(title = '') {
  const t = (title || 'Noticia').replace(/</g,'&lt;').slice(0,60);
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='1024' height='576'>\n  <defs>\n    <linearGradient id='g' x1='0' x2='1' y1='0' y2='1'>\n      <stop stop-color='#eef2ff' offset='0'/>\n      <stop stop-color='#e2e8f0' offset='1'/>\n    </linearGradient>\n  </defs>\n  <rect fill='url(#g)' width='100%' height='100%'/>\n  <text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle'\n        font-family='system-ui,Arial' font-size='36' fill='#334155'>${t}</text>\n</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

async function generateImageFor(title, topicName) {
  if (process.env.ENABLE_AI_IMAGES !== '1' || !process.env.OPENAI_API_KEY) return { url: null, isAI: false };
  try {
    const prompt = `Ilustración editorial clara y minimalista relacionada con ${topicName}. Tema/noticia: ${title}. Sin texto, sin logos de marcas, formato panorámico.`;
    const r = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST', headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-1', prompt, size: '512x288' }),
    });
    if (!r.ok) return { url: null, isAI: false };
    const j = await r.json();
    const url = j.data?.[0]?.url || null;
    return { url, isAI: !!url };
  } catch { return { url: null, isAI: false }; }
}

function normTitle(s='') {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim();
}

function titleSimilarity(a,b){
  const A = new Set(normTitle(a).split(' '));
  const B = new Set(normTitle(b).split(' '));
  if (!A.size || !B.size) return 0;
  let inter = 0; A.forEach(w=>{ if(B.has(w)) inter++; });
  const jacc = inter / (A.size + B.size - inter);
  return jacc; // 0..1
}

function isDuplicate(prev, cur){
  if (prev.url && cur.url && prev.url.split('?')[0] === cur.url.split('?')[0]) return true;
  const sim = titleSimilarity(prev.title||'', cur.title||'');
  return sim >= 0.7;
}

async function fetchNewsFor(cfg, lang) {
  const from = new Date(); from.setHours(from.getHours() - 48);
  const params = new URLSearchParams({
    q: cfg.q,
    language: lang,
    sortBy: 'publishedAt',
    searchIn: 'title,description',
    from: from.toISOString().slice(0,10),
    pageSize: '50',
  });
  const url = `https://newsapi.org/v2/everything?${params}`;
  const resp = await fetch(url, { headers: { 'X-Api-Key': process.env.NEWSAPI_KEY || '' } });
  if (!resp.ok) throw new Error(await resp.text());
  const data = await resp.json();
  return (data.articles||[]).map(a => ({...a, _lang: lang}));
}

function formatToLines(text, min=5, max=10) {
  if (!text) return '';
  const parts = (text.replace(/\n+/g,' ').split(/(?<=[\.!?])\s+/).filter(Boolean));
  const sliced = parts.slice(0, Math.max(min, Math.min(max, parts.length)));
  return sliced.join('\n');
}

async function translateTitleToEs(a) {
  if (a._lang !== 'en') return a.title || '';
  if (!process.env.OPENAI_API_KEY) return a.title || '';
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'Traduce títulos del inglés al español de forma natural. Devuelve SOLO el título, sin comillas ni explicaciones.' },
          { role: 'user', content: `Traduce al español este titular:\n${a.title || ''}` }
        ],
        temperature: 0.1,
      })
    });
    if (!r.ok) return a.title || '';
    const j = await r.json();
    return j.choices?.[0]?.message?.content?.trim?.() || (a.title || '');
  } catch { return a.title || ''; }
}

module.exports = async (req, res) => {
  try {
    const topicRaw = (req.query?.topic || 'tecnología').toString();

    if (topicRaw === 'ping') return res.status(200).json({ ok: true, articles: [] });
    if (topicRaw === '__diag') {
      return res.status(200).json({
        ok: true,
        hasOpenAI: Boolean(process.env.OPENAI_API_KEY),
        hasNewsAPI: Boolean(process.env.NEWSAPI_KEY),
        aiImages: process.env.ENABLE_AI_IMAGES === '1',
        env: process.env.VERCEL_ENV || 'unknown'
      });
    }

    const cfg = getTopicConfig(topicRaw);

    // 1) Traer ES + EN de las últimas 48 horas
    let raw = [];
    try {
      const [es, en] = await Promise.all([
        fetchNewsFor(cfg, 'es'),
        fetchNewsFor(cfg, 'en'),
      ]);
      raw = es.concat(en);
    } catch (err) {
      return res.status(200).json({ articles: [], warning: `NewsAPI error: ${String(err)}` });
    }

    // 2) Filtrar por tema + dentro de 48h exactas (SEPARADO ES/EN)
    const within48h = (a) => hoursAgo(a.publishedAt) <= 48;

    const filteredEs = raw.filter((a) => a._lang === 'es').filter((a) => {
      if (!within48h(a)) return false;
      const text = `${a.title || ''} ${a.description || ''}`;
      const okInclude = cfg.include ? cfg.include.some((re) => re.test(text)) : true;
      const okExclude = cfg.exclude ? !cfg.exclude.some((re) => re.test(text)) : true;
      return okInclude && okExclude;
    });

    const filteredEn = raw.filter((a) => a._lang === 'en').filter((a) => {
      if (!within48h(a)) return false;
      const text = `${a.title || ''} ${a.description || ''}`;
      const okInclude = cfg.include ? cfg.include.some((re) => re.test(text)) : true;
      const okExclude = cfg.exclude ? !cfg.exclude.some((re) => re.test(text)) : true;
      return okInclude && okExclude;
    });

    // 3) Ranking con cupos: máx 3 ES + 2 EN (rellena hasta 5)
    const scoredEs = filteredEs.map(a => ({ a, score: relevanceScore(cfg, a) })).sort((x,y)=> y.score - x.score);
    const scoredEn = filteredEn.map(a => ({ a, score: relevanceScore(cfg, a) })).sort((x,y)=> y.score - x.score);

    const chosen = [];
    const isDupVsChosen = (cand) => chosen.some(prev => isDuplicate(prev, cand));

    function takeFrom(list, maxCount) {
      const out = [];
      for (const it of list) {
        if (out.length >= maxCount) break;
        if (isDupVsChosen(it.a)) continue;
        out.push(it.a);
        chosen.push(it.a);
      }
      return out;
    }

    const cupoEs = 3; const cupoEn = 2;
    takeFrom(scoredEs, cupoEs);
    takeFrom(scoredEn, cupoEn);

    let combinedRemainder = [
      ...scoredEs.filter(x => !chosen.includes(x.a)),
      ...scoredEn.filter(x => !chosen.includes(x.a))
    ].sort((x,y)=> y.score - x.score);

    while (chosen.length < 5 && combinedRemainder.length) {
      const next = combinedRemainder.shift();
      if (isDupVsChosen(next.a)) continue;
      chosen.push(next.a);
    }

    const top5 = chosen.slice(0,5);

    async function summarize(a) {
      const en = a._lang === 'en';
      const basePrompt = en
        ? `Traduce y resume al ESPAÑOL en 5 a 10 líneas. Cada línea debe ser una frase corta separada por salto de línea. Al final añade exactamente: "fuente original en inglés". No inventes datos.\nTítulo: ${a.title}\nDescripción: ${a.description ?? '(sin descripción)'}\nEnlace: ${a.url}`
        : `Resume en ESPAÑOL en 5 a 10 líneas. Cada línea debe ser una frase corta separada por salto de línea. No inventes datos.\nTítulo: ${a.title}\nDescripción: ${a.description ?? '(sin descripción)'}\nEnlace: ${a.url}`;
      if (!process.env.OPENAI_API_KEY) {
        const desc = a.description || a.content || '';
        const base = formatToLines(desc || '', 5, 10);
        return en ? (base ? `${base}\n\nfuente original en inglés` : 'fuente original en inglés') : base;
      }
      try {
        const r = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-4o-mini', messages: [ { role: 'system', content: 'Eres un asistente que traduce y resume noticias al español con precisión y neutralidad. Usa 5–10 líneas, cada una una frase.' }, { role: 'user', content: basePrompt } ], temperature: 0.2 })
        });
        if (!r.ok) {
          const desc = a.description || a.content || '';
          const base = formatToLines(desc || '', 5, 10);
          return en ? (base ? `${base}\n\nfuente original en inglés` : 'fuente original en inglés') : base;
        }
        const j = await r.json();
        const txt = j.choices?.[0]?.message?.content?.trim?.() || '';
        return txt || formatToLines(a.description || '', 5, 10);
      } catch {
        const desc = a.description || a.content || '';
        const base = formatToLines(desc || '', 5, 10);
        return en ? (base ? `${base}\n\nfuente original en inglés` : 'fuente original en inglés') : base;
      }
    }

    async function translateTitle(a) { return translateTitleToEs(a); }

    async function pickImage(a) {
      if (a.urlToImage) return { url: a.urlToImage, isAI: false };
      const gen = await generateImageFor(a.title, cfg.name);
      if (gen.url) return gen;
      return { url: placeholderSVG(a.title), isAI: false };
    }

    const articles = await Promise.all(
      top5.map(async (a, idx) => {
        const [titleEs, summary, img] = await Promise.all([
          translateTitle(a),
          summarize(a),
          pickImage(a),
        ]);
        return {
          id: `${a.source?.id ?? 'news'}-${idx}`,
          title: titleEs || a.title,
          publishedAt: a.publishedAt,
          sourceName: a.source?.name ?? 'Desconocida',
          url: a.url,
          summary,
          imageUrl: img.url,
          imageIsAI: img.isAI,
        };
      })
    );

    return res.status(200).json({ articles });
  } catch (e) {
    return res.status(200).json({ articles: [], warning: `Server error: ${String(e)}` });
  }
};