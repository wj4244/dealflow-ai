const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const Database = require('better-sqlite3');

const app = express();
const db = new Database('./dealflow.db');

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, phone TEXT, address TEXT, city TEXT, source TEXT,
    status TEXT DEFAULT 'new', condition TEXT, sqft REAL, arv REAL,
    rehab_cost REAL, offer_amount REAL, min_offer REAL, asking_price REAL,
    notes TEXT, reddit_url TEXT,
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
    min_price REAL, max_price REAL, close_days INTEGER, deals_done INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS deals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER, buyer_id INTEGER, property_address TEXT,
    arv REAL, purchase_price REAL, wholesale_fee REAL,
    status TEXT DEFAULT 'under_contract',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(lead_id) REFERENCES leads(id),
    FOREIGN KEY(buyer_id) REFERENCES buyers(id)
  );
`);

function getAI() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// ─── REDDIT SCRAPER ───────────────────────────────────────────────
const SUBREDDITS = [
  'florida', 'tampa', 'orlando', 'jacksonville', 'miami',
  'realestate', 'RealEstateInvesting', 'Sarasota', 'fortlauderdale'
];

const MOTIVATED_KEYWORDS = [
  'need to sell', 'selling my house', 'sell fast', 'cash offer',
  'sell quickly', 'motivated seller', 'must sell', 'selling home',
  'fsbo', 'for sale by owner', 'sell my house', 'need to move',
  'foreclosure', 'behind on payments', 'divorce', 'inherited'
];

async function scrapeReddit() {
  console.log('Scanning Reddit for Florida motivated sellers...');
  
  for (const subreddit of SUBREDDITS) {
    try {
      const response = await axios.get(
        `https://www.reddit.com/r/${subreddit}/new.json?limit=25`,
        { headers: { 'User-Agent': 'DealFlowAI/1.0' } }
      );
      
      const posts = response.data?.data?.children || [];
      
      for (const post of posts) {
        const data = post.data;
        const title = (data.title || '').toLowerCase();
        const body = (data.selftext || '').toLowerCase();
        const fullText = title + ' ' + body;
        
        const isMotivated = MOTIVATED_KEYWORDS.some(kw => fullText.includes(kw));
        const isFL = fullText.includes('florida') || fullText.includes(' fl ') || 
                     ['tampa','orlando','jacksonville','miami','sarasota'].some(c => fullText.includes(c));
        
        if (isMotivated && (isFL || ['tampa','orlando','jacksonville','miami','sarasota','fortlauderdale'].includes(subreddit))) {
          const redditUrl = `https://reddit.com${data.permalink}`;
          const existing = db.prepare('SELECT id FROM leads WHERE reddit_url = ?').get(redditUrl);
          
          if (!existing) {
            const lead = db.prepare(`
              INSERT INTO leads (address, city, source, status, notes, reddit_url)
              VALUES (?, ?, 'reddit', 'new', ?, ?)
            `).run(
              data.title.substring(0, 100),
              subreddit,
              `${data.title} - ${data.selftext?.substring(0, 200)}`,
              redditUrl
            );
            console.log(`New Reddit lead: ${data.title.substring(0, 50)}`);
            await logOutreach(lead.lastInsertRowid, data.title, subreddit, redditUrl);
          }
        }
      }
    } catch (err) {
      console.log(`Reddit r/${subreddit} error: ${err.message}`);
    }
  }
}

async function logOutreach(leadId, title, city, url) {
  const message = `Found motivated seller post on Reddit: "${title}" - ${url}. AI ready to respond when contact info is available.`;
  db.prepare('INSERT INTO conversations (lead_id, role, message) VALUES (?, ?, ?)').run(leadId, 'ai', message);
}

function calculateOffer(sqft, condition, arv) {
  const rehabRate = condition === 'remodel' ? 50 : 40;
  const rehab = sqft * rehabRate;
  const rule70 = arv * 0.7;
  const offer = rule70 - rehab - 20000;
  const minOffer = rule70 - rehab - 15000;
  return { rehab, offer: Math.max(offer, 0), minOffer: Math.max(minOffer, 0) };
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
  const systemPrompt = `You are a real estate wholesale acquisitions specialist named David from Florida Home Buyers. You are texting with a motivated seller about their property. Your goal is to: 1. Build quick rapport 2. Find out if the property is livable or needs full remodel 3. Get the square footage 4. Find out their asking price and timeline 5. Calculate and make a cash offer: Livable = sqft x $40 rehab, Full remodel = sqft x $50 rehab, Offer = ARV x 70% - rehab - $20000, Minimum = ARV x 70% - rehab - $15000 6. Never go below minimum. Walk away politely if needed. 7. If they want to talk to someone, say your property specialist will call and ask what time works. 8. If they accept, say you will send DocuSign contract right away. Property: ${lead.address}. Notes: ${lead.notes}. Keep messages SHORT like real texts. Be warm and human. Never reveal you are an AI.`;
  const ai = getAI();
  const response = await ai.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 300, system: systemPrompt, messages });
  const aiReply = response.content[0].text;
  db.prepare('INSERT INTO conversations (lead_id, role, message) VALUES (?, ?, ?)').run(leadId, 'ai', aiReply);
  if (aiReply.toLowerCase().includes('contract') || aiReply.toLowerCase().includes('docusign')) {
    db.prepare("UPDATE leads SET status = 'under_contract' WHERE id = ?").run(leadId);
  } else if (incomingMessage && (incomingMessage.toLowerCase().includes('talk to someone') || incomingMessage.toLowerCase().includes('call me'))) {
    db.prepare("UPDATE leads SET status = 'hot' WHERE id = ?").run(leadId);
  } else if (history.length > 2) {
    db.prepare("UPDATE leads SET status = 'qualifying' WHERE id = ?").run(leadId);
  }
  db.prepare("UPDATE leads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(leadId);
  return aiReply;
}

