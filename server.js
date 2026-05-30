const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();

// Use /data directory for persistent storage on Railway
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
const DB_PATH = path.join(DATA_DIR, 'dealflow.db');

// Fallback to local if /data doesn't exist
let db;
try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);
  console.log(`Database at: ${DB_PATH}`);
} catch(e) {
  db = new Database('./dealflow.db');
  console.log('Using local database');
}

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, phone TEXT, address TEXT, city TEXT, state TEXT, zip TEXT,
    source TEXT, status TEXT DEFAULT 'new', condition TEXT,
    sqft REAL, arv REAL, rehab_cost REAL, offer_amount REAL,
    min_offer REAL, asking_price REAL, notes TEXT, reddit_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER, role TEXT, message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(lead_id) REFERENCES leads(id)
  );
  CREATE TABLE IF NOT EXISTS buyers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, phone TEXT, email TEXT, markets TEXT,
    min_price REAL, max_price REAL, close_days INTEGER,
    deals_done INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS deals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER, buyer_id INTEGER, property_address TEXT,
    arv REAL, purchase_price REAL, wholesale_fee REAL,
    status TEXT DEFAULT 'under_contract',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

function getAI() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

function calculateOffer(sqft, condition, arv) {
  const rate = condition === 'remodel' ? 50 : 40;
  const rehab = sqft * rate;
  const rule70 = arv * 0.7;
  return {
    rehab,
    offer: Math.max(rule70 - rehab - 20000, 0),
    minOffer: Math.max(rule70 - rehab - 15000, 0)
  };
}

async function runAIConversation(leadId, incomingMessage) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  if (!lead) return null;
  const history = db.prepare('SELECT role, message FROM conversations WHERE lead_id = ? ORDER BY created_at ASC').all(leadId);
  const messages = history.map(h => ({ role: h.role === 'ai' ? 'assistant' : 'user', content: h.message }));
  if (incomingMessage) {
    messages.push({ role: 'user', content: incomingMessage });
    db.prepare('INSERT INTO conversations (lead_id, role, message) VALUES (?, ?, ?)').run(leadId, 'seller', incomingMessage);
  }
  const systemPrompt = `You are a real estate wholesale acquisitions specialist named David from Florida Home Buyers. Text with motivated sellers. Goals: 1. Build rapport 2. Find if property is livable or needs full remodel 3. Get square footage 4. Get asking price and timeline 5. Make cash offer: Livable=sqft*$40 rehab, Remodel=sqft*$50 rehab, Offer=ARV*70%-rehab-$20000, Min=ARV*70%-rehab-$15000 6. Never go below minimum 7. If they want to talk, say specialist will call and ask what time 8. If they accept, say sending DocuSign. Property: ${lead.address}, ${lead.city}. Keep texts SHORT and human. Never reveal you are AI.`;
  const ai = getAI();
  const response = await ai.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 300, system: systemPrompt, messages });
  const aiReply = response.content[0].text;
  db.prepare('INSERT INTO conversations (lead_id, role, message) VALUES (?, ?, ?)').run(leadId, 'ai', aiReply);
  const lower = aiReply.toLowerCase();
  if (lower.includes('contract') || lower.includes('docusign')) {
    db.prepare("UPDATE leads SET status='under_contract' WHERE id=?").run(leadId);
  } else if (incomingMessage && (incomingMessage.toLowerCase().includes('talk to') || incomingMessage.toLowerCase().includes('call me'))) {
    db.prepare("UPDATE leads SET status='hot' WHERE id=?").run(leadId);
  } else if (history.length > 2) {
    db.prepare("UPDATE leads SET status='qualifying' WHERE id=?").run(leadId);
  }
  db.prepare("UPDATE leads SET updated_at=CURRENT_TIMESTAMP WHERE id=?").run(leadId);
  return aiReply;
}

async function sendSMS(to, message) {
  try {
    const apiKey = process.env.SMS_API_KEY;
    if (!apiKey) return;
    await axios.post('https://api.smsmobileapi.com/sendsms', { apikey: apiKey, number: to, message });
  } catch(e) { console.log('SMS error:', e.message); }
}

// ─── ROUTES ───────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  res.json({
    leadsToday: db.prepare("SELECT COUNT(*) as c FROM leads WHERE date(created_at)=date('now')").get().c,
    activeConvos: db.prepare("SELECT COUNT(*) as c FROM leads WHERE status='qualifying'").get().c,
    hotLeads: db.prepare("SELECT COUNT(*) as c FROM leads WHERE status='hot'").get().c,
    underContract: db.prepare("SELECT COUNT(*) as c FROM leads WHERE status='under_contract'").get().c,
    totalLeads: db.prepare("SELECT COUNT(*) as c FROM leads").get().c,
    closedDeals: db.prepare("SELECT COUNT(*) as c FROM deals WHERE status='closed'").get().c,
    totalEarned: db.prepare("SELECT COALESCE(SUM(wholesale_fee),0) as s FROM deals WHERE status='closed'").get().s,
  });
});

app.get('/api/leads', (req, res) => {
  res.json(db.prepare('SELECT * FROM leads ORDER BY updated_at DESC').all());
});

app.get('/api/conversations/:leadId', (req, res) => {
  res.json(db.prepare('SELECT * FROM conversations WHERE lead_id=? ORDER BY created_at ASC').all(req.params.leadId));
});

app.get('/api/activity', (req, res) => {
  res.json(db.prepare('SELECT c.*, l.address, l.city FROM conversations c JOIN leads l ON c.lead_id=l.id ORDER BY c.created_at DESC LIMIT 20').all());
});

