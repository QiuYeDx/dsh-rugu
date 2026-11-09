import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateObservation, validateObservations, validateSettingDescriptor, validateUtterance, validateIdentityClaim,
  validateSituationRef, validateRecallOptions, validateRecallLayers, validateNoteRequest, validateFixRequest,
  validateImportRecords, validateRelayExpectation, validatePerceptionAdapter, validateObserveOptions,
  assertObservation, ContractError, NotImplementedError, notImplemented,
  isOpaqueId, sameId, opaqueFrom, encodeParts, textHash, settingIdLeaksAccount,
  exposureRank, persistenceRank, reachHash, reachGrew, isOneOnOne, isPublicLike, LIMITS,
} from '../src/contract/index.js';

const actor = { claims: [{ kind: 'account', namespace: 'zz', id: 'u123456', verifiedBy: 'platform' }] };
const baseObs = () => ({
  id: 'm1', settingId: 'S-opaque', visibleTo: 'setting-audience', at: 1_000, perceivedAt: 1_000, actor,
  kind: 'utterance', text: '今晚又要加班', addressed: 'ambient', attention: 'peripheral', evidential: true, standing: 'first-hand',
});
const errorPaths = (r) => r.errors.map((e) => e.path);

test('Observation：合格的通过，补默认值，丢掉未知字段', () => {
  const r = validateObservation({ ...baseObs(), sneaky: 'x', agentToken: 'secret' });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.value.perceivedInSettingId, 'S-opaque');
  assert.equal(r.value.textTruncated, false);
  assert.equal(r.value.historical, false);
  assert.ok(!('sneaky' in r.value) && !('agentToken' in r.value));
  assert.deepEqual(r.value.actor, actor);
});

test('Observation：缺字段、枚举不对、类型不对都报出路径', () => {
  const r = validateObservation({ ...baseObs(), kind: 'shout', at: 'yesterday', evidential: undefined, addressed: 'loud' });
  assert.equal(r.ok, false);
  assert.ok(errorPaths(r).includes('kind'));
  assert.ok(errorPaths(r).includes('at'));
  assert.ok(errorPaths(r).includes('evidential'));
  assert.ok(errorPaths(r).includes('addressed'));
  assert.equal(r.value, null);
  assert.throws(() => assertObservation({ ...baseObs(), id: '' }), (e) => e instanceof ContractError && e.code === 'CONTRACT');
});

test('Observation：字段之间的自洽规则', () => {
  const bad = (patch, path) => {
    const r = validateObservation({ ...baseObs(), ...patch });
    assert.equal(r.ok, false, `应该不通过：${JSON.stringify(patch)}`);
    assert.ok(errorPaths(r).includes(path), `应该报 ${path}：${JSON.stringify(r.errors)}`);
  };
  bad({ kind: 'self-utterance' }, 'actor.self');                                        // 她自己的话必须是 self
  bad({ kind: 'self-utterance', actor: { self: true, claims: [] }, addressed: 'ambient' }, 'addressed');
  bad({ addressed: 'by-her' }, 'addressed');                                            // by-her 只给她自己
  bad({ actor: { self: true, claims: [] }, addressed: 'by-her' }, 'kind');                // 她的话用 self-utterance
  bad({ kind: 'self-thought', actor: { self: true, claims: [] }, addressed: 'by-her' }, 'visibleTo');   // 心里想的只有她
  bad({ kind: 'retract' }, 'target');
  bad({ target: 'm0' }, 'target');
  bad({ kind: 'edit', target: 'm1' }, 'target');                                        // 不能指向自己
  bad({ forwarded: { relayedBy: actor, authorVerified: true } }, 'forwarded.authorVerified');
  bad({ actor: { self: false, claims: [] } }, 'actor.self');
  bad({ text: 'x'.repeat(LIMITS.textMax + 1) }, 'text');
  bad({ id: 'a\u0000b' }, 'id');
  bad({ actor: { claims: [{ kind: 'principal', strength: 'platform' }] } }, 'actor.claims[0].strength');

  const ok = validateObservation({ ...baseObs(), kind: 'self-thought', actor: { self: true, claims: [] }, addressed: 'by-her', visibleTo: 'her-only' });
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  const retract = validateObservation({ ...baseObs(), kind: 'retract', target: 'm0' });
  assert.equal(retract.ok, true, JSON.stringify(retract.errors));
  const fwd = validateObservation({ ...baseObs(), forwarded: { relayedBy: actor, authorVerified: false }, derivedFrom: { adapter: 'other', obsId: 'x9' } });
  assert.equal(fwd.ok, true, JSON.stringify(fwd.errors));
});

test('Observation 批量：合格的进 accepted，不合格的带下标', () => {
  const { accepted, rejected } = validateObservations([baseObs(), { nope: 1 }, { ...baseObs(), id: 'm2' }]);
  assert.equal(accepted.length, 2);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].index, 1);
  assert.equal(validateObservations('not-a-list').rejected.length, 1);
});

