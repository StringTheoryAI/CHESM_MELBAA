// api/chat.js
// Serverless endpoint for Typebot → GroundX (RAG) → OpenAI → Markdown + clickable citations

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { query } = req.body;
    if (!query) {
      return res.status(400).json({ error: "Missing query" });
    }

    // Step 1 — Search GroundX
    const gxResp = await fetch("https://api.eyelevel.ai/search/content", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROUNDX_API_KEY}`,
      },
      body: JSON.stringify({
        bucketId: parseInt(process.env.GROUNDX_BUCKET_ID, 10),
        query,
        numResults: 5
      }),
    });

    if (!gxResp.ok) {
      const errText = await gxResp.text();
      throw new Error(`GroundX search failed: ${errText}`);
    }

    const gxData = await gxResp.json();

    // Step 2 — Build context string with citations
    const context = gxData.search.results
      .map((r, i) => {
        const url = r.sourceUrl || r.url || "#";
        return `[${i + 1}] ${r.text}\nSource: ${url}`;
      })
      .join("\n\n");

    // Step 3 — Ask OpenAI to answer with inline citation numbers
    const openaiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "You are an academic assistant. Use the provided sources to answer the user's question. Always cite sources as [1], [2], etc., matching the numbering in the context."
          },
          {
            role: "user",
            content: `Question: ${query}\n\nContext:\n${context}`
          }
        ],
        temperature: 0.2,
      }),
    });

    if (!openaiResp.ok) {
      const errText = await openaiResp.text();
      throw new Error(`OpenAI call failed: ${errText}`);
    }

    const openaiData = await openaiResp.json();
    const answer = openaiData.choices?.[0]?.message?.content || "No answer.";

    // Step 4 — Return Markdown answer + clickable sources
    const sources = gxData.search.results.map((r, i) => ({
      number: i + 1,
      url: r.sourceUrl || r.url || "#",
    }));

    res.status(200).json({
      answer_md: answer,
      sources
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Unknown error" });
  }
}
