// Earl Kendrick performance dashboard
// Node / Express server with JSON persistence, live Google Analytics and
// Google Search Console via Google sign in, plus an Anthropic powered counter page generator
// Built and managed by NXRD
//
// Google data uses OAuth, the same model as the Novograf dashboard. You sign in
// once with the Google account that already has access to both the GA4 property
// and the Search Console property, and the dashboard reads both on your behalf.
// There is no service account and no credentials to paste.
//
// Set these in Render:
//   GOOGLE_CLIENT_ID        OAuth client id from Google Cloud Console
//   GOOGLE_CLIENT_SECRET    OAuth client secret
//   GA_PROPERTY_ID          the 9 digit GA4 property to report on
//   GSC_SITE_URL            the Search Console property, eg sc-domain:earlkendrick.co.uk
//                           or the url form https://www.earlkendrick.co.uk/
//   ANTHROPIC_API_KEY       your Claude key for the counter page generator
//   BASE_URL                optional, eg https://ek-dashboard-rr91.onrender.com
//                           used to build the OAuth redirect, derived from the
//                           request if not set

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { google } = require('googleapis');

const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'state.json');

app.use(express.json({ limit: '1mb' }));

/* ---------- saved figures and approvals ---------- */
function defaultState() { return { kpis: {}, approved: [], tasks: [], liMom: {}, blogEdits: {} }; }
function readState() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { return defaultState(); }
}
function writeState(state) { fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2)); }

/* ---------- Google OAuth ---------- */
const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/webmasters.readonly',
  'openid',
  'email'
];

const oauthConfigured = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

function baseUrl(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  return proto + '://' + req.headers.host;
}
function redirectUri(req) {
  return process.env.OAUTH_REDIRECT_URI || (baseUrl(req) + '/auth/callback');
}
function oauthClient(req) {
  return new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, redirectUri(req));
}

// In memory session store. Single instance on Render free, so this holds while
// the service is awake. After a spin down or redeploy you sign in again.
const sessions = new Map(); // sessionId -> { tokens, email }

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function getSession(req) {
  const sid = parseCookies(req).ek_sess;
  if (sid && sessions.has(sid)) return Object.assign({ sid }, sessions.get(sid));
  return null;
}
function authedClient(req) {
  const s = getSession(req);
  if (!s) return null;
  const client = oauthClient(req);
  client.setCredentials(s.tokens);
  client.on('tokens', t => {
    const cur = sessions.get(s.sid) || {};
    sessions.set(s.sid, Object.assign({}, cur, { tokens: Object.assign({}, cur.tokens, t) }));
  });
  return client;
}

app.get('/auth/login', (req, res) => {
  if (!oauthConfigured()) return res.status(500).send('OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Render.');
  const client = oauthClient(req);
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: OAUTH_SCOPES
  });
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  if (!req.query.code) return res.redirect('/');
  try {
    const client = oauthClient(req);
    const { tokens } = await client.getToken(req.query.code);
    client.setCredentials(tokens);
    let email = null;
    try {
      const oauth2 = google.oauth2({ version: 'v2', auth: client });
      const me = await oauth2.userinfo.get();
      email = me.data.email;
    } catch (e) { /* email is optional */ }
    const sid = crypto.randomUUID();
    sessions.set(sid, { tokens, email });
    res.setHeader('Set-Cookie', 'ek_sess=' + sid + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000');
    res.redirect('/#analytics');
  } catch (e) {
    console.error('OAuth callback failed:', e.message);
    res.redirect('/?auth=error');
  }
});

