-- The ticket creation id and the visible provider number are different identifiers.
ALTER TABLE dk_reference_requests ADD COLUMN request_number TEXT;
