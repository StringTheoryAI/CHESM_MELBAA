// api/chat.js — GroundX (search.content) + OpenAI with CORS support and clean citations
// Requires env vars: GROUNDX_API_KEY, GROUNDX_BUCKET_ID, OPENAI_API_KEY

// Extract system prompt to a separate function for better maintainability
function getSystemPrompt() {
  return `You are a careful academic assistant specializing in osteoarthritis information. Use ONLY the provided context from the knowledge base to answer questions.

## Citation Requirements
- Add inline citations like [1], [2] matching the numbered sources
- Every factual claim must include a citation
- Use clear, well-structured text with proper citations
- Restrict your output to approximately 200 words
- Use Markdown formatting
- Begin with a brief summary sentence, then continue with bullet points

## Knowledge Base Restrictions
- Do not answer from general knowledge or internet sources
- STICK TO THE TOPIC OF OSTEOARTHRITIS
- Only use information from the provided context
- If information isn't in the context, state that clearly

## Language Guidelines
### Required Terminology
- Always say "osteoarthritis" instead of "OA"
- Say "have obesity" instead of "obesity"
- Say "have overweight" instead of "overweight"

### Prohibited Terms (Never Use)
- Degenerative, degradation
- Bones rubbing, bone on bone
- Chronic degenerative changes
- Negative test results
- Instability
- Wear and tear, worn away
- Neurological
- Don't worry
- Paresthesia
- Lordosis, kyphosis
- Disease
- Effusion
- Chronic
- Diagnostics
- "You are going to have to live with this"
- End Stage A

## Tone Adaptation
### For Healthcare Professionals
- Use professional, concise, clinical tone when user references:
  - Evidence-based practice
  - Clinical guidelines
  - Patient management
  - Medical terminology

### For General Public
- Use warm, clear, everyday language
- Explain medical terms when necessary
- Avoid jargon unless explained
- Be supportive and encouraging

## Conversation Guidelines
1. Wait for the user to ask a question before responding
2. If user intent is unclear, ask clarifying questions politely
3. Rephrase questions to connect them to osteoarthritis when helpful
4. Always use British English spelling
5. Show citations for every factual statement
6. Be concise but comprehensive within the word limit

## Response Structure
1. Brief summary statement answering the main question
2. Key points as bullet points with citations
3. Ensure all information ties back to osteoarthritis
4. Maintain supportive, informative tone throughout`;
}

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
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    
    let body = {};
    try { 
      body = raw ? JSON.parse(raw) : {}; 
    } catch (parseError) { 
      return res.status(400).json({ error: "Invalid JSON body" }); 
    }

    const query = (body.query || "").trim();
    if (!query) {
      return res.status(400).json({ error: "Missing 'query' string" });
    }

    // Environment variables
    const GX_KEY = process.env.GROUNDX_API_KEY;
    const GX_BUCKET = process.env.GROUNDX_BUCKET_ID;
    const OA_KEY = process.env.OPENAI_API_KEY;
    const OA_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

    if (!GX_KEY) return res.status(500).json({ error: "Missing GROUNDX_API_KEY" });
    if (!GX_BUCKET) return res.status(500).json({ error: "Missing GROUNDX_BUCKET_ID" });
    if (!OA_KEY) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

    // ---- GroundX search.content ----
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
    const sources = results.slice(0, 10).map((result, index) => {
      const chunkText = result.suggestedText || result.text || "";
      const chunkPreview = chunkText.length > 150 ? 
        chunkText.substring(0, 150) + "..." : 
        chunkText;

      return {
        number: index + 1,
        title: result.searchData?.title || result.fileName || `Source ${index + 1}`,
        url: result.sourceUrl || result.multimodalUrl || "",
        page: result.searchData?.pageNumber ?? result.searchData?.page ?? null,
        chunk_text: chunkPreview,
        confidence: result.score || null
      };
    });

    const context = llmText || results
      .map((result, index) => `[${index + 1}] ${result.suggestedText || result.text || ""}`)
      .join("\n\n");

    // ---- OpenAI for final answer ----
    const oaResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json", 
        Authorization: `Bearer ${OA_KEY}` 
      },
      body: JSON.stringify({
        model: OA_MODEL,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: getSystemPrompt()
          },
          {
            role: "user",
            content: `Question: ${query}

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

    // Citation formatting functions
    function createClickableCitations(text, sourcesArray) {
      let htmlText = text;
      
      sourcesArray.forEach((source) => {
        const citationRegex = new RegExp(`\\[${source.number}\\]`, 'g');
        const pageInfo = source.page ? ` (p. ${source.page})` : '';
        const tooltipContent = `${source.title}${pageInfo}${source.chunk_text ? '\n\nExcerpt: "' + source.chunk_text + '"' : ''}`;
        
        const clickableLink = `<a href="${source.url}" target="_blank" 
          title="${tooltipContent.replace(/"/g, '&quot;')}" 
          style="color: #0066cc; text-decoration: underline; font-weight: 500;">[${source.number}]</a>`;
        
        htmlText = htmlText.replace(citationRegex, clickableLink);
      });
      
      return htmlText;
    }

    function createHoverCitations(text, sourcesArray) {
      let result = text;
      
      sourcesArray.forEach((source) => {
        const citationRegex = new RegExp(`\\[${source.number}\\]`, 'g');
        
        const cleanTitle = source.title
          .replace(/\.pdf$|\.docx?$/i, '')
          .replace(/%2C/g, ',')
          .replace(/\+/g, ' ')
          .replace(/_/g, ' ');
        
        const pageInfo = source.page ? ` (p. ${source.page})` : '';
        const tooltipText = `${cleanTitle}${pageInfo}\n\n"${source.chunk_text || 'No preview available'}"`;
        const hoverLink = `[${source.number}](${source.url} "${tooltipText.replace(/"/g, '\'')}")`;
        
        result = result.replace(citationRegex, hoverLink);
      });
      
      return result;
    }

    function createHTMLTooltips(text, sourcesArray) {
      let result = text;
      
      sourcesArray.forEach((source) => {
        const citationRegex = new RegExp(`\\[${source.number}\\]`, 'g');
        
        const cleanTitle = source.title
          .replace(/\.pdf$|\.docx?$/i, '')
          .replace(/%2C/g, ',')
          .replace(/\+/g, ' ')
          .replace(/_/g, ' ');
        
        const pageInfo = source.page ? ` (p. ${source.page})` : '';
        const tooltipContent = `${cleanTitle}${pageInfo}\n\n"${source.chunk_text || 'No preview available'}"`;
        
        const htmlTooltip = `<a href="${source.url}" target="_blank" title="${tooltipContent.replace(/"/g, '&quot;')}" style="color: #0066cc; text-decoration: underline; font-weight: bold;">[${source.number}]</a>`;
        
        result = result.replace(citationRegex, htmlTooltip);
      });
      
      return result;
    }

    // Create multiple output formats
    const answer_md = answer;
    const answer_html = createClickableCitations(answer, sources);
    const answer_hover_citations = createHoverCitations(answer, sources);
    const answer_html_tooltips = createHTMLTooltips(answer, sources);

    // Sources formatting
    const sources_md = sources.map(s => {
      const pageInfo = s.page ? ` (p. ${s.page})` : '';
      const chunkInfo = s.chunk_text ? `\n   Excerpt: "${s.chunk_text}"` : '';
      return `[${s.number}]: ${s.url || ""} "${s.title || ""}"${pageInfo}${chunkInfo}`;
    }).join("\n");

    const sources_html = sources.map(s => {
      const pageInfo = s.page ? ` (p. ${s.page})` : '';
      const chunkInfo = s.chunk_text ? `<br><em>Excerpt: "${s.chunk_text}"</em>` : '';
      return `<strong>[${s.number}]:</strong> <a href="${s.url}" target="_blank">${s.title}</a>${pageInfo}${chunkInfo}`;
    }).join("<br><br>");

    return res.status(200).json({
      data: {
        answer_md: `${answer_md}\n\n---\n**Sources**\n${sources_md}`,
        answer_html: `${answer_html}<br><br><hr><strong>Sources</strong><br><br>${sources_html}`,
        answer_hover_citations: answer_hover_citations,
        answer_html_tooltips: answer_html_tooltips,
        sources: sources
      }
    });

  } catch (err) {
    console.error("chat.js error:", err);
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}