/**
 * eBay Marketplace Account Deletion Notification Handler
 * =======================================================
 * eBay requires this endpoint before issuing Production keys.
 * It receives account deletion events and responds correctly
 * so eBay considers your notification URL verified.
 *
 * DEPLOY OPTIONS (all free):
 *   A) Render.com  — push to GitHub, connect repo, deploy as Web Service
 *   B) Railway.app — `railway up` from this folder
 *   C) Glitch.com  — paste into a new Node project
 *   D) Local test  — `node ebay-notifications.js` + ngrok for temp HTTPS
 *
 * SETUP:
 *   1. npm install express crypto
 *   2. Set EBAY_VERIFICATION_TOKEN in your environment (make up any string)
 *   3. Deploy and get your HTTPS URL  (e.g. https://myapp.onrender.com)
 *   4. In eBay Developer Portal → Alert Settings → enter:
 *        Notification URL: https://yourapp.com/ebay/notifications
 *        Verification Token: (same string you set above)
 *   5. eBay will send a challenge — this server handles it automatically
 */

const express = require('express');
const crypto  = require('crypto');
const app     = express();

app.use(express.json());

const VERIFICATION_TOKEN = process.env.EBAY_VERIFICATION_TOKEN || 'reeldeal-verify-token-change-me';
const PORT = process.env.PORT || 3000;

// ── Challenge/verification endpoint ────────────────────────────────────────
// eBay sends a GET with ?challenge_code=xxx to verify you own the endpoint.
// You must respond with a SHA-256 hash of: challengeCode + verificationToken + endpoint URL
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

// ── Notification receiver ───────────────────────────────────────────────────
// eBay POSTs account deletion events here. You must acknowledge with 200.
// Store or log the userId if you hold any eBay user data (likely you don't).
app.post('/ebay/notifications', (req, res) => {
  const event = req.body;
  const topic = event?.metadata?.topic || 'unknown';
  const userId = event?.notification?.data?.userId || 'n/a';

  console.log(`[${new Date().toISOString()}] eBay notification received`);
  console.log(`  Topic:  ${topic}`);
  console.log(`  UserID: ${userId}`);

  // If you ever store eBay user data, delete it here for MARKETPLACE_ACCOUNT_DELETION events.
  // As a buyer/scanner tool you almost certainly don't, so just acknowledge.

  res.sendStatus(200);
});

// ── Health check ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'ReelDeal eBay Notification Handler', time: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`ReelDeal notification server running on port ${PORT}`);
  console.log(`Endpoint: /ebay/notifications`);
  console.log(`Verification token: ${VERIFICATION_TOKEN}`);
});
