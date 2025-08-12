// api/chat.js
// GroundX (REST) + OpenAI, returns Markdown with inline [1]-style citations.

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Parse JSON body (Vercel Node funcs don’t auto-parse)
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { return res.status(400).json({ error: "Invalid JSON body" }); }

    const query = (body.query || "").trim();
    if (!query) return res.status(400).json({ error: "Missing 'query' string" });

    // Env
    const GX_KEY = process.env.GROUNDX_API_KEY;
    const GX_ID  = process.env.GROUNDX_BUCKET_ID || process.env.GROUNDX_PROJECT_ID || process.env.GROUNDX_GROUP_ID;
    const OA_KEY = process.env.OPENAI_API_KEY;
    const OA_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

    if (!GX_KEY) return res.status(500).json({ error: "Missing GROUNDX_API_KEY" });
    if (!GX_ID)  return res.status(500).json({ error: "Missing GROUNDX_BUCKET_ID / PROJECT_ID / GROUP_ID" });
    if (!OA_KEY) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

    // ---- GroundX search per docs: POST /api/v1/search/content with { id, query, n } ----
    const payload = JSON.stringify({ id: Number(GX_ID), query, n: 5 });

    async function trySearch(headers) {
      const r = await fetch("https://api.groundx.ai/api/v1/search/content", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: payload
      });
      return r.ok ? { ok: true, json: await r.json() } : { ok: false, text: await r.text(), status: r.status };
    }

    // 1) Preferred per docs: X-API-Key
    let gx = await trySearch({ "X-API-Key": GX_KEY });

    // 2) Fallback: Authorization: Bearer
    if (!gx.ok && /api key|unauthorized|authorization/i.test(gx.text || "")) {
      gx = await trySearch({ Authorization: `Bearer ${GX_KEY}` });
    }

    if (!gx.ok) {
      return res.status(502).json({ error: `GroundX search failed: ${gx.text || `HTTP ${gx.status}`}` });
    }

    const gxData = gx.json;
    const results = gxData?.search?.results || [];
    const llmText = gxData?.search?.text || "";

    if (!llmText && results.length === 0) {
      return res.status(200).json({
        answer_md: `I couldn’t find relevant passages for “${query}”.`,
        sources: []
      });
    }

    // Build compact context and source list
    const sources = results.slice(0, 10).map((r, i) => ({
      number: i + 1,
      title: r.searchData?.title || r.fileName || `Source ${i + 1}`,
      url: r.sourceUrl || r.multimodalUrl || "",
      page: r.searchData?.pageNumber ?? r.searchData?.page ?? null,
    }));

    const context = llmText || results.map((r, i) =>
      `[${i + 1}] ${r.suggestedText || r.text || ""}`
    ).join("\n\n");

    // ---- OpenAI completion with inline citations ----
    const oaResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OA_KEY}` },
      body: JSON.stringify({
        model: OA_MODEL,
        temperature: 0.2,
        messages: [
          { role: "system",
            content: "You are a careful academic assistant. Use ONLY the provided context. Add inline citations like [1], [2] matching the numbered sources. Keep output in Markdown." },
          { role: "user",
            content: `Question: ${query}\n\nContext:\n${context}\n\nNumbered sources you may cite:\n${sources.map(s =>
              `${s.number}. ${s.title}${s.page ? ` (p.${s.page})` : ""}${s.url ? ` — ${s.url}` : ""}`
            ).join("\n")}`
          }
        ]
      })
    });

    if (!oaResp.ok) {
      const errText = await oaResp.text();
      return res.status(502).json({ error: `OpenAI call failed: ${errText}` });
    }

    const oaData = await oaResp.json();
    const answer = oaData?.choices?.[0]?.message?.content?.trim() || "No answer.";

    // Markdown reference links (clickable in Typebot)
    const sources_md = sources.map(s => `[${s.number}]: ${s.url || ""} "${s.title || ""}"`).join("\n");

    return res.status(200).json({
      answer_md: `${answer}\n\n---\n**Sources**\n${sources_md}`,
      sources
    });

  } catch (err) {
    console.error("chat.js error:", err);
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
