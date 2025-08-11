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

    const results = gxData.search?.results || [];

    if (results.length === 0) {
      return res.status(200).json({
        answer_md: "No relevant results found.",
        sources: [],
      });
    }

    // Build context with numbered citations
    const context = results
      .map(
        (r, i) =>
          `[${i + 1}] ${r.text || ""}\nSource: ${r.multimodalUrl || r.fileName}`
      )
      .join("\n\n");

    // --- Ask OpenAI to produce inline citations ---
    const aiRes = await openai.chat.completions.create({
      model: "gpt-4o-mini", // can change to gpt-4o
      messages: [
        {
          role: "system",
          content:
            "You are a helpful assistant. Use the provided context to answer the question and insert inline citations in the format [1], [2], etc. Match these to the sources provided. Keep output in Markdown.",
        },
        {
          role: "user",
          content: `Context:\n${context}\n\nQuestion: ${query}`,
        },
      ],
    });

    const answer = aiRes.choices[0].message.content;

    // Build clickable Markdown links for sources
    const sources = results.map((r, i) => ({
      number: i + 1,
      title: r.fileName || `Source ${i + 1}`,
      url: r.multimodalUrl || "",
    }));

    const sources_md = sources
      .map((s) => `[${s.number}]: ${s.url} "${s.title}"`)
      .join("\n");

    res.status(200).json({
      answer_md: `${answer}\n\n---\n**Sources**\n${sources_md}`,
      sources,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
