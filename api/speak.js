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

  const { text, model, voiceId: clientVoiceId } = req.body || {};
  // Use client-provided voice (cloned) or fall back to env default
  // Validate voice ID format (alphanumeric only) to prevent path injection
  if (clientVoiceId && !/^[a-zA-Z0-9]+$/.test(clientVoiceId)) {
    res.status(400).json({ error: { message: 'Invalid voice ID format.' } });
    return;
  }
  const voiceId = clientVoiceId || process.env.ELEVENLABS_VOICE_ID;
  if (!voiceId) {
    res.status(400).json({ error: { message: 'No voice available. Clone your voice first or set ELEVENLABS_VOICE_ID.' } });
    return;
  }
  if (!text || typeof text !== 'string' || text.length === 0) {
    res.status(400).json({ error: { message: 'Missing or empty text field.' } });
    return;
  }

  // Pick model: flash for short text (combat briefings), multilingual for longer narration
  const modelId = model || (text.length > 300 ? 'eleven_multilingual_v2' : 'eleven_flash_v2_5');

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg'
        },
        body: JSON.stringify({
          text: text.slice(0, 5000),
          model_id: modelId,
          voice_settings: { stability: 0.55, similarity_boost: 0.80 }
        })
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error('[speak] ElevenLabs error:', response.status, errText);
      res.status(response.status).json({ error: { message: 'ElevenLabs API error: ' + response.status } });
      return;
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');

    // Stream the audio response back to the browser
    const reader = response.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); return; }
        res.write(Buffer.from(value));
      }
    };
    await pump();
  } catch (err) {
    console.error('[speak] Proxy error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: 'Speech proxy error: ' + err.message } });
    } else {
      res.end();
    }
  }
}
