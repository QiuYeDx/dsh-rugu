import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBinding, assertBinding, TOOL_CLASSES } from '../src/binding/index.js';
import * as plugin from '../src/index.js';
import { ADAPTER_ID as QQ, createQqBridgeAdapter } from '../src/adapters/qq-bridge.js';
import { ADAPTER_ID as WEB, createWebAdapter } from '../src/adapters/web.js';
import { isAdapterId } from 'rugu-core/contract';

const binding = () => ({
  adapterId: 'zz',
  claimSession: () => null,
  sessionSignature: () => ({ presets: ['zz-chat'] }),
  tools: [
    { tool: 'zz_send', class: 'speak', resolve: () => null },
    { tool: 'zz_read', class: 'read', readerKind: 'content' },
    { tool: 'zz_post', class: 'speak', appraisedBy: 'adapter' },
    { tool: 'zz_ping', class: 'none' },
  ],
});

test('DSH 绑定：合格的通过；未分类、重复、说话类没有 resolve 都报', () => {
  assert.deepEqual(validateBinding(binding()), { ok: true, errors: [] });
  const b = binding();
  b.tools.push({ tool: 'zz_new' });
  b.tools.push({ tool: 'zz_send', class: 'speak', resolve: () => null });
  b.tools.push({ tool: 'zz_rule', class: 'standing' });
  b.tools.push({ tool: 'zz_x', class: 'none', readerKind: 'content' });
  const paths = validateBinding(b).errors.map((e) => e.path);
  assert.ok(paths.includes('tools[4].class'), '未分类的工具让契约测试失败（§11.1）');
  assert.ok(paths.includes('tools[5].tool'));
  assert.ok(paths.includes('tools[6].resolve'));
  assert.ok(paths.includes('tools[7].readerKind'));
  assert.throws(() => assertBinding({ adapterId: '' }), (e) => e.code === 'CONTRACT');
  assert.deepEqual(TOOL_CLASSES, ['speak', 'defer', 'standing', 'persist-foreign', 'read', 'none']);
});

test('插件形状：Cordis 行和服务名、inject；内置适配器缺必需的配置时报带 code 的错（宿主据此在总览标「没配置」）', () => {
  assert.equal(plugin.name, 'dsh-rugu');
  assert.equal(plugin.SERVICE_NAME, 'personaMemory');
  assert.deepEqual(plugin.inject, ['tools', 'connection']);
  assert.equal(typeof plugin.apply, 'function');
  assert.doesNotThrow(() => plugin.apply({}, {}), '没有宿主上下文：插件不可用，但不抛错');
  assert.equal(typeof plugin.apply({}, {}), 'function', '照样返回卸载函数');
  assert.ok(isAdapterId(QQ) && isAdapterId(WEB));
  assert.throws(() => createQqBridgeAdapter({}), (e) => e instanceof TypeError && e.code === 'PM_QQ_NO_BRIDGE_DIR');
  assert.throws(() => createWebAdapter({}), (e) => e instanceof TypeError && e.code === 'PM_ADAPTER_SALT', '没有盐也没有身份密钥：不悄悄编一个');
});
