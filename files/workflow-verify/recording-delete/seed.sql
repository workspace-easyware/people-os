CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT, password_salt TEXT, role TEXT NOT NULL DEFAULT 'user', status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, coaching_role TEXT);
CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS plaud_imports (user_id TEXT NOT NULL, plaud_file_id TEXT NOT NULL, doc_id TEXT, title TEXT, created_at INTEGER NOT NULL, recording_id TEXT, header TEXT, PRIMARY KEY (user_id, plaud_file_id));
INSERT OR REPLACE INTO users (id,email,name,role,status,created_at) VALUES ('uA','a@test.local','A','user','active','2026-11-19'),('uB','b@test.local','B','user','active','2026-11-19');
INSERT OR REPLACE INTO auth_sessions VALUES ('ddd824ea9d68a96a66f14bf72963ddb076a4e3f4996b43fbe55fda7eaf06e075','uA',9999999999999),('44291ee5bd396a4e810d8ac727d6f8289af6273719a5a543d2f342e3939ba1b7','uB',9999999999999);
INSERT OR REPLACE INTO documents (id,title,kind,content,owner_id) VALUES ('docR1','t1','transcript','x','uA');
INSERT OR REPLACE INTO chunks (id,doc_id,article,text,ord) VALUES ('docR1#0','docR1','a','x',0);
INSERT OR REPLACE INTO recordings (id,title,object_key,transcript_status,doc_id,owner_id) VALUES
 ('recR1','ready','recordings/recR1/a.ogg','ready','docR1','uA'),
 ('recR2','proc','recordings/recR2/a.ogg','processing',NULL,'uA'),
 ('recR3','orphan','','pending','docGONE','uA'),
 ('recR4','other','recordings/recR4/a.ogg','ready',NULL,'uB');
INSERT OR REPLACE INTO plaud_imports (user_id,plaud_file_id,doc_id,title,created_at,recording_id) VALUES ('uA','pf1','docR1','t1',1,'recR1');
