const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// ─── DATABASE ─────────────────────────────────────────────────────
const db = new Database('./dealflow.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT DEFAULT '', phone TEXT DEFAULT '', email TEXT DEFAULT '',
    address TEXT, city TEXT, state TEXT DEFAULT 'FL', zip TEXT DEFAULT '',
    source TEXT DEFAULT 'csv', status TEXT DEFAULT 'new',
    condition TEXT, sqft REAL, arv REAL,
    offer_amount REAL, min_offer REAL, asking_price REAL,
    notes TEXT DEFAULT '', dnc INTEGER DEFAULT 0,
    skiptrace_done INTEGER DEFAULT 0,
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

// ─── AI ───────────────────────────────────────────────────────────
function getAI() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// ─── OFFER CALCULATOR ─────────────────────────────────────────────
function calcOffer(sqft, condition, arv) {
  const rate = condition === 'remodel' ? 50 : 40;
  const rehab = sqft * rate;
  const rule70 = arv * 0.7;
  return {
    rehab,
    offer: Math.max(rule70 - rehab - 20000, 0),
    minOffer: Math.max(rule70 - rehab - 15000, 0)
  };
}

// ─── AI CONVERSATION ──────────────────────────────────────────────
async function runAI(leadId, incomingMessage) {
  const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(leadId);
  if (!lead) return null;
  const history = db.prepare('SELECT role,message FROM conversations WHERE lead_id=? ORDER BY created_at ASC').all(leadId);
  const messages = history.map(h => ({ role: h.role === 'ai' ? 'assistant' : 'user', content: h.message }));
  if (incomingMessage) {
    messages.push({ role: 'user', content: incomingMessage });
    db.prepare('INSERT INTO conversations (lead_id,role,message) VALUES (?,?,?)').run(leadId, 'seller', incomingMessage);
  }
  const system = `You are David from Florida Home Buyers. Text with motivated sellers. Get: 1) livable or remodel 2) square footage 3) asking price 4) timeline. Offer formula: Livable=sqft*$40 rehab, Remodel=sqft*$50 rehab, Offer=ARV*70%-rehab-$20000, Min=ARV*70%-rehab-$15000. Never go below minimum. If they want to talk schedule a call. If they accept send DocuSign. Property: ${lead.address}, ${lead.city} FL. Keep texts SHORT. Never say you are AI.`;
  const ai = getAI();
  const res = await ai.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 300, system, messages });
  const reply = res.content[0].text;
  db.prepare('INSERT INTO conversations (lead_id,role,message) VALUES (?,?,?)').run(leadId, 'ai', reply);
  const lower = reply.toLowerCase();
  if (lower.includes('contract') || lower.includes('docusign')) {
    db.prepare("UPDATE leads SET status='under_contract',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(leadId);
  } else if (incomingMessage && (incomingMessage.toLowerCase().includes('call') || incomingMessage.toLowerCase().includes('talk'))) {
    db.prepare("UPDATE leads SET status='hot',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(leadId);
  } else if (history.length > 2) {
    db.prepare("UPDATE leads SET status='qualifying',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(leadId);
  }
  return reply;
}

// ─── SMS ──────────────────────────────────────────────────────────
async function sendSMS(to, message) {
  try {
    if (!process.env.SMS_API_KEY) return;
    await axios.post('https://api.smsmobileapi.com/sendsms', {
      apikey: process.env.SMS_API_KEY, number: to, message
    });
  } catch(e) { console.log('SMS error:', e.message); }
}

// ─── TRACERFY SKIP TRACE ──────────────────────────────────────────
async function skipTraceLeads(leadIds) {
  const apiKey = process.env.TRACERFI_API_KEY;
  if (!apiKey) { console.log('No Tracerfy key'); return { error: 'No API key' }; }
  
  const leads = leadIds.map(id => db.prepare('SELECT * FROM leads WHERE id=?').get(id)).filter(Boolean);
  if (!leads.length) return { error: 'No leads found' };

  try {
    // Build CSV content for Tracerfy batch upload
    const csvLines = ['address,city,state,zip,first_name,last_name'];
    for (const l of leads) {
      const nameParts = (l.name || '').split(' ');
      const firstName = nameParts[0] || '';
      const lastName = nameParts.slice(1).join(' ') || '';
      csvLines.push(`"${l.address}","${l.city||'Tampa'}","${l.state||'FL'}","${l.zip||''}","${firstName}","${lastName}"`);
    }
    const csvContent = csvLines.join('\n');
    
    // Send as multipart form data
    const FormData = require('form-data');
    const form = new FormData();
    form.append('csv_file', Buffer.from(csvContent), { filename: 'leads.csv', contentType: 'text/csv' });
    form.append('address_column', 'address');
    form.append('city_column', 'city');
    form.append('state_column', 'state');
    form.append('first_name_column', 'first_name');
    form.append('last_name_column', 'last_name');
    form.append('trace_type', 'normal');
    form.append('mail_address_column', 'address');
    form.append('mail_city_column', 'city');
    form.append('mail_state_column', 'state');

    const response = await axios.post(
      'https://tracerfy.com/v1/api/trace/',
      form,
      { headers: { 'Authorization': `Bearer ${apiKey}`, ...form.getHeaders() } }
    );

    console.log('Tracerfy batch submitted:', response.data);
    return { success: true, queue_id: response.data.queue_id, message: 'Skip trace submitted. Results will appear automatically when complete.' };
  } catch(e) {
    console.log('Tracerfy error:', e.response?.data || e.message);
    return { error: e.response?.data?.detail || e.message };
  }
}

// ─── DNC SCRUB ────────────────────────────────────────────────────
async function dncScrub(phones) {
  const apiKey = process.env.TRACERFI_API_KEY;
  if (!apiKey || !phones.length) return;
  try {
    const response = await axios.post(
      'https://tracerfy.com/v1/api/dnc/scrub/',
      { phones },
      { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }
    );
    return response.data;
  } catch(e) {
    console.log('DNC error:', e.message);
    return null;
  }
}

// ─── ROUTES ───────────────────────────────────────────────────────

// Stats
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

// Leads
app.get('/api/leads', (req, res) => res.json(db.prepare('SELECT * FROM leads ORDER BY updated_at DESC').all()));

// Import leads from CSV (no duplicate check - always imports fresh)
app.post('/api/leads/import', async (req, res) => {
  try {
    const { leads } = req.body; // array of lead objects
    let imported = 0;
    const ids = [];
    for (const l of leads) {
      if (!l.address) continue;
      const result = db.prepare(
        'INSERT OR REPLACE INTO leads (address,city,state,zip,name,phone,sqft,source,status) VALUES (?,?,?,?,?,?,?,?,?)'
      ).run(l.address, l.city||'FL', l.state||'FL', l.zip||'', l.name||'', l.phone||'', l.sqft||null, 'propwire', 'new');
      ids.push(result.lastInsertRowid);
      imported++;
    }
    res.json({ imported, ids });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Skip trace selected leads
app.post('/api/leads/skiptrace', async (req, res) => {
  const { lead_ids } = req.body;
  const result = await skipTraceLeads(lead_ids);
  res.json(result);
});

// Tracerfy webhook - receives skip trace results
app.post('/api/tracerfy/webhook', async (req, res) => {
  try {
    const data = req.body;
    console.log('Tracerfy webhook received');
    const results = data.results || data.records || data.data || [];
    const phones = [];
    
    for (const record of results) {
      const addr = (record.address || record.property_address || '').split(',')[0].trim();
      const phone = record.phones?.[0]?.number || record.phone || '';
      const name = record.owner_name || record.name || '';
      const email = record.emails?.[0] || record.email || '';
      const dnc = record.dnc ? 1 : 0;
      
      if (phone) phones.push(phone);
      
      if (addr) {
        const lead = db.prepare("SELECT id FROM leads WHERE address LIKE ?").get(`%${addr}%`);
        if (lead) {
          db.prepare('UPDATE leads SET phone=COALESCE(?,phone), name=COALESCE(?,name), email=COALESCE(?,email), dnc=?, skiptrace_done=1, updated_at=CURRENT_TIMESTAMP WHERE id=?')
            .run(phone||null, name||null, email||null, dnc, lead.id);
        }
      }
    }
    res.json({ success: true });
  } catch(e) {
    console.log('Webhook error:', e.message);
    res.json({ success: false });
  }
});

// Conversations
app.get('/api/conversations/:leadId', (req, res) => res.json(db.prepare('SELECT * FROM conversations WHERE lead_id=? ORDER BY created_at ASC').all(req.params.leadId)));

app.post('/api/leads/:id/reply', async (req, res) => {
  const reply = await runAI(req.params.id, req.body.message);
  res.json({ reply });
});

// SMS inbound
app.post('/api/sms/inbound', async (req, res) => {
  const { from, message } = req.body;
  const lead = db.prepare('SELECT * FROM leads WHERE phone=?').get(from);
  if (lead) { const reply = await runAI(lead.id, message); if (reply) await sendSMS(from, reply); }
  res.json({ success: true });
});

// Update lead
app.patch('/api/leads/:id', (req, res) => {
  const { status, condition, sqft, arv, phone, name } = req.body;
  db.prepare('UPDATE leads SET status=COALESCE(?,status),condition=COALESCE(?,condition),sqft=COALESCE(?,sqft),arv=COALESCE(?,arv),phone=COALESCE(?,phone),name=COALESCE(?,name),updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(status, condition, sqft, arv, phone, name, req.params.id);
  res.json({ success: true });
});

// Buyers
app.get('/api/buyers', (req, res) => res.json(db.prepare('SELECT * FROM buyers ORDER BY deals_done DESC').all()));
app.post('/api/buyers', (req, res) => {
  const { name, phone, email, markets, min_price, max_price, close_days } = req.body;
  const r = db.prepare('INSERT INTO buyers (name,phone,email,markets,min_price,max_price,close_days) VALUES (?,?,?,?,?,?,?)').run(name,phone,email,markets,min_price,max_price,close_days);
  res.json({ id: r.lastInsertRowid });
});

// Deals
app.get('/api/deals', (req, res) => res.json(db.prepare('SELECT * FROM deals ORDER BY created_at DESC').all()));


// Clear all leads
app.delete('/api/leads/all', (req, res) => {
  db.prepare('DELETE FROM conversations').run();
  db.prepare('DELETE FROM leads').run();
  res.json({ success: true });
});

// Import Tracerfy results CSV
app.post('/api/leads/import-tracerfy', async (req, res) => {
  try {
    const { results } = req.body; // array of {address, name, phone, email, dnc}
    let updated = 0;
    for (const r of results) {
      if (!r.address) continue;
      const addrPart = r.address.split(',')[0].trim();
      const lead = db.prepare("SELECT id FROM leads WHERE address LIKE ?").get(`%${addrPart}%`);
      if (lead) {
        db.prepare('UPDATE leads SET name=COALESCE(?,name), phone=COALESCE(?,phone), email=COALESCE(?,email), dnc=?, skiptrace_done=1, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(r.name||null, r.phone||null, r.email||null, r.dnc?1:0, lead.id);
          .run(r.name||'', r.phone||'', r.email||'', r.dnc?1:0, lead.id);
        updated++;
      }
    }
    res.json({ updated });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Calculator
app.post('/api/calculate', (req, res) => res.json(calcOffer(req.body.sqft, req.body.condition, req.body.arv)));

// Activity
app.get('/api/activity', (req, res) => {
  res.json(db.prepare('SELECT c.*,l.address,l.city FROM conversations c JOIN leads l ON c.lead_id=l.id ORDER BY c.created_at DESC LIMIT 20').all());
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`DealFlow AI v2 running on port ${PORT}`));
