const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const Parser = require('rss-parser');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const parser = new Parser();
const db = new Database('./dealflow.db');

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ─── DATABASE SETUP ───────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    phone TEXT,
    address TEXT,
    city TEXT,
    source TEXT,
    status TEXT DEFAULT 'new',
    condition TEXT,
    sqft REAL,
    arv REAL,
    rehab_cost REAL,
    offer_amount REAL,
    min_offer REAL,
    asking_price REAL,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER,
    role TEXT,
    message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(lead_id) REFERENCES leads(id)
  );

  CREATE TABLE IF NOT EXISTS buyers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    phone TEXT,
    email TEXT,
    markets TEXT,
    min_price REAL,
    max_price REAL,
    close_days INTEGER,
    deals_done INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS deals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER,
    buyer_id INTEGER,
    property_address TEXT,
    arv REAL,
    purchase_price REAL,
    wholesale_fee REAL,
    status TEXT DEFAULT 'under_contract',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(lead_id) REFERENCES leads(id),
    FOREIGN KEY(buyer_id) REFERENCES buyers(id)
  );
`);

// ─── ANTHROPIC CLIENT ─────────────────────────────────────────────
function getAI() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// ─── FLORIDA CRAIGSLIST CITIES ────────────────────────────────────
const FL_CITIES = [
  'tampa', 'orlando', 'jacksonville', 'miami', 
  'ftlauderdale', 'westpalmbeach', 'sarasota', 'capecoral'
];

const CL_FEEDS = FL_CITIES.map(city => ({
  city,
  url: `https://${city}.craigslist.org/search/reo?format=rss`
}));

// ─── SCRAPE CRAIGSLIST ────────────────────────────────────────────
async function scrapeCraigslist() {
  console.log('🔍 Scanning Craigslist Florida markets...');
  for (const feed of CL_FEEDS) {
    try {
      const result = await parser.parseURL(feed.url);
      for (const item of result.items || []) {
        const address = item.title || '';
        const existing = db.prepare('SELECT id FROM leads WHERE address = ?').get(address);
        if (!existing && address) {
          const lead = db.prepare(`
            INSERT INTO leads (address, city, source, status)
            VALUES (?, ?, 'craigslist', 'new')
          `).run(address, feed.city);
          console.log(`✅ New lead: ${address} — ${feed.city}`);
          await initiateOutreach(lead.lastInsertRowid, address, feed.city);
        }
      }
    } catch (err) {
      console.log(`⚠️ ${feed.city} feed error: ${err.message}`);
    }
  }
}

// ─── CALCULATE OFFER ──────────────────────────────────────────────
function calculateOffer(sqft, condition, arv) {
  const rehabRate = condition === 'remodel' ? 50 : 40;
  const rehab = sqft * rehabRate;
  const rule70 = arv * 0.7;
  const offer = rule70 - rehab - 20000;
  const minOffer = rule70 - rehab - 15000;
  return { rehab, offer: Math.max(offer, 0), minOffer: Math.max(minOffer, 0) };
}

