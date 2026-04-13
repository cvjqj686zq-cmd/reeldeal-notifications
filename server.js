const express = require('express');
const crypto  = require('crypto');
const https   = require('https');
const app     = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const VERIFICATION_TOKEN = process.env.EBAY_VERIFICATION_TOKEN || 'reeldeal-verify-token-change-me';
const ANTHROPIC_KEY      = process.env.ANTHROPIC_API_KEY || '';
const PORT               = process.env.PORT || 3000;

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── helpers ────────────────────────────────────────────────────────────────

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    const options = {
      hostname, path, method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(bodyStr) }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { reject(new Error('Invalid JSON: ' + data.substring(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function httpsGet(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET', headers }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Token cache ────────────────────────────────────────────────────────────
const tokenCache = {};

async function getToken(clientId, clientSecret) {
  const cached = tokenCache[clientId];
  if (cached && Date.now() < cached.expiry) return cached.token;
  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body  = 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope';
  const result = await httpsPost('api.ebay.com', '/identity/v1/oauth2/token', {
    'Authorization': `Basic ${creds}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  }, body);
  if (!result.body.access_token) throw new Error(result.body.error_description || 'Auth failed');
  tokenCache[clientId] = { token: result.body.access_token, expiry: Date.now() + (result.body.expires_in - 120) * 1000 };
  return result.body.access_token;
}

// ── Claude FMV analysis ────────────────────────────────────────────────────
async function analyzeWithClaude(listings, threshold, minProfit, studioList) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY not set in Render environment variables');
  const prompt = `You are an expert eBay reseller specializing in boutique physical media (Criterion, Arrow Video, Vinegar Syndrome, Shout Factory, Kino Lorber, Severin Films, Second Sight, Indicator, 88 Films, Imprint, Eureka, Powerhouse Films, Fun City Editions, Deaf Crocodile, Twilight Time, Synapse Films, AGFA, American Genre Film Archive).

These listings were returned by eBay searches for boutique studios. Some may not actually be boutique releases — generic studio titles, bootlegs, or unrelated items sometimes slip through.

For each listing:
1. Identify whether it is genuinely a release from one of the boutique studios listed above. Set isBoutique=false and skip FMV analysis for anything that is not.
2. For confirmed boutique releases, estimate fair market value (FMV) using sold comps if provided, otherwise your knowledge of collector demand, OOP status, and market trends.
3. Flag isDeal=true if asking price is ${threshold}%+ below FMV AND estimated profit >= $${minProfit}.

Targeted studios for this scan: ${studioList.join(', ')}

Listings: ${JSON.stringify(listings)}
Respond ONLY with a JSON array, no markdown, no backticks. Each object:
{"itemId":"","title":"","studio":"","isBoutique":true,"askingPrice":0,"estimatedFMV":0,"discountPct":0,"estimatedProfit":0,"isDeal":false,"isHot":false,"isOOP":false,"reasoning":"","resaleNotes":"","url":""}`;

  const result = await httpsPost('api.anthropic.com', '/v1/messages', {
    'Content-Type': 'application/json',
    'x-api-key': ANTHROPIC_KEY,
    'anthropic-version': '2023-06-01',
  }, {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = result.body.content.map(c => c.text || '').join('');
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

// ── POST /scan ─────────────────────────────────────────────────────────────
app.post('/scan', async (req, res) => {
  const { clientId, clientSecret, studios, maxPrice = 50, format = '', maxResults = 50, threshold = 50, minProfit = 10, condition = 'NEW|LIKE_NEW|VERY_GOOD' } = req.body;
  if (!clientId || !clientSecret) return res.status(400).json({ error: 'clientId and clientSecret required' });

  console.log(`[${new Date().toISOString()}] Scan — studios: ${studios?.join(', ')}`);

  try {
    const token = await getToken(clientId, clientSecret);
    const studioList = (studios && studios.length > 0) ? studios.slice(0, 6) : ['Criterion', 'Arrow Video', 'Vinegar Syndrome'];

    let allListings = [];
    for (const studio of studioList) {
      const q = format ? `${studio} ${format}` : studio;
      const condFilter = condition && condition !== '' ? `,conditions:{${condition}}` : '';
      const path = `/buy/browse/v1/item_summary/search?q=${encodeURIComponent(q)}&filter=buyingOptions:{FIXED_PRICE},price:[0..${maxPrice}],priceCurrency:USD${condFilter}&category_ids=617&limit=${maxResults}&sort=price`;
      try {
        const data = await httpsGet('api.ebay.com', path, {
          'Authorization': `Bearer ${token}`,
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        });
        const items = data.itemSummaries || [];
        allListings.push(...items);
        console.log(`  ${studio}: ${items.length} listings`);
      } catch(e) { console.error(`  ${studio} error: ${e.message}`); }
    }

    // Deduplicate
    const seen = new Set();
    allListings = allListings.filter(l => {
      if (seen.has(l.itemId)) return false;
      seen.add(l.itemId); return true;
    });

    allListings = allListings.slice(0, 100);
    console.log(`  Total unique listings: ${allListings.length}`);

    console.log(`  Total: ${allListings.length} unique listings`);

    // Fetch sold comps
    const compsResults = await Promise.all(allListings.map(async l => {
      try {
        const q = encodeURIComponent(l.title.substring(0, 50) + ' blu-ray');
        const path = `/services/search/FindingService/v1?OPERATION-NAME=findCompletedItems&SERVICE-VERSION=1.0.0&SECURITY-APPNAME=${encodeURIComponent(clientId)}&RESPONSE-DATA-FORMAT=JSON&keywords=${q}&categoryId=617&itemFilter(0).name=SoldItemsOnly&itemFilter(0).value=true&paginationInput.entriesPerPage=10&siteid=0`;
        const data = await httpsGet('svcs.ebay.com', path, {});
        const items = data?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item || [];
        const prices = items.map(i => parseFloat(i.sellingStatus?.[0]?.currentPrice?.[0]?.__value__ || 0)).filter(p => p > 0);
        if (!prices.length) return null;
        return { avg: prices.reduce((a,b)=>a+b,0)/prices.length, count: prices.length };
      } catch(e) { return null; }
    }));

    // Build payload for Claude
    const payload = allListings.map((l, i) => ({
      itemId: l.itemId,
      title: l.title,
      askingPrice: parseFloat(l.price?.value || 0),
      condition: l.condition,
      url: l.itemWebUrl,
      soldComps: compsResults[i],
    }));

    // Filter out anything Claude flagged as not a boutique release
    const analyzed = (await analyzeWithClaude(payload, threshold, minProfit, studioList))
      .filter(item => item.isBoutique !== false);

    console.log(`  Analysis complete — ${analyzed.filter(a=>a.isDeal).length} deals, ${analyzed.length} boutique listings`);

    res.json({ listings: analyzed });

  } catch(e) {
    console.error('Scan error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── eBay challenge verification ────────────────────────────────────────────
app.get('/ebay/notifications', (req, res) => {
  const challengeCode = req.query.challenge_code;
  if (!challengeCode) return res.status(400).json({ error: 'Missing challenge_code' });
  const endpointUrl = `https://${req.get('host')}/ebay/notifications`;
  const hash = crypto.createHash('sha256').update(challengeCode + VERIFICATION_TOKEN + endpointUrl).digest('hex');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(JSON.stringify({ challengeResponse: hash }));
});

app.post('/ebay/notifications', (req, res) => {
  console.log(`[${new Date().toISOString()}] Deletion notification received`);
  res.sendStatus(200);
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'ReelDeal Server', time: new Date().toISOString() });
});

app.listen(PORT, () => console.log(`ReelDeal server running on port ${PORT}`));
