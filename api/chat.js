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
// Text supplements — combined into one block to stay within the 4 cache_control block limit
const daneRulings    = loadText('dane-rulings.txt');
const teRulesSummary = loadText('te-rules-summary.txt');

console.log('[startup]',
  rulebookB64    ? `rulebook ${Math.round(rulebookB64.length/1024)}KB`       : 'rulebook MISSING',
  pokLRRB64      ? `pok-lrr ${Math.round(pokLRRB64.length/1024)}KB`         : 'pok-lrr MISSING',
  teRulebookB64  ? `te-rulebook ${Math.round(teRulebookB64.length/1024)}KB` : 'te-rulebook MISSING',
  daneRulings    ? `dane-rulings ${daneRulings.length}chars`                 : 'dane-rulings MISSING',
  teRulesSummary ? `te-summary ${teRulesSummary.length}chars`                : 'te-summary MISSING'
);

// Anthropic API limit: maximum 4 blocks with cache_control per request.
// The frontend system prompt uses 1 cached block, so we budget 3 here.
// Budget: rulebook+pok-lrr(1) + text-supplements(2) + te-rulebook(3, TE only)
// The two base PDFs share one cache slot; text supplements get another.
function buildRulebookMessage(includeTE) {
  const content = [];

  // Block 1: TI4 base rulebook PDF (no cache_control — shares slot with pok-lrr)
  if (rulebookB64) content.push({
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data: rulebookB64 },
    title: 'Twilight Imperium 4th Edition Rulebook'
  });

  // Block 2: PoK Living Rules Reference PDF — cache_control on last PDF of the pair
  if (pokLRRB64) content.push({
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data: pokLRRB64 },
    title: 'Prophecy of Kings Living Rules Reference',
    cache_control: { type: 'ephemeral' }   // cache slot 1 (covers both base PDFs)
  });

  // Block 3: Text supplements — Dane rulings always included; TE faction data appended when active.
  // Merged into one block to minimize cache slots.
  const supplementParts = [];
  if (daneRulings) supplementParts.push(daneRulings);
  if (includeTE && teRulesSummary) supplementParts.push(teRulesSummary);
  if (supplementParts.length > 0) {
    content.push({
      type: 'document',
      source: { type: 'text', media_type: 'text/plain', data: supplementParts.join('\n\n' + '='.repeat(60) + '\n\n') },
      title: includeTE
        ? 'Official Dane Beltrami Rulings + Thunder\'s Edge Faction Reference'
        : 'Official Dane Beltrami Rulings & Errata (override RAW when they conflict)',
      cache_control: { type: 'ephemeral' }  // cache slot 2
    });
  }

  // Block 4: Thunder's Edge rulebook PDF (only when TE active)
  if (includeTE && teRulebookB64) {
    content.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: teRulebookB64 },
      title: "Thunder's Edge Official Expansion Rulebook",
      cache_control: { type: 'ephemeral' }  // cache slot 3
    });
  }

  if (!content.length) return null;

  content.push({
    type: 'text',
    text: 'These are your authoritative rules sources. The Dane Beltrami rulings document contains official rulings that OVERRIDE the printed rules (RAW) when they conflict — always check it first. Cite the source of your answer when responding to rules questions.'
  });

  return { role: 'user', content };
}

// Fallback: text-only supplements when PDFs are rejected by the API
function buildTextOnlyRulebookMessage(includeTE) {
  const supplementParts = [];
  if (daneRulings) supplementParts.push(daneRulings);
  if (includeTE && teRulesSummary) supplementParts.push(teRulesSummary);
  if (!supplementParts.length) return null;
  return {
    role: 'user',
    content: [{
      type: 'text',
      text: supplementParts.join('\n\n' + '='.repeat(60) + '\n\n'),
      cache_control: { type: 'ephemeral' }
    }]
  };
}

const RULEBOOK_ACK = {
  role: 'assistant',
  content: 'Understood. Rulebooks, Dane rulings, and any expansion references are loaded. For rules questions I will check Dane rulings first (they override RAW), then the LRR, then the base rulebook, and will cite my source.'
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
    const isWarmup = body._warmCache === true;
    delete body._includeThundersEdge;
    delete body._warmCache;

    const rulebookMsg = buildRulebookMessage(includeTE);

    // Cache warmup: send a minimal request just to prime the prompt cache
    if (isWarmup) {
      if (!rulebookMsg) { res.status(200).json({ warmed: true }); return; }
      const warmBody = {
        model: body.model || 'claude-sonnet-4-20250514',
        max_tokens: 1,
        system: body.system || [{ type: 'text', text: 'Reply with OK.' }],
        messages: [
          rulebookMsg,
          RULEBOOK_ACK,
          { role: 'user', content: 'Confirm rules loaded.' }
        ]
      };
      const warmResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'prompt-caching-2024-07-31,pdfs-2024-09-25'
        },
        body: JSON.stringify(warmBody)
      });
      const warmData = await warmResp.json();
      if (warmData.usage) {
        const u = warmData.usage;
        console.log(`[cache-warm te=${includeTE}] hits=${u.cache_read_input_tokens||0} writes=${u.cache_creation_input_tokens||0} fresh=${u.input_tokens||0}`);
      }
      res.status(200).json({ warmed: true, usage: warmData.usage });
      return;
    }

    const apiHeaders = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31,pdfs-2024-09-25'
    };

    const userMessages = [...(body.messages || [])];

    if (rulebookMsg && Array.isArray(body.messages)) {
      body.messages = [rulebookMsg, RULEBOOK_ACK, ...body.messages];
    }

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: apiHeaders,
      body: JSON.stringify(body)
    });

    let data = await upstream.json();

    // If the API rejects a PDF, retry without PDFs so the user isn't stuck
    if (!upstream.ok && data.error?.message?.toLowerCase().includes('pdf')) {
      console.warn('[chat] PDF rejected by API, retrying without PDFs:', data.error.message);
      // Build a text-only fallback: strip PDF documents, keep text supplements
      const fallbackMsg = buildTextOnlyRulebookMessage(includeTE);
      const fallbackBody = { ...body, messages: fallbackMsg
        ? [fallbackMsg, RULEBOOK_ACK, ...userMessages]
        : userMessages
      };
      const retry = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: apiHeaders,
        body: JSON.stringify(fallbackBody)
      });
      data = await retry.json();
      if (data.usage) data._pdfFallback = true;
    }

    if (data.usage) {
      const u = data.usage;
      const hits   = u.cache_read_input_tokens    || 0;
      const writes = u.cache_creation_input_tokens || 0;
      const fresh  = u.input_tokens  || 0;
      const out    = u.output_tokens || 0;
      const cost   = (fresh*3 + writes*3.75 + hits*0.30) / 1e6 + (out*15) / 1e6;
      const saved  = (hits * 2.70 / 1e6).toFixed(5);
      console.log(`[te=${includeTE}${data._pdfFallback?' PDF-FALLBACK':''}] hits=${hits} writes=${writes} fresh=${fresh} out=${out} cost=$${cost.toFixed(5)} saved=$${saved}`);
    }

    res.status(upstream.ok || data._pdfFallback ? 200 : upstream.status).json(data);
  } catch (err) {
    console.error('Proxy error:', err);
    res.status(500).json({ error: { message: 'Proxy error: ' + err.message } });
  }
}