// ─── AI CONVERSATION ──────────────────────────────────────────────
async function runAIConversation(leadId, incomingMessage) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  if (!lead) return null;

  const history = db.prepare(
    'SELECT role, message FROM conversations WHERE lead_id = ? ORDER BY created_at ASC'
  ).all(leadId);

  const messages = history.map(h => ({
    role: h.role === 'ai' ? 'assistant' : 'user',
    content: h.message
  }));

  if (incomingMessage) {
    messages.push({ role: 'user', content: incomingMessage });
    db.prepare('INSERT INTO conversations (lead_id, role, message) VALUES (?, ?, ?)').run(leadId, 'seller', incomingMessage);
  }

  const systemPrompt = `You are a real estate wholesale acquisitions specialist named David from Florida Home Buyers. 
You are texting with a motivated seller about their property.

Your goal is to:
1. Build quick rapport
2. Find out if the property is livable or needs full remodel
3. Get the square footage
4. Find out their asking price and timeline
5. Calculate and make a cash offer using this formula:
   - Livable: sqft × $40 = rehab cost
   - Full remodel: sqft × $50 = rehab cost  
   - Offer = ARV × 70% - rehab - $20,000 wholesale fee
   - Minimum offer = ARV × 70% - rehab - $15,000
6. Negotiate firmly but fairly. Never go below minimum offer. Walk away politely if they won't budge.
7. If they want to speak to someone live, say you'll have your property specialist call them and ask what time works.
8. If they accept the offer, tell them you'll send a contract via DocuSign right away.

Current lead info:
- Address: ${lead.address}
- City: ${lead.city}
- Condition: ${lead.condition || 'unknown'}
- Sqft: ${lead.sqft || 'unknown'}
- ARV estimate: ${lead.arv || 'unknown'}

Keep messages SHORT and conversational like real texts. Never sound robotic. Be warm and human.
Never reveal you are an AI.`;

  const ai = getAI();
  const response = await ai.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 300,
    system: systemPrompt,
    messages
  });

  const aiReply = response.content[0].text;
  db.prepare('INSERT INTO conversations (lead_id, role, message) VALUES (?, ?, ?)').run(leadId, 'ai', aiReply);

  // Update lead status based on conversation
  if (aiReply.toLowerCase().includes('contract') || aiReply.toLowerCase().includes('docusign')) {
    db.prepare("UPDATE leads SET status = 'under_contract' WHERE id = ?").run(leadId);
  } else if (incomingMessage && (
    incomingMessage.toLowerCase().includes('talk to someone') ||
    incomingMessage.toLowerCase().includes('call me') ||
    incomingMessage.toLowerCase().includes('speak to')
  )) {
    db.prepare("UPDATE leads SET status = 'hot' WHERE id = ?").run(leadId);
  } else if (history.length > 2) {
    db.prepare("UPDATE leads SET status = 'qualifying' WHERE id = ?").run(leadId);
  }

  db.prepare("UPDATE leads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(leadId);
  return aiReply;
}

// ─── SEND SMS ─────────────────────────────────────────────────────
async function sendSMS(to, message) {
  try {
    const apiKey = process.env.SMS_API_KEY;
    const fromNumber = process.env.SMS_FROM_NUMBER;
    if (!apiKey || !fromNumber) {
      console.log(`📱 SMS (no key): To ${to}: ${message}`);
      return;
    }
    await axios.post('https://api.smsmobileapi.com/sendsms', {
      apikey: apiKey,
      number: to,
      message: message
    });
    console.log(`📱 SMS sent to ${to}`);
  } catch (err) {
    console.log(`⚠️ SMS error: ${err.message}`);
  }
}

// ─── INITIATE OUTREACH ────────────────────────────────────────────
async function initiateOutreach(leadId, address, city) {
  const firstMessage = `Hi, I came across your property at ${address} and wanted to reach out. We buy homes as-is for cash with no fees or commissions. Would you be open to a quick no-obligation offer? — David, Florida Home Buyers`;
  db.prepare('INSERT INTO conversations (lead_id, role, message) VALUES (?, ?, ?)').run(leadId, 'ai', firstMessage);
  console.log(`📤 Outreach initiated for ${address}`);
}

// ─── ROUTES ───────────────────────────────────────────────────────

// Dashboard stats
app.get('/api/stats', (req, res) => {
  const stats = {
    leadsToday: db.prepare("SELECT COUNT(*) as c FROM leads WHERE date(created_at) = date('now')").get().c,
    activeConvos: db.prepare("SELECT COUNT(*) as c FROM leads WHERE status = 'qualifying'").get().c,
    hotLeads: db.prepare("SELECT COUNT(*) as c FROM leads WHERE status = 'hot'").get().c,
    underContract: db.prepare("SELECT COUNT(*) as c FROM leads WHERE status = 'under_contract'").get().c,
    totalLeads: db.prepare("SELECT COUNT(*) as c FROM leads").get().c,
    closedDeals: db.prepare("SELECT COUNT(*) as c FROM deals WHERE status = 'closed'").get().c,
    totalEarned: db.prepare("SELECT COALESCE(SUM(wholesale_fee),0) as s FROM deals WHERE status = 'closed'").get().s,
  };
  res.json(stats);
});

