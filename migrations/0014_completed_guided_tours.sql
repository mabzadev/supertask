-- Persist guided tour completion state expected by the Supertask frontend.
ALTER TABLE core_userprofile ADD COLUMN completed_guided_tours TEXT NOT NULL DEFAULT '["sidebar","database","builder","automation"]';

UPDATE core_userprofile
SET completed_guided_tours = '["sidebar","database","builder","automation"]'
WHERE completed_guided_tours IS NULL OR completed_guided_tours = '' OR completed_guided_tours = '[]';
