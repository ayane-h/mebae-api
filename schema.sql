DROP TABLE IF EXISTS companies;

CREATE TABLE companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    company_name TEXT NOT NULL,
    job_url TEXT,
    job_text TEXT,
    interest_level INTEGER DEFAULT 3,
    status TEXT DEFAULT '応募前',
    is_favorite INTEGER DEFAULT 0,
    is_sleeping INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

DROP TABLE IF EXISTS impressions;

CREATE TABLE impressions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    content TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

DROP TABLE IF EXISTS honne;

CREATE TABLE honne (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL UNIQUE,
    content TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

DROP TABLE IF EXISTS memos;

CREATE TABLE memos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    content TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE desired_conditions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    label TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE requirement_matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    condition_id INTEGER NOT NULL,
    mark TEXT NOT NULL,
    note TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(company_id, condition_id)
);

CREATE TABLE records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    category TEXT NOT NULL,
    note TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE records ADD COLUMN title TEXT NOT NULL DEFAULT '';

ALTER TABLE requirement_matches ADD COLUMN manually_edited INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS ai_suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE companies ADD COLUMN selection_flow TEXT;
ALTER TABLE companies ADD COLUMN selection_flow_manually_edited INTEGER NOT NULL DEFAULT 0;

ALTER TABLE desired_conditions ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

ALTER TABLE companies ADD COLUMN short_memo TEXT;

CREATE TABLE IF NOT EXISTS demo_users (
    user_id TEXT PRIMARY KEY,
    rematch_count INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 関連リンク（採用ページ・企業HP・別の求人など。1社にいくつでも登録できる）
CREATE TABLE IF NOT EXISTS company_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    label TEXT NOT NULL,
    url TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);