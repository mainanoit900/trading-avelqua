UPDATE referral_commissions
SET reward_percent = CASE level_no
  WHEN 1 THEN 20
  WHEN 2 THEN 15
  WHEN 3 THEN 10
  WHEN 4 THEN 5
  WHEN 5 THEN 5
  ELSE reward_percent
END,
is_enabled = TRUE
WHERE level_no BETWEEN 1 AND 5;

INSERT INTO referral_commissions (level_no, reward_percent, is_enabled)
SELECT v.level_no, v.reward_percent, TRUE
FROM (VALUES (1,20),(2,15),(3,10),(4,5),(5,5)) AS v(level_no,reward_percent)
WHERE NOT EXISTS (
  SELECT 1 FROM referral_commissions rc WHERE rc.level_no = v.level_no
);

CREATE INDEX IF NOT EXISTS idx_scoin_tx_package_reward_payment_user
ON scoin_transactions (tx_type, ref_payment_id, user_id);

CREATE INDEX IF NOT EXISTS idx_scoin_tx_ref_first_user
ON scoin_transactions (tx_type, ref_user_id);

CREATE INDEX IF NOT EXISTS idx_scoin_tx_level_bonus_payment
ON scoin_transactions (tx_type, ref_payment_id);