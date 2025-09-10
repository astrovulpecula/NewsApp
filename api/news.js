// api/news.js — 24h ROBUSTO
// - SOLO noticias de las últimas 24h (filtrado estricto en servidor)
// - Cupos: máx 5 (ideal 3 ES + 2 EN, si faltan se rellena con lo mejor disponible)
// - EN: traduce SIEMPRE el TITULAR al español y añade " (ENG)" al final del título
// - Resumen SIEMPRE en 5–10 líneas (una frase por línea). Si es inglesa, termina con "fuente original en inglés"
// - Imágenes: original -> IA si ENABLE_AI_IMAGES=1 -> placeholder
// - DEBUG: añade ?debug=1 para ver contadores internos
// - FALLBACK: si no hay resultados, intenta Top Headlines (tecnología) en ES (ES/MX) y EN (US/GB)

// -------------- utilidades de tema --------------
function normalizeTopic(s = '') { return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim(); }
function getTopicConfig(topicRaw) {
  const t = normalizeTopic(topicRaw);
  const TECNO = {
    key: 'technology',
    q: '"tecnologia" OR tecnologia OR smartphone OR "telefono inteligente" OR Android OR iPhone OR Apple OR Google OR Microsoft OR software OR hardware OR gadget OR chip OR semiconductor OR ciberseguridad OR internet',
    include: [ /tecnolog/i, /smartphone/i, /m[óo]vil|telefono inteligente/i, /android/i, /iphone|ios|apple/i, /microsoft|windows/i, /google|pixel/i, /software|hardware|gadget|chip|semiconductor|ciberseguridad|internet|router|wifi/i ],
    exclude: [/f[úu]tbol|tenis|baloncesto|moda|celebridad|cocina|viajes/i],
  };
  const ASTRO = { key: 'astro', q: 'astrofotografia OR astrophotography OR "fotografia astronomica" OR telescopio OR "via lactea" OR "cielo profundo" OR nebulosa OR cometa', include: [/astrofotograf|astrophotograph|fotografia astronom|via lactea|nebulosa|cometa|telescopi|cielo profundo/i] };
  const AI = { key: 'ai', q: '"inteligencia artificial" OR IA OR "machine learning" OR "aprendizaje automatico" OR "deep learning" OR OpenAI OR ChatGPT OR LLM OR "modelo generativo" OR transformer', include: [/inteligencia artificial|\bIA\b|machine learning|aprendizaje automatico|deep learning|openai|chatgpt|modelo generativo|\bLLM\b|transformer/i] };
  if (/astro/.test(t)) return { name: 'Astrofotografía', ...ASTRO };
  if (/(^|\s)ai(\s|$)/.test(t) || /inteligencia artificial|aprendizaje|machine/.test(t)) return { name: 'Inteligencia Artificial', ...AI };
  if (/tecno/.test(t)) return { name: 'Tecnología', ...TECNO };
  return { name: topicRaw, key: 'custom', q: topicRaw, include: [new RegExp(topicRaw, 'i')] };
}

