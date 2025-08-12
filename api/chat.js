// api/chat.js
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { query } = req.body;

    // ---- Env checks ----
    const GX_KEY = process.env.GROUNDX_API_KEY;
    const GX_BUCKET = process.env.GROUNDX_BUCKET_ID;
    const OA_KEY = process.env.OPENAI_API_KEY;
    const OA_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

    if (!GX_KEY || !GX_BUCKET || !OA_KEY) {
      return res.status(500).json({
        error: "Missing required environment variables"
      });
    }

    // ---- GroundX search ----
    const gxResponse = await fetch(
      "https://api.eyelevel.ai/api/v1/search/content",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${GX_KEY}`
        },
        body: JSON.stringify({
          id: Number(GX_BUCKET),  // GroundX expects "id"
          query: query,
          n: 5                    // number of results
        })
      }
    );

    const gxData = await gxResponse.json();
    if (!gxResponse.ok) {
      throw new Error(`GroundX search failed: ${JSON.stringify(gxData)}`);
    }

    const contextText = gxData?.search?.text || "";

    // ---- OpenAI request ----
    const oaResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OA_KEY}`
      },
      body: JSON.stringify({
        model: OA_MODEL,
        messages: [
          { role: "system", content: "You are a helpful assistant. Use the provided context to answer." },
          { role: "user", content: `Context: ${contextText}\n\nQuestion: ${query}` }
        ],
        temperature: 0.2
      })
    });

    const oaData = await oaResponse.json();
    if (!oaResponse.ok) {
      throw new Error(`OpenAI request failed: ${JSON.stringify(oaData)}`);
    }

    const answer = oaData.choices?.[0]?.message?.content || "";

    res.status(200).json({
      answer,
      sources: gxData?.search?.results || []
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
