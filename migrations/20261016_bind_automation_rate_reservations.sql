-- Nullable linkage preserves historical holds without guessing their origin.
-- A lease identifies one attempt; only unsubmitted parts may be recovered.
ALTER TABLE automation_rate_reservations ADD COLUMN job_id CHAR(36) NULL;
ALTER TABLE automation_rate_reservations ADD COLUMN lease_token CHAR(36) NULL;
