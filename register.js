#!/usr/bin/env node
/**
 * Registers this server with Claude Code for every project on this machine:
 *
 *   node register.js            # claude mcp add whatsapp --scope user -- node <this folder>/server.js
 *   node register.js --remove   # claude mcp remove whatsapp --scope user
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const remove = process.argv.includes('--remove');
const args = remove
  ? ['mcp', 'remove', 'whatsapp', '--scope', 'user']
  : ['mcp', 'add', 'whatsapp', '--scope', 'user', '--', process.execPath, join(here, 'server.js')];

const r = spawnSync('claude', args, { stdio: 'inherit', shell: process.platform === 'win32' });
if (r.error || r.status !== 0) {
  console.error(`\nCould not run "claude ${args.join(' ')}".`);
  console.error('Is Claude Code installed and on your PATH? https://claude.com/claude-code');
  process.exit(1);
}
if (!remove) {
  console.log('\nRegistered. Open any Claude Code session and ask it to run wa_status.');
}