app.post('/auth/logout', (req, res) => {
  const s = getSession(req);
  if (s) sessions.delete(s.sid);
  res.setHeader('Set-Cookie', 'ek_sess=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/auth/status', (req, res) => {
  const s = getSession(req);
  res.json({ oauthConfigured: oauthConfigured(), signedIn: !!s, email: s ? s.email : null });
});

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function labelFromYearMonth(ym) {
  const m = parseInt(ym.slice(4), 10);
  return MONTHS[m - 1] || ym;
}

/* ---------- Google Analytics, via the signed in account ---------- */
app.get('/api/analytics', async (req, res) => {
  const auth = authedClient(req);
  if (!auth) return res.json({ configured: false, signedIn: false });
  if (!process.env.GA_PROPERTY_ID) return res.json({ configured: false, signedIn: true, error: 'GA_PROPERTY_ID not set' });
  try {
    const data = google.analyticsdata({ version: 'v1beta', auth });
    const property = 'properties/' + process.env.GA_PROPERTY_ID;

    const totals = await data.properties.runReport({
      property,
      requestBody: {
        dateRanges: [{ startDate: '90daysAgo', endDate: 'today' }],
        metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'newUsers' }]
      }
    });
    const tr = totals.data.rows && totals.data.rows[0];
    const v = tr ? tr.metricValues.map(x => Number(x.value)) : [0, 0, 0];

    const byMonth = await data.properties.runReport({
      property,
      requestBody: {
        dateRanges: [{ startDate: '90daysAgo', endDate: 'today' }],
        dimensions: [{ name: 'yearMonth' }],
        metrics: [{ name: 'sessions' }],
        orderBys: [{ dimension: { dimensionName: 'yearMonth' } }]
      }
    });
    const monthly = (byMonth.data.rows || []).map(r => ({
      label: labelFromYearMonth(r.dimensionValues[0].value),
      sessions: Number(r.metricValues[0].value)
    }));

    res.json({ configured: true, signedIn: true, range: 'Last 90 days', sessions: v[0], users: v[1], newUsers: v[2], monthly });
  } catch (e) {
    console.error('Analytics query failed:', e.message);
    res.json({ configured: false, signedIn: true, error: e.message });
  }
});

