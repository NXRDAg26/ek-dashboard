// Earl Kendrick performance dashboard
// Node / Express server with JSON persistence and live Google Analytics
// Built and managed by NXRD
//
// Live website data comes from Google Analytics 4. Credentials are read from
// environment variables only, never from the repo. Set these in Render:
//   GA_PROPERTY_ID          the 9 digit GA4 property id
//   GOOGLE_CREDENTIALS_JSON the full service account JSON key (paste as one value)
// If those are not set the dashboard runs fine and the analytics block shows
// a not connected state rather than any made up figures.

const express = require('express');
const fs = require('fs');
const path = require('path');
const { BetaAnalyticsDataClient } = require('@google-analytics/data');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'state.json');

app.use(express.json());

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
});
