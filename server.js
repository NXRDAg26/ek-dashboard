// Earl Kendrick performance dashboard
// Node / Express server with JSON persistence, live Google Analytics,
// live Google Search Console gap finding and an Anthropic powered counter page generator
// Built and managed by NXRD
//
// Credentials are read from environment variables only, never from the repo.
// Set these in Render:
//   GA_PROPERTY_ID          the 9 digit GA4 property id
//   GSC_SITE_URL            the Search Console property, eg sc-domain:earlkendrick.co.uk
//                           or the full url form https://www.earlkendrick.co.uk/
//   GOOGLE_CREDENTIALS_JSON the full service account JSON key, used for both GA and Search Console
//   ANTHROPIC_API_KEY       your Claude API key, used by the counter page generator
// The same service account must be granted Viewer on the GA4 property and added
// as a user on the Search Console property. Any block whose credentials are not
// set shows a not connected state rather than any invented figures.

const express = require('express');
const fs = require('fs');
const path = require('path');
const { BetaAnalyticsDataClient } = require('@google-analytics/data');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'state.json');

app.use(express.json({ limit: '1mb' }));

/* ---------- saved figures and approvals ---------- */
function defaultState() { return { kpis: {}, approved: [] }; }
function readState() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { return defaultState(); }
}
function writeState(state) { fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2)); }

/* ---------- Google Analytics ---------- */
let analyticsClient = null;
let analyticsReady = false;

function initAnalytics() {
  const propertyId = process.env.GA_PROPERTY_ID;
  if (!propertyId) return;
  try {
    if (process.env.GOOGLE_CREDENTIALS_JSON) {
      const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
      analyticsClient = new BetaAnalyticsDataClient({
        credentials: { client_email: creds.client_email, private_key: creds.private_key }
      });
      analyticsReady = true;
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      analyticsClient = new BetaAnalyticsDataClient();
      analyticsReady = true;
    }
  } catch (e) {
    console.error('Analytics init failed:', e.message);
    analyticsReady = false;
  }
}
initAnalytics();

/* ---------- Google Search Console ---------- */
let gscClient = null;
let gscReady = false;

function initSearchConsole() {
  const site = process.env.GSC_SITE_URL;
  if (!site) return;
  try {
    let auth;
    const scopes = ['https://www.googleapis.com/auth/webmasters.readonly'];
    if (process.env.GOOGLE_CREDENTIALS_JSON) {
      const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
      auth = new google.auth.JWT(creds.client_email, null, creds.private_key, scopes);
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      auth = new google.auth.GoogleAuth({ scopes });
    } else {
      return;
    }
    gscClient = google.searchconsole({ version: 'v1', auth });
    gscReady = true;
  } catch (e) {
    console.error('Search Console init failed:', e.message);
    gscReady = false;
  }
}
initSearchConsole();

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function labelFromYearMonth(ym) {
  const m = parseInt(ym.slice(4), 10);
  return MONTHS[m - 1] || ym;
}

app.get('/api/analytics', async (req, res) => {
  if (!analyticsReady) return res.json({ configured: false });
  const property = `properties/${process.env.GA_PROPERTY_ID}`;
  try {
    const [totals] = await analyticsClient.runReport({
      property,
      dateRanges: [{ startDate: '90daysAgo', endDate: 'today' }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'newUsers' }]
    });
    const v = (totals.rows && totals.rows[0]) ? totals.rows[0].metricValues.map(x => Number(x.value)) : [0, 0, 0];

    const [byMonth] = await analyticsClient.runReport({
      property,
      dateRanges: [{ startDate: '90daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'yearMonth' }],
      metrics: [{ name: 'sessions' }],
      orderBys: [{ dimension: { dimensionName: 'yearMonth' } }]
    });
    const monthly = (byMonth.rows || []).map(r => ({
      label: labelFromYearMonth(r.dimensionValues[0].value),
      sessions: Number(r.metricValues[0].value)
    }));

    res.json({ configured: true, range: 'Last 90 days', sessions: v[0], users: v[1], newUsers: v[2], monthly });
  } catch (e) {
    console.error('Analytics query failed:', e.message);
    res.json({ configured: false, error: e.message });
  }
});

/* ---------- Search Console gap finder ---------- */
app.get('/api/searchconsole/gaps', async (req, res) => {
  if (!gscReady) return res.json({ configured: false });
  const siteUrl = process.env.GSC_SITE_URL;
  try {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 90);
    const fmt = d => d.toISOString().slice(0, 10);

    const resp = await gscClient.searchanalytics.query({
      siteUrl,
      requestBody: {
        startDate: fmt(start),
        endDate: fmt(end),
        dimensions: ['query'],
        rowLimit: 1000,
        dataState: 'all'
      }
    });

    const rows = (resp.data.rows || []).map(r => ({
      query: r.keys[0],
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.ctr,
      position: Number(r.position.toFixed(1))
    }));

    // Striking distance: ranking just off page one, real demand behind it
    const striking = rows
      .filter(r => r.position >= 8 && r.position <= 20 && r.impressions >= 30)
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 25);

    // Lost clicks: visible on page one but the click through is leaking away
    const lostclicks = rows
      .filter(r => r.position <= 15 && r.impressions >= 50 && r.ctr < 0.02)
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 25);

    res.json({ configured: true, range: 'Last 90 days', striking, lostclicks });
  } catch (e) {
    console.error('Search Console query failed:', e.message);
    res.json({ configured: false, error: e.message });
  }
});

