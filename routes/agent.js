const express = require('express');
const router = express.Router();
const { query } = require('../config/database');

const AGENT_TOKEN = process.env.AVELQUA_AGENT_TOKEN || 'avelqua-vps-2026';

function checkAgent(req, res, next) {
  const token = req.headers['x-agent-token'];
  if (token !== AGENT_TOKEN) {
    return res.status(401).json({ ok: false, message: 'unauthorized agent' });
  }
  next();
}

router.get('/queue', checkAgent, async (req, res) => {
  try {
    const r = await query(`
      SELECT
        id,
        command_type AS action,
        payload,
        vps_id
      FROM vps_system.vps_agent_commands
      WHERE status='pending'
      ORDER BY id ASC
      LIMIT 1
    `);

    if (!r.rows.length) {
      return res.json({ ok: true, command: null });
    }

    const cmd = r.rows[0];

    await query(`
      UPDATE vps_system.vps_agent_commands
      SET status='processing', updated_at=NOW()
      WHERE id=$1
    `, [cmd.id]);

    return res.json({
      ok: true,
      command: {
        id: cmd.id,
        commandId: cmd.id,
        action: cmd.action,
        payload: {
          ...(cmd.payload || {}),
          commandId: cmd.id,
          vpsId: cmd.vps_id
        }
      }
    });
  } catch (err) {
    console.error('[agent queue error]', err);
    return res.status(500).json({ ok: false, message: err.message });
  }
});

module.exports = router;