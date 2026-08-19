CREATE TABLE files (
    file_id TEXT PRIMARY KEY,
    pin TEXT,
    burn BOOLEAN DEFAULT 0,
    anti_leak BOOLEAN DEFAULT 0,
    owner_id INTEGER,
    custom_link TEXT,
    telegram_file_id TEXT,
    media_type TEXT,
    caption TEXT
);

CREATE TABLE states (
    chat_id INTEGER PRIMARY KEY,
    action TEXT,
    file_key TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
