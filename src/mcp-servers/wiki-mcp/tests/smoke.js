/**
 * === 代码 Wiki MCP 烟雾测试 (tests/smoke.js) ===
 *
 * 通过 spawn 子进程 + JSON-RPC over stdio 模拟 MCP 客户端，
 * 验证 17 个工具的注册与核心功能。
 *
 * 隔离策略：测试前 snapshotData（复制 data/source/ 全部 json 到临时目录），
 * 测试后 restoreData（还原）。写操作不影响真实数据。
 *
 * 运行：node tests/smoke.js
 * （vitest 不会拾取此文件——它在 src 下且是 .js，不符合 vitest include 模式）
 */

'use strict';

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'data', 'source');
const SERVER_PATH = path.join(ROOT, 'wiki_server.js');

const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ${PASS} ${msg}`);
  } else {
    failed++;
    console.log(`  ${FAIL} ${msg}`);
  }
}

function assertEqual(actual, expected, msg) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ${PASS} ${msg}`);
  } else {
    failed++;
    console.log(`  ${FAIL} ${msg}`);
    console.log(`         expected: ${JSON.stringify(expected)}`);
    console.log(`         actual:   ${JSON.stringify(actual)}`);
  }
}

// ==================== MCP 客户端 ====================

class MCPClient {
  constructor() {
    this.proc = null;
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.proc = spawn('node', [SERVER_PATH], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: ROOT,
      });
      this.proc.stdout.setEncoding('utf-8');
      this.proc.stdout.on('data', (chunk) => {
        this.buffer += chunk;
        let idx;
        while ((idx = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, idx).trim();
          this.buffer = this.buffer.slice(idx + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && this.pending.has(msg.id)) {
              const { resolve: res } = this.pending.get(msg.id);
              this.pending.delete(msg.id);
              res(msg);
            }
          } catch { /* 忽略非 JSON 行 */ }
        }
      });
      this.proc.stderr.on('data', () => { /* 吞掉 stderr 日志 */ });
      this.proc.on('error', reject);
      setTimeout(resolve, 300); // 等服务器启动
    });
  }

  send(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      this.proc.stdin.write(msg + '\n');
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`超时: ${method}`));
        }
      }, 10000);
    });
  }

  initialize() {
    return this.send('initialize', {});
  }

  listTools() {
    return this.send('tools/list', {});
  }

  callTool(name, args) {
    return this.send('tools/call', { name, arguments: args });
  }

  close() {
    if (this.proc) {
      this.proc.stdin.end();
      this.proc.kill();
    }
  }
}

// ==================== 数据隔离 ====================

const SNAP_DIR = path.join(ROOT, 'data', '.snap-test');

function snapshotData() {
  if (fs.existsSync(SNAP_DIR)) fs.rmSync(SNAP_DIR, { recursive: true });
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  if (fs.existsSync(SOURCE_DIR)) {
    for (const f of fs.readdirSync(SOURCE_DIR)) {
      fs.copyFileSync(path.join(SOURCE_DIR, f), path.join(SNAP_DIR, f));
    }
  }
}

function restoreData() {
  if (fs.existsSync(SOURCE_DIR)) {
    for (const f of fs.readdirSync(SOURCE_DIR)) {
      fs.unlinkSync(path.join(SOURCE_DIR, f));
    }
  }
  if (fs.existsSync(SNAP_DIR)) {
    for (const f of fs.readdirSync(SNAP_DIR)) {
      fs.copyFileSync(path.join(SNAP_DIR, f), path.join(SOURCE_DIR, f));
    }
    fs.rmSync(SNAP_DIR, { recursive: true });
  }
}

// ==================== 测试用例 ====================

