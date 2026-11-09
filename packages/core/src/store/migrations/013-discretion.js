// 013 · discretion：第一眼（glance，D106）。她听到一句话的那一刻就知道它（感知落库即在心里），第一眼只是轻轻地、异步地看一下
// 这句话「对他来说有多私密、他有没有叮嘱别外传、是谁的事、是不是要她做什么、一句话的大概」，让说出口的分寸更准、更快。
// 第一眼从不决定她知不知道（唯一的例外是收紧：别人的事、他叮嘱别外传而又没要她做什么）。不回填旧的感知。
//   state：pending（排着 / 正在看）/ done / failed（失败一次，下一次有合格的事件再试一次）；
//   sens / limit_kind / quote / quote_ok：模型给的敏感度、限制和原话（quote 必须是这句话或同一个人的话里的原文，代码核对，quote_ok）；
//   about：speaker / her / both / others / unclear；asks：是不是要她做点什么、跟她约定了什么；
//   mixed：卡片上有除了他和她以外的人写的字（这时第一眼只能收紧，asks 不算数）；
//   gist / vague：一句话的大概、不带名字数字细节的说法（≤ discretion.glance.gistChars / vagueChars）；
//   replaces：这句话改掉了同一个人在同一场合更早的哪一条（感知 id，代码核对过）；
//   applies：这句叮嘱（「刚才那句别外传」）说的是他前面的哪几句（感知 id 的 JSON 数组，代码核对过），那几句一起收紧。
// 级联：admin.purge 删感知时一起删；intake.expireRawText 原文到期时把 quote / gist / vague 清掉（§2.3）。
export default {
  version: 13,
  name: 'discretion-glances',
  owner: 'discretion',
  tables: ['glances'],
  up(db) {
    db.exec(`
      CREATE TABLE glances (
        percept_id   INTEGER PRIMARY KEY,
        setting_key  TEXT NOT NULL,
        state        TEXT NOT NULL CHECK (state IN ('pending','done','failed')),
        sens         REAL,
        limit_kind   TEXT CHECK (limit_kind IS NULL OR limit_kind IN ('none','soft','strict')),
        quote        TEXT,
        quote_ok     INTEGER NOT NULL DEFAULT 0,
        about        TEXT CHECK (about IS NULL OR about IN ('speaker','her','both','others','unclear')),
        asks         INTEGER NOT NULL DEFAULT 0,
        mixed        INTEGER NOT NULL DEFAULT 0,
        gist         TEXT,
        vague        TEXT,
        replaces     INTEGER,
        applies      TEXT,
        prompt_ver   TEXT,
        model        TEXT,
        attempts     INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL,
        done_at      INTEGER,
        latency_ms   INTEGER
      ) STRICT;
      CREATE INDEX glances_setting ON glances(setting_key, state);
    `);
  },
};
