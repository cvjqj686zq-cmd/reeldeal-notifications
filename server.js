const express = require('express');
const crypto  = require('crypto');
const https   = require('https');
const app     = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const VERIFICATION_TOKEN = process.env.EBAY_VERIFICATION_TOKEN || 'reeldeal-verify-token-change-me';
const PORT = process.env.PORT || 3000;

// CORS — must be before all routes
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.sendStatus(204);
  }
  next();
});

// eBay challenge verification
app.get('/ebay/notifications', (req, res) => {
  const challengeCode = req.query.challenge_code;
  if (!challengeCode) return res.status(400).json({ error: 'Missing challenge_code' });
  const endpointUrl = `https://${req.get('host')}/ebay/notifications`;
  const hash = crypto.createHash('sha256')
    .update(challengeCode + VERIFICATION_TOKEN + endpointUrl)
    .digest('hex');
  console.log(`[${new Date().toISOString()}] Challenge received → responded`);
  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(JSON.stringify({ challengeResponse: hash }));
});

// eBay account deletion notifications
app.post('/ebay/notifications', (req, res) => {
  const topic  = req.body?.metadata?.topic || 'unknown';
  const userId = req.body?.notification?.data?.userId || 'n/a';
  console.log(`[${new Date().toISOString()}] Notification — topic: ${topic}, userId: ${userId}`);
  res.sendStatus(200);
});

// CORS proxy — eBay OAuth token
app.post('/proxy/token', (req, res) => {
  const { clientId, clientSecret } = req.body;
  if (!clientId || !clientSecret) {
    return res.status(400).json({ error: 'clientId and clientSecret required' });
  }

  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body  = 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope';

  const options = {
    hostname: 'api.ebay.com',
    path:     '/identity/v1/oauth2/token',
    method:   'POST',
    headers: {
      'Authorization':  `Basic ${creds}`,
      'Content-Type':   'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  };

  const proxyReq = https.request(options, (proxyRes) => {
    let data = '';
    proxyRes.on('data', chunk => data += chunk);
    proxyRes.on('end', () => {
      console.log(`[${new Date().toISOString()}] Token proxy — status: ${proxyRes.statusCode}`);
      try {
        res.status(proxyRes.statusCode).json(JSON.parse(data));
      } catch(e) {
        res.status(500).json({ error: 'Invalid response from eBay', raw: data });
      }
    });
  });

  proxyReq.on('error', e => {
    console.error('Token proxy error:', e.message);
    res.status(500).json({ error: e.message });
  });

  proxyReq.write(body);
  proxyReq.end();
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'ReelDeal Server', time: new Date().toISOString() });
});

app.listen(PORT, () => console.log(`ReelDeal server running on port ${PORT}`));
