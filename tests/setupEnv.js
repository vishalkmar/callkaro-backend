// Test environment - never real keys.

process.env.NODE_ENV = 'test';
process.env.DOTENV_PATH = '/nonexistent/.env';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://callkaro:callkaro@localhost:5434/callkaro_test';
process.env.PUBLIC_BASE_URL = 'https://api.test.local';
process.env.JWT_ACCESS_SECRET = 'a'.repeat(64);
process.env.JWT_REFRESH_SECRET = 'b'.repeat(64);
process.env.BREVO_API_KEY = 'xkeysib-test';
process.env.BREVO_SENDER_EMAIL = 'no-reply@test.local';
process.env.ADMIN_API_KEY = 'admin-test-key';
process.env.TWILIO_ACCOUNT_SID = 'AC' + '1'.repeat(32);
process.env.TWILIO_API_KEY_SID = 'SK' + '2'.repeat(32);
process.env.TWILIO_API_KEY_SECRET = 'secret';
process.env.TWILIO_AUTH_TOKEN = 'twilio-auth-token';
process.env.TWILIO_TWIML_APP_SID = 'AP' + '3'.repeat(32);
process.env.CALLER_ID_POOL = '+911140000001,+911140000002';
process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
process.env.RAZORPAY_KEY_SECRET = 'rzp_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'rzp_webhook_secret';
process.env.PLAY_RTDN_TOKEN = 'rtdn-token';
process.env.ACCOUNTS_PER_DEVICE = '2';