test('ObserveOptions：adapter、cursor', () => {
  assert.deepEqual(validateObserveOptions(undefined).value, { historical: false });
  const r = validateObserveOptions({ adapter: 'zz', historical: true, cursor: { key: 'k', value: '42' } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { adapter: 'zz', historical: true, cursor: { key: 'k', value: '42' } });
  assert.equal(validateObserveOptions({ adapter: '9bad' }).ok, false);
});

const descriptor = () => ({
  id: 'S1', label: '某游戏群', stability: 'persistent',
  audience: { size: 30, entry: 'invite', unknownObservers: true, membersKnown: 'recent-speakers' },
  disclosure: { visibleTo: 'members', persistence: 'logged', searchable: false, attributedToHer: true },
  ownership: { owner: 'unknown', herRole: '普通成员', herModerates: false, actsOnBehalfOfPrincipal: false },
  norms: { notes: [{ text: '内部事务别外传', author: actor }] },
  capabilities: { preSendGate: true, canHold: false },
  attending: true,
});

test('SettingDescriptor：合格的通过；公开场合必须有不认识的旁观者', () => {
  const r = validateSettingDescriptor(descriptor());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.value.norms.notes[0].author.claims[0].id, 'u123456');
  const pub = descriptor();
  pub.disclosure.visibleTo = 'anyone';
  pub.audience.unknownObservers = false;
  assert.ok(errorPaths(validateSettingDescriptor(pub)).includes('audience.unknownObservers'));
  const loop = { ...descriptor(), parent: 'S1' };
  assert.ok(errorPaths(validateSettingDescriptor(loop)).includes('parent'));
  const badSize = descriptor();
  badSize.audience.size = 2.5;
  assert.ok(errorPaths(validateSettingDescriptor(badSize)).includes('audience.size'));
  const noCaps = descriptor();
  delete noCaps.capabilities;
  assert.ok(errorPaths(validateSettingDescriptor(noCaps)).includes('capabilities'));
});

test('场合属性推出来的量：公开程度、留存、可见范围', () => {
  const g = validateSettingDescriptor(descriptor()).value;
  assert.equal(exposureRank(g), 2);                 // 有不认识的旁观者
  assert.equal(persistenceRank(g), 1);
  const dm = { ...g, audience: { size: 2, entry: 'closed', unknownObservers: false, membersKnown: 'exact' }, disclosure: { ...g.disclosure, visibleTo: 'participants' } };
  assert.equal(isOneOnOne(dm), true);
  assert.equal(exposureRank(dm), 0);
  const closed = { ...g, audience: { ...g.audience, unknownObservers: false, entry: 'closed' } };
  assert.equal(exposureRank(closed), 1);
  const pub = { ...g, audience: { ...g.audience, size: 'unbounded', entry: 'open' }, disclosure: { visibleTo: 'anyone', persistence: 'public-permanent', searchable: true, attributedToHer: true } };
  assert.equal(exposureRank(pub), 3);
  assert.equal(isPublicLike(pub), true);
  assert.equal(reachGrew(closed, g), true);
  assert.equal(reachGrew(g, closed), false);
  assert.notEqual(reachHash(g), reachHash(closed));
  assert.equal(reachHash(g), reachHash({ ...g, label: '改了称呼', audience: { ...g.audience, size: 31 } }));   // 人数和称呼不算可见范围
});

test('Utterance、ExpressionChannel', () => {
  const u = { channel: { targetSettingId: 'S1', persistence: 'once', formHint: '评论' }, text: ['好呀'], origin: { path: 'tool', sessionId: 'sess', callId: 'c1' } };
  assert.equal(validateUtterance(u).ok, true);
  assert.ok(errorPaths(validateUtterance({ ...u, text: ['  '] })).includes('text'));
  assert.ok(errorPaths(validateUtterance({ ...u, origin: { path: 'owner-approved' } })).includes('origin.holdToken'));
  assert.ok(errorPaths(validateUtterance({ ...u, channel: { ...u.channel, persistence: 'forever' } })).includes('channel.persistence'));
  assert.equal(validateUtterance({ ...u, origin: { path: 'owner-approved', holdToken: 'h1' } }).ok, true);
});

test('身份证据：每种 claim', () => {
  assert.equal(validateIdentityClaim({ kind: 'display-name', name: '阿明', scope: 'S1', observedAt: 5 }).ok, true);
  assert.equal(validateIdentityClaim({ kind: 'self-introduction', text: '我是阿明的表哥', obs: 'm9' }).ok, true);
  assert.equal(validateIdentityClaim({ kind: 'role-in-setting', setting: 'S1', role: '管理员', moderates: true }).ok, true);
  assert.equal(validateIdentityClaim({ kind: 'principal', strength: 'config' }).ok, true);
  assert.equal(validateIdentityClaim({ kind: 'account', namespace: 'zz', id: 'u1', verifiedBy: 'rumor' }).ok, false);
  assert.equal(validateIdentityClaim({ kind: 'nickname', name: 'x' }).ok, false);
});

