export default async function handler(req, res) {
  try {
    const { query } = req.body;

    // 1. Search GroundX
    const gxRes = await fetch(`https://api.groundx.ai/v1/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROUNDX_API_KEY}`,
      },
      body: JSON.stringify({
        bucketId: parseInt(process.env.GROUNDX_BUCKET_ID, 10),
        query,
        numResults: 5,
      }),
    });

    if (!gxRes.ok) {
      throw new Error(`GroundX search failed: ${await gxRes.text()}`);
    }

    const gxData = await gxRes.json();

    // 2. Combine into OpenAI prompt
    const context = gxData.results
      .map((r, i) => `[${i + 1}] ${r.text}`)
      .join("\n\n");

    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Answer using markdown and cite sources." },
          { role: "user", content: `${query}\n\nContext:\n${context}` },
        ],
      }),
    });

    const openaiData = await openaiRes.json();

    // 3. Return answer + sources
    res.status(200).json({
      answer_md: openaiData.choices?.[0]?.message?.content || "",
      sources: gxData.results.map((r) => ({
        title: r.documentTitle,
        url: r.sourceUrl,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
