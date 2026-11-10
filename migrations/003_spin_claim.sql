-- Spin prizes collected by watching a rewarded ad: the spin is decided first (claimed = FALSE), the credits
-- are added only when the ad was watched (verified by Google's SSV callback, or by the app in test-ad mode).

ALTER TABLE spins ADD COLUMN claimed BOOLEAN NOT NULL DEFAULT TRUE;   -- old spins were credited at once
ALTER TABLE spins ADD COLUMN claimed_at TIMESTAMPTZ;
CREATE INDEX spins_unclaimed_idx ON spins (user_id, created_at DESC) WHERE claimed = FALSE;

ALTER TABLE ad_sessions ADD COLUMN ref_id UUID;                       -- the spin a 'spin_claim' ad pays out
ALTER TABLE ad_sessions DROP CONSTRAINT IF EXISTS ad_sessions_purpose_check;
ALTER TABLE ad_sessions ADD CONSTRAINT ad_sessions_purpose_check CHECK (purpose IN ('credits', 'extra_spin', 'spin_claim'));
ALTER TABLE ad_rewards DROP CONSTRAINT IF EXISTS ad_rewards_purpose_check;
ALTER TABLE ad_rewards ADD CONSTRAINT ad_rewards_purpose_check CHECK (purpose IN ('credits', 'extra_spin', 'spin_claim'));
