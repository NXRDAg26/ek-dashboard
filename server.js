// Earl Kendrick performance dashboard
// Node / Express server with lightweight JSON persistence
// Flat layout: every file sits in the same folder, no subfolders
// Built and managed by NXRD

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'state.json');

app.use(express.json());

function defaultState() {
  return { kpis: {}, approved: [] };
}
function readState() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { return defaultState(); }
}
function writeState(state) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

// Serve the dashboard at the home page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Saved figures and approvals
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
});
