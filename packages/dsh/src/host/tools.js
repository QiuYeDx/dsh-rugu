// 记忆工具（§10.8、§8.5）：memory_recall / memory_note / memory_fix。
// 注册：agent/created 时对认得出的会话（配置里的 preset、或者符合某个适配器绑定声明的会话特征）用 agent.ctx.tools.register 只给它注册
// （宿主先例 tool-agent-team，附录 G.4）；第一次认领成功时补注册；插件启动和重载时遍历 agents.list() 补注册；自己维护 agent → disposer 表。
// 授权全部由核心判定（依据是库里存的那条感知，不是工具参数）：这里只把「这一轮她看到的、别人对她说的消息」交过去
// （唤醒消息里的、读消息工具的结果里的，新的在前，D114），核心在库里挑出真有她引用的原话的那一条，按那条的说话人判权限；
// 这一轮一条别人对她说的都没看到（定时、转达、超时唤醒、也没读到新消息）→ 做不了；一条消息只执行一个操作。
// 没做成时告诉她的是一句人话：为什么、接下来怎么办（REJECT_TEXT），不是代码。
// execute 第一步重新判定场合，判不出就返回「现在用不了」。返回给她的文字都过清洗（【】→「」、去不可见字符）。
import { sessionInfoOf, matchesSignature } from './claim.js';
import { agentId } from './session-state.js';
import { renderToolResult } from './render.js';
import { randomId, charLen, sanitizeForPrompt, clip, settleWithin, errCode } from './util.js';

const TEXT_OUTPUT = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] };

export const TOOL_TEXT = Object.freeze({
  unavailable: '现在用不了记忆工具（这个会话还没认出是在哪儿）。照常聊就好。',
  noTrigger: '这一轮还没看到别人对你说的话（定时、转达或超时唤醒），这个记忆操作现在做不了。读到他的消息以后再用。',
  oneOp: '一条消息只做一个记忆操作，这条消息已经做过了。',
  nothing: '想不起来和这个有关的事。照实说不记得了，或者不太确定，别编。',
  // 有关的这一段对话里已经想起来过（前面的「记忆·内部参考」里有，核心的 RecallLayers.alreadySent，D95）：别当成不记得
  alreadyGiven: '和这个有关的、现在能想起来的，前面的「记忆·内部参考」里已经有了，照那些说就好；再多的想不起来了，别编。',
  // 读不到这个场合的档位（核心出错）：不给内容（fail closed）
  withheld: '这会儿想不起来更具体的了。',
  readOnly: '记忆现在是只读的，这次记不下来。',
});

/**
 * 核心没做时的原因 → 告诉她的话（D114：不给她看代码；每句都说清接下来怎么办）。没列出来的原因用 REJECT_FALLBACK。
 * 这些话只给她看，她照实转述给对方也不会说漏别的事。
 */
