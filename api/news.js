// api/news.js — últimas 48h, top 5, filtro por tema, ES/EN con traducción, dedupe y soporte de imágenes
// - Si una noticia es en inglés, el resumen se traduce al español y añade: "fuente original en inglés".
// - Deduplica por URL y similitud de título.
// - Preferimos imagen original (urlToImage). Si falta y ENABLE_AI_IMAGES=1, generamos con OpenAI Images.

function normalizeTopic(s = '') {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function getTopicConfig(topicRaw) {
  const t = normalizeTopic(topicRaw);
  const TECNO = {
    q: '"tecnologia" OR tecnologia OR smartphone OR "telefono inteligente" OR Android OR iPhone OR Apple OR Google OR Microsoft OR software OR hardware OR gadget OR chip OR semiconductor OR ciberseguridad OR internet',
    include: [
      /tecnolog/i, /smartphone/i, /m[óo]vil|telefono inteligente/i,
      /android/i, /iphone|ios|apple/i, /microsoft|windows/i, /google|pixel/i,
      /software|hardware|gadget|chip|semiconductor|ciberseguridad|internet|router|wifi/i,
    ],
    exclude: [/f[úu]tbol|tenis|baloncesto|moda|celebridad|cocina|viajes/i],
  };
  const ASTRO = {
    q: 'astrofotografia OR astrophotography OR "fotografia astronomica" OR telescopio OR "via lactea" OR "cielo profundo" OR nebulosa OR cometa',
    include: [/astrofotograf|astrophotograph|fotografia astronom|via lactea|nebulosa|cometa|telescopi|cielo profundo/i],
  };
  const AI = {
    q: '"inteligencia artificial" OR IA OR "machine learning" OR "aprendizaje automatico" OR "deep learning" OR OpenAI OR ChatGPT OR LLM OR "modelo generativo" OR transformer',
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

    // 2) Filtrar por tema + dentro de 48h exactas
    const within48h = (a) => hoursAgo(a.publishedAt) <= 48;
    const filteredBase = raw.filter((a) => {
      if (!within48h(a)) return false;
      const text = `${a.title || ''} ${a.description || ''}`;
      const okInclude = cfg.include ? cfg.include.some((re) => re.test(text)) : true;
      const okExclude = cfg.exclude ? !cfg.exclude.some((re) => re.test(text)) : true;
      return okInclude && okExclude;
    });

    // 3) Ranking y DEDUP (mantener la mejor)
    const scored = filteredBase.map(a => ({ a, score: relevanceScore(cfg, a) }));
    const deduped = [];
    for (const cur of scored.sort((x,y)=> y.score - x.score)) {
      const keep = !deduped.some(prev => isDuplicate(prev.a, cur.a));
      if (keep) deduped.push(cur);
    }

    const top5 = deduped.slice(0,5).map(x => x.a);

    // 4) Resumen + imagen (traducción si EN)
    async function summarize(a) {
      const en = a._lang === 'en';
      const basePrompt = en
        ? `Resume en español en 3-4 frases y traduce de forma natural; al final añade exactamente: "fuente original en inglés". No inventes datos.\nTítulo: ${a.title}\nDescripción: ${a.description ?? '(sin descripción)'}\nEnlace: ${a.url}`
        : `Resume en 3-4 frases, en español y de forma neutral. No inventes datos.\nTítulo: ${a.title}\nDescripción: ${a.description ?? '(sin descripción)'}\nEnlace: ${a.url}`;
      if (!process.env.OPENAI_API_KEY) {
        const desc = a.description || a.content || '';
        return en ? (desc ? `${desc}\n\nfuente original en inglés` : 'fuente original en inglés') : desc;
      }
      try {
        const r = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-4o-mini', messages: [ { role: 'system', content: 'Eres un asistente que resume noticias con precisión y neutralidad.' }, { role: 'user', content: basePrompt } ], temperature: 0.2 })
        });
        if (!r.ok) {
          const desc = a.description || a.content || '';
          return en ? (desc ? `${desc}\n\nfuente original en inglés` : 'fuente original en inglés') : desc;
        }
        const j = await r.json();
        const txt = j.choices?.[0]?.message?.content?.trim?.() || (a.description || '');
        return txt;
      } catch {
        const desc = a.description || a.content || '';
        return en ? (desc ? `${desc}\n\nfuente original en inglés` : 'fuente original en inglés') : desc;
      }
    }

    async function pickImage(a) {
      if (a.urlToImage) return { url: a.urlToImage, isAI: false };
      const gen = await generateImageFor(a.title, cfg.name);
      if (gen.url) return gen;
      return { url: placeholderSVG(a.title), isAI: false };
    }

    const articles = await Promise.all(
      top5.map(async (a, idx) => {
        const summary = await summarize(a);
        const img = await pickImage(a);
        return {
          id: `${a.source?.id ?? 'news'}-${idx}`,
          title: a.title,
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
