// api/news.js — FILTRO POR CATEGORÍA (Tecnología / Astrofotografía / IA)
// Copia y pega TODO este archivo en /api/news.js de tu repositorio.
// Objetivo: que si eliges "Tecnología" salgan solo noticias de tecnología;
// lo mismo para "Astrofotografía" e "Inteligencia Artificial".

// Utilidades para mapear el tema que viene del front a una consulta y a filtros
function normalizeTopic(s = '') {
  return s
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quita acentos
    .toLowerCase()
    .trim();
}

function getTopicConfig(topicRaw) {
  const t = normalizeTopic(topicRaw);

  // Palabras clave y filtros por tema
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
  // Tema libre (Otros temas)
  return { name: topicRaw, q: topicRaw, include: [new RegExp(topicRaw, 'i')] };
}

module.exports = async (req, res) => {
  try {
    const topicRaw = (req.query?.topic || 'tecnología').toString();

    // 0) Rutas utilitarias de salud/diag
    if (topicRaw === 'ping') return res.status(200).json({ ok: true, articles: [] });
    if (topicRaw === '__diag') {
      return res.status(200).json({
        ok: true,
        hasOpenAI: Boolean(process.env.OPENAI_API_KEY),
        hasNewsAPI: Boolean(process.env.NEWSAPI_KEY),
        env: process.env.VERCEL_ENV || 'unknown'
      });
    }

    // 1) Construir consulta según tema
    const cfg = getTopicConfig(topicRaw);

    // 2) Llamar a NewsAPI (últimos 3 días, español, buscando sobre todo en títulos y descripción)
    const from = new Date();
    from.setDate(from.getDate() - 3);
    const params = new URLSearchParams({
      q: cfg.q,
      language: 'es',
      sortBy: 'publishedAt',
      searchIn: 'title,description',
      from: from.toISOString().slice(0,10),
      pageSize: '50', // traer más y luego filtrar
    });
    const newsURL = `https://newsapi.org/v2/everything?${params}`;

    let raw = [];
    try {
      const newsRes = await fetch(newsURL, { headers: { 'X-Api-Key': process.env.NEWSAPI_KEY || '' } });
      if (!newsRes.ok) {
        const txt = await newsRes.text();
        return res.status(200).json({ articles: [], warning: `NewsAPI error: ${txt}` });
      }
      const news = await newsRes.json();
      raw = (news.articles || []);
    } catch (err) {
      return res.status(200).json({ articles: [], warning: `NewsAPI fetch failed: ${String(err)}` });
    }

    // 3) Filtro extra en servidor (por si NewsAPI mete ruido) + ranking por relevancia y recencia (72h)
    function hoursAgo(iso) {
      const t = new Date(iso).getTime();
      if (!t) return 9999;
      return (Date.now() - t) / (1000 * 60 * 60);
    }

    function relevanceScore(cfg, a) {
      const title = (a.title || "");
      const desc = (a.description || "");
      let score = 0;
      // Coincidencias en título pesan más que en descripción
      if (cfg.include) {
        cfg.include.forEach((re) => {
          if (re.test(title)) score += 3;
          else if (re.test(desc)) score += 1.5;
        });
      }
      if (cfg.exclude) {
        cfg.exclude.forEach((re) => {
          if (re.test(title) || re.test(desc)) score -= 5;
        });
      }
      // Recencia: dentro de 72h obtiene bonificación (0..2)
      const h = hoursAgo(a.publishedAt);
      if (isFinite(h)) {
        const rec = Math.max(0, 72 - h) / 72; // 0..1
        score += rec * 2;
      }
      return score;
    }

    const filteredBase = raw.filter((a) => {
      const text = `${a.title || ''} ${a.description || ''}`;
      const okInclude = cfg.include ? cfg.include.some((re) => re.test(text)) : true;
      const okExclude = cfg.exclude ? !cfg.exclude.some((re) => re.test(text)) : true;
      return okInclude && okExclude;
    });

    // Ordenar por score descendente y quedarnos con TOP 5
    const filtered = filteredBase
      .map((a) => ({ a, score: relevanceScore(cfg, a) }))
      .sort((x, y) => y.score - x.score)
      .slice(0, 5)
      .map((x) => x.a);

    // 4) Resumen con OpenAI si hay clave; si no, usar descripción
    async function summarize(a) {
      const prompt = `Resume en 3-4 frases, en español y de forma neutral, la noticia basada en el título y la descripción. No inventes datos.\nTítulo: ${a.title}\nDescripción: ${a.description ?? '(sin descripción)'}\nEnlace: ${a.url}`;
      if (!process.env.OPENAI_API_KEY) return a.description || a.content || '';
      try {
        const r = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
              { role: 'system', content: 'Eres un asistente que resume noticias con precisión y neutralidad.' },
              { role: 'user', content: prompt },
            ],
            temperature: 0.2,
          }),
        });
        if (!r.ok) return a.description || a.content || '';
        const j = await r.json();
        return j.choices?.[0]?.message?.content?.trim?.() || a.description || '';
      } catch { return a.description || a.content || ''; }
    }

    const articles = await Promise.all(
      filtered.map(async (a, idx) => ({
        id: `${a.source?.id ?? 'news'}-${idx}`,
        title: a.title,
        publishedAt: a.publishedAt,
        sourceName: a.source?.name ?? 'Desconocida',
        url: a.url,
        summary: await summarize(a),
      }))
    );

    return res.status(200).json({ articles });
  } catch (e) {
    return res.status(200).json({ articles: [], warning: `Server error: ${String(e)}` });
  }
};
