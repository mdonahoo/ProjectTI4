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

const rulebookB64    = loadPDF('rulebook.pdf');
const pokLRRB64      = loadPDF('pok-lrr.pdf');
const teRulebookB64  = loadPDF('te-rulebook.pdf');
const teRulesSummary = loadText('te-rules-summary.txt');

console.log('[startup]',
  rulebookB64    ? `rulebook ${Math.round(rulebookB64.length/1024)}KB`      : 'rulebook MISSING',
  pokLRRB64      ? `pok-lrr ${Math.round(pokLRRB64.length/1024)}KB`        : 'pok-lrr MISSING',
  teRulebookB64  ? `te-rulebook ${Math.round(teRulebookB64.length/1024)}KB` : 'te-rulebook MISSING',
  teRulesSummary ? `te-summary ${teRulesSummary.length}chars`               : 'te-summary MISSING'
);

// Build document content blocks to prepend as the first user message.
// The system array only supports type:'text' — documents must live in messages[].
// We inject them as a synthetic first user message so Claude has full rulebook access
// on every call, and the cache_control marks them for prompt caching (~90% cheaper after first call).
function buildRulebookMessage(includeTE) {
  const content = [];

  if (rulebookB64) content.push({
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data: rulebookB64 },
    title: 'Twilight Imperium 4th Edition Rulebook',
    cache_control: { type: 'ephemeral' }
  });

  if (pokLRRB64) content.push({
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data: pokLRRB64 },
    title: 'Prophecy of Kings Living Rules Reference',
    cache_control: { type: 'ephemeral' }
  });

  if (includeTE) {
    if (teRulebookB64) content.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: teRulebookB64 },
      title: "Thunder's Edge Official Expansion Rulebook",
      cache_control: { type: 'ephemeral' }
    });
    if (teRulesSummary) content.push({
      type: 'document',
      source: { type: 'text', media_type: 'text/plain', data: teRulesSummary },
      title: "Thunder's Edge Faction Breakthroughs & New Factions Reference",
      cache_control: { type: 'ephemeral' }
    });
  }

  if (!content.length) return null;

  // Add a text block asking Claude to use these docs as authoritative sources
  content.push({
    type: 'text',
    text: 'These are your authoritative rulebook sources. Use them to answer rules questions accurately, citing specific sections when relevant. If rules in these documents differ from your training knowledge, trust the documents.'
  });

  return { role: 'user', content };
}

// Matching synthetic assistant acknowledgment (required: messages must alternate user/assistant)
const RULEBOOK_ACK = {
  role: 'assistant',
  content: 'Understood. I have the TI4 rulebook and Living Rules Reference loaded and will cite them for rules questions.'
};

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

    // system array: only text blocks are allowed here
    // The client sends system as [{type:'text', text:STATIC_SYSTEM, cache_control:...}, {type:'text', text:dynamicPrompt}]
    // This is already correct — leave it as-is

    // Prepend rulebook documents as synthetic first messages in the messages array
    const rulebookMsg = buildRulebookMessage(includeTE);
    if (rulebookMsg && Array.isArray(body.messages)) {
      body.messages = [rulebookMsg, RULEBOOK_ACK, ...body.messages];
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
