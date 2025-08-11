// api/chat.js
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { query } = req.body;

    if (!query) {
      return res.status(400).json({ error: "Missing query" });
    }

    // --- GroundX search ---
    const gxRes = await fetch(`https://api.groundx.ai/api/v1/search`, {
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
      const errorText = await gxRes.text();
      throw new Error(`GroundX search failed: ${errorText}`);
    }

    const gxData = await gxRes.json();

    // Combine sources for LLM context
    const context = gxData.search.results
      .map(r => r.text || "")
      .join("\n\n");

    // --- Ask OpenAI ---
    const aiRes = await openai.chat.completions.create({
      model: "gpt-4o-mini", // can change to gpt-4o or gpt-4
      messages: [
        { role: "system", content: "Answer the question using the provided context." },
        { role: "user", content: `Context:\n${context}\n\nQuestion: ${query}` },
      ],
    });

    const answer = aiRes.choices[0].message.content;

    res.status(200).json({
      answer_md: answer,
      sources: gxData.search.results.map(r => ({
        id: r.documentId,
        fileName: r.fileName,
        url: r.multimodalUrl,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
