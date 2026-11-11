-- Rising2 login database (LoginDatabase.db3)
-- The table the old C# PRMasterServer created, plus `created`. An older
-- LoginDatabase.db3 gets that column on the first start (filled from lasttime).
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
    session  INTEGER NULL DEFAULT '0',
    created  INTEGER NULL DEFAULT '0'   -- registration time (unix); the profile's "Enlisted since"
);
