-- Migration: Initial schema for Chat Nodes Canvas
-- Database: D1 (Cloudflare)
-- Date: 2024-01-01

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  avatar_url TEXT,
  preferences TEXT, -- JSON string
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_users_email ON users(email);

-- Canvas table
CREATE TABLE IF NOT EXISTS canvas (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  thumbnail_url TEXT,
  is_public INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_canvas_user_id ON canvas(user_id);
CREATE INDEX idx_canvas_created_at ON canvas(created_at);

-- Media table - tracks files in R2
CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT UNIQUE NOT NULL,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  user_id TEXT,
  canvas_id TEXT,
  uploaded_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (canvas_id) REFERENCES canvas(id) ON DELETE CASCADE
);

CREATE INDEX idx_media_key ON media(key);
CREATE INDEX idx_media_user_id ON media(user_id);
CREATE INDEX idx_media_canvas_id ON media(canvas_id);

-- Chat sessions table
CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  canvas_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  chatgpt_conversation_id TEXT,
  title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (canvas_id) REFERENCES canvas(id) ON DELETE CASCADE
);

CREATE INDEX idx_chat_sessions_canvas_id ON chat_sessions(canvas_id);
CREATE INDEX idx_chat_sessions_node_id ON chat_sessions(node_id);

-- AI interactions table - for analytics and vector search
CREATE TABLE IF NOT EXISTS ai_interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  response TEXT NOT NULL,
  model TEXT,
  tokens_used INTEGER,
  vector_id TEXT, -- Reference to Vectorize index entry
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_ai_interactions_session_id ON ai_interactions(session_id);
CREATE INDEX idx_ai_interactions_user_id ON ai_interactions(user_id);
CREATE INDEX idx_ai_interactions_created_at ON ai_interactions(created_at);

-- Tools usage table - for Composio API integration tracking
CREATE TABLE IF NOT EXISTS tools_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_params TEXT, -- JSON string
  result TEXT,
  success INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_tools_usage_session_id ON tools_usage(session_id);
CREATE INDEX idx_tools_usage_user_id ON tools_usage(user_id);
CREATE INDEX idx_tools_usage_tool_name ON tools_usage(tool_name);

-- Access logs table - for Cloudflare Access integration
CREATE TABLE IF NOT EXISTS access_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource TEXT,
  ip_address TEXT,
  user_agent TEXT,
  success INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_access_logs_user_id ON access_logs(user_id);
CREATE INDEX idx_access_logs_created_at ON access_logs(created_at);
