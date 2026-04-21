#!/usr/bin/env node
/**
 * buddy-chat.mjs — Buddy Bot Chat CLI
 *
 * Simple CLI for sending and receiving XMTP messages as a buddy bot.
 * Used for testing, debugging, and as the daemon entry point for per-agent services.
 *
 * Usage:
 *   node scripts/buddy-chat.mjs --agent-id alice --send "Hey!" --to 0xAbC...
 *   node scripts/buddy-chat.mjs --agent-id alice --list
 *   node scripts/buddy-chat.mjs --agent-id alice --history --to 0xAbC...
 *   node scripts/buddy-chat.mjs --agent-id alice --daemon
 *   node scripts/buddy-chat.mjs --help
 *
 * Dependencies: Node built-ins + setup-identity.mjs (local) + viem (for address validation).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

import { hasIdentity, loadIdentity, isValidAgentId, atomicWrite, readJsonSafe } from './setup-identity.mjs';

// ── Constants ────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

const HOME = homedir();
const EVERCLAW_DIR = process.env.EVERCLAW_DIR || join(HOME, '.everclaw');
const CHAT_STORE_DIR = join(EVERCLAW_DIR, 'buddy-chats');

const VERSION = '1.0.0';
const MAX_MESSAGE_LENGTH = 4096;
const MAX_HISTORY_DEFAULT = 50;

// ── Validation ───────────────────────────────────────────────────

/**
 * Validate an Ethereum address (0x + 40 hex chars).
 * @param {string} addr
 * @returns {boolean}
 */
function isValidAddress(addr) {
  return typeof addr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(addr);
}

/**
 * Validate a message is safe to send.
 * @param {string} msg
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateMessage(msg) {
  if (!msg || typeof msg !== 'string') {
    return { valid: false, reason: 'Message is empty.' };
  }
  if (msg.length > MAX_MESSAGE_LENGTH) {
    return { valid: false, reason: `Message exceeds max length (${MAX_MESSAGE_LENGTH} chars).` };
  }
  // Block control characters (including \r, except newline and tab)
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\r]/.test(msg)) {
    return { valid: false, reason: 'Message contains control characters.' };
  }
  // Block injection patterns
  if (/\{\{.*\}\}|\$\{.*\}|<script|javascript:|`/i.test(msg)) {
    return { valid: false, reason: 'Message contains disallowed patterns.' };
  }
  return { valid: true };
}

// ── Atomic File Operations ───────────────────────────────────────



// ── Chat Store ───────────────────────────────────────────────────

/**
 * Get the conversation directory for an agent + peer pair.
 * @param {string} agentId
 * @param {string} peerAddress
 * @param {string} [baseDir]
 * @returns {string}
 */
function getConversationDir(agentId, peerAddress, baseDir = CHAT_STORE_DIR) {
  const peerHash = createHash('sha256').update(peerAddress.toLowerCase()).digest('hex').slice(0, 16);
  return join(baseDir, agentId, peerHash);
}

/**
 * Get the conversation index file path for an agent.
 * @param {string} agentId
 * @param {string} [baseDir]
 * @returns {string}
 */
function getConversationIndexPath(agentId, baseDir = CHAT_STORE_DIR) {
  return join(baseDir, agentId, 'conversations.json');
}

/**
 * Load the conversation index for an agent.
 * @param {string} agentId
 * @param {string} [baseDir]
 * @returns {{ conversations: object[] }}
 */
export function loadConversationIndex(agentId, baseDir = CHAT_STORE_DIR) {
  const data = readJsonSafe(getConversationIndexPath(agentId, baseDir));
  if (data && Array.isArray(data.conversations)) return data;
  return { conversations: [] };
}

/**
 * Save the conversation index.
 * @param {string} agentId
 * @param {object} index
 * @param {string} [baseDir]
 */
function saveConversationIndex(agentId, index, baseDir = CHAT_STORE_DIR) {
  atomicWrite(getConversationIndexPath(agentId, baseDir), JSON.stringify(index, null, 2));
}

/**
 * Load messages for a conversation.
 * @param {string} agentId
 * @param {string} peerAddress
 * @param {string} [baseDir]
 * @returns {object[]}
 */
