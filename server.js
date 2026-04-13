/**
 * eBay Marketplace Account Deletion Notification Handler
 * =======================================================
 * eBay requires this endpoint before issuing Production keys.
 * Deploy to Render.com — see README for instructions.
 */

const express = require('express');
const crypto  = require('crypto');
const app     = express();

app.use(express.json());

const VERIFICATION_TOKEN = process.env.EBAY_VERIFICATION_TOKEN || 'reeldeal-verify-token-change-me';
const PORT = process.env.PORT || 3000;

// eBay sends a GET with ?challenge_code=xxx to verify you own the endpoint.
app.get('/ebay/notifications', (req, res) => {
  const challengeCode = req.query.challenge_code;
  if (!challengeCode) return res.status(400).json({ error: 'Missing challenge_code' });

  const endpointUrl = `${req.protocol}://${req.get('host')}/ebay/notifications`;
  const hash = crypto
    .createHash('sha256')
    .update(challengeCode + VERIFICATION_TOKEN + endpointUrl)
    .digest('hex');

  console.log(`[${new Date().toISOString()}] eBay challenge received → responded with hash`);
  res.json({ challengeResponse: hash });
});

// eBay POSTs account deletion events here. Respond 200 to acknowledge.
app.post('/ebay/notifications', (req, res) => {
  const event  = req.body;
  const topic  = event?.metadata?.topic || 'unknown';
  const userId = event?.notification?.data?.userId || 'n/a';
  console.log(`[${new Date().toISOString()}] eBay notification — topic: ${topic}, userId: ${userId}`);
  res.sendStatus(200);
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'ReelDeal eBay Notification Handler', time: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
