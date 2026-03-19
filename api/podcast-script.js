export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: { message: 'Method not allowed' } }); return; }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: { message: 'ANTHROPIC_API_KEY not set.' } });
    return;
  }

  const { round, events, faction, opponents, vp, vpGoal, roundTotal, gameContext } = req.body || {};
  if (!events || !events.length) {
    res.status(400).json({ error: { message: 'No journal events provided.' } });
    return;
  }

  const roundNum = round || 1;
  const isEarlyGame = roundNum <= 2;
  const isMidGame = roundNum >= 3 && roundNum <= 4;
  const isLateGame = roundNum >= 5;
  const isClimactic = (vp || 0) >= (vpGoal || 10) - 2;

  const pacing = isClimactic ? 'climactic finale — urgent, high-stakes, dramatic'
    : isLateGame ? 'late game tension — alliances fracturing, VP race tightening'
    : isMidGame ? 'mid game political intrigue — shifting alliances, strategic maneuvering'
    : 'early game exploration — hopeful, building, discovering the galaxy';

  const prompt = `You are a cinematic podcast narrator for a Twilight Imperium 4 board game session. Generate a podcast script for Round ${roundNum}.

GAME CONTEXT:
- Narrator's Faction: ${faction || 'Unknown'}
- Opponents: ${opponents || 'Unknown'}
- Current VP: ${vp || 0} / ${vpGoal || 10}
- Round ${roundNum} of approximately ${roundTotal || '6'}
- Pacing: ${pacing}
${gameContext ? '- Additional context: ' + gameContext : ''}

ROUND ${roundNum} EVENTS:
${events.map((e, i) => `${i + 1}. ${e}`).join('\n')}

Generate a JSON object with this EXACT structure:
{
  "narration": "<60-120 second narration script. Write in third person dramatic present tense, like a sports commentator crossed with a documentary narrator. Reference specific factions, planets, and game events. Build tension. Make it cinematic but grounded in what actually happened. No generic filler — every sentence should reference a specific event from the list above.>",
  "music_prompt": "<A specific music generation prompt for ElevenLabs. Include: genre/style, tempo (BPM), key (major/minor), instruments, and mood. CRITICAL: Do NOT reference any real composers, artists, film scores, or copyrighted works — ElevenLabs will reject the prompt. Describe the sound purely with musical terms. Match the pacing note above. Example: 'Tense cinematic orchestral underscore, 85 BPM, D minor, cello ostinato with muted brass stabs, building tension, epic sci-fi atmosphere'>",
  "sfx": [
    {
      "at_percent": <number 0-100 representing where in the narration this SFX should fire, e.g. 30 means 30% through>,
      "prompt": "<Specific ElevenLabs SFX prompt for this moment. Be concrete: 'massive space cannon volley, ship explosions, sci-fi military battle' not just 'battle sounds'>",
      "duration": <number 2-8, seconds for this SFX>
    }
  ]
}

RULES:
- Generate exactly 2-4 SFX entries, timed to the most dramatic moments
- The narration should be 150-300 words (roughly 60-120 seconds when spoken)
- SFX prompts must be specific to the events (not generic)
- Music prompt must match the round's emotional arc
- Return ONLY valid JSON, no markdown, no explanation`;

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await upstream.json();
    if (!upstream.ok) {
      console.error('[podcast-script] Anthropic error:', upstream.status, JSON.stringify(data));
      res.status(upstream.status).json({ error: { message: 'Script generation failed' } });
      return;
    }

    const text = data.content?.find(b => b.type === 'text')?.text || '';

    // Parse the JSON from Claude's response
    try {
      // Strip any markdown code fences if present
      const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      const script = JSON.parse(cleaned);

      // Validate structure
      if (!script.narration || !script.music_prompt || !Array.isArray(script.sfx)) {
        throw new Error('Missing required fields');
      }

      console.log('[podcast-script] Generated:', script.narration.length, 'chars narration,',
        script.sfx.length, 'SFX cues');

      res.status(200).json(script);
    } catch (parseErr) {
      console.error('[podcast-script] Parse error:', parseErr.message, 'Raw:', text.slice(0, 200));
      res.status(500).json({ error: { message: 'Failed to parse script: ' + parseErr.message } });
    }
  } catch (err) {
    console.error('[podcast-script] Error:', err);
    res.status(500).json({ error: { message: 'Script generation error: ' + err.message } });
  }
}
