import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// ─── Mock fetch globally before importing the handler ───────────────────────
let fetchCalls = [];
let fetchResponses = [];

function pushFetchResponse(status, body) {
  fetchResponses.push({ status, ok: status >= 200 && status < 300, body });
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  fetchCalls.push({ url, opts, body: JSON.parse(opts.body) });
  const resp = fetchResponses.shift() || { status: 500, ok: false, body: { error: { message: 'No mock response' } } };
  return { status: resp.status, ok: resp.ok, json: async () => resp.body };
};

// Set a dummy API key so the handler doesn't bail out
process.env.ANTHROPIC_API_KEY = 'test-key-123';

// Import after mocking
const { default: handler } = await import('../api/chat.js');

// ─── Helpers ────────────────────────────────────────────────────────────────

function mockReq(method, body) {
  return { method, body: body || {} };
}

function mockRes() {
  const res = {
    _status: null, _json: null, _headers: {},
    _ended: false,
    status(code) { res._status = code; return res; },
    json(data) { res._json = data; return res; },
    setHeader(k, v) { res._headers[k] = v; },
    end() { res._ended = true; }
  };
  return res;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('chat handler', () => {
  beforeEach(() => {
    fetchCalls = [];
    fetchResponses = [];
  });

  // ── CORS & method checks ──────────────────────────────────────────────

  it('responds to OPTIONS with 204', async () => {
    const res = mockRes();
    await handler(mockReq('OPTIONS'), res);
    assert.equal(res._status, 204);
    assert.equal(res._headers['Access-Control-Allow-Origin'], '*');
  });

  it('rejects GET with 405', async () => {
    const res = mockRes();
    await handler(mockReq('GET'), res);
    assert.equal(res._status, 405);
  });

  // ── Normal request flow ───────────────────────────────────────────────

  it('proxies a normal chat request to Anthropic', async () => {
    pushFetchResponse(200, {
      content: [{ type: 'text', text: 'Hello!' }],
      usage: { input_tokens: 10, output_tokens: 5 }
    });

    const res = mockRes();
    await handler(mockReq('POST', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }]
    }), res);

    assert.equal(res._status, 200);
    assert.equal(res._json.content[0].text, 'Hello!');

    // Should have called Anthropic API
    assert.equal(fetchCalls.length, 1);
    const call = fetchCalls[0];
    assert.ok(call.url.includes('api.anthropic.com'));

    // Should include beta headers for prompt caching AND PDFs
    const headers = call.opts.headers;
    assert.ok(headers['anthropic-beta'].includes('prompt-caching-2024-07-31'));
    assert.ok(headers['anthropic-beta'].includes('pdfs-2024-09-25'));
  });

  it('prepends rulebook messages to the conversation', async () => {
    pushFetchResponse(200, {
      content: [{ type: 'text', text: 'Answer' }],
      usage: { input_tokens: 100, output_tokens: 20 }
    });

    const res = mockRes();
    await handler(mockReq('POST', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'What is PDS?' }]
    }), res);

    const sentBody = fetchCalls[0].body;
    // The first message should be the rulebook (role: user with document content)
    assert.equal(sentBody.messages[0].role, 'user');
    assert.ok(Array.isArray(sentBody.messages[0].content));
    // The second message should be the assistant ack
    assert.equal(sentBody.messages[1].role, 'assistant');
    // The user's actual message should be last
    const lastMsg = sentBody.messages[sentBody.messages.length - 1];
    assert.equal(lastMsg.content, 'What is PDS?');
  });

  it('includes TE rulebook when _includeThundersEdge is set', async () => {
    pushFetchResponse(200, {
      content: [{ type: 'text', text: 'TE answer' }],
      usage: { input_tokens: 100, output_tokens: 10 }
    });

    const res = mockRes();
    await handler(mockReq('POST', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      _includeThundersEdge: true,
      messages: [{ role: 'user', content: 'Tell me about TE' }]
    }), res);

    const sentBody = fetchCalls[0].body;
    // Should NOT have _includeThundersEdge in the forwarded body
    assert.equal(sentBody._includeThundersEdge, undefined);
    // Rulebook message should have more content blocks (TE PDF + TE summary)
    const rulebookContent = sentBody.messages[0].content;
    const pdfBlocks = rulebookContent.filter(b => b.type === 'document' && b.source?.media_type === 'application/pdf');
    // Should have 3 PDFs: rulebook, pok-lrr, te-rulebook
    assert.ok(pdfBlocks.length >= 3, `Expected at least 3 PDF blocks, got ${pdfBlocks.length}`);
  });

  it('strips _includeThundersEdge and _warmCache from forwarded body', async () => {
    pushFetchResponse(200, {
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 10, output_tokens: 2 }
    });

    const res = mockRes();
    await handler(mockReq('POST', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      _includeThundersEdge: true,
      _warmCache: false,
      messages: [{ role: 'user', content: 'test' }]
    }), res);

    const sentBody = fetchCalls[0].body;
    assert.equal(sentBody._includeThundersEdge, undefined);
    assert.equal(sentBody._warmCache, undefined);
  });

  // ── PDF fallback ──────────────────────────────────────────────────────

  it('retries without PDFs when API rejects a PDF', async () => {
    // First call: Anthropic returns PDF error
    pushFetchResponse(400, {
      error: { message: 'messages.0.content.0.pdf.source.base64.data: The PDF specified was not valid.' }
    });
    // Second call (retry): success
    pushFetchResponse(200, {
      content: [{ type: 'text', text: 'Fallback answer' }],
      usage: { input_tokens: 50, output_tokens: 10 }
    });

    const res = mockRes();
    await handler(mockReq('POST', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'What is PDS?' }]
    }), res);

    // Should have made 2 fetch calls
    assert.equal(fetchCalls.length, 2, `Expected 2 fetch calls, got ${fetchCalls.length}`);

    // First call should have PDF documents
    const firstBody = fetchCalls[0].body;
    const firstPdfs = firstBody.messages[0].content.filter(b => b.source?.media_type === 'application/pdf');
    assert.ok(firstPdfs.length > 0, 'First call should include PDFs');

    // Second call (fallback) should NOT have PDF documents
    const retryBody = fetchCalls[1].body;
    const retryHasPdf = retryBody.messages.some(m =>
      Array.isArray(m.content) && m.content.some(b => b.source?.media_type === 'application/pdf')
    );
    assert.equal(retryHasPdf, false, 'Retry should not include any PDFs');

    // Should still return 200 with the fallback response
    assert.equal(res._status, 200);
    assert.equal(res._json.content[0].text, 'Fallback answer');
    assert.equal(res._json._pdfFallback, true);
  });

  it('preserves user messages in the fallback retry', async () => {
    pushFetchResponse(400, {
      error: { message: 'The PDF specified was not valid.' }
    });
    pushFetchResponse(200, {
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 10, output_tokens: 2 }
    });

    const res = mockRes();
    await handler(mockReq('POST', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      messages: [
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'First answer' },
        { role: 'user', content: 'Follow up' }
      ]
    }), res);

    // The retry should contain the original user messages
    const retryBody = fetchCalls[1].body;
    const retryMsgs = retryBody.messages;
    // Should end with the user's conversation
    const userMsgs = retryMsgs.filter(m => m.content === 'First question' || m.content === 'Follow up');
    assert.equal(userMsgs.length, 2, 'Both user messages should be in retry');
  });

  it('does NOT retry for non-PDF errors', async () => {
    pushFetchResponse(429, {
      error: { message: 'Rate limit exceeded' }
    });

    const res = mockRes();
    await handler(mockReq('POST', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }]
    }), res);

    // Should only have made 1 call — no retry
    assert.equal(fetchCalls.length, 1);
    assert.equal(res._status, 429);
  });

  // ── Cache warmup ──────────────────────────────────────────────────────

  it('handles cache warmup requests', async () => {
    pushFetchResponse(200, {
      usage: { input_tokens: 5, cache_creation_input_tokens: 1000 }
    });

    const res = mockRes();
    await handler(mockReq('POST', {
      _warmCache: true,
      model: 'claude-sonnet-4-20250514'
    }), res);

    assert.equal(res._status, 200);
    assert.equal(res._json.warmed, true);
  });

  // ── Rulebook message structure ────────────────────────────────────────

  it('respects the 4 cache_control block limit', async () => {
    pushFetchResponse(200, {
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 10, output_tokens: 2 }
    });

    const res = mockRes();
    await handler(mockReq('POST', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      _includeThundersEdge: true,
      messages: [{ role: 'user', content: 'test' }]
    }), res);

    const rulebookContent = fetchCalls[0].body.messages[0].content;
    const cachedBlocks = rulebookContent.filter(b => b.cache_control);
    assert.ok(cachedBlocks.length <= 4, `Expected at most 4 cached blocks, got ${cachedBlocks.length}`);
  });

  // ── Error handling ────────────────────────────────────────────────────

  it('returns 500 when ANTHROPIC_API_KEY is missing', async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    const res = mockRes();
    await handler(mockReq('POST', { messages: [{ role: 'user', content: 'Hi' }] }), res);

    assert.equal(res._status, 500);
    assert.ok(res._json.error.message.includes('ANTHROPIC_API_KEY'));

    process.env.ANTHROPIC_API_KEY = savedKey;
  });
});
