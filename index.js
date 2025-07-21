const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const axios = require('axios');
const { Pool } = require('pg');

dotenv.config();

const pool = new Pool({
  user: 'gptuser',
  host: 'localhost',
  database: 'gptproxy',
  password: 'MissyD14%', // 🔐 Replace with your real password
  port: 5432
});

const app = express();

app.use(cors({
  origin: [
    'http://localhost',
    'http://localhost:30000',
    'http://88.162.236.115'
  ],
  methods: ['POST'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json());

const PORT = process.env.PORT || 3000;

/*
// 🔐 Optional API key auth — leave disabled unless needed
app.use((req, res, next) => {
  const userKey = req.headers['authorization']?.split(' ')[1];
  const validKeys = process.env.ALLOWED_KEYS?.split(',') || [];
  if (!userKey || !validKeys.includes(userKey)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
});
*/

app.post('/api/gpt', async (req, res) => {
  const { prompt, npcName, model = 'gpt-4o', systemPrompt, userId = 'unknown' } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'Missing prompt' });
  }

  const usedSystemPrompt = systemPrompt;

  try {
    const axiosResponse = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model,
        messages: [
          { role: 'system', content: usedSystemPrompt },
          { role: 'user', content: prompt },
        ],
        temperature: 0.7,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_KEY}`,
        },
      }
    );

    const data = axiosResponse.data;
    const reply = data.choices?.[0]?.message?.content?.trim() || '⚠️ Empty response';

    try {
      await pool.query(`
        INSERT INTO gpt_usage_log (user_id, model, prompt_length, response_length, tokens_used)
        VALUES ($1, $2, $3, $4, $5)
      `, [
        userId,
        model,
        prompt.length,
        reply.length,
        data?.usage?.total_tokens || null
      ]);
    } catch (dbErr) {
      console.error("❌ Failed to log GPT usage:", dbErr);
    }

    res.json({ reply });

  } catch (err) {
    console.error('GPT error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🟢 Server running on port ${PORT}`);
});
