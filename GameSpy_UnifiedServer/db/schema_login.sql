-- Rising2 login database (LoginDatabase.db3)
-- Identical to the table the old C# PRMasterServer created, so an existing
-- LoginDatabase.db3 works unchanged.
--   userid    = id + 200000000
--   profileid = id + 100000000   (this is the Sake "ownerid")
--   password  = md5(plain password), lowercase hex
CREATE TABLE IF NOT EXISTS users (
    id       INTEGER PRIMARY KEY,
    name     TEXT NOT NULL,
    password TEXT NOT NULL,
    email    TEXT NOT NULL,
    country  TEXT NOT NULL,
    lastip   TEXT NOT NULL,
    lasttime INTEGER NULL DEFAULT '0',
    session  INTEGER NULL DEFAULT '0'
);