// -------------- helpers --------------
function hoursAgo(iso) { const t = new Date(iso).getTime(); return t ? (Date.now() - t) / 36e5 : 9999; }
function relevanceScore(cfg, a) {
  const title = a.title || '', desc = a.description || '';
  let s = 0; if (cfg.include) cfg.include.forEach(re => { if (re.test(title)) s += 3; else if (re.test(desc)) s += 1.5; });
  if (cfg.exclude) cfg.exclude.forEach(re => { if (re.test(title) || re.test(desc)) s -= 5; });
  const h = hoursAgo(a.publishedAt); if (isFinite(h)) s += Math.max(0, 24 - h) / 24 * 3; // 0..3
  return s;
}
function placeholderSVG(title = '') { const t = (title || 'Noticia').replace(/</g,'&lt;').slice(0,60); const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='1024' height='576'>\n<defs><linearGradient id='g' x1='0' x2='1' y1='0' y2='1'><stop stop-color='#eef2ff' offset='0'/><stop stop-color='#e2e8f0' offset='1'/></linearGradient></defs><rect fill='url(#g)' width='100%' height='100%'/><text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' font-family='system-ui,Arial' font-size='36' fill='#334155'>${t}</text></svg>`; return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`; }
async function generateImageFor(title, topicName) {
  if (process.env.ENABLE_AI_IMAGES !== '1' || !process.env.OPENAI_API_KEY) return { url: null, isAI: false };
  try {
    const r = await fetch('https://api.openai.com/v1/images/generations', { method: 'POST', headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-image-1', prompt: `Ilustración editorial clara y minimalista relacionada con ${topicName}. Tema/noticia: ${title}. Sin texto ni logos.`, size: '512x288' }) });
    if (!r.ok) return { url: null, isAI: false }; const j = await r.json(); const url = j.data?.[0]?.url || null; return { url, isAI: !!url };
  } catch { return { url: null, isAI: false }; }
}
function normTitle(s=''){return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim();}
function titleSimilarity(a,b){const A=new Set(normTitle(a).split(' ')),B=new Set(normTitle(b).split(' '));if(!A.size||!B.size)return 0;let i=0;A.forEach(w=>{if(B.has(w))i++});return i/(A.size+B.size-i)}
function isDuplicate(prev,cur){ if(prev.url&&cur.url&&prev.url.split('?')[0]===cur.url.split('?')[0])return true; return titleSimilarity(prev.title||'',cur.title||'')>=0.7; }

// -------------- fetchers --------------
async function fetchEverything(cfg, lang){
  // Pedimos 2 días hacia atrás (NewsAPI filtra por día, no hora). Luego nosotros filtramos 24h exactas.
  const from = new Date(); from.setDate(from.getDate()-2);
  const p = new URLSearchParams({ q: cfg.q, language: lang, sortBy: 'publishedAt', searchIn: 'title,description', from: from.toISOString().slice(0,10), pageSize: '100' });
  const url = `https://newsapi.org/v2/everything?${p}`;
  const r = await fetch(url, { headers: { 'X-Api-Key': process.env.NEWSAPI_KEY || '' } }); if(!r.ok) throw new Error(await r.text());
  const j = await r.json(); return (j.articles||[]).map(a=>({...a,_lang:lang}));
}
async function fetchTopHeadlinesTechnology(lang){
  // Fallback para Tecnología: titulares principales por país
  const countries = lang==='es' ? ['es','mx'] : ['us','gb'];
  let out=[]; for(const c of countries){
    const p = new URLSearchParams({ country:c, category:'technology', pageSize:'50' });
    const url = `https://newsapi.org/v2/top-headlines?${p}`;
    const r = await fetch(url, { headers: { 'X-Api-Key': process.env.NEWSAPI_KEY || '' } }); if(!r.ok) continue;
    const j = await r.json(); out = out.concat((j.articles||[]).map(a=>({...a,_lang:lang})));
  } return out;
}

// ---- Formateo ----
function formatToLines(text, min=5, max=10){ if(!text) return ''; const parts=(text.replace(/\n+/g,' ').split(/(?<=[.!?])\s+/).filter(Boolean)).map(s=>s.trim()); let lines=parts.slice(0,max); if(lines.length<min){ const extra=text.split(/[,;]\s+/).filter(Boolean); for(const e of extra){ if(lines.length>=min)break; if(!lines.includes(e)) lines.push(e); } lines=lines.slice(0,Math.max(min,Math.min(max,lines.length))); } return lines.join('\n'); }
async function translateTitleToEs(a){ if(a._lang!=='en') return a.title||''; if(!process.env.OPENAI_API_KEY) return a.title||''; try{ const r=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{'Authorization':`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-4o-mini',messages:[{role:'system',content:'Traduce títulos del inglés al español con naturalidad. Devuelve SOLO el título.'},{role:'user',content:`${a.title||''}`}],temperature:0.1})}); if(!r.ok) return a.title||''; const j=await r.json(); return j.choices?.[0]?.message?.content?.trim?.()||a.title||''; }catch{ return a.title||''; }}

module.exports = async (req,res)=>{
  try{
    const topicRaw = (req.query?.topic||'tecnología').toString();
    const debugOn = req.query?.debug==='1';
    if(topicRaw==='ping') return res.status(200).json({ok:true,articles:[]});
    if(topicRaw==='__diag') return res.status(200).json({ ok:true, hasOpenAI:!!process.env.OPENAI_API_KEY, hasNewsAPI:!!process.env.NEWSAPI_KEY, aiImages: process.env.ENABLE_AI_IMAGES==='1', env: process.env.VERCEL_ENV||'unknown' });

    const cfg = getTopicConfig(topicRaw);

    let rawEs=[], rawEn=[], errMsg=null;
    try { [rawEs, rawEn] = await Promise.all([ fetchEverything(cfg,'es'), fetchEverything(cfg,'en') ]); }
    catch(e){ errMsg = String(e); }

    // Si falló Everything o no hay nada, y el tema es Tecnología, probamos fallback TopHeadlines
    if((!rawEs.length && !rawEn.length) && cfg.key==='technology'){
      try { [rawEs, rawEn] = await Promise.all([ fetchTopHeadlinesTechnology('es'), fetchTopHeadlinesTechnology('en') ]); } catch {}
    }

    const within24h = a => hoursAgo(a.publishedAt) <= 24;
    const byTopic = (a)=>{ const text=`${a.title||''} ${a.description||''}`; const okInc = cfg.include? cfg.include.some(re=>re.test(text)) : true; const okExc = cfg.exclude? !cfg.exclude.some(re=>re.test(text)) : true; return okInc && okExc; };

    const filteredEs = rawEs.filter(within24h).filter(byTopic);
    const filteredEn = rawEn.filter(within24h).filter(byTopic);

    const scoredEs = filteredEs.map(a=>({a,score:relevanceScore(cfg,a)})).sort((x,y)=>y.score-x.score);
    const scoredEn = filteredEn.map(a=>({a,score:relevanceScore(cfg,a)})).sort((x,y)=>y.score-x.score);

    const chosen=[]; const isDup=(cand)=>chosen.some(p=>isDuplicate(p,cand));
    function take(list,max){ for(const it of list){ if(chosen.length>=max) break; if(isDup(it.a)) continue; chosen.push(it.a); } }
    take(scoredEs,3); take(scoredEn,5); // mete 3 ES + hasta 2 EN (se recorta luego a 5)

    let rest=[...scoredEs.filter(x=>!chosen.includes(x.a)),...scoredEn.filter(x=>!chosen.includes(x.a))].sort((x,y)=>y.score-x.score);
    while(chosen.length<5 && rest.length){ const n=rest.shift(); if(isDup(n.a)) continue; chosen.push(n.a); }

    const top5 = chosen.slice(0,5);

    async function summarize(a){ const en=a._lang==='en'; const prompt = en ? `Traduce Y resume en ESPAÑOL en 5 a 10 líneas. Cada línea = UNA frase breve separada por SALTO DE LÍNEA. No inventes datos. Al final añade: "fuente original en inglés".\nTítulo: ${a.title}\nDescripción: ${a.description ?? '(sin descripción)'}\nEnlace: ${a.url}` : `Resume en ESPAÑOL en 5 a 10 líneas. Cada línea = UNA frase breve separada por SALTO DE LÍNEA. No inventes datos.\nTítulo: ${a.title}\nDescripción: ${a.description ?? '(sin descripción)'}\nEnlace: ${a.url}`;
      if(!process.env.OPENAI_API_KEY){ const base = formatToLines(a.description||a.content||'',5,10); return en? (base? `${base}\n\nfuente original en inglés`:'fuente original en inglés') : base; }
      try{ const r=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{'Authorization':`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-4o-mini',messages:[{role:'system',content:'Eres un asistente que traduce y resume noticias al español con precisión. Devuelve 5–10 líneas (una frase por línea).'}, {role:'user',content:prompt}],temperature:0.2})}); if(!r.ok){ const base=formatToLines(a.description||a.content||'',5,10); return en? (base? `${base}\n\nfuente original en inglés`:'fuente original en inglés') : base; } const j=await r.json(); const txt=j.choices?.[0]?.message?.content?.trim?.()||''; return formatToLines(txt,5,10); }catch{ const base=formatToLines(a.description||a.content||'',5,10); return en? (base? `${base}\n\nfuente original en inglés`:'fuente original en inglés') : base; }
    }
    async function pickImage(a){ if(a.urlToImage) return {url:a.urlToImage,isAI:false}; const gen=await generateImageFor(a.title,cfg.name); if(gen.url) return gen; return {url:placeholderSVG(a.title),isAI:false}; }

    const articles = await Promise.all(top5.map(async (a,idx)=>{ const [tEs,summary,img]=await Promise.all([translateTitleToEs(a), summarize(a), pickImage(a)]); const titleOut = a._lang==='en' ? `${tEs||a.title} (ENG)` : (tEs||a.title); return { id:`${a.source?.id ?? 'news'}-${idx}`, title:titleOut, publishedAt:a.publishedAt, sourceName:a.source?.name ?? 'Desconocida', url:a.url, summary, imageUrl: img.url, imageIsAI: img.isAI }; }));

    const payload = { articles };
    if(debugOn) payload.debug = { errMsg, esRaw: rawEs.length, enRaw: rawEn.length, es24: filteredEs.length, en24: filteredEn.length, chosen: top5.length };
    return res.status(200).json(payload);
  }catch(e){ return res.status(200).json({ articles: [], warning: `Server error: ${String(e)}` }); }
};