/* ---------- Search Console gap finder, via the signed in account ---------- */
app.get('/api/searchconsole/gaps', async (req, res) => {
  const auth = authedClient(req);
  if (!auth) return res.json({ configured: false, signedIn: false });
  if (!process.env.GSC_SITE_URL) return res.json({ configured: false, signedIn: true, error: 'GSC_SITE_URL not set' });
  try {
    const gsc = google.searchconsole({ version: 'v1', auth });
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 90);
    const fmt = d => d.toISOString().slice(0, 10);

    const resp = await gsc.searchanalytics.query({
      siteUrl: process.env.GSC_SITE_URL,
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

    const striking = rows
      .filter(r => r.position >= 8 && r.position <= 20 && r.impressions >= 30)
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 25);

    const lostclicks = rows
      .filter(r => r.position <= 15 && r.impressions >= 50 && r.ctr < 0.02)
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 25);

    res.json({ configured: true, signedIn: true, range: 'Last 90 days', striking, lostclicks });
  } catch (e) {
    console.error('Search Console query failed:', e.message);
    res.json({ configured: false, signedIn: true, error: e.message });
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

/* ---------- Anthropic gap ideas, theme aware, per competitor ---------- */
app.post('/api/gap-ideas', async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(400).json({ ok: false, error: 'No ANTHROPIC_API_KEY set in Render' });

  const competitor = (req.body && req.body.competitor ? String(req.body.competitor) : '').trim();
  const context = (req.body && req.body.context ? String(req.body.context) : '').trim();
  const theme = (req.body && req.body.theme ? String(req.body.theme) : '').trim();
  const services = (req.body && req.body.services ? String(req.body.services) : '').trim();
  const audience = (req.body && req.body.audience ? String(req.body.audience) : '').trim();
  const research = !!(req.body && req.body.research);
  if (!competitor || !theme) return res.status(400).json({ ok: false, error: 'A competitor and a theme are required' });

  const system = [
    'You advise Earl Kendrick, a UK building surveying and property consultancy, on how to win search and content ground from a named competitor.',
    'Given one competitor and the current monthly content theme, find specific gaps in how that competitor covers the theme, that Earl Kendrick can exploit.',
    '',
    'House style rules, follow every one:',
    'UK English. No hyphens anywhere. No em dashes. No emojis. Consultative and direct.',
    '',
    'Return only a single JSON object, no markdown fences, with exactly these keys:',
    'competitor the competitor name echoed back,',
    'ideas an array of 4 objects, each with: gap a short phrase naming the gap, why one sentence on why it beats this competitor on this theme, angle a concrete Earl Kendrick page or post title that fills the gap, query a short search phrase to target.'
  ].join('\n');

  const userMsg = [
    'Competitor: ' + competitor,
    context ? 'Competitor context: ' + context : '',
    'Current theme: ' + theme,
    services ? 'Theme services: ' + services : '',
    audience ? 'Theme audience: ' + audience : '',
    'Find four gaps against this competitor on this theme and give Earl Kendrick the angle to take each one.',
    research ? 'Research the competitor on the web first.' : ''
  ].filter(Boolean).join('\n');

  const body = {
    model: GEN_MODEL,
    max_tokens: 2000,
    system,
    messages: [{ role: 'user', content: userMsg }]
  };
  if (research) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }];

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    if (data.error) return res.status(500).json({ ok: false, error: data.error.message || 'Anthropic API error' });
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    let parsed = null;
    try {
      const clean = text.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
      parsed = JSON.parse(clean);
    } catch (e) {
      return res.json({ ok: true, ideas: null, raw: text });
    }
    res.json({ ok: true, competitor: parsed.competitor || competitor, ideas: parsed.ideas || [] });
  } catch (e) {
    console.error('Gap ideas failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ---------- Anthropic: one idea against every competitor at once ---------- */
app.post('/api/gap-ideas-batch', async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(400).json({ ok: false, error: 'No ANTHROPIC_API_KEY set in Render' });

  const theme = (req.body && req.body.theme ? String(req.body.theme) : '').trim();
  const services = (req.body && req.body.services ? String(req.body.services) : '').trim();
  const audience = (req.body && req.body.audience ? String(req.body.audience) : '').trim();
  const competitors = Array.isArray(req.body && req.body.competitors) ? req.body.competitors : [];
  if (!theme || !competitors.length) return res.status(400).json({ ok: false, error: 'A theme and competitors are required' });

  const system = [
    'You advise Earl Kendrick, a UK building surveying and property consultancy, on how to win search and content ground from named competitors.',
    'For the current monthly theme, give one strong content gap idea against each competitor in the list.',
    'House style: UK English. No hyphens. No em dashes. No emojis. Consultative and direct.',
    'Return only a single JSON object, no markdown fences, with one key: ideas, an array in the SAME ORDER as the competitors given.',
    'Each array item has: competitor the exact name, gap a short phrase, why one sentence on why it beats this competitor on this theme, angle a concrete Earl Kendrick page or post title, query a short search phrase to target.'
  ].join('\n');

  const list = competitors.map((c, i) => (i + 1) + '. ' + c.name + (c.context ? ' (' + c.context + ')' : '')).join('\n');
  const userMsg = [
    'Current theme: ' + theme,
    services ? 'Theme services: ' + services : '',
    audience ? 'Theme audience: ' + audience : '',
    'Competitors, in order:',
    list,
    'Return exactly one idea per competitor, in the same order.'
  ].filter(Boolean).join('\n');

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: GEN_MODEL, max_tokens: 3000, system, messages: [{ role: 'user', content: userMsg }] })
    });
    const data = await r.json();
    if (data.error) return res.status(500).json({ ok: false, error: data.error.message || 'Anthropic API error' });
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    let parsed = null;
    try {
      const clean = text.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
      parsed = JSON.parse(clean);
    } catch (e) { return res.json({ ok: true, ideas: null, raw: text }); }
    res.json({ ok: true, ideas: parsed.ideas || [] });
  } catch (e) {
    console.error('Batch gap ideas failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ---------- page audit: fetch a page and return UI and CTA fixes ---------- */
function extractPage(html) {
  const pick = re => { const m = html.match(re); return m ? m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : ''; };
  const all = (re, cap) => { const out = []; let m; while ((m = re.exec(html)) && out.length < 40) out.push(m[cap].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()); return out.filter(Boolean); };
  const title = pick(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const metaDesc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || [])[1] || '';
  const h1 = all(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, 1);
  const h2 = all(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, 1);
  const h3 = all(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, 1);
  const links = all(/<a[^>]*>([\s\S]*?)<\/a>/gi, 1);
  const buttons = all(/<button[^>]*>([\s\S]*?)<\/button>/gi, 1);
  const forms = (html.match(/<form[\b]/gi) || []).length;
  const imgs = (html.match(/<img[\b ]/gi) || []).length;
  const imgsAlt = (html.match(/<img[^>]+alt=["'][^"']+["']/gi) || []).length;
  const words = (html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().split(' ').length);
  return { title, metaDesc, h1, h2, h3, links: links.slice(0, 30), buttons, forms, imgs, imgsAlt, words };
}

app.post('/api/page-audit', async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(400).json({ ok: false, error: 'No ANTHROPIC_API_KEY set in Render' });
  let url = (req.body && req.body.url ? String(req.body.url) : '').trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try { new URL(url); } catch (e) { return res.status(400).json({ ok: false, error: 'That does not look like a valid URL' }); }

  let page = null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'EK-Dashboard-Audit/1.0' } });
    clearTimeout(t);
    if (!r.ok) return res.status(400).json({ ok: false, error: 'The page returned status ' + r.status });
    const html = await r.text();
    page = extractPage(html);
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'Could not load that page. ' + e.message });
  }

  const system = [
    'You are a senior conversion and UX strategist auditing a single web page for Earl Kendrick, a UK building surveying and property consultancy.',
    'You are given a structured extract of the page. Produce a practical improvement checklist a non technical person can work through and tick off.',
    'Focus on what the page can control: layout and UI, calls to action, content and clarity, trust and proof, SEO and AEO, and accessibility.',
    'Each item must be one specific action, written so it can be ticked when done. Avoid vague advice.',
    'House style: UK English. No hyphens. No em dashes. No emojis. Direct and plain.',
    'Return only a single JSON object, no markdown fences, with keys:',
    'title the page title, summary one sentence on the pages main weakness, groups an array of objects each with name a group label and items an array of short action strings. Use 4 to 6 groups, 3 to 6 items each.'
  ].join('\n');

  const userMsg = [
    'Page URL: ' + url,
    'Title: ' + (page.title || 'none'),
    'Meta description: ' + (page.metaDesc || 'none'),
    'H1 headings: ' + (page.h1.join(' | ') || 'none'),
    'H2 headings: ' + (page.h2.slice(0, 12).join(' | ') || 'none'),
    'H3 headings: ' + (page.h3.slice(0, 12).join(' | ') || 'none'),
    'Link and nav text samples: ' + (page.links.join(' | ') || 'none'),
    'Button text: ' + (page.buttons.join(' | ') || 'none'),
    'Forms on page: ' + page.forms,
    'Images: ' + page.imgs + ', with alt text: ' + page.imgsAlt,
    'Approximate word count: ' + page.words,
    'Audit this page and return the improvement checklist.'
  ].join('\n');

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: GEN_MODEL, max_tokens: 3000, system, messages: [{ role: 'user', content: userMsg }] })
    });
    const data = await r.json();
    if (data.error) return res.status(500).json({ ok: false, error: data.error.message || 'Anthropic API error' });
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    let parsed = null;
    try {
      const clean = text.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
      parsed = JSON.parse(clean);
    } catch (e) { return res.json({ ok: true, audit: null, raw: text, url }); }
    res.json({ ok: true, url, title: parsed.title || page.title, summary: parsed.summary || '', groups: parsed.groups || [] });
  } catch (e) {
    console.error('Page audit failed:', e.message);
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
    approved: Array.isArray(body.approved) ? body.approved : [],
    tasks: Array.isArray(body.tasks) ? body.tasks : [],
    liMom: body.liMom && typeof body.liMom === 'object' ? body.liMom : {},
    blogEdits: body.blogEdits && typeof body.blogEdits === 'object' ? body.blogEdits : {}
  };
  try { writeState(state); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: 'Could not save state' }); }
});

app.get('/healthz', (req, res) => res.send('ok'));

app.listen(PORT, () => {
  console.log('Earl Kendrick dashboard running on port ' + PORT);
  console.log('Google OAuth ' + (oauthConfigured() ? 'configured' : 'not configured'));
  console.log('Counter page generator ' + (process.env.ANTHROPIC_API_KEY ? 'ready' : 'no key set'));
});
