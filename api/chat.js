import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadPDF(filename) {
  try {
    const buf = fs.readFileSync(path.join(__dirname, '..', 'data', filename));
    return buf.toString('base64');
  } catch (err) {
    console.error(`PDF load failed: ${filename}`, err.message);
    return null;
  }
}
function loadText(filename) {
  try {
    return fs.readFileSync(path.join(__dirname, '..', 'data', filename), 'utf8');
  } catch (err) {
    console.error(`Text load failed: ${filename}`, err.message);
    return null;
  }
}

// Load all docs at module startup (reused across warm Lambda invocations)
const rulebookB64    = loadPDF('rulebook.pdf');
const pokLRRB64      = loadPDF('pok-lrr.pdf');
const teRulebookB64  = loadPDF('te-rulebook.pdf');       // Official Thunder's Edge rulebook
const teRulesSummary = loadText('te-rules-summary.txt'); // Breach/breakthrough/faction detail supplement

console.log('[startup]',
  rulebookB64    ? `rulebook ${Math.round(rulebookB64.length/1024)}KB`    : 'rulebook MISSING',
  pokLRRB64      ? `pok-lrr ${Math.round(pokLRRB64.length/1024)}KB`      : 'pok-lrr MISSING',
  teRulebookB64  ? `te-rulebook ${Math.round(teRulebookB64.length/1024)}KB` : 'te-rulebook MISSING',
  teRulesSummary ? `te-summary ${teRulesSummary.length}chars`             : 'te-summary MISSING'
);

function buildDocumentBlocks(includeTE) {
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

  // Thunder's Edge — only loaded when expansion is active (saves ~$0.05/msg otherwise)
  if (includeTE) {
    if (teRulebookB64) blocks.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: teRulebookB64 },
      title: "Thunder's Edge Official Expansion Rulebook"
    });
    if (teRulesSummary) blocks.push({
      type: 'document',
      source: { type: 'text', media_type: 'text/plain', data: teRulesSummary },
      title: "Thunder's Edge Faction Breakthroughs & New Factions Reference"
    });
  }

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
    res.status(500).json({ error: { message: 'ANTHROPIC_API_KEY not set in Vercel Environment Variables.' } });
    return;
  }

  try {
    const body = { ...req.body };
    const includeTE = body._includeThundersEdge === true;
    delete body._includeThundersEdge;

    const docBlocks = buildDocumentBlocks(includeTE);
    if (Array.isArray(body.system) && docBlocks.length > 0) {
      body.system = [...docBlocks, ...body.system];
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

    if (data.usage) {
      const u = data.usage;
      const hits=u.cache_read_input_tokens||0, writes=u.cache_creation_input_tokens||0;
      const fresh=u.input_tokens||0, out=u.output_tokens||0;
      const cost=(fresh*3+writes*3.75+hits*0.30)/1e6+(out*15)/1e6;
      const saved=(hits*2.70/1e6).toFixed(5);
      console.log(`[te=${includeTE}] hits=${hits} writes=${writes} fresh=${fresh} out=${out} cost=$${cost.toFixed(5)} saved=$${saved}`);
    }

    res.status(upstream.status).json(data);
  } catch (err) {
    console.error('Proxy error:', err);
    res.status(500).json({ error: { message: 'Proxy error: ' + err.message } });
  }
}
