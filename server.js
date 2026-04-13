const express = require('express');
const crypto  = require('crypto');
const app     = express();

app.use(express.json());

const VERIFICATION_TOKEN = process.env.EBAY_VERIFICATION_TOKEN || 'reeldeal-verify-token-change-me';
const PORT = process.env.PORT || 3000;

// eBay challenge verification — GET /ebay/notifications?challenge_code=xxx
app.get('/ebay/notifications', (req, res) => {
  const challengeCode = req.query.challenge_code;
  if (!challengeCode) return res.status(400).json({ error: 'Missing challenge_code' });

  // Hash order MUST be: challengeCode + verificationToken + endpointUrl
  const endpointUrl = `https://${req.get('host')}/ebay/notifications`;
  const hash = crypto
    .createHash('sha256')
    .update(challengeCode + VERIFICATION_TOKEN + endpointUrl)
    .digest('hex');

  console.log(`[${new Date().toISOString()}] Challenge received`);
  console.log(`  challenge_code: ${challengeCode}`);
  console.log(`  endpoint used in hash: ${endpointUrl}`);
  console.log(`  response hash: ${hash}`);

  // Must return exact JSON with Content-Type application/json
  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(JSON.stringify({ challengeResponse: hash }));
});

// eBay account deletion notifications — POST /ebay/notifications
app.post('/ebay/notifications', (req, res) => {
  const topic  = req.body?.metadata?.topic || 'unknown';
  const userId = req.body?.notification?.data?.userId || 'n/a';
  console.log(`[${new Date().toISOString()}] Notification received — topic: ${topic}, userId: ${userId}`);
  res.sendStatus(200);
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'ReelDeal eBay Notification Handler', time: new Date().toISOString() });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