export function loadMessages(agentId, peerAddress, baseDir = CHAT_STORE_DIR, limit = 1000) {
  const convDir = getConversationDir(agentId, peerAddress, baseDir);
  const messagesFile = join(convDir, 'messages.jsonl');

  if (!existsSync(messagesFile)) return [];

  const lines = readFileSync(messagesFile, 'utf8').trim().split('\n').filter(Boolean);
  // Only parse last N lines to prevent unbounded memory use
  const tail = lines.slice(-limit);
  const messages = [];
  for (const line of tail) {
    try {
      messages.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }
  return messages;
}

/**
 * Append a message to a conversation.
 * @param {string} agentId
 * @param {string} peerAddress
 * @param {object} message — { direction: 'sent'|'received', content, timestamp }
 * @param {string} [baseDir]
 */
export function appendMessage(agentId, peerAddress, message, baseDir = CHAT_STORE_DIR) {
  const convDir = getConversationDir(agentId, peerAddress, baseDir);
  mkdirSync(convDir, { recursive: true, mode: 0o700 });

  const messagesFile = join(convDir, 'messages.jsonl');
  const entry = {
    id: randomUUID(),
    direction: message.direction,
    content: message.content,
    timestamp: message.timestamp || new Date().toISOString(),
    peerAddress: peerAddress.toLowerCase()
  };

  // Atomic append: read prior content, append, write back
  let prior = '';
  try { prior = readFileSync(messagesFile, 'utf8'); } catch { /* new file */ }
  const updated = prior + JSON.stringify(entry) + '\n';
  const tmp = messagesFile + '.tmp.' + randomUUID().slice(0, 8);
  writeFileSync(tmp, updated, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, messagesFile);

  // Update conversation index
  const index = loadConversationIndex(agentId, baseDir);
  const existing = index.conversations.find(c => c.peerAddress.toLowerCase() === peerAddress.toLowerCase());
  if (existing) {
    existing.lastMessageAt = entry.timestamp;
    existing.messageCount = (existing.messageCount || 0) + 1;
    existing.lastPreview = entry.content.slice(0, 80);
  } else {
    index.conversations.push({
      peerAddress: peerAddress.toLowerCase(),
      startedAt: entry.timestamp,
      lastMessageAt: entry.timestamp,
      messageCount: 1,
      lastPreview: entry.content.slice(0, 80)
    });
  }
  saveConversationIndex(agentId, index, baseDir);

  return entry;
}

// ── XMTP Send (Stub) ────────────────────────────────────────────

/**
 * Send a message via XMTP.
 * Currently stores locally. Full XMTP send requires the XMTP SDK daemon.
 *
 * @param {string} agentId — Sender agent ID
 * @param {string} toAddress — Recipient XMTP address
 * @param {string} content — Message content
 * @param {object} [opts]
 * @returns {Promise<object>} Send result
 */
export async function sendMessage(agentId, toAddress, content, opts = {}) {
  const baseDir = opts.baseDir || EVERCLAW_DIR;
  const chatBaseDir = opts.chatBaseDir || CHAT_STORE_DIR;

  // Validate agent has identity
  if (!hasIdentity(agentId, baseDir)) {
    throw new Error(`Agent "${agentId}" has no XMTP identity. Run setup-identity first.`);
  }

  // Validate recipient
  if (!isValidAddress(toAddress)) {
    throw new Error(`Invalid recipient address: "${toAddress}"`);
  }

  // Validate message
  const validation = validateMessage(content);
  if (!validation.valid) {
    throw new Error(`Invalid message: ${validation.reason}`);
  }

  // Load sender identity for address
  const identity = loadIdentity(agentId, baseDir);

  // Store message locally
  const entry = appendMessage(agentId, toAddress, {
    direction: 'sent',
    content
  }, chatBaseDir);

  // TODO: Actual XMTP send via SDK when daemon is running
  // For now, messages are stored locally and will be synced when
  // the XMTP daemon connects to the network.

  return {
    id: entry.id,
    from: identity.address,
    to: toAddress,
    content,
    timestamp: entry.timestamp,
    delivered: false,  // Will be true once XMTP daemon confirms
    stored: true
  };
}

// ── Daemon Mode ──────────────────────────────────────────────────

/**
 * Run in daemon mode — listens for incoming messages and processes them.
 * This is the entry point for per-agent launchd/systemd services.
 *
 * @param {string} agentId
 * @param {object} [opts]
 */
async function runDaemon(agentId, opts = {}) {
  const baseDir = opts.baseDir || EVERCLAW_DIR;

  if (!hasIdentity(agentId, baseDir)) {
    console.error(`❌ Agent "${agentId}" has no XMTP identity. Run setup-identity first.`);
    process.exit(1);
  }

  const identity = loadIdentity(agentId, baseDir);
  console.log(`🤝 Buddy Bot daemon started for "${agentId}"`);
  console.log(`   Address: ${identity.address}`);
  console.log(`   Network: ${identity.network}`);
  console.log(`   ⚠️  XMTP message polling not yet implemented in this version.`);
  console.log(`   Actual message routing happens via OpenClaw workspace agents.`);
  console.log(`   This daemon provides heartbeat monitoring and local chat store.`);
  console.log('');

  // Heartbeat loop — check for coordination messages periodically
  const HEARTBEAT_MS = opts.heartbeatMs || 30000; // 30 seconds

  const heartbeat = async () => {
    try {
      // TODO: Poll XMTP network for new messages
      // For now, just log a heartbeat
      const now = new Date().toISOString();
      console.log(`[${now}] heartbeat — agent=${agentId} status=listening`);
    } catch (err) {
      console.error(`[heartbeat error] ${err.message}`);
    }
  };

  // Initial heartbeat
  await heartbeat();

  // Schedule recurring heartbeats
  const interval = setInterval(heartbeat, HEARTBEAT_MS);

  // Graceful shutdown
  const shutdown = (signal) => {
    console.log(`\n🛑 Received ${signal}. Shutting down buddy-${agentId}...`);
    clearInterval(interval);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Keep process alive
  await new Promise(() => {});
}

// ── CLI ──────────────────────────────────────────────────────────

/**
 * Parse CLI arguments.
 * @param {string[]} argv
 * @returns {object}
 */
function parseArgs(argv) {
  const args = {
    agentId: null,
    send: null,
    to: null,
    list: false,
    history: false,
    limit: MAX_HISTORY_DEFAULT,
    daemon: false,
    help: false,
    json: false,
    baseDir: null,
    chatBaseDir: null
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--agent-id': args.agentId = argv[++i]; break;
      case '--send': args.send = argv[++i]; break;
      case '--to': args.to = argv[++i]; break;
      case '--limit': args.limit = parseInt(argv[++i], 10) || MAX_HISTORY_DEFAULT; break;
      case '--base-dir': args.baseDir = argv[++i]; break;
      case '--chat-base-dir': args.chatBaseDir = argv[++i]; break;
      case '--list': args.list = true; break;
      case '--history': args.history = true; break;
      case '--daemon': args.daemon = true; break;
      case '--json': args.json = true; break;
      case '--help': case '-h': args.help = true; break;
      default:
        if (arg.startsWith('--')) {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        }
    }
  }
  return args;
}

/**
 * Show help text.
 */
function showHelp() {
  console.log(`
🤝 Buddy Bot Chat CLI v${VERSION}

Usage:
  buddy-chat --agent-id <id> --send "message" --to <address>   Send a message
  buddy-chat --agent-id <id> --list                            List conversations
  buddy-chat --agent-id <id> --history --to <address>          Show message history
  buddy-chat --agent-id <id> --daemon                          Run as daemon
  buddy-chat --help                                            Show this help

Options:
  --agent-id <id>       Agent identity to use (required for all commands)
  --send <message>      Message text to send
  --to <address>        Recipient XMTP address (0x...)
  --list                List all conversations for this agent
  --history             Show message history with a peer
  --limit <n>           Max messages to show (default: ${MAX_HISTORY_DEFAULT})
  --daemon              Run as background daemon (for launchd/systemd)
  --json                Output as JSON
  --base-dir <path>     Override ~/.everclaw base directory
  --chat-base-dir <p>   Override chat store directory

Examples:
  buddy-chat --agent-id alice --send "Hey, free Thursday?" --to 0xAbC...def
  buddy-chat --agent-id alice --list
  buddy-chat --agent-id alice --history --to 0xAbC...def --limit 20
  buddy-chat --agent-id alice --daemon
`);
}

/**
 * CLI: Send a message.
 */
async function cmdSend(args) {
  if (!args.to) {
    console.error('❌ --to <address> is required for sending.');
    process.exit(1);
  }
  if (!args.send) {
    console.error('❌ --send <message> is required.');
    process.exit(1);
  }

  const result = await sendMessage(args.agentId, args.to, args.send, {
    baseDir: args.baseDir,
    chatBaseDir: args.chatBaseDir
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`✉️  Message ${result.delivered ? 'sent' : 'queued'}:`);
  console.log(`   From:     ${result.from}`);
  console.log(`   To:       ${result.to}`);
  console.log(`   Content:  ${result.content.slice(0, 80)}${result.content.length > 80 ? '...' : ''}`);
  console.log(`   ID:       ${result.id}`);
  console.log(`   Stored:   ${result.stored ? 'yes' : 'no'}`);
  console.log(`   Delivered: ${result.delivered ? 'yes' : 'queued for XMTP sync'}`);
}

/**
 * CLI: List conversations.
 */
function cmdList(args) {
  const index = loadConversationIndex(args.agentId, args.chatBaseDir || CHAT_STORE_DIR);

  if (args.json) {
    console.log(JSON.stringify(index.conversations, null, 2));
    return;
  }

  if (index.conversations.length === 0) {
    console.log(`No conversations for agent "${args.agentId}".`);
    return;
  }

  // Sort by most recent
  const sorted = [...index.conversations].sort((a, b) =>
    new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()
  );

  console.log(`💬 ${sorted.length} conversation(s) for "${args.agentId}":\n`);
  for (const conv of sorted) {
    const ago = timeSince(new Date(conv.lastMessageAt));
    console.log(`  ${conv.peerAddress}`);
    console.log(`    Messages: ${conv.messageCount}  Last: ${ago}`);
    console.log(`    Preview:  ${conv.lastPreview || '(empty)'}`);
    console.log('');
  }
}

/**
 * CLI: Show message history.
 */
function cmdHistory(args) {
  if (!args.to) {
    console.error('❌ --to <address> is required for history.');
    process.exit(1);
  }

  const messages = loadMessages(args.agentId, args.to, args.chatBaseDir || CHAT_STORE_DIR, args.limit);

  if (args.json) {
    console.log(JSON.stringify(messages.slice(-args.limit), null, 2));
    return;
  }

  if (messages.length === 0) {
    console.log(`No messages with ${args.to}.`);
    return;
  }

  const shown = messages.slice(-args.limit);
  console.log(`📜 ${shown.length} of ${messages.length} messages with ${args.to}:\n`);

  for (const msg of shown) {
    const direction = msg.direction === 'sent' ? '→' : '←';
    const time = new Date(msg.timestamp).toLocaleString();
    console.log(`  ${direction} [${time}] ${msg.content}`);
  }
  console.log('');
}

/**
 * Human-readable time since a date.
 * @param {Date} date
 * @returns {string}
 */
function timeSince(date) {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ── Entry Point ──────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) { showHelp(); return; }

  // All commands require --agent-id
  if (!args.agentId) {
    console.error('❌ --agent-id is required. Run --help for usage.');
    process.exit(1);
  }

  if (!isValidAgentId(args.agentId)) {
    console.error(`❌ Invalid agent ID: "${args.agentId}"`);
    process.exit(1);
  }

  if (args.daemon) { await runDaemon(args.agentId, { baseDir: args.baseDir }); return; }
  if (args.list) { cmdList(args); return; }
  if (args.history) { cmdHistory(args); return; }
  if (args.send) { await cmdSend(args); return; }

  // No action specified
  showHelp();
}

// Run CLI when executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
}
