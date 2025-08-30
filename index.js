const express = require('express');
const stripe = require('stripe');
const { google } = require('googleapis');
const app = express();

// Environment variables
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;
const ALERT_EMAIL = process.env.ALERT_EMAIL || 'admin@example.com';

// Initialize Stripe
const stripeClient = stripe(STRIPE_SECRET_KEY);

// Initialize Gmail
const oauth2Client = new google.auth.OAuth2(
  GMAIL_CLIENT_ID,
  GMAIL_CLIENT_SECRET,
  'urn:ietf:wg:oauth:2.0:oob'
);

oauth2Client.setCredentials({
  refresh_token: GMAIL_REFRESH_TOKEN
});

const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

// Middleware
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// Logging array to store recent activity
let recentLogs = [];

function log(message, level = 'info') {
  const timestamp = new Date().toISOString();
  const logEntry = { timestamp, level, message };
  console.log(`[${timestamp}] ${level.toUpperCase()}: ${message}`);
  recentLogs.unshift(logEntry);
  if (recentLogs.length > 100) recentLogs.pop();
}

// Helper function to send email alerts
async function sendEmailAlert(paymentData) {
  try {
    const subject = `🚨 Payment Failed Alert - ${paymentData.customer_name || 'Unknown Customer'}`;
    
    const emailBody = `
A payment failure has been detected in your Stripe account:

Customer: ${paymentData.customer_name || 'Unknown'}
Customer Email: ${paymentData.customer_email || 'Not provided'}
Amount: $${(paymentData.amount / 100).toFixed(2)} ${paymentData.currency?.toUpperCase() || 'USD'}
Payment Method: ${paymentData.payment_method_type || 'Unknown'}
Failure Code: ${paymentData.failure_code || 'Not provided'}
Failure Message: ${paymentData.failure_message || 'No details provided'}
Payment Intent ID: ${paymentData.payment_intent_id}
Timestamp: ${new Date(paymentData.created * 1000).toLocaleString()}

Please review this failed payment in your Stripe dashboard:
https://dashboard.stripe.com/payments/${paymentData.payment_intent_id}

---
Automated alert from Stripe Payment Monitor
    `.trim();

    const message = [
      'Content-Type: text/plain; charset="UTF-8"',
      'MIME-Version: 1.0',
      `To: ${ALERT_EMAIL}`,
      `Subject: ${subject}`,
      '',
      emailBody
    ].join('\n');

    const encodedMessage = Buffer.from(message)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedMessage,
      },
    });

    log(`Email alert sent successfully for payment ${paymentData.payment_intent_id}`);
    return true;
  } catch (error) {
    log(`Failed to send email alert: ${error.message}`, 'error');
    return false;
  }
}

// Standard endpoints
app.get('/', (req, res) => {
  res.json({
    service: 'Stripe Payment Failure Monitor',
    status: 'running',
    endpoints: {
      '/': 'Service status and available endpoints',
      '/health': 'Health check endpoint',
      '/webhook': 'Stripe webhook endpoint for payment events',
      '/logs': 'View recent activity logs',
      '/test': 'Test payment failure alert'
    },
    webhook_events: [
      'payment_intent.payment_failed',
      'invoice.payment_failed',
      'charge.failed'
    ]
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    stripe_connected: !!STRIPE_SECRET_KEY,
    gmail_connected: !!GMAIL_CLIENT_ID && !!GMAIL_REFRESH_TOKEN
  });
});

app.get('/logs', (req, res) => {
  res.json({
    logs: recentLogs.slice(0, 50),
    total: recentLogs.length
  });
});

app.post('/test', async (req, res) => {
  log('Manual test triggered');
  
  const testPaymentData = {
    customer_name: 'Test Customer',
    customer_email: 'test@example.com',
    amount: 2000, // $20.00
    currency: 'usd',
    payment_method_type: 'card',
    failure_code: 'card_declined',
    failure_message: 'Your card was declined.',
    payment_intent_id: 'pi_test_' + Date.now(),
    created: Math.floor(Date.now() / 1000)
  };

  const success = await sendEmailAlert(testPaymentData);
  
  res.json({
    success,
    message: success ? 'Test alert sent successfully' : 'Failed to send test alert',
    test_data: testPaymentData
  });
});

// Stripe webhook endpoint
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripeClient.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    log(`Received Stripe webhook event: ${event.type}`);
  } catch (err) {
    log(`Webhook signature verification failed: ${err.message}`, 'error');
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle payment failure events
  if (event.type === 'payment_intent.payment_failed' || 
      event.type === 'invoice.payment_failed' || 
      event.type === 'charge.failed') {
    
    try {
      const eventData = event.data.object;
      
      // Extract relevant payment data
      const paymentData = {
        payment_intent_id: eventData.id || eventData.payment_intent,
        amount: eventData.amount || eventData.amount_due,
        currency: eventData.currency,
        failure_code: eventData.failure_code || eventData.last_payment_error?.code,
        failure_message: eventData.failure_message || eventData.last_payment_error?.message,
        payment_method_type: eventData.payment_method_types?.[0] || 
                            eventData.payment_method?.type ||
                            eventData.source?.type,
        created: eventData.created,
        customer_name: '',
        customer_email: ''
      };

      // Get customer information if available
      if (eventData.customer) {
        try {
          const customer = await stripeClient.customers.retrieve(eventData.customer);
          paymentData.customer_name = customer.name || '';
          paymentData.customer_email = customer.email || '';
        } catch (customerError) {
          log(`Failed to retrieve customer info: ${customerError.message}`, 'error');
        }
      }

      log(`Processing payment failure: ${paymentData.payment_intent_id}, Amount: $${(paymentData.amount / 100).toFixed(2)}`);
      
      // Send email alert
      const emailSent = await sendEmailAlert(paymentData);
      
      if (emailSent) {
        log(`Successfully processed payment failure event: ${event.type}`);
      } else {
        log(`Failed to send alert for payment failure: ${paymentData.payment_intent_id}`, 'error');
      }
      
    } catch (error) {
      log(`Error processing payment failure event: ${error.message}`, 'error');
    }
  }

  res.json({ received: true, type: event.type });
});

// Error handling middleware
app.use((error, req, res, next) => {
  log(`Unhandled error: ${error.message}`, 'error');
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log(`Stripe Payment Failure Monitor started on port ${PORT}`);
  log(`Webhook endpoint: /webhook`);
  log(`Ready to monitor payment failures and send email alerts`);
});

module.exports = app;