// api/chat.js — GroundX (no SDK) + OpenAI with inline [1]-style citations
// Works on Vercel Node 18/20. Requires env vars: GROUNDX_API_KEY, GROUNDX_BUCKET_ID, OPENAI_API_KEY.

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
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return res.status(400).json({ error: "Invalid JSON body" });
    }

    const query = (body.query || "").trim();
    if (!query) return res.status(400).json({ error: "Missing 'query' string" });

    // Env vars
    const GX_KEY = process.env.GROUNDX_API_KEY;
    const GX_BUCKET = process.env.GROUNDX_BUCKET_ID;
    const OA_KEY = process.env.OPENAI_API_KEY;
    const OA_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

    if (!GX_KEY) return res.status(500).json({ error: "Missing GROUNDX_API_KEY" });
    if (!GX_BUCKET) return res.status(500).json({ error: "Missing GROUNDX_BUCKET_ID" });
    if (!OA_KEY) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

    // --- GroundX search (correct path + Bearer header) ---
    const gxResp = await fetch("https://api.groundx.ai/api/v1/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GX_KEY}`  // <-- important
      },
      body: JSON.stringify({
        bucketId: Number(GX_BUCKET),
        query,
        numResults: 5
      })
    });

    if (!gxResp.ok) {
      const errText = await gxResp.text();
      return res.status(502).json({ error: `GroundX search failed: ${errText}` });
    }

    const gxData = await gxResp.json();
    const results = gxData?.search?.results || [];
    if (!Array.isArray(results) || results.length === 0) {
      return res.status(200).json({
        answer_md: `I couldn’t find relevant passages for “${query}”.`,
        sources: []
      });
    }

    // Build context and sources for the LLM
    const context = results
      .map((r, i) => `[${i + 1}] ${r.text || ""}\nSource: ${r.multimodalUrl || r.sourceUrl || r.fileName || ""}`)
      .join("\n\n");

    const sources = results.map((r, i) => ({
      number: i + 1,
      title: r.searchData?.title || r.fileName || `Source ${i + 1}`,
      url: r.multimodalUrl || r.sourceUrl || ""
    }));

    // --- OpenAI completion with inline [n] citation instruction ---
    const oaResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OA_KEY}`
      },
      body: JSON.stringify({
        model: OA_MODEL,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "You are a careful academic assistant. Use ONLY the provided context to support claims. " +
              "Add inline citations like [1], [2] that match the numbered sources. Keep output in Markdown."
          },
          { role: "user", content: `Context:\n${context}\n\nQuestion: ${query}` }
        ]
      })
    });

    if (!oaResp.ok) {
      const errText = await oaResp.text();
      return res.status(502).json({ error: `OpenAI call failed: ${errText}` });
    }

    const oaData = await oaResp.json();
    const answer = oaData?.choices?.[0]?.message?.content?.trim() || "No answer.";

    // Markdown reference links at the bottom for clickability
    const sources_md = sources
      .map((s) => `[${s.number}]: ${s.url || ""} "${s.title || ""}"`)
      .join("\n");

    return res.status(200).json({
      answer_md: `${answer}\n\n---\n**Sources**\n${sources_md}`,
      sources
    });
  } catch (err) {
    console.error("chat.js error:", err);
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
