-- Keyword search (task 1.3). External-content FTS5 index over items, kept in sync by triggers.
-- Not managed by Drizzle. After restoring `items` from a backup, rebuild the index with:
--   INSERT INTO items_fts(items_fts) VALUES('rebuild');
CREATE VIRTUAL TABLE `items_fts` USING fts5(title, body, content='items', content_rowid='rowid', tokenize='porter unicode61');
--> statement-breakpoint
CREATE TRIGGER `items_fts_ai` AFTER INSERT ON `items` BEGIN
  INSERT INTO items_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
--> statement-breakpoint
CREATE TRIGGER `items_fts_ad` AFTER DELETE ON `items` BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;
--> statement-breakpoint
CREATE TRIGGER `items_fts_au` AFTER UPDATE OF `title`, `body` ON `items` BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO items_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
