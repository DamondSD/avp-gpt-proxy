import express from 'express';
import https from 'https';
import fs from 'fs';
import pg from 'pg';
import dotenv from 'dotenv';
import cors from 'cors';


dotenv.config();

const app = express();
const port = 3000;

app.use(cors({
  origin: (origin, callback) => {
    const allowed = ['http://localhost', 'https://api.shadowdrake.dev'];
    if (!origin || allowed.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['POST'],
  credentials: false
}));

const pool = new pg.Pool({
  user: process.env.DB_USER,
  host: 'db', // 'db' must match service name in docker-compose
  database: process.env.DB_NAME,
  password: process.env.DB_PASS,
  port: 5432,
});

app.use(express.json());

app.get('/api/ping', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/users', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM users');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get("/auth/patreon", (req, res) => {
  const redirect = `https://www.patreon.com/oauth2/authorize` +
    `?response_type=code` +
    `&client_id=${process.env.PATREON_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(process.env.PATREON_REDIRECT_URI)}` +
    `&scope=identity identity.memberships`;

  res.redirect(redirect);
});

app.get("/auth/patreon/callback", async (req, res) => {
  const code = req.query.code;

  try {
    // Exchange code for access token
    const tokenRes = await fetch("https://www.patreon.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        grant_type: "authorization_code",
        client_id: process.env.PATREON_CLIENT_ID,
        client_secret: process.env.PATREON_CLIENT_SECRET,
        redirect_uri: process.env.PATREON_REDIRECT_URI
      })
    });

    const tokenText = await tokenRes.text();
    if (!tokenRes.ok) {
      throw new Error(`Token exchange failed: ${tokenRes.status} ${tokenRes.statusText} - ${tokenText}`);
    }

    const tokenData = JSON.parse(tokenText);
    const accessToken = tokenData.access_token;

    // Fetch user + membership info
    const userRes = await fetch(
      "https://www.patreon.com/api/oauth2/v2/identity?include=memberships.currently_entitled_tiers&fields[user]=full_name&fields[member]=patron_status&fields[tier]=title",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    const userText = await userRes.text();
    if (!userRes.ok) {
      throw new Error(`User fetch failed: ${userRes.status} ${userRes.statusText} - ${userText}`);
    }

    const userData = JSON.parse(userText);
    console.log("✅ Patreon Login Success:");
    console.dir(userData, { depth: null });

    // Pull user + tier info
    const patreonId = userData?.data?.id;
    const fullName = userData?.data?.attributes?.full_name || "Unknown";
    const membership = userData?.included?.[0];
    const tierName = membership?.attributes?.currently_entitled_tiers?.[0]?.title || "free";

    const tierMap = {
      Archivist: 'tier1',
      Lorebinder: 'tier2',
      Vaultkeeper: 'tier3'
    };
    const mappedTier = tierMap[tierName] || 'free';

    console.log("🔐 Patreon Tier:", mappedTier);

    await pool.query(`
      INSERT INTO gpt_usage_totals (user_id, user_name, tier)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id)
      DO UPDATE SET user_name = EXCLUDED.user_name, tier = EXCLUDED.tier;
    `, [patreonId, fullName, mappedTier]);

    res.send(`
      <h2>✅ Login successful!</h2>
      <p>You are now linked as <strong>${fullName}</strong> with tier <strong>${mappedTier}</strong>.</p>
      <p>You may close this window and return to Foundry.</p>
    `);
  } catch (err) {
    console.error("❌ Patreon OAuth error:", err);
    res.status(500).send(`
      <h2>❌ Error during Patreon login</h2>
      <pre>\${err.message || err}</pre>
    `);
  }
});




app.get('/api/usage', async (req, res) => {
  const userId = req.headers['x-user-id'];

  if (!userId) return res.status(400).json({ error: 'Missing user ID' });

  try {
    const result = await pool.query(`
      SELECT prompts_used, tier, god_mode FROM gpt_usage_totals WHERE user_id = $1
    `, [userId]);


    const row = result.rows[0] || {};
    const count = parseInt(row.prompts_used || '0');
    const tier = row.tier || 'free';

    res.json({ count, tier, god: row?.god_mode === true });

  } catch (err) {
    console.error('❌ DB error in /api/usage:', err);
    res.status(500).json({ error: 'Database error' });
  }
});


app.use(express.json());

