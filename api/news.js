// api/news.js — versión robusta con diagnósticos y mejor manejo de errores
// - Soporta ?topic=ping (salud) y ?topic=__diag (diagnóstico rápido)
// - Si NewsAPI falla, devuelve 200 con articles: [] para que el front NO entre en modo demo
// - Si OpenAI falla, usa la descripción de la noticia

module.exports = async (req, res) => {
  try {
    const topic = (req.query?.topic || 'tecnología').toString();

    // 0) Rutas utilitarias
    if (topic === 'ping') {
      return res.status(200).json({ ok: true, articles: [] });
    }
    if (topic === '__diag') {
      return res.status(200).json({
        ok: true,
        hasOpenAI: Boolean(process.env.OPENAI_API_KEY),
        hasNewsAPI: Boolean(process.env.NEWSAPI_KEY),
        env: process.env.VERCEL_ENV || 'unknown'
      });
    }

    // 1) Traer artículos recientes (últimos 7 días) en español desde NewsAPI
    const from = new Date();
    from.setDate(from.getDate() - 7);
    const params = new URLSearchParams({
      q: topic,
      language: 'es',
      sortBy: 'publishedAt',
      searchIn: 'title,description,content',
      from: from.toISOString().slice(0,10),
      pageSize: '8',
    });
    const newsURL = `https://newsapi.org/v2/everything?${params}`;

    let raw = [];
    try {
      const newsRes = await fetch(newsURL, {
        headers: { 'X-Api-Key': process.env.NEWSAPI_KEY || '' },
      });
      if (!newsRes.ok) {
        // No rompemos la UX: devolvemos 200 con lista vacía y el motivo
        const txt = await newsRes.text();
        return res.status(200).json({ articles: [], warning: `NewsAPI error: ${txt}` });
      }
      const news = await newsRes.json();
      raw = (news.articles || []).slice(0, 8);
    } catch (err) {
      // Falla la llamada a NewsAPI (red, DNS, etc.)
      return res.status(200).json({ articles: [], warning: `NewsAPI fetch failed: ${String(err)}` });
    }

    // 2) Resumir cada artículo con OpenAI (si hay clave); si no, usar descripción
    async function summarize(a) {
      const prompt = `Resume en 3-4 frases, en español y de forma neutral, la noticia basada en el título y la descripción. No inventes datos.\nTítulo: ${a.title}\nDescripción: ${a.description ?? '(sin descripción)'}\nEnlace: ${a.url}`;

      if (!process.env.OPENAI_API_KEY) {
        return a.description || a.content || '';
      }

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
      } catch {
        return a.description || a.content || '';
      }
    }

    const articles = await Promise.all(
      raw.map(async (a, idx) => ({
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
