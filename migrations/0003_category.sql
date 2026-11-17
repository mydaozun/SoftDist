-- 软件分类：留空表示未分类，用户页按此分组筛选
ALTER TABLE apps ADD COLUMN category TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_apps_category ON apps (category);
