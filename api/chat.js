// api/chat.js

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { query } = req.body;
    if (!query) {
      return res.status(400).json({ error: "Missing 'query' in request body" });
    }

    // ---- Env checks ----
    const GX_KEY = process.env.GROUNDX_API_KEY;
    const GX_BUCKET = process.env.GROUNDX_BUCKET_ID;
    const OA_KEY = process.env.OPENAI_API_KEY;
    const OA_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

    if (!GX_KEY || !GX_BUCKET || !OA_KEY) {
      return res.status(500).json({
        error: "Missing one or more required environment variables"
      });
    }

    // --- Helper: GroundX search with auth/host permutations ---
    async function gxSearch({ key, bucketId, query }) {
      const payload = JSON.stringify({
        bucketId: Number(bucketId),
        query,
        numResults: 5
      });

      const tries = [
        {
          url: "https://api.groundx.ai/api/v1/search",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }
        },
        {
          url: "https://api.groundx.ai/api/v1/search",
          headers: { "Content-Type": "application/json", "x-api-key": key }
        },
        {
          url: "https://api.eyelevel.ai/api/v1/search",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }
        },
        {
          url: "https://api.eyelevel.ai/api/v1/search",
          headers: { "Content-Type": "application/json", "x-api-key": key }
        },
        {
          url: "https://api.groundx.ai/api/v1/search",
          headers: { "Content-Type": "application/json", Authorization: `Token ${key}` }
        }
      ];

      let lastText = "";
      for (const t of tries) {
        const r = await fetch(t.url, { method: "POST", headers: t.headers, body: payload });
        if (r.ok) return r.json();
        lastText = await r.text();
        if (!/api key|unauthorized|authorization/i.test(lastText)) {
          throw new Error(`GroundX search failed: ${lastText}`);
        }
      }
      throw new Error(`GroundX auth failed after retries: ${lastText}`);
    }

    // --- Run GroundX search ---
    const gxData = await gxSearch({ key: GX_KEY, bucketId: GX_BUCKET, query });
    const results = gxData?.search?.results || gxData?.results || [];

    if (!Array.isArray(results) || results.length === 0) {
      return res.status(200).json({
        answer_md: `I couldn’t find relevant passages for “${query}”.`,
        sources: []
      });
    }

    // --- Build context for OpenAI ---
    const context = results
      .map((r, i) => `Source ${i + 1}: ${r.text || r.chunk || ""}`)
      .join("\n\n");

    // --- Call OpenAI ---
    const oaRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OA_KEY}`
      },
      body: JSON.stringify({
        model: OA_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You are a helpful assistant. Use the provided context to answer the query. Cite sources as [Source #]."
          },
          { role: "user", content: `Context:\n${context}\n\nQuery: ${query}` }
        ],
        temperature: 0
      })
    });

    if (!oaRes.ok) {
      const errText = await oaRes.text();
      throw new Error(`OpenAI API failed: ${errText}`);
    }

    const oaJson = await oaRes.json();
    const answer = oaJson.choices?.[0]?.message?.content || "";

    // --- Return answer + sources ---
    res.status(200).json({
      answer_md: answer,
      sources: results.map((r, i) => ({
        id: i + 1,
        text: r.text || r.chunk || "",
        sourceUrl: r.sourceUrl || r.url || null
      }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Server error" });
  }
}
