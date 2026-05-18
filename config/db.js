
const fs = require('fs');
const path = require('path');
const DATA_FILE = path.join(__dirname, '..', 'data', 'data.json');

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const seed = {
      users: [], packages: [], carts: [], orders: [], payments: [], coupons: [], news: [], siteContent: {}, vpsNodes: [], mt5Assignments: []
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(seed, null, 2));
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveData(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

module.exports = { loadData, saveData, DATA_FILE };
