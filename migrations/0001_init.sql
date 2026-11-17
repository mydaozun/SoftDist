-- 软件分发表
CREATE TABLE IF NOT EXISTS apps (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT    NOT NULL,
  version        TEXT    NOT NULL DEFAULT '',
  description    TEXT    NOT NULL DEFAULT '',
  download_url   TEXT    NOT NULL,
  installer_type TEXT    NOT NULL DEFAULT 'auto',  -- auto | msi | exe | ps1 | msix | zip | none
  silent_args    TEXT    NOT NULL DEFAULT '',
  sha256         TEXT    NOT NULL DEFAULT '',
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_name ON apps (name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_apps_enabled ON apps (enabled);
