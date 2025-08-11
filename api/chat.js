import { GroundX } from "groundx";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const gx = new GroundX({ api_key: process.env.GROUNDX_API_KEY });

function pickSearchId() {
  const b = process.env.GROUNDX_BUCKET_ID && parseInt(process.env.GROUNDX_BUCKET_ID, 10);
  const p = process.env.GROUNDX_PROJECT_ID && parseInt(process.env.GROUNDX_PROJECT_ID, 10);
  const g = process.env.GROUNDX_GROUP_ID && parseInt(process.env.GROUNDX_GROUP_ID, 10);
  if (b) return b;
  if (p) return p;
  if (g) return g;
  throw new Error("Set one of GROUNDX_BUCKET_ID / GROUNDX_PROJECT_ID / GROUNDX_GROUP_ID");
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

async function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => (data += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch (e) {
        reject(e);
      }
    });
  });
}

function toSources(results = []) {
  return results.slice(0, 10).map((r, i) => {
    const title =
      r.searchData?.title ||
      r.searchData?.fileName ||
      (r.sourceUrl ? new URL(r.sourceUrl).pathname.split("/").pop() : `Document ${r.documentId}`);
    return {
      n: i + 1,
      title,
      url: r.sourceUrl || "",
      page: r.searchData?.pageNumber ?? r.searchData?.page ?? null,
      documentId: r.documentId
    };
  });
}

function buildSourcesForPrompt(sources) {
  return sources
    .map(s => `${s.n}. ${s.title}${s.page ? ` (p.${s.page})` : ""}${s.url ? ` — ${s.url}` : ""}`)
    .join("\n");
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { query } = await readJson(req);
    if (!query || typeof query !== "string") {
      return res.status(400).json({ error: "Missing 'query' string" });
    }

    const id = pickSearchId();
    const searchResp = await gx.search.content({ id, query });
    const search = searchResp?.search || {};
    const llmText = search.text || "";
    const results = Array.isArray(search.results) ? search.results : [];
    const sources = toSources(results);

    if (!llmText) {
      return res.status(200).json({
        answer_md: `I couldn’t find relevant passages for “${query}”.`,
        sources: []
      });
    }

    const system = [
      "You are a careful academic assistant.",
      "Use ONLY the provided context to support claims.",
      "Add numbered in-text citations like [1] or [2,3] immediately after any sentence that relies on sources.",
      "Never invent citation numbers—choose only from the list provided.",
      "Prefer pinpointing (include page numbers in prose when supplied).",
      "Return Markdown only."
    ].join(" ");

    const user = [
      `Question: ${query}`,
      "",
      "Context:",
      llmText,
      "",
      "Citable sources (numbers you may cite):",
      buildSourcesForPrompt(sources)
    ].join("\n");

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      temperature: 0.2
    });

    const answer_md = completion.choices?.[0]?.message?.content?.trim() || "No answer.";
    return res.status(200).json({ answer_md, sources });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}
