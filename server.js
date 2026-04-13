const express = require('express');
const crypto  = require('crypto');
const https   = require('https');
const app     = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const VERIFICATION_TOKEN = process.env.EBAY_VERIFICATION_TOKEN || 'reeldeal-verify-token-change-me';
const PORT = process.env.PORT || 3000;

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── helpers ────────────────────────────────────────────────────────────────

function ebayGet(path, token) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.ebay.com',
      path,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        'Content-Type': 'application/json',
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Invalid JSON from eBay: ' + data.substring(0,200))); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function ebayFinding(clientId, keywords) {
  return new Promise((resolve, reject) => {
    const q = encodeURIComponent(keywords.substring(0, 50) + ' blu-ray');
    const path = `/services/search/FindingService/v1?OPERATION-NAME=findCompletedItems&SERVICE-VERSION=1.0.0&SECURITY-APPNAME=${encodeURIComponent(clientId)}&RESPONSE-DATA-FORMAT=JSON&keywords=${q}&categoryId=617&itemFilter(0).name=SoldItemsOnly&itemFilter(0).value=true&paginationInput.entriesPerPage=10&siteid=0`;
    const options = { hostname: 'svcs.ebay.com', path, method: 'GET' };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

function ebayToken(clientId, clientSecret) {
  return new Promise((resolve, reject) => {
    const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const body  = 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope';
    const options = {
      hostname: 'api.ebay.com',
      path: '/identity/v1/oauth2/token',
      method: 'POST',
      headers: {
        'Authorization': `Basic ${creds}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Token parse error')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Token cache (in-memory, per clientId) ─────────────────────────────────
const tokenCache = {};

async function getToken(clientId, clientSecret) {
  const cached = tokenCache[clientId];
  if (cached && Date.now() < cached.expiry) return cached.token;
  const data = await ebayToken(clientId, clientSecret);
  if (!data.access_token) throw new Error(data.error_description || 'Auth failed');
  tokenCache[clientId] = { token: data.access_token, expiry: Date.now() + (data.expires_in - 120) * 1000 };
  return data.access_token;
}

// ── POST /scan — full scan endpoint ───────────────────────────────────────
// Body: { clientId, clientSecret, studios[], maxPrice, format, maxResults }
// Returns: { listings: [...analyzed] }
app.post('/scan', async (req, res) => {
  const { clientId, clientSecret, studios, maxPrice = 50, format = '', maxResults = 50 } = req.body;
  if (!clientId || !clientSecret) return res.status(400).json({ error: 'clientId and clientSecret required' });

  console.log(`[${new Date().toISOString()}] Scan request — studios: ${studios?.join(', ')}`);

  try {
    const token = await getToken(clientId, clientSecret);
    const studioList = (studios && studios.length > 0) ? studios.slice(0, 6) : ['Criterion', 'Arrow Video', 'Vinegar Syndrome'];

    let allListings = [];

    for (const studio of studioList) {
      const q = format ? `${studio} ${format}` : studio;
      const path = `/buy/browse/v1/item_summary/search?q=${encodeURIComponent(q)}&filter=buyingOptions:{FIXED_PRICE},price:[0..${maxPrice}],priceCurrency:USD&category_ids=617&limit=${maxResults}&sort=price`;
      try {
        const data = await ebayGet(path, token);
        const items = data.itemSummaries || [];
        allListings.push(...items);
        console.log(`  ${studio}: ${items.length} listings`);
      } catch(e) {
        console.error(`  ${studio} error: ${e.message}`);
      }
    }

    // Deduplicate
    const seen = new Set();
    allListings = allListings.filter(l => {
      if (seen.has(l.itemId)) return false;
      seen.add(l.itemId);
      return true;
    }).slice(0, 100);

    console.log(`  Total unique listings: ${allListings.length}`);

    // Fetch sold comps for each listing
    const compsResults = await Promise.all(
      allListings.map(async l => {
        const data = await ebayFinding(clientId, l.title);
        if (!data) return null;
        const items = data?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item || [];
        const prices = items
          .map(i => parseFloat(i.sellingStatus?.[0]?.currentPrice?.[0]?.__value__ || 0))
          .filter(p => p > 0);
        if (!prices.length) return null;
        return { avg: prices.reduce((a,b)=>a+b,0)/prices.length, count: prices.length };
      })
    );

    // Return raw data to the browser — Claude AI analysis happens client-side via Anthropic API
    const result = allListings.map((l, i) => ({
      itemId: l.itemId,
      title: l.title,
      askingPrice: parseFloat(l.price?.value || 0),
      condition: l.condition,
      url: l.itemWebUrl,
      image: l.image?.imageUrl || null,
      soldComps: compsResults[i],
    }));

    res.json({ listings: result });

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
  const hash = crypto.createHash('sha256')
    .update(challengeCode + VERIFICATION_TOKEN + endpointUrl)
    .digest('hex');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(JSON.stringify({ challengeResponse: hash }));
});

// ── eBay account deletion notifications ───────────────────────────────────
app.post('/ebay/notifications', (req, res) => {
  console.log(`[${new Date().toISOString()}] Deletion notification received`);
  res.sendStatus(200);
});

// ── Health check ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'ReelDeal Server', time: new Date().toISOString() });
});

app.listen(PORT, () => console.log(`ReelDeal server running on port ${PORT}`));
