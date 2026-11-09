// 防抖读文件（§11.1、H2）：安静 300 ms 再读、刷屏最长 2 秒也读、轮询 5 秒兜底、临时文件不理、读不动不记指纹、监视器坏了重新挂。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createDebouncedWatch } from '../../src/adapters/watch.js';
import { ioOf } from '../../src/adapters/util.js';
import { fakeTimers, fakeFs } from './helpers.js';

function setup() {
  const timers = fakeTimers();
  const fs = fakeFs(timers);
  const dir = path.join('X:', 'bridge', 'state');
  const file = path.join(dir, 'social-v2.json');
  const io = ioOf({ readFile: fs.readFile, stat: fs.stat, watch: fs.watch, timers, now: timers.now });
  const results = [];
  let answer = 'ok';
  const w = createDebouncedWatch({
    dir, name: 'social-v2.json', file, io,
    onChange: (stamp) => { results.push({ stamp, text: fs.files.get(file)?.text }); return typeof answer === 'function' ? answer() : answer; },
  });
  return { timers, fs, dir, file, w, results, setAnswer: (a) => { answer = a; } };
}

test('防抖：一次写入（临时文件 + rename 两个事件）等安静 300 ms 只读一次', () => {
  const { timers, fs, file, w, results } = setup();
  w.start();
  fs.write(file, '{"a":1}');
  timers.advance(299);
  assert.equal(results.length, 0, '还没安静够 300 ms');
  timers.advance(1);
  assert.equal(results.length, 1);
  assert.equal(results[0].text, '{"a":1}');
  assert.ok(w.stats().ignored >= 1, '临时文件的事件被忽略');
  w.stop();
});

test('防抖：连续刷屏（每 100 ms 一次）最长 2 秒也读一次；2 秒里最多读 1–2 次', () => {
  const { timers, fs, file, w, results } = setup();
  w.start();
  for (let i = 0; i < 40; i++) { fs.write(file, `{"n":${i}}`); timers.advance(100); }   // 4 秒、40 次写
  const readsDuringBurst = results.length;
  assert.ok(readsDuringBurst >= 2 && readsDuringBurst <= 3, `4 秒刷屏里读了 ${readsDuringBurst} 次`);
  timers.advance(300);
  assert.equal(results.at(-1).text, '{"n":39}', '刷屏停下后读到最后一份');
  w.stop();
});

test('轮询兜底：没有文件事件也能在 5 秒内读到变化；没变就不读', () => {
  const { timers, fs, file, w, results } = setup();
  w.start();
  fs.write(file, '{"x":1}', { events: false });
  timers.advance(4999);
  assert.equal(results.length, 0);
  timers.advance(1);
  assert.equal(results.length, 1, '轮询比较大小和修改时间，变了才读');
  timers.advance(20_000);
  assert.equal(results.length, 1, '文件没变，轮询不读');
  w.stop();
});

test('读不动（占用）不记指纹：下一次轮询再试；内容坏了记下指纹，等文件变了再读', () => {
  const { timers, fs, file, w, results, setAnswer } = setup();
  w.start();
  setAnswer('busy');
  fs.write(file, '{"x":1}');
  timers.advance(300);
  assert.equal(results.length, 1);
  setAnswer('ok');
  timers.advance(5000);
  assert.equal(results.length, 2, '占用的那次没记指纹，轮询时重读');
  setAnswer('parse');
  fs.write(file, '{"x":');
  timers.advance(300);
  assert.equal(results.length, 3);
  timers.advance(15_000);
  assert.equal(results.length, 3, '坏文件不反复读');
  setAnswer('ok');
  fs.write(file, '{"x":2}');
  timers.advance(300);
  assert.equal(results.length, 4, '文件变了再读');
  w.stop();
});

test('监视器坏了（目录被删、句柄失效）在轮询时重新挂上；stop 之后什么都不读', () => {
  const { timers, fs, dir, file, w, results } = setup();
  w.start();
  assert.equal(fs.watcherCount(dir), 1);
  fs.killWatchers(dir);
  assert.equal(fs.watcherCount(dir), 0, '坏掉的监视器摘掉了');
  fs.write(file, '{"y":1}');
  timers.advance(5000);
  assert.equal(results.length, 1, '轮询兜底读到');
  assert.equal(fs.watcherCount(dir), 1, '轮询时重新挂上');
  assert.equal(w.stats().rearmed, 1);
  fs.write(file, '{"y":1.5}');
  timers.advance(300);
  assert.equal(results.length, 2, '重新挂上的监视器照常触发');
  w.stop();
  fs.write(file, '{"y":2}');
  timers.advance(10_000);
  assert.equal(results.length, 2, '停了就不读');
  assert.equal(timers.pending(), 0, '定时器都清掉了');
});

test('文件被删掉：报一次 missing；重新出现（轮换）再读', () => {
  const { timers, fs, file, w, results } = setup();
  w.start();
  fs.write(file, '{"z":1}');
  timers.advance(300);
  fs.remove(file);
  timers.advance(300);
  assert.equal(results.length, 2);
  assert.equal(results[1].stamp, null);
  fs.write(file, '{"z":2}');
  timers.advance(300);
  assert.equal(results.length, 3);
  assert.equal(results[2].text, '{"z":2}');
  w.stop();
});
