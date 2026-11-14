-- Importing Digikala listings, and the User-Agent the seller Open API is called with.
-- The Open API refuses authenticated calls whose User-Agent it does not accept ("Invalid User-Agent!");
-- the value is not in its specification, so the manager can set the one Digikala gives.
ALTER TABLE dk_connection ADD COLUMN user_agent TEXT;