test('读接口和写类请求的参数', () => {
  const s = validateSituationRef({ settingId: 'S1', trigger: 'message', sessionId: 'sess-1' });
  assert.equal(s.ok, true);
  assert.equal(s.value.homeSettingId, 'S1');
  assert.equal(validateSituationRef({ settingId: 'S1', trigger: 'poke' }).ok, false);
  assert.equal(validateRecallOptions({ mode: 'deliberate', deadlineMs: 3000, budgetChars: 600, about: '阿明' }).ok, true);
  assert.equal(validateRecallOptions({ mode: 'deliberate', deadlineMs: 600_000, budgetChars: 600 }).ok, false);
  assert.equal(validateRecallLayers({ items: [{ id: 'a1', layer: 'recalled', rendered: 'x', verdict: 'share', confidence: 0.9, provenance: '他自己说的', appraisalRef: 'ap1' }], degradeLevel: 0, traceId: 't' }).ok, true);
  // §9.3.6：每条都必须对得上一次判定；omit 的根本不该出现
  assert.equal(validateRecallLayers({ items: [{ id: 'a1', layer: 'recalled', rendered: 'x', verdict: 'share', confidence: 0.9, provenance: 'p', appraisalRef: '' }], degradeLevel: 0, traceId: 't' }).ok, false);
  assert.equal(validateRecallLayers({ items: [{ id: 'a1', layer: 'recalled', rendered: 'x', verdict: 'omit', confidence: 0.9, provenance: 'p', appraisalRef: 'ap1' }], degradeLevel: 0, traceId: 't' }).ok, false);
  assert.equal(validateNoteRequest({ triggerObsId: 'm1', speaker: actor, op: 'remember', text: '我生日是 3 月', evidenceQuote: '生日' }).ok, true);
  assert.equal(validateFixRequest({ triggerObsId: 'm1', speaker: actor, op: 'correct', target: 'a1', evidenceQuote: '不是' }).ok, false);
  assert.equal(validateImportRecords([{ subjects: ['阿明'], text: '喜欢猫', sourceMeta: { speaker: '阿明' }, norm: { restriction: 'soft' } }]).ok, true);
  assert.equal(validateImportRecords([{ subjects: [], text: 'x', sourceMeta: {} }]).ok, false);
  assert.equal(validateRelayExpectation({ adapter: 'zz', obsId: 'm1', textHash: textHash('x'), until: 10 }).ok, true);
});

test('适配器形状', () => {
  const a = { id: 'zz', protocol: 2, describeSetting() {}, selfClaims: () => [], principalClaims: () => [] };
  assert.equal(validatePerceptionAdapter(a).ok, true);
  assert.equal(validatePerceptionAdapter({ ...a, protocol: 1 }).ok, false);
  assert.equal(validatePerceptionAdapter({ ...a, start: 'yes' }).ok, false);
  assert.equal(validatePerceptionAdapter({ ...a, id: 'has space' }).ok, false);
});

test('不透明 id 的帮手', () => {
  assert.equal(isOpaqueId('abc'), true);
  assert.equal(isOpaqueId(''), false);
  assert.equal(isOpaqueId('x'.repeat(513)), false);
  assert.equal(isOpaqueId(42), false);
  assert.equal(sameId('a', 'a'), true);
  assert.equal(sameId('', ''), false);
  // 长度前缀：['a:b','c'] 和 ['a','b:c'] 不会撞
  assert.notDeepEqual(encodeParts('a:b', 'c'), encodeParts('a', 'b:c'));
  assert.notEqual(opaqueFrom('k', 'a:b', 'c'), opaqueFrom('k', 'a', 'b:c'));
  assert.equal(opaqueFrom('k', 'x'), opaqueFrom('k', 'x'));
  assert.notEqual(opaqueFrom('k1', 'x'), opaqueFrom('k2', 'x'));
  assert.equal(textHash('今晚  又要\n加班'), textHash(' 今晚 又要 加班 '));
  assert.equal(textHash('ａｂｃ'), textHash('abc'));   // NFKC
  assert.equal(settingIdLeaksAccount('group-u123456', actor.claims), true);
  assert.equal(settingIdLeaksAccount(opaqueFrom('salt', 'u123456'), actor.claims), false);
});

test('NotImplementedError 带模块名', () => {
  assert.throws(() => notImplemented('intake.enqueue'), (e) => e instanceof NotImplementedError && e.code === 'NOT_IMPLEMENTED' && e.module === 'intake' && e.what === 'intake.enqueue');
});
