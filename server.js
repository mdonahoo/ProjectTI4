import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { readFileSync } from 'fs';

// Load .env.local if it exists (for local dev — Vercel handles env vars in production)
try {
  const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '.env.local');
  const envContent = readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch {}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Clone-voice receives multipart/form-data — must be registered BEFORE express.json()
// so the raw body stream is not consumed by the JSON parser.
const { default: cloneVoiceHandler } = await import('./api/clone-voice.js');
app.all('/api/clone-voice', (req, res) => cloneVoiceHandler(req, res));

// JSON body parser for all other API routes
app.use(express.json({ limit: '50mb' }));

// API routes
const { default: chatHandler } = await import('./api/chat.js');
app.all('/api/chat', (req, res) => chatHandler(req, res));

const { default: speakHandler } = await import('./api/speak.js');
app.all('/api/speak', (req, res) => speakHandler(req, res));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
