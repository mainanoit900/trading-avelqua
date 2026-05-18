const express = require('express');
const { requireLogin } = require('../middleware/requireAuth');
const { query } = require('../config/database');

const router = express.Router();

router.get('/', requireLogin, async (req, res) => {
  try {
    const currentUser = req.user || req.session.user;
    const result = await query(`SELECT * FROM users WHERE id = $1 LIMIT 1`, [currentUser.id]);
    const dbUser = result.rows[0] || currentUser;

    req.session.user = dbUser;

    return res.render('app', {
      pageTitle: 'App Dashboard',
      user: {
        ...dbUser,
        name: dbUser.full_name || dbUser.first_name || dbUser.name || '',
        emailVerified: Boolean(dbUser.email_verified || dbUser.verified_at),
        email_verified: Boolean(dbUser.email_verified || dbUser.verified_at)
      },
      currentUser: dbUser,
      verifyRequired: String(req.query.verify_required || '') === '1',
      lang: req.session?.lang || 'th'
    });
  } catch (error) {
    console.error('app route error:', error);
    return res.status(500).render('page', {
      title: 'Server Error',
      pageTitle: 'Server Error',
      content: 'Unable to load app dashboard.'
    });
  }
});

module.exports = router;
