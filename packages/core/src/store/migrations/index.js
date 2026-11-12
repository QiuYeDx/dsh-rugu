// 全部迁移，按编号排好。新迁移只往后加（第一次真实安装之后不再改旧文件，§12.5）。
import m001 from './001-store.js';
import m002 from './002-intake.js';
import m003 from './003-entities.js';
import m004 from './004-encode.js';
import m005 from './005-dynamics.js';
import m006 from './006-discretion.js';
import m007 from './007-context.js';
import m008 from './008-consolidate.js';
import m009 from './009-worker.js';
import m010 from './010-admin.js';
import m011 from './011-backup.js';
import m012 from './012-discretion.js';
import m013 from './013-discretion.js';
import m014 from './014-discretion.js';
import m015 from './015-intake.js';
import m016 from './016-intake.js';
import m017 from './017-consolidate.js';
import m018 from './018-encode.js';
import m019 from './019-encode.js';
import m020 from './020-retrieve.js';
import m021 from './021-discretion.js';

/** @type {readonly import('../migrate.js').Migration[]} */
export const MIGRATIONS = Object.freeze([m001, m002, m003, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013, m014, m015, m016, m017, m018, m019, m020, m021]);

/** 代码支持的 schema 版本。库的版本比它新 → 只读（§12.5）。 */
export const SCHEMA_VERSION = MIGRATIONS.at(-1).version;

/** 表 → 拥有它的模块（只有拥有者能写，别的模块调拥有者的写函数）。FTS 分表 percepts_fts_* 归 intake。 */
export const TABLE_OWNERS = Object.freeze(Object.fromEntries(MIGRATIONS.flatMap((m) => m.tables.map((t) => [t, m.owner]))));
