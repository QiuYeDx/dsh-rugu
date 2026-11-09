// 012 · discretion：判定记录多记模型自己的判断和代码收紧的每一步（D102），以及工作记忆说出口的档位（D101）。只加列。
//   model_verdict / model_json：第二段模型原样给出的结论和它的输出（只有 verdict、vague、hint、sens、limit 这几项，不含卡片）；
//     读缓存时按当时的情况重跑代码的底线（stage2.js 的 finalizeVerdict），不把一次底线造成的「不提」当成她的判断沿用下去；
//   floors_json：代码把模型的结论收紧的每一步 [{floor, from, to}]（管理页「想起来但被代码拦下」、实测排查用）；
//   speak：stage=1 的工作记忆行（rule A4 / A5 / A1…）说出口的档位 free / careful / not-here。
export default {
  version: 12,
  name: 'discretion-model-verdict',
  owner: 'discretion',
  tables: [],
  up(db) {
    db.exec(`
      ALTER TABLE appraisals ADD COLUMN model_verdict TEXT;
      ALTER TABLE appraisals ADD COLUMN model_json TEXT;
      ALTER TABLE appraisals ADD COLUMN floors_json TEXT;
      ALTER TABLE appraisals ADD COLUMN speak TEXT;
    `);
  },
};
