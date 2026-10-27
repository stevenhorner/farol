-- DROP TABLE orders; (kept for reference, not run)
DELETE FROM orders;
DELETE FROM orders WHERE cancelled = 1;
DROP TABLE legacy_orders;
ALTER TABLE orders DROP COLUMN cancelled;
UPDATE orders SET total = 0 WHERE id = 1;
INSERT INTO audit (note) VALUES ('DROP TABLE x');
