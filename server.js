// Earl Kendrick performance dashboard
// Node / Express server with lightweight JSON persistence
// Built and managed by NXRD

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'state.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function defaultState() {
  // The front end carries its own KPI defaults, so a fresh state can start empty.
  // On the first save the full set of figures is written here.
  return { kpis: {}, approved: [] };
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return defaultState();
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

// Return the saved figures and approvals
app.get('/api/state', (req, res) => {
  res.json(readState());
});

// Save the figures and approvals
app.post('/api/state', (req, res) => {
  const body = req.body || {};
  const state = {
    kpis: body.kpis && typeof body.kpis === 'object' ? body.kpis : {},
    approved: Array.isArray(body.approved) ? body.approved : []
  };
  try {
    writeState(state);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Could not save state' });
  }
});

// Health check for Render
app.get('/healthz', (req, res) => res.send('ok'));

app.listen(PORT, () => {
  console.log('Earl Kendrick dashboard running on port ' + PORT);
});