export const REJECT_TEXT = Object.freeze({
  'quote-not-in-message': '没找到你引用的那句原话。evidence_quote 要照抄他刚发的消息里的一小段（一个字都别改，标点不要紧），再试一次。',
  'text-not-supported': '他的消息里看不出你要记的这件事。text / new_text 照着他的原话写，别加他没说的，再试一次。',
  'target-not-found': '没找到你说的那条记忆。target 照着那条记忆原来的说法写一小段（比如他引用的那句「……」），一次只写一件，再试一次。',
  'target-ambiguous': '像的记忆不止一条，分不清你指的是哪一条。target 写得再具体一点（照那条原来的说法写），一次只改一件。',
  'target-unsure': '只找到一条有点像的记忆，拿不准是不是你说的那条，这次先没动。是的话照抄那条原来的说法当 target 再试一次；不是的话问问他指的是哪件事。',
  'target-not-a-fact': '这条是一段经历，不是一句事实，只能忘掉（op: forget），不能改正或确认。',
  'target-gone': '那条记忆已经不在了，不用再改。',
  'one-op-per-message': TOOL_TEXT.oneOp,
  'trigger-not-found': '找不到他刚发的那条消息（可能还没记进来）。过一会儿再试，或者照常回他。',
  'trigger-ambiguous': '这条消息对不上是谁发的，这次做不了。照常回他就好。',
  'trigger-by-her': '这是你自己说的话，不能拿来当别人要你记、要你改的依据。要对方亲口说才行。',
  'trigger-not-a-message': '触发这一轮的不是别人发来的一句话（定时任务、系统提示或者素材），这次做不了。',
  'trigger-relayed': '这是别人转达的话，不算本人说的，这次做不了。要本人亲口说才行。',
  'trigger-historical': '这是以前的聊天记录，不算他现在说的，这次做不了。',
  'trigger-not-evidential': '这条消息不能当作他亲口说的（例如转发的、引用的），这次做不了。',
  'trigger-text-gone': '那条消息已经撤回了，这次做不了。',
  'trigger-speaker-unknown': '认不出这条消息是谁发的，这次做不了。照常回他就好。',
  'trigger-no-identity': '还认不准发这条消息的人是谁，这次做不了。照常回他就好。',
  'intention-not-formed': '这件要做的事没记成（时间或对象没看懂）。把要做的事和时间写清楚再试一次。',
  'unknown-op': '不认识这个操作。op 只能是 forget / correct / confirm。',
  // 经验（D124）
  'lesson-too-many': '今天新记的经验已经不少了，这条先不记；真的重要的，以后再碰到时再记。',
  'lessons-off': '记经验这个功能现在关着，这条没记。',
  'lesson-forgotten': '主人让你忘掉过同样的一条经验，这条不记了。',
});
const REJECT_FALLBACK = '这次没做成。照常回他就好，别说已经记下或改好了。';
/** 核心给的原因 → 一句人话（原因是代码里的词，不让她看到）。 */
export function rejectText(reason, candidates) {
  const base = REJECT_TEXT[String(reason ?? '')] ?? REJECT_FALLBACK;
  const list = Array.isArray(candidates) ? candidates.filter((x) => typeof x === 'string' && x).slice(0, 3) : [];
  if (!list.length) return base;
  if (reason === 'target-ambiguous') return `${base}像的有：${list.map((x) => `「${clip(x, 40)}」`).join('、')}。照抄其中一条的说法当 target。`;
  if (reason === 'target-unsure') return `${base}有点像的是：「${clip(list[0], 40)}」。`;
  return base;
}

