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