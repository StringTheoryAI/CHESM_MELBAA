// api/chat.js
// Robust JSON parsing + clear errors + GroundX fetch (no SDK) + OpenAI answer with citations

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    // ---- Parse JSON body (Vercel doesn't auto-parse for Node functions) ----
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return res.status(400).json({ error: "Invalid JSON body" });
    }

    const query = (body && body.query || "").trim();
    if (!query) return res.status(400).json({ error: "Missing 'query' string" });

    // ---- Env checks ----
    const GX_KEY = process.env.GROUNDX_API_KEY;
    const GX_BUCKET = process.env.GROUNDX_BUCKET_ID;
    const OA_KEY = process.env.OPENAI_API_KEY;

    if (!GX_KEY) return res.status(500).json({ error: "Missing GROUNDX_API_KEY" });
    if (!GX_BUCKET) return res.status(500).json({ error: "Missing GROUNDX_BUCKET_ID" });
    if (!OA_KEY) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

    // ---- GroundX search ----
    const gxResp = await fetch("https://api.groundx.ai/api/v1/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GX_KEY}`,
      },
      body: JSON.stringify({
        bucketId: Number(GX_BUCKET),
        query,
        numResults: 5,
      }),
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
        sources: [],
      });
    }

    // Build context and sources
    const context = results
      .map((r, i) => `[${i + 1}] ${r.text || ""}\nSource: ${r.multimodalUrl || r.sourceUrl || r.fileName || ""}`)
      .join("\n\n");

    const sources = results.map((r, i) => ({
      number: i + 1,
      title: r.fileName || r.searchData?.title || `Source ${i + 1}`,
      url: r.multimodalUrl || r.sourceUrl || "",
    }));

    // ---- OpenAI completion ----
    const oaResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OA_KEY}`,
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "You are a careful academic assistant. Use ONLY the provided context. Add inline citations like [1], [2] matching the numbered source list. Keep output in Markdown.",
          },
          {
            role: "user",
            content: `Context:\n${context}\n\nQuestion: ${query}`,
          },
        ],
      }),
    });

    if (!oaResp.ok) {
      const errText = await oaResp.text();
      return res.status(502).json({ error: `OpenAI call failed: ${errText}` });
    }

    const oaData = await oaResp.json();
    const answer = oaData?.choices?.[0]?.message?.content?.trim() || "No answer.";

    const sources_md = sources
      .map((s) => `[${s.number}]: ${s.url || ""} "${s.title || ""}"`)
      .join("\n");

    return res.status(200).json({
      answer_md: `${answer}\n\n---\n**Sources**\n${sources_md}`,
      sources,
    });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