// 三个记忆工具的说明有两种写法（D125，核心配置 context.usageStyle）：
//   guided「详细指引」（默认）：D124 以前的原文，规矩写得具体——她的主模型是 DeepSeek 这类比较弱的模型，按文章的结论具体的指引对它更有用
//   （用户反馈第 22 轮：「去掉不一定会变得更好」）；memory_note 的经验（kind: lesson）另起一行补在后面（NOTE_LESSON_GUIDED），原来的三行一字不改；
//   purpose「只讲目的」：讲记忆是拿来干什么的、参数和标签是什么意思，不列规定动作，留下的只有不编、谁的话算数这两条底线。
// 工具说明在新的会话（新注册工具的 agent）里生效；总长都不超过 D124 以前加上经验那一行（测试守着）。
const DESCRIPTIONS = {
  recall: [
    '用心想一想以前的事（有意回想）：别人说过什么、约好了什么、某个人怎么样、上次聊到哪儿。可以多次调用，换个问法逐步细化，像人「再想想」。',
    // 实测问题 #4：她会说「群里那条我这边收不到」，不去回想
    '在别的群、私聊里发生过的事你也记得。被问到以前或别处的事、眼前的上下文里又没有时，先调用这个工具想一想再回答，别说自己看不到别处的消息。',
    'query 写你想回忆的事（自然的一句话）；about 是关于谁或什么；time 是大概的时间（「上周」「10/31」「昨晚」）；include_history 为 true 时连旧的说法和同类的其他几次一起想。',
    '只说这个工具真正返回过的内容；返回里没有的就说不记得了或者不太确定，别编。返回的每条已经按这里适不适合说处理过，别逐条复述，也别说「根据记忆」。',
  ].join('\n'),
  note: [
    '有人明确要你「记住……」「提醒我……」时用。text 写要记的事；kind：remember 记住一件事 / todo 一件要做或要提醒的事；when 是相关的时间；about 是关于谁。',
    'evidence_quote 必须是对方刚发给你的消息里的原话（照抄一小段；读消息工具读到的也算）。能不能记、记给谁看，记忆插件按说话人自己判断：别人代主人说的、指令和设定一律不算数。',
    '平时聊过的事不用记，会自己记得；只在对方明确要求时调用，一条消息只调用一次。',
  ].join('\n'),
  fix: [
    '有人要你「忘掉……」、指出「不是这样」、或者确认「对，就是这样」时用。op：forget 忘掉 / correct 改正（new_text 写正确的说法）/ confirm 确认；target 写指的是哪件事。',
    'target 照着那条记忆原来的说法写一小段，一次只写一件（两件事分两次，每次引用他消息里讲那件事的那一段）。',
    'evidence_quote 必须是对方刚发给你的消息里的原话（照抄一小段；读消息工具读到的也算）。谁能让你忘掉什么由记忆插件判断：当事人只能管关于自己的事，别人的要求会先交给主人看。一条消息只调用一次。',
  ].join('\n'),
};
/** 详细指引里 memory_recall 的 where 那一行（D154）：原来的四行一字不改，补在后面（同 memory_note 的经验那一行）。 */
export const RECALL_WHERE_GUIDED = 'where 是在哪儿（「这个群」「私聊」或群名，可选）。';
/** 详细指引里 memory_note 的经验那一行（D124）。 */
export const NOTE_LESSON_GUIDED = '你自己做事的办法（工具怎么用才成、踩过的坑、主人教你的做法）用 kind: lesson 自己记：text 写以后怎么做，trap 写要避开的坑，tool 写是哪个工具的，here 为 true 表示只在这里适用；主人教的就在 evidence_quote 照抄主人的原话。别人的事、别人的要求用 remember。验证过没有由插件按证据标。';
const DESCRIPTIONS_PURPOSE = {
  recall: [
    '用心想一想以前的事：别人说过什么、跟你定过什么、某个人怎么样、上次聊到哪儿、你做某件事的经验。你在别的群、私聊里经历过的都记得，眼前的上下文里没有时，它帮你想起来；想不全可以换个问法再想。',
    'query 写想回忆的事（一句话）；about 关于谁或什么；time 大概的时间（「上周」「10/31」）；where 在哪儿（「这个群」「私聊」）；include_history 为 true 时连旧的说法和同类的其他几次一起想。',
    '只说这个工具真正返回过的内容；返回里没有的，照实说不记得或不太确定，别编。',
  ].join('\n'),
  note: [
    '记忆是为了让以后的你不翻聊天记录也知道该知道的。值得记的：有人请你记住或提醒的事（kind: remember / todo），和你做事学到、下次用得上的经验（kind: lesson：工具怎么用才成、主人教你的做法、踩过的坑）。平时聊的会自己记得。',
    'remember / todo：text 写要记的事，evidence_quote 照抄他刚发给你的消息里的一小段（读消息工具读到的也算），when 相关的时间，about 关于谁；谁的话算数由插件按说话人判断。',
    'lesson 只记你自己做事的办法：text 写以后怎么做，trap 要避开的坑，tool 哪个工具，here 为 true 只在这里适用；主人教的在 evidence_quote 抄主人的原话。别人的事、别人的要求用 remember。',
  ].join('\n'),
  fix: [
    '记忆错了、过时了、或者有人不想被记着时用：forget 忘掉 / correct 改正（new_text 写对的说法）/ confirm 确认没错。target 照那条记忆原来的说法写一小段，一次一件。',
    'evidence_quote 照抄他刚发给你的消息里的一小段（读消息工具读到的也算）。谁能让你改什么由插件判断：当事人只管关于自己的事，别人的要求先交给主人看。',
  ].join('\n'),
};
/** 总字数上限：「只讲目的」不超过 D124 以前三个说明的总字数（806）；「详细指引」是原文另加经验那一行和 where 那一行（D154，各带换行）。 */
export const DESCRIPTION_BUDGET = 806;
export const DESCRIPTION_BUDGET_GUIDED = 806 + [...NOTE_LESSON_GUIDED].length + 1 + [...RECALL_WHERE_GUIDED].length + 1;
/** 写法 → 三个工具的说明（不认识的按 guided）。 */
export function descriptionsFor(style) {
  if (style === 'purpose') return DESCRIPTIONS_PURPOSE;
  return { ...DESCRIPTIONS, recall: [DESCRIPTIONS.recall, RECALL_WHERE_GUIDED].join('\n'), note: [DESCRIPTIONS.note, NOTE_LESSON_GUIDED].join('\n') };
}

