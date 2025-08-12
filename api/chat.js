// api/botpress-chat.js — GroundX + OpenAI for Botpress
// Requires env vars: GROUNDX_API_KEY, GROUNDX_BUCKET_ID, OPENAI_API_KEY
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Parse Botpress webhook payload
    const { event } = req.body;
    const query = event?.payload?.text?.trim();
    
    if (!query) {
      return res.status(400).json({ error: "Missing query text" });
    }

    // Env variables
    const GX_KEY = process.env.GROUNDX_API_KEY;
    const GX_BUCKET = process.env.GROUNDX_BUCKET_ID;
    const OA_KEY = process.env.OPENAI_API_KEY;
    const OA_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

    if (!GX_KEY || !GX_BUCKET || !OA_KEY) {
      return res.status(500).json({ error: "Missing required environment variables" });
    }

    // ---- GroundX search ----
    const gxUrl = `https://api.groundx.ai/api/v1/search/${encodeURIComponent(GX_BUCKET)}`;
    const gxResp = await fetch(gxUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": GX_KEY
      },
      body: JSON.stringify({
        query,
        n: 10,
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
      return res.json({
        responses: [{
          type: "text",
          markdown: `I couldn't find relevant information for "${query}".`
        }]
      });
    }

    // Enhanced sources with more details
    const sources = results.slice(0, 10).map((r, i) => {
      const chunkText = r.suggestedText || r.text || "";
      const chunkPreview = chunkText.length > 150 ? 
        chunkText.substring(0, 150) + "..." : 
        chunkText;

      return {
        number: i + 1,
        title: r.searchData?.title || r.fileName || `Source ${i + 1}`,
        url: r.sourceUrl || r.multimodalUrl || "",
        page: r.searchData?.pageNumber ?? r.searchData?.page ?? null,
        chunk_text: chunkPreview
      };
    });

    const context = llmText || results
      .map((r, i) => `[${i + 1}] ${r.suggestedText || r.text || ""}`)
      .join("\n\n");

    // ---- OpenAI for final answer ----
    const oaResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OA_KEY}` },
      body: JSON.stringify({
        model: OA_MODEL,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: "You are a helpful assistant. Use ONLY the provided context. Add inline citations like [1], [2] matching the numbered sources. Provide clear, well-structured responses."
          },
          {
            role: "user",
            content: `Question: ${query}\n\nContext:\n${context}\n\nNumbered sources:\n${sources.map(s => `${s.number}. ${s.title}${s.page ? ` (p.${s.page})` : ""}`).join("\n")}`
          }
        ]
      })
    });

    if (!oaResp.ok) {
      const text = await oaResp.text();
      return res.status(502).json({ error: `OpenAI call failed: ${text}` });
    }

    const oaData = await oaResp.json();
    const answer = oaData?.choices?.[0]?.message?.content?.trim() || "No answer available.";

    // Create Botpress-compatible response with clickable citations
    function createBotpressMarkdown(text, sourcesArray) {
      let markdownText = text;
      
      sourcesArray.forEach((source) => {
        const citationRegex = new RegExp(`\\[${source.number}\\]`, 'g');
        const pageInfo = source.page ? ` (p. ${source.page})` : '';
        
        // Create markdown link for Botpress
        const clickableLink = `[\\[${source.number}\\]](${source.url} "${source.title}${pageInfo}")`;
        
        markdownText = markdownText.replace(citationRegex, clickableLink);
      });
      
      return markdownText;
    }

    const botpressAnswer = createBotpressMarkdown(answer, sources);
    
    // Create sources section with clickable links
    const sourcesMarkdown = sources.map(s => {
      const pageInfo = s.page ? ` (p. ${s.page})` : '';
      const excerpt = s.chunk_text ? `\n*Excerpt: "${s.chunk_text}"*` : '';
      return `**${s.number}.** [${s.title}](${s.url})${pageInfo}${excerpt}`;
    }).join('\n\n');

    // Return Botpress-compatible response
    return res.json({
      responses: [
        {
          type: "text",
          markdown: `${botpressAnswer}\n\n---\n\n**Sources:**\n\n${sourcesMarkdown}`
        }
      ]
    });

  } catch (err) {
    console.error("Botpress chat error:", err);
    return res.status(500).json({ 
      error: err?.message || "Server error",
      responses: [{
        type: "text",
        markdown: "Sorry, I encountered an error processing your request."
      }]
    });
  }
}