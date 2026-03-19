export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: { message: 'Method not allowed' } }); return; }

  const apiKey = process.env.ELEVENLABS_API_KEY || process.env.ELEVEN_LABS_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: { message: 'ELEVENLABS_API_KEY not set.' } });
    return;
  }

  const { prompt, duration_ms } = req.body || {};
  if (!prompt || typeof prompt !== 'string') {
    res.status(400).json({ error: { message: 'Missing music prompt.' } });
    return;
  }

  // Clamp duration: 30s to 180s (3 minutes max)
  const durationMs = Math.min(Math.max(duration_ms || 120000, 30000), 180000);

  // Strip copyrighted artist/composer/film references that trigger ElevenLabs content filter
  const cleanPrompt = prompt.slice(0, 1000)
    .replace(/\b(Hans Zimmer|John Williams|Howard Shore|Ramin Djawadi|Ludwig G[öo]ransson|Bear McCreary|James Horner|Ennio Morricone|Danny Elfman|Alexandre Desplat|Michael Giacchino|Vangelis)\b/gi, '')
    .replace(/\b(Star Wars|Interstellar|Lord of the Rings|Inception|Game of Thrones|Dune|Avatar|Marvel|Avengers|Batman|Dark Knight|Phantom Menace|Blade Runner)\b/gi, '')
    .replace(/\b(style|inspired|like|vibes)\s+$/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  try {
    const response = await fetch('https://api.elevenlabs.io/v1/music', {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        prompt: cleanPrompt,
        music_length_ms: durationMs,
        model_id: 'music_v1',
        force_instrumental: true
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[music] ElevenLabs error:', response.status, errText);
      let detail = 'Music generation failed: ' + response.status;
      try { const j = JSON.parse(errText); detail = j?.detail?.message || j?.detail || j?.error?.message || detail; } catch {}
      res.status(response.status).json({ error: { message: detail } });
      return;
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');

    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) { res.end(); return; }
      res.write(Buffer.from(value));
    }
  } catch (err) {
    console.error('[music] Error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: 'Music generation error: ' + err.message } });
    } else {
      res.end();
    }
  }
}
