const express = require('express');
const appRoutes = require('./app');

const router = express.Router();

router.post('/stripe/webhook', appRoutes.handleStripeWebhook);

module.exports = router;