// IMPORT SINGLE LEAD
app.post('/api/leads/import', async (req, res) => {
  try {
    const { address, city, state, zip, phone, name, sqft, source } = req.body;
    if (!address) return res.status(400).json({ error: 'Address required' });
    const existing = db.prepare('SELECT id FROM leads WHERE address=?').get(address);
    if (existing) return res.json({ id: existing.id, skipped: true });
    const lead = db.prepare(
      'INSERT INTO leads (address, city, state, zip, phone, name, sqft, source, status) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(address, city||'FL', state||'FL', zip||'', phone||'', name||'', sqft||null, source||'csv', 'new');
    const msg = `New lead imported: ${address}, ${city}. AI ready to reach out.`;
    db.prepare('INSERT INTO conversations (lead_id, role, message) VALUES (?,?,?)').run(lead.lastInsertRowid, 'ai', msg);
    res.json({ id: lead.lastInsertRowid });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/leads/:id/reply', async (req, res) => {
  const reply = await runAIConversation(req.params.id, req.body.message);
  res.json({ reply });
});

app.post('/api/sms/inbound', async (req, res) => {
  const { from, message } = req.body;
  const lead = db.prepare('SELECT * FROM leads WHERE phone=?').get(from);
  if (lead) { const reply = await runAIConversation(lead.id, message); if (reply) await sendSMS(from, reply); }
  res.json({ success: true });
});

app.patch('/api/leads/:id', (req, res) => {
  const { status, condition, sqft, arv, phone, name } = req.body;
  db.prepare('UPDATE leads SET status=COALESCE(?,status), condition=COALESCE(?,condition), sqft=COALESCE(?,sqft), arv=COALESCE(?,arv), phone=COALESCE(?,phone), name=COALESCE(?,name), updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, condition, sqft, arv, phone, name, req.params.id);
  res.json({ success: true });
});

app.post('/api/buyers', (req, res) => {
  const { name, phone, email, markets, min_price, max_price, close_days } = req.body;
  const result = db.prepare('INSERT INTO buyers (name,phone,email,markets,min_price,max_price,close_days) VALUES (?,?,?,?,?,?,?)').run(name, phone, email, markets, min_price, max_price, close_days);
  res.json({ id: result.lastInsertRowid });
});

app.get('/api/buyers', (req, res) => {
  res.json(db.prepare('SELECT * FROM buyers ORDER BY deals_done DESC').all());
});

app.post('/api/calculate', (req, res) => {
  res.json(calculateOffer(req.body.sqft, req.body.condition, req.body.arv));
});

app.post('/api/scan', (req, res) => {
  res.json({ message: 'Use CSV upload to add leads' });
});


// ─── TRACERFY SKIP TRACE ──────────────────────────────────────────
async function skipTraceLead(leadId, address, city, state) {
  const apiKey = process.env.TRACERFI_API_KEY;
  if (!apiKey) return;
  try {
    const response = await axios.post('https://tracerfy.com/api/trace/', 
      { addresses: [{ address, city, state: state || 'FL' }] },
      { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }
    );
    const result = response.data;
    if (result && result.results && result.results[0]) {
      const data = result.results[0];
      const phone = data.phones && data.phones[0] ? data.phones[0].number : null;
      const name = data.owner_name || null;
      if (phone || name) {
        db.prepare('UPDATE leads SET phone=COALESCE(?,phone), name=COALESCE(?,name), updated_at=CURRENT_TIMESTAMP WHERE id=?').run(phone, name, leadId);
        console.log(`Skip traced lead ${leadId}: ${name} - ${phone}`);
      }
    }
  } catch(e) {
    console.log('Tracerfy error:', e.message);
  }
}

// ─── TRACERFY WEBHOOK ─────────────────────────────────────────────
app.post('/api/tracerfy/webhook', async (req, res) => {
  try {
    const data = req.body;
    console.log('Tracerfy webhook received:', JSON.stringify(data).substring(0, 200));
    
    // Handle webhook results
    const results = data.results || data.records || data.data || [];
    for (const record of results) {
      const address = record.address || record.property_address || '';
      const phone = record.phones?.[0]?.number || record.phone || record.mobile || '';
      const name = record.owner_name || record.name || '';
      const email = record.emails?.[0] || record.email || '';
      
      if (address) {
        const lead = db.prepare('SELECT id FROM leads WHERE address LIKE ?').get(`%${address.split(',')[0]}%`);
        if (lead) {
          db.prepare('UPDATE leads SET phone=COALESCE(NULLIF(?,''),phone), name=COALESCE(NULLIF(?,''),name), updated_at=CURRENT_TIMESTAMP WHERE id=?').run(phone, name, lead.id);
          console.log(`Updated lead ${lead.id} with skip trace data`);
        }
      }
    }
    res.json({ success: true });
  } catch(e) {
    console.log('Webhook error:', e.message);
    res.json({ success: false });
  }
});


// Auto skip trace all leads missing phone numbers on startup
async function skipTraceAllPending() {
  const pending = db.prepare("SELECT * FROM leads WHERE (phone IS NULL OR phone = '') AND status != 'dead'").all();
  console.log(`Auto skip tracing ${pending.length} leads...`);
  for (const lead of pending) {
    await skipTraceLead(lead.id, lead.address, lead.city, lead.state);
    await new Promise(r => setTimeout(r, 500)); // small delay between calls
  }
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`DealFlow AI running on port ${PORT}`);
  setTimeout(skipTraceAllPending, 3000); // run skip trace 3 seconds after startup
});

// This line already exists - adding webhook and tracerfy integration below the existing routes
