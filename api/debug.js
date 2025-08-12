export default async function handler(req, res) {
  // Mask the sensitive values
  const mask = (val) => val ? val.substring(0, 4) + '...' + val.slice(-4) : null;

  res.status(200).json({
    GROUNDX_API_KEY: mask(process.env.GROUNDX_API_KEY),
    GROUNDX_BUCKET_ID: process.env.GROUNDX_BUCKET_ID || null,
    OPENAI_API_KEY: mask(process.env.OPENAI_API_KEY),
    OPENAI_MODEL: process.env.OPENAI_MODEL || null,
    NODE_ENV: process.env.NODE_ENV
  });
}