// Get all leads
app.get('/api/leads', (req, res) => {
  const leads = db.prepare('SELECT * FROM leads ORDER BY updated_at DESC').all();
  res.json(leads);
});

// Get leads by status
app.get('/api/leads/:status', (req, res) => {
  const leads = db.prepare('SELECT * FROM leads WHERE status = ? ORDER BY updated_at DESC').all(req.params.status);
  res.json(leads);
});

// Get conversation for a lead
app.get('/api/conversations/:leadId', (req, res) => {
  const convos = db.prepare('SELECT * FROM conversations WHERE lead_id = ? ORDER BY created_at ASC').all(req.params.leadId);
  res.json(convos);
});

// Receive inbound SMS webhook
app.post('/api/sms/inbound', async (req, res) => {
  const { from, message } = req.body;
  console.log(`📨 Inbound SMS from ${from}: ${message}`);
  
  // Find lead by phone
  const lead = db.prepare('SELECT * FROM leads WHERE phone = ?').get(from);
  if (lead) {
    const reply = await runAIConversation(lead.id, message);
    if (reply) await sendSMS(from, reply);
  }
  res.json({ success: true });
});

// Manual reply trigger (for testing)
app.post('/api/leads/:id/reply', async (req, res) => {
  const { message } = req.body;
  const reply = await runAIConversation(req.params.id, message);
  res.json({ reply });
});

// Add cash buyer
app.post('/api/buyers', (req, res) => {
  const { name, phone, email, markets, min_price, max_price, close_days } = req.body;
  const result = db.prepare(`
    INSERT INTO buyers (name, phone, email, markets, min_price, max_price, close_days)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name, phone, email, markets, min_price, max_price, close_days);
  res.json({ id: result.lastInsertRowid });
});

// Get all buyers
app.get('/api/buyers', (req, res) => {
  const buyers = db.prepare('SELECT * FROM buyers ORDER BY deals_done DESC').all();
  res.json(buyers);
});

// Calculate offer
app.post('/api/calculate', (req, res) => {
  const { sqft, condition, arv } = req.body;
  const result = calculateOffer(sqft, condition, arv);
  res.json(result);
});

// Update lead
app.patch('/api/leads/:id', (req, res) => {
  const { status, condition, sqft, arv, phone, name } = req.body;
  db.prepare(`
    UPDATE leads SET 
      status = COALESCE(?, status),
      condition = COALESCE(?, condition),
      sqft = COALESCE(?, sqft),
      arv = COALESCE(?, arv),
      phone = COALESCE(?, phone),
      name = COALESCE(?, name),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(status, condition, sqft, arv, phone, name, req.params.id);
  res.json({ success: true });
});

// Activity feed
app.get('/api/activity', (req, res) => {
  const activity = db.prepare(`
    SELECT c.*, l.address, l.city 
    FROM conversations c
    JOIN leads l ON c.lead_id = l.id
    ORDER BY c.created_at DESC
    LIMIT 20
  `).all();
  res.json(activity);
});

// Trigger manual scan
app.post('/api/scan', async (req, res) => {
  scrapeCraigslist();
  res.json({ message: 'Scan started' });
});

// ─── CRON: SCAN EVERY 30 MINUTES ─────────────────────────────────
cron.schedule('*/30 * * * *', () => {
  scrapeCraigslist();
});

// ─── START SERVER ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 DealFlow AI running on port ${PORT}`);
  scrapeCraigslist(); // scan on startup
});