app.post("/api/gpt", async (req, res) => {

  const {
    prompt,
    npcName,
    model = "gpt-4",
    systemPrompt,
    user_name = "Unknown"
  } = req.body;

  const user_id = req.headers["x-user-id"] || "anonymous";

  console.log("📥 Incoming GPT request:", { user_id, model, prompt, systemPrompt });
  const limitsEnabled = process.env.LIMITS_ENABLED === "true";
  const godUserId = process.env.GOD_MODE_ID;
  const isGod = user_id === godUserId || row?.god_mode;

  if (limitsEnabled && user_id !== godUserId) {
    try {
      const result = await pool.query(
        `SELECT prompts_used, tier, god_mode FROM gpt_usage_totals WHERE user_id = $1`,
        [user_id]
      );

      const row = result.rows[0];
      const tier = row?.tier || 'free';
      const godMode = row?.god_mode;


      if (godMode === true) {
        console.log("🛡️ God Mode enabled — bypassing limits.");
      } else {
        const limits = {
          free: 30,
          tier1: 200,
          tier2: 500,
          tier3: 3000
        };

        const now = new Date();
        const lastReset = new Date(row?.last_reset || 0);
        const daysSinceReset = (now - lastReset) / (1000 * 60 * 60 * 24);

        if (daysSinceReset >= 30) {
          await pool.query(`
          UPDATE gpt_usage_totals
          SET prompts_used = 0, last_reset = NOW()
          WHERE user_id = $1
        `, [user_id]);

          console.log(`🔄 Reset prompt usage for ${user_id} (last reset was ${Math.floor(daysSinceReset)} days ago)`);
        }


        const max = limits[tier] || 30;
        const used = row?.prompts_used || 0;

        if (used >= max) {
          console.log(`🚫 User ${user_id} (${tier}) hit limit: ${used}/${max}`);
          return res.status(403).json({
            error: `You've reached your monthly prompt limit (${max} for tier: ${tier}).`
          });
        }
      }
    } catch (err) {
      console.error("❌ Error checking prompt limits:", err);
      return res.status(500).json({ error: "Failed to verify usage limits." });
    }
  }


  if (!prompt || !systemPrompt) {
    return res.status(400).json({ error: "Missing prompt or systemPrompt" });
  }

  try {
    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_KEY}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt }
        ]
      })
    });

    const data = await openaiRes.json();

    if (!openaiRes.ok) {
      console.error("❌ OpenAI Error:", data);
      return res.status(500).json({ error: data.error?.message || "OpenAI error" });
    }

    const reply = data.choices?.[0]?.message?.content?.trim() || "(No response)";
    const usage = data.usage || {};

    // Log usage to PostgreSQL
    try {
      console.log("📝 Logging to DB with:", {
        user_id,
        model,
        prompt_length: prompt.length,
        response_length: reply.length,
        tokens_used: usage.total_tokens || 0
      });

      await pool.query(`
        INSERT INTO gpt_usage_totals (
        user_id, user_name, prompts_used, last_prompt,
        total_tokens, total_prompt_len, total_response_len
        )
        VALUES ($1, $2, 1, NOW(), $3, $4, $5)
        ON CONFLICT (user_id)
        DO UPDATE SET
        user_name = EXCLUDED.user_name,
        prompts_used = gpt_usage_totals.prompts_used + 1,
        total_tokens = gpt_usage_totals.total_tokens + $3,
        total_prompt_len = gpt_usage_totals.total_prompt_len + $4,
        total_response_len = gpt_usage_totals.total_response_len + $5,
        last_prompt = NOW();
      `, [user_id, user_name, usage.total_tokens || 0, prompt.length, reply.length]);

      console.log(`✅ Tracked prompt for user ${user_id}`);
    } catch (err) {
      console.error("❌ Failed to log to DB:", err);
    }

    res.json({ reply, usage });
  } catch (err) {
    console.error("❌ Unexpected server error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});


const sslOptions = {
  key: fs.readFileSync('/app/cert/key.pem'),
  cert: fs.readFileSync('/app/cert/cert.pem')
};

app.post("/api/admin/reset-prompts", async (req, res) => {
  const godId = process.env.GOD_MODE_ID;
  const userId = req.headers["x-user-id"];

  if (userId !== godId) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  try {
    await pool.query(`
      UPDATE gpt_usage_totals
      SET prompts_used = 0,
          last_reset = NOW()
    `);

    console.log(`🔁 Manual prompt reset triggered by ${userId}`);
    res.json({ message: "✅ All prompt usage has been reset." });
  } catch (err) {
    console.error("❌ Manual reset failed:", err);
    res.status(500).json({ error: "Failed to reset prompt usage." });
  }
});



https.createServer(sslOptions, app).listen(port, () => {
  console.log(`🔐 HTTPS server running at https://localhost:${port}`);
});