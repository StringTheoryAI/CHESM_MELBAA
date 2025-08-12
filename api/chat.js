// api/chat.js — GroundX (search.content) + OpenAI with CORS support and clean citations
// Requires env vars: GROUNDX_API_KEY, GROUNDX_BUCKET_ID, OPENAI_API_KEY
export default async function handler(req, res) {
  // Add CORS headers for Botpress and other clients
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  
  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

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
    try { body = raw ? JSON.parse(raw) : {}; } catch { return res.status(400).json({ error: "Invalid JSON body" }); }

    const query = (body.query || "").trim();
    if (!query) return res.status(400).json({ error: "Missing 'query' string" });

    // Env
    const GX_KEY    = process.env.GROUNDX_API_KEY;
    const GX_BUCKET = process.env.GROUNDX_BUCKET_ID; // numeric or UUID, goes in the URL path
    const OA_KEY    = process.env.OPENAI_API_KEY;
    const OA_MODEL  = process.env.OPENAI_MODEL || "gpt-4o-mini";

    if (!GX_KEY)    return res.status(500).json({ error: "Missing GROUNDX_API_KEY" });
    if (!GX_BUCKET) return res.status(500).json({ error: "Missing GROUNDX_BUCKET_ID" });
    if (!OA_KEY)    return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

    // ---- GroundX search.content ----
    // Docs: POST https://api.groundx.ai/api/v1/search/:id  (id = bucketId/groupId/documentId)
    // Header: X-API-Key
    // Body: { query, n?, verbosity?, filter?, relevance? }
    const gxUrl = `https://api.groundx.ai/api/v1/search/${encodeURIComponent(GX_BUCKET)}`;
    const gxResp = await fetch(gxUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": GX_KEY
      },
      body: JSON.stringify({
        query,
        n: 10, // Increased for more sources
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
      return res.status(200).json({
        data: {
          answer_md: `I couldn't find relevant passages for "${query}".`,
          answer_html: `I couldn't find relevant passages for "${query}".`,
          answer_clean_inline: `I couldn't find relevant passages for "${query}".`,
          answer_hover_citations: `I couldn't find relevant passages for "${query}".`,
          sources: []
        }
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
        chunk_text: chunkPreview,
        confidence: r.score || null
      };
    });

    const context = llmText || results
      .map((r, i) => `[${i + 1}] ${r.suggestedText || r.text || ""}`)
      .join("\n\n");

    // ---- OpenAI for final answer (Markdown with inline [n]) ----
    const oaResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OA_KEY}` },
      body: JSON.stringify({
        model: OA_MODEL,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "You are a careful academic assistant. Use ONLY the provided context. Add inline citations like [1], [2] matching the numbered sources. Output clear, well-structured text with proper citations."
          },
          {
            role: "user",
            content:
`Question: ${query}

Context:
${context}

Numbered sources you may cite:
${sources.map(s => `${s.number}. ${s.title}${s.page ? ` (p.${s.page})` : ""}${s.url ? ` — ${s.url}` : ""}`).join("\n")}`
          }
        ]
      })
    });

    if (!oaResp.ok) {
      const text = await oaResp.text();
      return res.status(502).json({ error: `OpenAI call failed: ${text}` });
    }

    const oaData = await oaResp.json();
    const answer = oaData?.choices?.[0]?.message?.content?.trim() || "No answer.";

    // Function to convert citations to clickable HTML links
    function createClickableCitations(text, sourcesArray) {
      let htmlText = text;
      
      sourcesArray.forEach((source) => {
        const citationRegex = new RegExp(`\\[${source.number}\\]`, 'g');
        
        // Create tooltip content
        const pageInfo = source.page ? ` (p. ${source.page})` : '';
        const tooltipContent = `${source.title}${pageInfo}${source.chunk_text ? '\n\nExcerpt: "' + source.chunk_text + '"' : ''}`;
        
        // Create clickable citation with tooltip
        const clickableLink = `<a href="${source.url}" target="_blank" 
          title="${tooltipContent.replace(/"/g, '&quot;')}" 
          style="color: #0066cc; text-decoration: underline; font-weight: 500;">[${source.number}]</a>`;
        
        htmlText = htmlText.replace(citationRegex, clickableLink);
      });
      
      return htmlText;
    }

    // Function to create hover-enabled citations for Botpress
    function createHoverCitations(text, sourcesArray) {
      let result = text;
      
      sourcesArray.forEach((source) => {
        const citationRegex = new RegExp(`\\[${source.number}\\]`, 'g');
        
        // Create clean title (remove file extensions and URL encoding)
        const cleanTitle = source.title
          .replace(/\.pdf$|\.docx?$/i, '')
          .replace(/%2C/g, ',')
          .replace(/\+/g, ' ')
          .replace(/_/g, ' ');
        
        const pageInfo = source.page ? ` (p. ${source.page})` : '';
        
        // Create tooltip content with excerpt
        const tooltipText = `${cleanTitle}${pageInfo}\n\n"${source.chunk_text || 'No preview available'}"`;
        
        // Create markdown link with hover title
        const hoverLink = `[${source.number}](${source.url} "${tooltipText.replace(/"/g, '\'')}")`;
        
        result = result.replace(citationRegex, hoverLink);
      });
      
      return result;
    }

    // Function to create clean inline citations (no sources list)
    function createCleanInlineCitations(text, sourcesArray) {
      let result = text;
      
      sourcesArray.forEach((source) => {
        const citationRegex = new RegExp(`\\[${source.number}\\]`, 'g');
        
        // Create clean title
        const cleanTitle = source.title
          .replace(/\.pdf$|\.docx?$/i, '')
          .replace(/%2C/g, ',')
          .replace(/\+/g, ' ')
          .replace(/_/g, ' ');
        
        const pageInfo = source.page ? ` (p. ${source.page})` : '';
        
        // Create a cleaner citation format
        const cleanCitation = `[[${source.number}: ${cleanTitle.substring(0, 30)}${cleanTitle.length > 30 ? '...' : ''}${pageInfo}]](${source.url})`;
        
        result = result.replace(citationRegex, cleanCitation);
      });
      
      return result;
    }

    // Create multiple output formats
    const answer_md = answer;
    const answer_html = createClickableCitations(answer, sources);
    const answer_hover_citations = createHoverCitations(answer, sources);
    const answer_clean_inline = createCleanInlineCitations(answer, sources);

    // No sources section for clean format
    const clean_format = answer_clean_inline;
    const hover_format = answer_hover_citations;

    // Enhanced sources section for markdown (fallback)
    const sources_md = sources.map(s => {
      const pageInfo = s.page ? ` (p. ${s.page})` : '';
      const chunkInfo = s.chunk_text ? `\n   Excerpt: "${s.chunk_text}"` : '';
      return `[${s.number}]: ${s.url || ""} "${s.title || ""}"${pageInfo}${chunkInfo}`;
    }).join("\n");

    // Enhanced sources section for HTML
    const sources_html = sources.map(s => {
      const pageInfo = s.page ? ` (p. ${s.page})` : '';
      const chunkInfo = s.chunk_text ? `<br><em>Excerpt: "${s.chunk_text}"</em>` : '';
      return `<strong>[${s.number}]:</strong> <a href="${s.url}" target="_blank">${s.title}</a>${pageInfo}${chunkInfo}`;
    }).join("<br><br>");

    return res.status(200).json({
      data: {
        answer_md: `${answer_md}\n\n---\n**Sources**\n${sources_md}`,
        answer_html: `${answer_html}<br><br><hr><strong>Sources</strong><br><br>${sources_html}`,
        answer_clean_inline: clean_format, // Clean format with no sources list
        answer_hover_citations: hover_format, // Hover tooltips
        sources: sources
      }
    });

  } catch (err) {
    console.error("chat.js error:", err);
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}