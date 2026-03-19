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

  const { prompt, duration_seconds } = req.body || {};
  if (!prompt || typeof prompt !== 'string') {
    res.status(400).json({ error: { message: 'Missing SFX prompt.' } });
    return;
  }

  // Clamp duration: 0.5 to 15 seconds
  const duration = Math.min(Math.max(duration_seconds || 4, 0.5), 15);

  try {
    const response = await fetch('https://api.elevenlabs.io/v1/sound-generation', {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: prompt.slice(0, 500),
        model_id: 'eleven_text_to_sound_v2',
        duration_seconds: duration,
        prompt_influence: 0.5
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[sfx] ElevenLabs error:', response.status, errText);
      res.status(response.status).json({ error: { message: 'SFX generation failed: ' + response.status } });
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
    console.error('[sfx] Error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: 'SFX generation error: ' + err.message } });
    } else {
      res.end();
    }
  }
}
