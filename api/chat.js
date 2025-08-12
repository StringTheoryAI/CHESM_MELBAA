// api/chat.js — GroundX (search.content) + OpenAI
// Requires env vars: GROUNDX_API_KEY, GROUNDX_BUCKET_ID, OPENAI_API_KEY
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Parse JSON body (Vercel Node functions don't auto-parse)
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { return res.status(400).json({ error: "Invalid JSON body" }); }

    const query = (body.query || "").trim();
    if (!query) return res.status(400).json({ error: "Missing 'query' string" });

    // Env
    const GX_KEY    = process.env.GROUNDX_API_KEY;
    const GX_BUCKET = process.env.GROUNDX_BUCKET_ID; // numeric or UUID, goes in the URL path
    const OA_KEY    = process.env.OPENAI_API_KEY;
    const OA_MODEL  = process.env.OPENAI_MODEL || "gpt-4o-mini";

    if (!GX_KEY)    return res.status(500).json({ error: "Missing GROUNDX_API_KEY" });
    if (!GX_BUCKET) return res.status(500).json({ error: "Missing GROUNDX_BUCKET_ID" });
    if (!OA_KEY)    return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

    // ---- GroundX search.content ----
    // Docs: POST https://api.groundx.ai/api/v1/search/:id  (id = bucketId/groupId/documentId)
    // Header: X-API-Key
    // Body: { query, n?, verbosity?, filter?, relevance? }
    const gxUrl = `https://api.groundx.ai/api/v1/search/${encodeURIComponent(GX_BUCKET)}`;
    const gxResp = await fetch(gxUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": GX_KEY
      },
      body: JSON.stringify({
        query,
        n: 5,
        verbosity: 2
      })
    });

    if (!gxResp.ok) {
      const text = await gxResp.text();
      return res.status(502).json({ error: `GroundX search failed: ${text}` });
    }

    const gxData = await gxResp.json();
    const results = gxData?.search?.results || [];
    const llmText = gxData?.search?.text || "";

    if (!llmText && results.length === 0) {
      return res.status(200).json({
        answer_md: `I couldn’t find relevant passages for “${query}”.`,
        sources: []
      });
    }

    // Sources + context
    const sources = results.slice(0, 10).map((r, i) => ({
      number: i + 1,
      title: r.searchData?.title || r.fileName || `Source ${i + 1}`,
      url: r.sourceUrl || r.multimodalUrl || "",
      page: r.searchData?.pageNumber ?? r.searchData?.page ?? null
    }));

    const context = llmText || results
      .map((r, i) => `[${i + 1}] ${r.suggestedText || r.text || ""}`)
      .join("\n\n");

    // ---- OpenAI for final answer (Markdown with inline [n]) ----
    const oaResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OA_KEY}` },
      body: JSON.stringify({
        model: OA_MODEL,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "You are a careful academic assistant. Use ONLY the provided context. Add inline citations like [1], [2] matching the numbered sources. Output Markdown."
          },
          {
            role: "user",
            content:
`Question: ${query}

Context:
${context}

Numbered sources you may cite:
${sources.map(s => `${s.number}. ${s.title}${s.page ? ` (p.${s.page})` : ""}${s.url ? ` — ${s.url}` : ""}`).join("\n")}`
          }
        ]
      })
    });

    if (!oaResp.ok) {
      const text = await oaResp.text();
      return res.status(502).json({ error: `OpenAI call failed: ${text}` });
    }

    const oaData = await oaResp.json();
    const answer = oaData?.choices?.[0]?.message?.content?.trim() || "No answer.";

    // Reference links (clickable in Typebot)
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
