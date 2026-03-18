import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load PDFs once at module startup (reused across warm Lambda invocations)
function loadPDF(filename) {
  try {
    const buf = fs.readFileSync(path.join(__dirname, '..', 'data', filename));
    return buf.toString('base64');
  } catch (err) {
    console.error(`PDF load failed: ${filename} —`, err.message);
    return null;
  }
}

const rulebookB64 = loadPDF('rulebook.pdf');
const pokLRRB64   = loadPDF('pok-lrr.pdf');

console.log('[startup]',
  rulebookB64 ? `rulebook OK (${Math.round(rulebookB64.length/1024)}KB)` : 'rulebook MISSING',
  pokLRRB64   ? `pok-lrr OK (${Math.round(pokLRRB64.length/1024)}KB)`   : 'pok-lrr MISSING'
);

function buildPDFBlocks() {
  const blocks = [];
  if (rulebookB64) blocks.push({
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data: rulebookB64 },
    title: 'Twilight Imperium 4th Edition Rulebook'
  });
  if (pokLRRB64) blocks.push({
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data: pokLRRB64 },
    title: 'Prophecy of Kings Living Rules Reference'
  });
  return blocks;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: { message: 'Method not allowed' } }); return; }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: { message: 'ANTHROPIC_API_KEY not set. Add it in Vercel project Settings → Environment Variables, then redeploy.' } });
    return;
  }

  try {
    const body = { ...req.body };

    // Prepend PDF blocks before the client's system array.
    // The cache_control:ephemeral on the client's STATIC_SYSTEM text block
    // creates a checkpoint covering [pdf1]+[pdf2]+[static text] together.
    // After the first call (cache write ~$0.31), each hit costs ~$0.025 — 90% cheaper.
    const pdfBlocks = buildPDFBlocks();
    if (Array.isArray(body.system) && pdfBlocks.length > 0) {
      body.system = [...pdfBlocks, ...body.system];
    }

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31'
      },
      body: JSON.stringify(body)
    });

    const data = await upstream.json();

    // Log cache stats to Vercel function logs
    if (data.usage) {
      const u = data.usage;
      const hits   = u.cache_read_input_tokens    || 0;
      const writes = u.cache_creation_input_tokens || 0;
      const fresh  = u.input_tokens  || 0;
      const out    = u.output_tokens || 0;
      const cost   = (fresh*3 + writes*3.75 + hits*0.30)/1e6 + (out*15)/1e6;
      const saved  = hits > 0 ? ((hits*2.70)/1e6).toFixed(5) : '0';
      console.log(`[cache] hits=${hits} writes=${writes} fresh=${fresh} out=${out} cost=$${cost.toFixed(5)} saved=$${saved}`);
    }

    res.status(upstream.status).json(data);
  } catch (err) {
    console.error('Proxy error:', err);
    res.status(500).json({ error: { message: 'Proxy error: ' + err.message } });
  }
}