/* ---------- Anthropic counter page generator ---------- */
const GEN_MODEL = process.env.GEN_MODEL || 'claude-sonnet-4-6';

app.post('/api/generate-page', async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(400).json({ ok: false, error: 'No ANTHROPIC_API_KEY set in Render' });

  const query = (req.body && req.body.query ? String(req.body.query) : '').trim();
  const competitors = Array.isArray(req.body && req.body.competitors) ? req.body.competitors : [];
  const research = !!(req.body && req.body.research);
  if (!query) return res.status(400).json({ ok: false, error: 'A target query or topic is required' });

  const system = [
    'You are a senior B2B content strategist writing for Earl Kendrick, a UK building surveying and property consultancy.',
    'Earl Kendrick serves managing agents, developers, fund managers and asset managers across residential blocks and commercial property.',
    'Write a complete, publish ready website page that targets the given search query and out competes the named competitors on that topic.',
    '',
    'House style rules, follow every one without exception:',
    'Use UK English throughout.',
    'Never use hyphens anywhere in the copy.',
    'Never use em dashes anywhere in the copy.',
    'Never use emojis.',
    'Keep the voice consultative and authoritative, the firm works alongside the client team, never salesy or hyped.',
    'Build for SEO and AEO. Use one clear H1, scannable H2 sections, a short direct answer near the top, and a frequently asked questions block at the end with question and answer pairs.',
    '',
    'Return only a single JSON object, no markdown fences, no preamble, with exactly these keys:',
    'title a page title under 60 characters,',
    'metaDescription under 155 characters,',
    'h1 the page heading,',
    'summary two sentences naming the gap this page fills against the competitors,',
    'html the full page body as clean semantic HTML using only h1 h2 h3 p ul li strong tags and a simple question and answer structure, with no inline styles and no script tags.'
  ].join('\n');

  const userMsg = [
    'Target query or topic: ' + query,
    'Competitors to counter: ' + (competitors.length ? competitors.join(', ') : 'the general field'),
    'Find the gap in how those competitors cover this topic, then write the page that fills it for Earl Kendrick.',
    research ? 'Research the current competitor angle on the web before writing.' : ''
  ].filter(Boolean).join('\n');

  const body = {
    model: GEN_MODEL,
    max_tokens: 6000,
    system,
    messages: [{ role: 'user', content: userMsg }]
  };
  if (research) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    if (data.error) return res.status(500).json({ ok: false, error: data.error.message || 'Anthropic API error' });

    const text = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    let parsed = null;
    try {
      const clean = text.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
      parsed = JSON.parse(clean);
    } catch (e) {
      return res.json({ ok: true, page: null, raw: text });
    }
    res.json({ ok: true, page: parsed });
  } catch (e) {
    console.error('Generate failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ---------- routes ---------- */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/api/state', (req, res) => res.json(readState()));
app.post('/api/state', (req, res) => {
  const body = req.body || {};
  const state = {
    kpis: body.kpis && typeof body.kpis === 'object' ? body.kpis : {},
    approved: Array.isArray(body.approved) ? body.approved : []
  };
  try { writeState(state); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: 'Could not save state' }); }
});

app.get('/healthz', (req, res) => res.send('ok'));

app.listen(PORT, () => {
  console.log('Earl Kendrick dashboard running on port ' + PORT);
  console.log('Google Analytics ' + (analyticsReady ? 'connected' : 'not configured'));
  console.log('Search Console ' + (gscReady ? 'connected' : 'not configured'));
  console.log('Counter page generator ' + (process.env.ANTHROPIC_API_KEY ? 'ready' : 'no key set'));
});
