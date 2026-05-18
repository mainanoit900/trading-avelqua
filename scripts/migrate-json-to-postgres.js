require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { query, getClient } = require('../config/database');

function loadFirstExisting(paths) {
  for (const p of paths) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  return {};
}

function parseDate(v) {
  return v ? new Date(v) : null;
}

(async () => {
  const root = path.join(__dirname, '..');
  const json = loadFirstExisting([
    path.join(root, 'data', 'data.json'),
    path.join(root, 'data.json')
  ]);

  const client = await getClient();
  try {
    await client.query('BEGIN');

    for (const user of json.users || []) {
      const provider = ['web', 'google', 'line', 'mixed'].includes(String(user.provider || '').toLowerCase())
        ? String(user.provider).toLowerCase()
        : 'web';
      const passwordHash = user.password
        ? await bcrypt.hash(String(user.password), 10)
        : '';
      const insertUser = await client.query(
        `INSERT INTO users (legacy_id, first_name, last_name, full_name, email, phone, address, password_hash, role, provider, google_id, line_id, email_verified, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,COALESCE($15,NOW()))
         ON CONFLICT (legacy_id) DO UPDATE SET full_name = EXCLUDED.full_name
         RETURNING id`,
        [
          String(user.id),
          user.firstName || '',
          user.lastName || '',
          user.name || [user.firstName, user.lastName].filter(Boolean).join(' '),
          user.email || null,
          user.phone || '',
          user.address || '',
          passwordHash,
          user.role || 'user',
          provider,
          user.googleId || null,
          user.lineId || null,
          !!(user.emailVerified || user.isVerified),
          user.status || 'active',
          parseDate(user.createdAt)
        ]
      );
      const newUserId = insertUser.rows[0].id;

      if (user.activePackageName || user.packageEndAt) {
        await client.query(
          `INSERT INTO user_subscriptions (user_id, package_name_snapshot, source_channel, status, start_at, end_at, lot_min, lot_max, ports_min, ports_max, profit_label)
           VALUES ($1,$2,$3,'active',$4,$5,$6,$7,$8,$9,$10)`,
          [
            newUserId,
            user.activePackageName || '',
            provider,
            parseDate(user.packageStartAt),
            parseDate(user.packageEndAt),
            Number(user.lotMin || 0),
            Number(user.lotMax || 0),
            Number(user.portMin || 0),
            Number(user.portMax || 0),
            user.profit?.label || ''
          ]
        );
      }
    }

    for (const pkg of json.packages || []) {
      await client.query(
        `INSERT INTO packages (legacy_id, package_code, group_name, name_th, name_en, summary_th, summary_en, days, price, lot_min, lot_max, ports_min, ports_max, profit_min, profit_max, profit_label_th, profit_label_en, support_th, support_en, is_popular, is_enabled, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
         ON CONFLICT (legacy_id) DO NOTHING`,
        [
          String(pkg.id),
          pkg.code || null,
          String(pkg.size || 'basic').toUpperCase(),
          pkg.nameTh || pkg.name || '',
          pkg.nameEn || pkg.name || '',
          pkg.summaryTh || pkg.summary || '',
          pkg.summaryEn || pkg.summary || '',
          Number(pkg.days || 0),
          Number(pkg.price || 0),
          Number(pkg.lotMin || 0),
          Number(pkg.lotMax || 0),
          Number(pkg.portMin || 0),
          Number(pkg.portMax || 0),
          Number(pkg.profit?.min || 0),
          Number(pkg.profit?.max || 0),
          pkg.profit?.label || '',
          pkg.profit?.label || '',
          pkg.supportTh || pkg.support || '',
          pkg.supportEn || pkg.support || '',
          !!pkg.popular,
          pkg.enabled !== false,
          Number(pkg.id || 0)
        ]
      );
    }

    for (const p of json.payments || []) {
      const userIdRes = p.userId ? await client.query(`SELECT id FROM users WHERE legacy_id = $1 LIMIT 1`, [String(p.userId)]) : { rows: [] };
      const packageIdRes = p.packageId ? await client.query(`SELECT id FROM packages WHERE legacy_id = $1 LIMIT 1`, [String(p.packageId)]) : { rows: [] };
      await client.query(
        `INSERT INTO payments (legacy_id, user_id, package_id, payer_name, payer_email, package_name_snapshot, amount, final_amount, payment_method, payment_status, paid_at, created_at, raw_payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (legacy_id) DO NOTHING`,
        [
          String(p.id),
          userIdRes.rows[0]?.id || null,
          packageIdRes.rows[0]?.id || null,
          p.payerName || '',
          p.payerEmail || '',
          p.packageName || '',
          Number(p.amount || 0),
          Number(p.amount || 0),
          p.method || 'manual',
          p.status || 'pending',
          parseDate(p.paidAt || p.approvedAt),
          parseDate(p.createdAt),
          JSON.stringify(p)
        ]
      );
    }

    for (const c of json.coupons || []) {
      await client.query(
        `INSERT INTO coupons (legacy_id, coupon_name, coupon_code, coupon_type, discount_amount, is_free, usage_limit, used_count, expires_at, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (legacy_id) DO NOTHING`,
        [
          String(c.id),
          c.name || c.couponName || 'Coupon',
          c.code || c.couponCode,
          c.type || 'discount',
          Number(c.discountAmount || 0),
          String(c.type || '').toLowerCase() === 'free',
          Number(c.usageLimit || 1),
          Number(c.usedCount || 0),
          parseDate(c.expiresAt),
          c.active !== false
        ]
      );
    }

    for (const node of json.vpsNodes || []) {
      await client.query(
        `INSERT INTO vps_nodes (legacy_id, node_name, ip_address, max_lot, max_ports, used_lot, used_ports, ping_ms, speed_mbps, status, last_error)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (legacy_id) DO NOTHING`,
        [
          String(node.id),
          node.name || node.nodeName || `VPS-${node.id}`,
          node.ip || node.ipAddress || '',
          Number(node.maxLot || 0),
          Number(node.maxPorts || 0),
          Number(node.usedLot || 0),
          Number(node.usedPorts || 0),
          Number(node.ping || 0),
          Number(node.speed || 0),
          node.status || 'available',
          node.error || ''
        ]
      );
    }

    for (const article of json.news || []) {
      await client.query(
        `INSERT INTO news_articles (legacy_id, title, body, translated_title, translated_body, analysis, source_name, source_url, image_url, category_name, published_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (legacy_id) DO NOTHING`,
        [
          String(article.id),
          article.title || '',
          article.body || '',
          article.translatedTitle || '',
          article.translatedBody || '',
          article.analysis || '',
          article.source || '',
          article.url || '',
          article.imageUrl || '',
          article.category || '',
          parseDate(article.createdAt || article.publishedAt)
        ]
      );
    }

    if (json.aiSettings) {
      await client.query(
        `UPDATE ai_settings SET bot_name = $1, persona_th = $2, is_enabled = $3, updated_at = NOW() WHERE id = 1`,
        [json.aiSettings.botName || 'สายฝน', json.aiSettings.persona || 'สุภาพ ลงท้ายด้วยคำว่าค่ะ', json.aiSettings.enabled !== false]
      );
    }

    await client.query('COMMIT');
    console.log('Migration completed successfully');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', error);
    process.exitCode = 1;
  } finally {
    client.release();
  }
})();
