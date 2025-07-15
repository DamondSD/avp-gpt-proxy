import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  const userKey = req.headers['authorization']?.split(' ')[1];
  const validKeys = process.env.ALLOWED_KEYS?.split(',') || [];
  if (!userKey || !validKeys.includes(userKey)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
});

app.post('/api/gpt', async (req, res) => {
  const { prompt, npcName, model = 'gpt-4o' } = req.body;

  if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

  const systemPrompt = npcName
    ? `You are roleplaying as ${npcName}. Stay in character unless asked for out-of-character details.`
    : "You are ArchiveOfVoices, a helpful assistant for tabletop roleplaying games.";

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        temperature: 0.7,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error?.message || 'Unknown error from OpenAI');
    }

    const reply = data.choices?.[0]?.message?.content?.trim() || '⚠️ Empty response';
    res.json({ reply });
  } catch (err) {
    console.error('GPT error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🟢 Server running on port ${PORT}`);
});