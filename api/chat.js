export default async function handler(req, res) {
  try {
    const { query } = req.body;

    // ---- Env checks ----
    const GX_KEY = process.env.GROUNDX_API_KEY;
    const GX_BUCKET = process.env.GROUNDX_BUCKET_ID;
    const OA_KEY = process.env.OPENAI_API_KEY;
    const OA_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

    if (!GX_KEY || !GX_BUCKET || !OA_KEY) {
      return res.status(500).json({
        error: "Missing environment variables. Check Vercel settings."
      });
    }

    // ---- Step 1: Call GroundX Search ----
    const gxUrl = `https://api.groundx.ai/api/v1/search`;
    const gxResp = await fetch(gxUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GX_KEY}`  // ✅ Correct format
      },
      body: JSON.stringify({
        bucketId: GX_BUCKET,
        query,
        count: 5
      })
    });

    const gxData = await gxResp.json();
    if (!gxResp.ok) {
      return res.status(500).json({
        error: `GroundX search failed: ${JSON.stringify(gxData, null, 2)}`
      });
    }

    // ---- Step 2: Prepare context for OpenAI ----
    const sourcesText = gxData.results
      .map((r, i) => `Source ${i + 1}: ${r.content}`)
      .join("\n\n");

    const prompt = `Answer the question using the sources below.\n\nQuestion: ${query}\n\nSources:\n${sourcesText}`;

    // ---- Step 3: Call OpenAI ----
    const oaResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OA_KEY}`
      },
      body: JSON.stringify({
        model: OA_MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2
      })
    });

    const oaData = await oaResp.json();
    if (!oaResp.ok) {
      return res.status(500).json({
        error: `OpenAI call failed: ${JSON.stringify(oaData, null, 2)}`
      });
    }

    // ---- Step 4: Respond ----
    res.status(200).json({
      answer: oaData.choices[0].message.content,
      citations: gxData.results.map(r => r.fileName || r.documentId)
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
}
