const express = require('express');
const router = express.Router();

router.get('/admin/vps', async (req, res) => {
  res.render('admin/vps/index', { pageTitle: 'Admin VPS' });
});

module.exports = router;
