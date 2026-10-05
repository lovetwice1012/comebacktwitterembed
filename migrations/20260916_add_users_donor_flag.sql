ALTER TABLE users
    ADD COLUMN is_donor TINYINT(1) NOT NULL DEFAULT 0
    AFTER additional_auto_extract_slots;
