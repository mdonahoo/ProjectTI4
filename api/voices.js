export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  // Collect ELEVENLABS_VOICE_<NAME>=<voiceId> env vars
  const PREFIX = 'ELEVENLABS_VOICE_';
  const voices = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith(PREFIX) && key !== 'ELEVENLABS_VOICE_ID') {
      const label = key.slice(PREFIX.length).replace(/_/g, ' ');
      voices.push({ id: value, label });
    }
  }

  // Include default voice if set
  const defaultId = process.env.ELEVENLABS_VOICE_ID;
  if (defaultId && !voices.some(v => v.id === defaultId)) {
    voices.unshift({ id: defaultId, label: 'Default' });
  }

  res.json({ voices });
}