async function runTests() {
  snapshotData();
  const client = new MCPClient();
  try {
    await client.start();

    // --- 1. initialize ---
    console.log('\n--- 1. initialize ---');
    const init = await client.initialize();
    assert(!!init.result, 'initialize 返回 result');
    assert(init.result?.serverInfo?.name === 'wiki-mcp', 'serverInfo.name = wiki-mcp');
    assert(!!init.result?.capabilities?.tools, 'capabilities.tools 存在');

    // --- 2. tools/list 有 17 个工具 ---
    console.log('\n--- 2. tools/list ---');
    const tl = await client.listTools();
    const tools = tl.result?.tools || [];
    assertEqual(tools.length, 17, `tools/list 返回 17 个工具（实际 ${tools.length}）`);
    const names = tools.map(t => t.name);
    const expected17 = [
      'search_cards', 'get_card', 'get_relations', 'get_card_tree', 'get_source',
      'list_cards', 'get_phase_context', 'list_phases', 'check_doc_updates', 'read_raw_file',
      'diff_docs',
      'add_card', 'update_card', 'remove_card', 'update_relations',
      'scan_codebase', 'render_md',
    ];
    for (const n of expected17) {
      assert(names.includes(n), `工具 ${n} 存在`);
    }

    // --- 3. add_card ---
    console.log('\n--- 3. add_card ---');
    const addRes = await client.callTool('add_card', {
      card: {
        id: 'mod-test-fixture',
        type: 'module',
        title: 'TestFixtureModule',
        summary: 'A test fixture module',
        content: 'This is a test fixture module for smoke testing.',
        source: 'tests/fixture.ts',
        tags: ['test', 'phase:test-1'],
        level: '重要',
      },
    });
    assert(!addRes.error, 'add_card 无 error');
    const addResult = JSON.parse(addRes.result?.content?.[0]?.text || '{}');
    assert(addResult.success === true, 'add_card success=true');

    // --- 4. search_cards ---
    console.log('\n--- 4. search_cards ---');
    const searchRes = await client.callTool('search_cards', { query: 'TestFixture' });
    const searchResult = JSON.parse(searchRes.result?.content?.[0]?.text || '{}');
    assert(searchResult.count >= 1, 'search_cards 命中刚添加的卡片');
    assert(
      searchResult.results?.some(c => c.id === 'mod-test-fixture'),
      'search_cards 结果含 mod-test-fixture',
    );

    // --- 5. get_card ---
    console.log('\n--- 5. get_card ---');
    const getRes = await client.callTool('get_card', { card_id: 'mod-test-fixture' });
    const card = JSON.parse(getRes.result?.content?.[0]?.text || '{}');
    assertEqual(card.id, 'mod-test-fixture', 'get_card id 正确');
    assertEqual(card.type, 'module', 'get_card type 正确');

    // --- 6. update_card ---
    console.log('\n--- 6. update_card ---');
    const updRes = await client.callTool('update_card', {
      card_id: 'mod-test-fixture',
      patch: { summary: 'Updated summary' },
    });
    const updResult = JSON.parse(updRes.result?.content?.[0]?.text || '{}');
    assert(updResult.success === true, 'update_card success=true');
    assertEqual(updResult.card?.summary, 'Updated summary', 'update_card summary 已更新');

    // --- 7. add second card + update_relations ---
    console.log('\n--- 7. update_relations ---');
    await client.callTool('add_card', {
      card: {
        id: 'fn-test-helper',
        type: 'function',
        title: 'testHelper',
        summary: 'A helper function',
        content: 'Helper content',
        source: 'tests/helper.ts',
      },
    });
    const relRes = await client.callTool('update_relations', {
      relations: [{
        id: 'rel-test-001',
        from: 'fn-test-helper',
        to: 'mod-test-fixture',
        type: 'part_of',
        direction: 'directed',
        label: '属于',
      }],
    });
    const relResult = JSON.parse(relRes.result?.content?.[0]?.text || '{}');
    assert(relResult.success === true, 'update_relations success=true');

    // --- 8. get_relations ---
    console.log('\n--- 8. get_relations ---');
    const relsRes = await client.callTool('get_relations', { card_id: 'fn-test-helper' });
    const rels = JSON.parse(relsRes.result?.content?.[0]?.text || '{}');
    assert(rels.relations?.length >= 1, 'get_relations 至少 1 条关系');
    assert(
      rels.relations?.some(r => r.to === 'mod-test-fixture'),
      'get_relations 含指向 mod-test-fixture 的关系',
    );

    // --- 9. get_card_tree ---
    console.log('\n--- 9. get_card_tree ---');
    const treeRes = await client.callTool('get_card_tree', { card_id: 'fn-test-helper' });
    const tree = JSON.parse(treeRes.result?.content?.[0]?.text || '{}');
    assert(!!tree.card, 'get_card_tree 返回 card');
    assert(
      tree.parents?.some(p => p.id === 'mod-test-fixture'),
      'get_card_tree parents 含 mod-test-fixture',
    );

    // --- 10. get_source ---
    console.log('\n--- 10. get_source ---');
    const srcRes = await client.callTool('get_source', { card_id: 'mod-test-fixture' });
    const src = JSON.parse(srcRes.result?.content?.[0]?.text || '{}');
    assertEqual(src.source, 'tests/fixture.ts', 'get_source source 正确');

    // --- 11. list_cards ---
    console.log('\n--- 11. list_cards ---');
    const listRes = await client.callTool('list_cards', {});
    const list = JSON.parse(listRes.result?.content?.[0]?.text || '{}');
    assert(list.count >= 2, `list_cards 至少 2 张（实际 ${list.count}）`);

    // --- 12. list_phases ---
    console.log('\n--- 12. list_phases ---');
    const phRes = await client.callTool('list_phases', {});
    const ph = JSON.parse(phRes.result?.content?.[0]?.text || '{}');
    // phases.json 初始为空数组，count 应为 0
    assertEqual(ph.count, 0, 'list_phases 初始 0 个阶段');

    // --- 13. check_doc_updates ---
    console.log('\n--- 13. check_doc_updates ---');
    const chkRes = await client.callTool('check_doc_updates', {});
    const chk = JSON.parse(chkRes.result?.content?.[0]?.text || '{}');
    assert(typeof chk.summary === 'string', 'check_doc_updates 返回 summary 字符串');

    // --- 14. diff_docs (纯文本模式) ---
    console.log('\n--- 14. diff_docs ---');
    const diffRes = await client.callTool('diff_docs', {
      old_content: 'line1\nline2\nline3',
      new_content: 'line1\nline2-modified\nline3\nline4',
    });
    const diff = JSON.parse(diffRes.result?.content?.[0]?.text || '{}');
    assert(diff.stats?.added >= 1, `diff_docs added >= 1（实际 ${diff.stats?.added}）`);
    assert(diff.stats?.removed >= 1, `diff_docs removed >= 1（实际 ${diff.stats?.removed}）`);

    // --- 15. scan_codebase ---
    console.log('\n--- 15. scan_codebase ---');
    // 扫描 wiki-mcp 自身的 lib/ 目录
    const scanRes = await client.callTool('scan_codebase', { repo_path: 'lib' });
    const scan = JSON.parse(scanRes.result?.content?.[0]?.text || '{}');
    assert(scan.files_scanned > 0, `scan_codebase 扫描到文件（${scan.files_scanned}）`);
    assert(scan.cards_suggested > 0, `scan_codebase 产出建议（${scan.cards_suggested}）`);
    assert(
      scan.suggestions?.some(s => s.type === 'function' || s.type === 'module'),
      'scan_codebase suggestions 含 function 或 module 类型',
    );

    // --- 16. render_md (snapshot) ---
    console.log('\n--- 16. render_md (snapshot) ---');
    const rendRes = await client.callTool('render_md', { mode: 'snapshot' });
    const rend = JSON.parse(rendRes.result?.content?.[0]?.text || '{}');
    assert(rend.success === true, 'render_md snapshot success=true');
    assert(rend.file?.endsWith('knowledge-snapshot.md'), 'render_md 文件名正确');
    assert(fs.existsSync(rend.file), 'render_md 文件已落盘');

    // --- 17. render_md (card) ---
    console.log('\n--- 17. render_md (card) ---');
    const rendCardRes = await client.callTool('render_md', {
      mode: 'card',
      card_id: 'mod-test-fixture',
    });
    const rendCard = JSON.parse(rendCardRes.result?.content?.[0]?.text || '{}');
    assert(rendCard.success === true, 'render_md card success=true');
    assert(fs.existsSync(rendCard.file), 'render_md card 文件已落盘');

    // --- 18. remove_card ---
    console.log('\n--- 18. remove_card ---');
    const rmRes = await client.callTool('remove_card', { card_id: 'mod-test-fixture' });
    const rm = JSON.parse(rmRes.result?.content?.[0]?.text || '{}');
    assert(rm.success === true, 'remove_card success=true');
    // 验证已删除
    const getAfter = await client.callTool('get_card', { card_id: 'mod-test-fixture' });
    assert(!!getAfter.error, 'remove_card 后 get_card 返回 error');

  } catch (e) {
    console.error('\n测试执行异常:', e);
    failed++;
  } finally {
    client.close();
  }

  // --- 汇总 ---
  console.log('\n=========================================');
  console.log(`  结果: ${passed} passed, ${failed} failed`);
  console.log('=========================================');
  if (failed > 0) process.exitCode = 1;
}

// ==================== 清理导出文件（测试前） ====================

function cleanExports() {
  const exportsDir = path.join(ROOT, 'visualizer', 'exports');
  if (fs.existsSync(exportsDir)) {
    for (const f of fs.readdirSync(exportsDir)) {
      if (f.endsWith('.md')) {
        fs.unlinkSync(path.join(exportsDir, f));
      }
    }
  }
}

// ==================== 主入口 ====================

cleanExports();
runTests().then(() => {
  restoreData();
  console.log('\n数据已还原，测试结束。');
}).catch((e) => {
  console.error('致命错误:', e);
  restoreData();
  process.exit(1);
});