/** 工具定义（defineTool 的输入）。style：核心的 context.usageStyle（D125），不给按 guided。 */
export function memoryToolSpecs(style = 'guided') {
  const DESC = descriptionsFor(style);
  const guided = style !== 'purpose';
  return {
    recall: { name: 'memory_recall', description: DESC.recall, timeoutMs: 15_000, parameters: {
      query: { type: 'string', required: true, description: '想回忆的事（自然的一句话）' },
      about: { type: 'string', description: '关于谁或什么（可选）' },
      time: { type: 'string', description: '大概的时间，例如「上周」「10/31」（可选）' },
      where: { type: 'string', description: '在哪儿，例如「这个群」「私聊」、某个群的名字（可选）' },
      include_history: { type: 'boolean', description: '连旧的说法和同类的其他几次一起想（可选）' },
    } },
    // 详细指引里 remember / todo 的参数说明照 D124 以前的原文（评审 M6）；evidence_quote 在模式里没法按 kind 写必填，说明里写明
    // （核心的契约照旧要它）。lesson 的三个参数是新加的
    note: { name: 'memory_note', description: DESC.note, timeoutMs: 15_000, parameters: {
      text: { type: 'string', required: true, description: guided ? '要记的事' : '要记的事；lesson 写以后怎么做' },
      kind: { type: 'string', enum: ['remember', 'todo', 'lesson'], description: `remember 记住（默认）/ todo 要做或要提醒的事 / lesson ${guided ? '你自己做事的办法' : '做事的经验'}` },
      about: { type: 'string', description: '关于谁（可选）' },
      when: { type: 'string', description: '相关的时间（可选）' },
      // 经验（D124）
      trap: { type: 'string', description: 'lesson：要避开的坑（可选）' },
      tool: { type: 'string', description: 'lesson：是哪个工具的经验（可选）' },
      here: { type: 'boolean', description: 'lesson：只在这里适用（可选）' },
      evidence_quote: { type: 'string', description: guided ? '对方刚发给你的消息里的原话（照抄一小段）；remember / todo 必填' : '他刚发给你的消息里的原话（照抄一小段）；remember / todo 必填，lesson 是主人教的就填' },
    } },
    fix: { name: 'memory_fix', description: DESC.fix, timeoutMs: 15_000, parameters: {
      op: { type: 'string', enum: ['forget', 'correct', 'confirm'], required: true, description: 'forget 忘掉 / correct 改正 / confirm 确认' },
      target: { type: 'string', required: true, description: '指的是哪件事' },
      new_text: { type: 'string', description: 'correct 时：正确的说法' },
      evidence_quote: { type: 'string', required: true, description: '对方刚发给你的消息里的原话（照抄一小段）' },
    } },
  };
}

const say = (s) => sanitizeForPrompt(s, { keepNewlines: true });

/**
 * @param {{getPm: () => any, claims: object, states: object, assembler: object, hostConfig: () => object, log: object,
 *          getDefineTool: () => ((d: object) => object)|null, recallNonces: Map<string, object>,
 *          blockedFor?: (adapterId: string) => boolean, infoOf?: typeof sessionInfoOf}} deps
 *   infoOf：读会话现在的 preset（D112：从下拉里换过预设的会话，会话头还是旧的），默认只看会话头
 */
