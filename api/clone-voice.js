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

  try {
    // Collect the raw request body (multipart form from browser)
    const chunks = [];
    for await (const chunk of req) { chunks.push(chunk); }
    const rawBody = Buffer.concat(chunks);

    // Extract the boundary from the incoming content-type
    const ct = req.headers['content-type'] || '';

    // Forward the exact multipart body to ElevenLabs as-is
    const response = await fetch('https://api.elevenlabs.io/v1/voices/add', {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': ct
      },
      body: rawBody
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('[clone-voice] ElevenLabs error:', response.status, JSON.stringify(data));
      const msg = typeof data?.detail === 'string' ? data.detail
        : data?.detail?.message || JSON.stringify(data?.detail) || 'Voice cloning failed (status ' + response.status + ')';
      res.status(response.status).json({ error: { message: msg } });
      return;
    }

    console.log('[clone-voice] Created voice:', data.voice_id);
    res.status(200).json({ voice_id: data.voice_id });
  } catch (err) {
    console.error('[clone-voice] Error:', err);
    res.status(500).json({ error: { message: 'Voice cloning error: ' + err.message } });
  }
}
