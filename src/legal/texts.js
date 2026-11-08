// GENERATED copy of CallKaroApp/src/constants/legal.js (served at /legal/privacy and /legal/terms for the
// Play Store). Edit the app file, then: node scripts/syncLegal.js  (a monorepo test fails if they differ).
// Local copy of the legal texts (v1). Later these are fetched from the server / hosted URL.
// IMPORTANT: have a lawyer review both documents before public launch (DoT/TRAI, IT Act, DPDP Act 2023).

const TERMS_OF_USE = {
  title: 'Terms of Use',
  updated: 'Version v1 - October 2026',
  sections: [
    {
      heading: '1. What CallingKaro is',
      body: 'CallingKaro lets you place calls from the app over the internet to mobile and landline numbers in India. Calls are carried by a licensed telecom/CPaaS partner. The person you call receives a normal phone call.',
    },
    {
      heading: '2. Credits',
      body: 'Calls use credits. 1000 credits = 1 minute of talk time, charged per second (for example 2 minutes 15 seconds = 2,250 credits). You need at least 1000 credits to start a call. Calls that are not answered, busy or failed cost nothing. Credits come from paid minute packs, rewarded video ads, the daily spin wheel and promotions. Credits have no cash value, cannot be transferred and cannot be withdrawn. Paid credits do not expire.',
    },
    {
      heading: '3. Acceptable use - strictly prohibited',
      body: 'You must NOT use CallingKaro to: harass, threaten, stalk or abuse anyone; make fraudulent, scam, phishing or extortion calls; impersonate any person, company, bank or government body; make spam, robocalls or unsolicited marketing calls; call numbers that have asked not to be called; or break any law. We may suspend accounts, block numbers and share information with law enforcement where required by law.',
    },
    {
      heading: '4. Caller ID',
      body: 'Your calls show a number owned or verified by CallingKaro, never a spoofed or random number. People who call that number back hear a message explaining it is used by CallingKaro and how to report misuse.',
    },
    {
      heading: '5. Call recording',
      body: 'If you record a call, an announcement / beep is played so that both sides know the call is being recorded. You are responsible for obtaining any consent the law requires from the other person. Recordings are stored on your phone; copies held by our provider are deleted automatically after a limited period.',
    },
    {
      heading: '6. Payments and refunds',
      body: 'Minute packs are digital goods delivered instantly after the payment is verified. If a payment succeeds but credits are not added, contact support with the order ID and we will add the credits or refund you. Unused paid credits may be refunded within 7 days of purchase on request. If a payment is refunded or charged back, the related credits are removed from your wallet.',
    },
    {
      heading: '7. Rewards',
      body: 'Rewarded ads and spins are limited per day. Rewards are decided by our servers. Using emulators, automation, multiple accounts or any trick to collect rewards may lead to removal of credits and account suspension.',
    },
    {
      heading: '8. Availability',
      body: 'Call quality depends on your internet connection and our partners. Emergency numbers (100, 101, 102, 108, 112) and short codes cannot be dialled from CallingKaro - always use your phone dialer for emergencies.',
    },
    {
      heading: '9. Account',
      body: 'You sign in with your email and a one-time code. You can delete your account at any time from Settings. We keep billing and call metadata for the period required by law.',
    },
    {
      heading: '10. Contact',
      body: 'Questions or complaints: support@yourapp.in',
    },
  ],
};

const PRIVACY_POLICY = {
  title: 'Privacy Policy',
  updated: 'Version v1 - October 2026',
  sections: [
    {
      heading: '1. Data we collect',
      body: 'Email address (to sign you in), a device identifier (to protect free rewards from abuse), call metadata needed for billing and legal retention (your account, the number you called, start time, duration, credits charged, caller ID used), wallet and purchase records, and reports you submit.',
    },
    {
      heading: '2. Data that stays on your phone',
      body: 'Your contacts are read only on your phone to show names and let you call quickly - they are NEVER uploaded to our servers. Your call history list, call notes, settings and downloaded recordings are stored on your phone and are deleted when you clear app data or uninstall.',
    },
    {
      heading: '3. Call recordings',
      body: 'Recording only happens when you turn it on, and an announcement is played. Our telecom provider holds a temporary encrypted copy which we delete automatically after a short period; the app downloads your copy to your phone.',
    },
    {
      heading: '4. Ads',
      body: "Rewarded video ads are served by Google AdMob, which may use your advertising ID and device information according to Google's policies. Where required, we ask for consent for personalised ads. You can reset or delete your advertising ID in Android settings.",
    },
    {
      heading: '5. Payments',
      body: 'Payments are processed by Google Play Billing (or our payment partner). We never see or store your full card or UPI details - only an order reference and status.',
    },
    {
      heading: '6. Why we use data',
      body: 'To provide calls, bill credits, prevent fraud and abuse, respond to complaints and legal requests, and improve reliability. We do not sell your personal data.',
    },
    {
      heading: '7. Retention',
      body: 'Account data is kept while your account is active. Call metadata and billing records are kept for the period required by Indian telecom and tax rules, then deleted. Provider recording copies are auto-deleted after the configured period.',
    },
    {
      heading: '8. Your rights (DPDP Act 2023)',
      body: 'You can access and correct your data, withdraw consent, and delete your account from Settings > Account > Delete account, or by emailing support. Deletion anonymises your profile; records we must keep by law are retained only for that purpose.',
    },
    {
      heading: '9. Contact / grievance officer',
      body: 'support@yourapp.in',
    },
  ],
};

module.exports = { TERMS_OF_USE, PRIVACY_POLICY };