export function createMemoryTools({ getPm, claims, states, assembler, hostConfig, log, getDefineTool, recallNonces, blockedFor = () => false, infoOf = sessionInfoOf, coreConfig = () => ({}) }) {
  /** 用法说明的写法（D125，核心配置 context.usageStyle；读不到按 guided）。 */
  const style = () => { try { return coreConfig()?.context?.usageStyle === 'purpose' ? 'purpose' : 'guided'; } catch { return 'guided'; } };
  /** agentId → disposer */
  const registered = new Map();
  const stats = { registered: 0, calls: { memory_recall: 0, memory_note: 0, memory_fix: 0 }, results: {} };
  const bump = (k) => { stats.results[k] = (stats.results[k] ?? 0) + 1; };

  const claimFor = (exec) => {
    const sid = agentId(exec?.agent);
    if (!sid) return null;
    return claims.get(sid) ?? claims.resolve(infoOf(exec.agent));
  };

  async function recall(args, exec) {
    stats.calls.memory_recall += 1;
    const pm = getPm();
    const claim = claimFor(exec);
    if (!pm || !claim) { bump('unavailable'); return TOOL_TEXT.unavailable; }
    const tc = hostConfig().tools ?? {};
    const st = states.get(claim.sessionId);
    // 她自己开启（空闲唤醒、定时提醒到点，D144）、还没读到新消息的一轮（D115）：按 idle 想，核心不把这里最后一个对她说话的人当成在问她的人
    const sit = { settingId: claim.settingId, sessionId: claim.sessionId, trigger: !st.trigger?.obsId && st.selfTurn ? 'idle' : 'message', homeSettingId: claim.settingId,
      ...(st.trigger?.obsId ? { focusObsId: st.trigger.obsId } : {}) };
    const q = String(args?.query ?? '').trim();
    if (!q) return '要想什么？query 写一句想回忆的事。';
    const deadline = tc.recallDeadlineMs ?? 8000;
    const opt = { mode: 'deliberate', query: clip(q, 200), deadlineMs: deadline, budgetChars: tc.recallBudgetChars ?? 1200,
      ...(args?.about ? { about: clip(String(args.about), 80) } : {}), ...(args?.time ? { time: clip(String(args.time), 40) } : {}),
      ...(args?.where ? { where: clip(String(args.where), 40) } : {}),
      ...(args?.include_history === true ? { includeHistory: true } : {}), ...(exec?.signal ? { signal: exec.signal } : {}) };
    const t0 = Date.now();
    const r = await settleWithin(pm.recall(sit, opt), deadline + 1000);
    // 等不到、报错的交回核心记下来（D117：重启也留得下，管理页的诊断看得到）
    if (!r.value) {
      try { pm.sessions?.recallOutcome?.(claim.sessionId, { outcome: r.timedOut ? 'timeout' : 'error', waitedMs: Date.now() - t0, trigger: 'tool', ...(r.error ? { code: errCode(r.error) } : {}) }); } catch { /* 只是计数 */ }
    }
    const given = Number(r.value?.alreadySent) > 0;
    if (!r.value?.items?.length) { bump(!r.value ? 'error' : given ? 'alreadyGiven' : 'nothing'); return given ? TOOL_TEXT.alreadyGiven : TOOL_TEXT.nothing; }
    // 回忆（D155）：结果里有回忆那一层时整个结果的上限放开，开头带「找了哪儿」那一行
    const rcTurn = r.value.items.some((it) => it?.layer === 'recollect');
    const { text, used } = renderToolResult(r.value.items, { style: style(), ...(rcTurn ? { maxChars: Math.max(1600, tc.recollectChars ?? 4600), note: String(r.value.recollect?.note ?? '') } : {}) });
    if (!used.length) { bump(given ? 'alreadyGiven' : 'nothing'); return given ? TOOL_TEXT.alreadyGiven : TOOL_TEXT.nothing; }
    // 场合的档只有 off / live：关着的场合核心回想就是空的；这里只防读不到档位（不给内容，也不记注入日志）
    if (assembler.modeOf(claim.settingId) !== 'live') { bump('withheld'); return TOOL_TEXT.withheld; }
    const nonce = randomId(12);
    try {
      pm.sessions.injected({ sessionId: claim.sessionId, nonce, layer: 'memory_recall', mode: 'live', chars: charLen(text),
        items: used.map((it) => ({ id: it.id, layer: it.layer, verdict: it.verdict, appraisalRef: it.appraisalRef, ...(typeof it.speak === 'string' ? { speak: it.speak } : {}),
          ...(typeof it.unit === 'string' ? { unit: it.unit } : {}), ...(typeof it.unitKey === 'string' ? { unitKey: it.unitKey } : {}),
          // 这一条自己的字数（D133：注入预算按条目的层记账）
          ...(typeof it.rendered === 'string' ? { chars: charLen(it.rendered) } : {}) })),
        ...(Number.isInteger(r.value.degradeLevel) ? { degradeLevel: r.value.degradeLevel } : {}),
        ...(rcTurn && r.value.recollect?.log && typeof r.value.recollect.log === 'object' ? { recollect: r.value.recollect.log } : {}) });
    } catch (e) {
      log.warn('tools.recall.rejected', { error: errCode(e) });
      bump('unappraised');
      return TOOL_TEXT.nothing;
    }
    if (exec?.callId) recallNonces.set(String(exec.callId), { sessionId: claim.sessionId, nonce });
    bump('recalled');
    return text;
  }

  /** note / fix 共用：拿到触发消息、一条消息一个操作、调核心、把结果说成人话。 */
  async function writeOp(kind, args, exec, build) {
    stats.calls[kind] += 1;
    const pm = getPm();
    const claim = claimFor(exec);
    if (!pm || !claim) { bump('unavailable'); return TOOL_TEXT.unavailable; }
    if (pm.readOnly) { bump('readOnly'); return TOOL_TEXT.readOnly; }
    const st = states.get(claim.sessionId);
    // 候选：这一轮她看到的、别人对她说的（新的在前），加上触发这一轮的那条。都做过操作了就不用再问核心；
    // 还有没做过的就全交过去（做过的排后面）：核心按原话在哪一条里挑，原话只在做过的那条里时报「一条消息只做一个操作」
    const seen = Array.isArray(st.seen) ? st.seen : [];
    const all = [...seen];
    if (st.trigger?.obsId && !all.some((x) => x.obsId === st.trigger.obsId)) all.push({ obsId: st.trigger.obsId, actor: st.trigger.actor ?? null, at: st.trigger.msgAt ?? null });
    if (!all.length) { bump('noTrigger'); return TOOL_TEXT.noTrigger; }
    if (all.every((x) => st.opsUsed.has(x.obsId))) { bump('oneOp'); return TOOL_TEXT.oneOp; }
    const cands = [...all.filter((x) => !st.opsUsed.has(x.obsId)), ...all.filter((x) => st.opsUsed.has(x.obsId))];
    // 说话人（契约要的形状）取第一条带着它的；授权不看它，核心只认库里那条感知自己的说话人
    const trig = { obsId: cands[0].obsId, obsIds: cands.slice(1).map((x) => x.obsId).slice(0, 8), actor: cands.find((x) => x.actor)?.actor ?? null };
    let res;
    try {
      res = await (kind === 'memory_note' ? pm.note(build(trig)) : pm.fix(build(trig)));
    } catch (e) {
      if (e?.code === 'CONTRACT') { bump('badArgs'); return kind === 'memory_note'
        ? '参数不对：text 和 evidence_quote 都要填，evidence_quote 照抄他刚发的消息里的一小段。'
        : '参数不对：op、target 和 evidence_quote 都要填（correct 还要写 new_text），evidence_quote 照抄他刚发的消息里的一小段。'; }
      if (e?.code === 'READ_ONLY' || e?.name === 'ReadOnlyError') { bump('readOnly'); return TOOL_TEXT.readOnly; }
      log.warn('tools.write.error', { tool: kind, error: errCode(e) });
      bump('error');
      return '这次没记下来，过一会儿再说。';
    }
    if (res?.status === 'done' || res?.status === 'review') st.opsUsed.add(typeof res.triggerObsId === 'string' && res.triggerObsId ? res.triggerObsId : trig.obsId);
    bump(res?.status ?? 'unknown');
    if (res?.status === 'done') return kind === 'memory_note' ? '记下了。' : '好，记忆已经按这个改了。';
    if (res?.status === 'review') return '先记下了，要等主人确认后才算数。可以照实告诉对方。';
    if (res?.status === 'rejected') bump(`rejected:${String(res.reason ?? '').slice(0, 40)}`);
    return say(rejectText(res?.reason, res?.candidates));
  }

  /**
   * memory_note kind=lesson（D124）：她自己的经验。不占「一条消息一个操作」、不要求这一轮有人对她说话；给了 evidence_quote 才拿这一轮看到的消息去核对原话。
   * 验证过没有由核心按证据定（主人的原话、宿主看到的「先没成、换了做法以后成了」），这里只把结果说成人话。
   */
  async function lesson(args, exec) {
    stats.calls.memory_note += 1;
    const pm = getPm();
    const claim = claimFor(exec);
    if (!pm || !claim || typeof pm.lessons?.note !== 'function') { bump('unavailable'); return TOOL_TEXT.unavailable; }
    if (pm.readOnly) { bump('readOnly'); return TOOL_TEXT.readOnly; }
    const text = String(args?.text ?? '').trim();
    if (!text) { bump('badArgs'); return '参数不对：text 写以后怎么做（一句话）。'; }
    const st = states.get(claim.sessionId);
    // 这一轮是谁开的头（没有 = 她自己开的头）和她这一轮看到的、别人对她说的：没引原话也交过去——核心据此认出「这是别人口授的」
    // （听来的，还没验证），试出来的经验也只在主人或她自己开的头时才算验证过（评审 H3）
    const trigId = st.trigger?.obsId ?? null;
    const seen = (Array.isArray(st.seen) ? st.seen.map((x) => x.obsId) : []).filter((x) => typeof x === 'string' && x && x !== trigId).slice(0, 8);
    const quote = typeof args?.evidence_quote === 'string' ? args.evidence_quote.trim() : '';
    if (quote && !trigId && !seen.length) { bump('noTrigger'); return TOOL_TEXT.noTrigger; }
    let res;
    try {
      res = await pm.lessons.note({
        sessionId: claim.sessionId, text: clip(text, 200), ...(args?.trap ? { trap: clip(String(args.trap), 80) } : {}), ...(args?.tool ? { tool: clip(String(args.tool), 80) } : {}),
        ...(args?.about ? { about: clip(String(args.about), 80) } : {}), ...(args?.here === true ? { here: true } : {}),
        ...(trigId ? { triggerObsId: trigId } : {}), ...(seen.length ? { triggerObsIds: seen } : {}), ...(quote ? { evidenceQuote: quote } : {}),
      });
    } catch (e) {
      if (e?.code === 'READ_ONLY' || e?.name === 'ReadOnlyError') { bump('readOnly'); return TOOL_TEXT.readOnly; }
      log.warn('tools.lesson.error', { error: errCode(e) });
      bump('error');
      return '这次没记下来，过一会儿再说。';
    }
    bump(`lesson:${res?.status ?? 'unknown'}`);
    if (res?.status === 'done') {
      const which = res.lessonStatus === 'verified' ? '验证过的' : '还没验证的';
      return res.merged ? `记下了，并进了你原来那条经验（现在是${which}）。` : `记下了（${which}经验）。`;
    }
    return say(rejectText(res?.reason));
  }

  const note = (args, exec) => (args?.kind === 'lesson' ? lesson(args, exec) : writeOp('memory_note', args, exec, (trig) => ({
    triggerObsId: trig.obsId, ...(trig.obsIds.length ? { triggerObsIds: trig.obsIds } : {}), ...(trig.actor ? { speaker: trig.actor } : {}), op: args?.kind === 'todo' ? 'todo' : 'remember',
    text: String(args?.text ?? ''), ...(args?.about ? { about: clip(String(args.about), 80) } : {}), ...(args?.when ? { when: clip(String(args.when), 40) } : {}),
    evidenceQuote: String(args?.evidence_quote ?? ''),
  })));
  const fix = (args, exec) => writeOp('memory_fix', args, exec, (trig) => ({
    triggerObsId: trig.obsId, ...(trig.obsIds.length ? { triggerObsIds: trig.obsIds } : {}), ...(trig.actor ? { speaker: trig.actor } : {}), op: ['forget', 'correct', 'confirm'].includes(args?.op) ? args.op : 'confirm',
    target: String(args?.target ?? ''), ...(args?.new_text ? { newText: String(args.new_text) } : {}), evidenceQuote: String(args?.evidence_quote ?? ''),
  }));

  /** 包一层：工具体出错只给她一句人话，不让整轮失败。 */
  const safe = (fn) => async (args, exec) => { try { return await fn(args, exec); } catch (e) { log.warn('tools.error', { error: errCode(e) }); return '记忆工具这会儿出了点问题，照常聊就好。'; } };

  function definitions() {
    const defineTool = getDefineTool();
    if (!defineTool) return null;
    const specs = memoryToolSpecs(style());
    return [
      defineTool({ ...specs.recall, output: TEXT_OUTPUT, isConcurrencySafe: () => true, execute: safe(recall) }),
      defineTool({ ...specs.note, output: TEXT_OUTPUT, isConcurrencySafe: () => false, execute: safe(note) }),
      defineTool({ ...specs.fix, output: TEXT_OUTPUT, isConcurrencySafe: () => false, execute: safe(fix) }),
    ];
  }

  /**
   * 这个 agent 要不要有记忆工具（创建时还不知道场合，B2：按 preset 和会话特征判断；认领成功时再补）。
   * 自检说这个适配器的会话现在用不了（blockedFor，例：QQ 白名单补丁没打，桥接的守卫会拒绝）就不给，免得她反复撞拒绝。
   */
  function eligible(agent, { claimed = false } = {}) {
    if (hostConfig().features?.tools === false || hostConfig().enabled === false) return false;
    const info = infoOf(agent);
    if (!info.id || info.origin === 'subagent' || (info.delegationDepth ?? 0) > 0) return false;
    const known = claims.get(info.id);
    if (known && blockedFor(known.adapterId)) return false;
    if (claimed) return true;
    let matched = null;
    for (const b of claims.activeBindings()) { let sig = null; try { sig = b.sessionSignature?.(); } catch { sig = null; } if (matchesSignature(info, sig)) { matched = b.adapterId; break; } }
    if (matched && blockedFor(matched)) return false;
    const presets = hostConfig().tools?.presets ?? [];
    if (presets.includes('*') || (info.preset && presets.includes(info.preset))) return true;
    return !!matched;
  }

  function registerOn(agent, opt = {}) {
    const id = agentId(agent);
    if (!id || registered.has(id) || !eligible(agent, opt)) return false;
    const reg = agent?.ctx?.tools?.register;
    if (typeof reg !== 'function') return false;
    const defs = definitions();
    if (!defs) return false;
    const disposers = [];
    try { for (const d of defs) disposers.push(agent.ctx.tools.register(d)); } catch (e) {
      for (const x of disposers) { try { x?.(); } catch { /* 尽力 */ } }
      log.warn('tools.register', { error: errCode(e) });
      return false;
    }
    registered.set(id, () => { for (const x of disposers) { try { x?.(); } catch { /* 尽力 */ } } });
    stats.registered += 1;
    return true;
  }

  return {
    registerOn,
    eligible,
    unregister(agent) { const id = agentId(agent); const d = registered.get(id); if (d) { registered.delete(id); d(); } },
    disposeAll() { for (const d of registered.values()) d(); registered.clear(); },
    has: (id) => registered.has(id),
    handlers: { recall: safe(recall), note: safe(note), fix: safe(fix) },
    status: () => ({ ...stats, live: registered.size, calls: { ...stats.calls }, results: { ...stats.results } }),
  };
}