async function sendSMS(to, message) {
  try {
    const apiKey = process.env.SMS_API_KEY;
    if (!apiKey) { console.log(`SMS (no key): To ${to}: ${message}`); return; }
    await axios.post('https://api.smsmobileapi.com/sendsms', { apikey: apiKey, number: to, message: message });
  } catch (err) { console.log(`SMS error: ${err.message}`); }
}

app.get('/api/stats', (req, res) => {
  res.json({
    leadsToday: db.prepare("SELECT COUNT(*) as c FROM leads WHERE date(created_at) = date('now')").get().c,
    activeConvos: db.prepare("SELECT COUNT(*) as c FROM leads WHERE status = 'qualifying'").get().c,
    hotLeads: db.prepare("SELECT COUNT(*) as c FROM leads WHERE status = 'hot'").get().c,
    underContract: db.prepare("SELECT COUNT(*) as c FROM leads WHERE status = 'under_contract'").get().c,
    totalLeads: db.prepare("SELECT COUNT(*) as c FROM leads").get().c,
    closedDeals: db.prepare("SELECT COUNT(*) as c FROM deals WHERE status = 'closed'").get().c,
    totalEarned: db.prepare("SELECT COALESCE(SUM(wholesale_fee),0) as s FROM deals WHERE status = 'closed'").get().s,
  });
});

app.get('/api/leads', (req, res) => { res.json(db.prepare('SELECT * FROM leads ORDER BY updated_at DESC').all()); });
app.get('/api/conversations/:leadId', (req, res) => { res.json(db.prepare('SELECT * FROM conversations WHERE lead_id = ? ORDER BY created_at ASC').all(req.params.leadId)); });

app.post('/api/sms/inbound', async (req, res) => {
  const { from, message } = req.body;
  const lead = db.prepare('SELECT * FROM leads WHERE phone = ?').get(from);
  if (lead) { const reply = await runAIConversation(lead.id, message); if (reply) await sendSMS(from, reply); }
  res.json({ success: true });
});

app.post('/api/leads/:id/reply', async (req, res) => {
  const reply = await runAIConversation(req.params.id, req.body.message);
  res.json({ reply });
});

app.post('/api/buyers', (req, res) => {
  const { name, phone, email, markets, min_price, max_price, close_days } = req.body;
  const result = db.prepare('INSERT INTO buyers (name, phone, email, markets, min_price, max_price, close_days) VALUES (?, ?, ?, ?, ?, ?, ?)').run(name, phone, email, markets, min_price, max_price, close_days);
  res.json({ id: result.lastInsertRowid });
});

app.get('/api/buyers', (req, res) => { res.json(db.prepare('SELECT * FROM buyers ORDER BY deals_done DESC').all()); });
app.post('/api/calculate', (req, res) => { res.json(calculateOffer(req.body.sqft, req.body.condition, req.body.arv)); });

app.patch('/api/leads/:id', (req, res) => {
  const { status, condition, sqft, arv, phone, name } = req.body;
  db.prepare('UPDATE leads SET status = COALESCE(?, status), condition = COALESCE(?, condition), sqft = COALESCE(?, sqft), arv = COALESCE(?, arv), phone = COALESCE(?, phone), name = COALESCE(?, name), updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, condition, sqft, arv, phone, name, req.params.id);
  res.json({ success: true });
});

app.get('/api/activity', (req, res) => {
  res.json(db.prepare('SELECT c.*, l.address, l.city FROM conversations c JOIN leads l ON c.lead_id = l.id ORDER BY c.created_at DESC LIMIT 20').all());
});

app.post('/api/scan', async (req, res) => { scrapeReddit(); res.json({ message: 'Scanning Reddit for motivated sellers...' }); });

cron.schedule('*/30 * * * *', () => { scrapeReddit(); });

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => { console.log(`DealFlow AI running on port ${PORT}`); scrapeReddit(); });
