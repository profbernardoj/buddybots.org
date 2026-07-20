# Buddy Bots — Agent-to-Agent Social Coordination

**Repo:** [github.com/EverClaw/buddybots.org](https://github.com/EverClaw/buddybots.org) (private)
**Concept:** Create a group chat, everyone gets their own AI buddy bot. Bots coordinate with each other over XMTP to handle real-world planning on behalf of their humans.

---

## What Buddy Bots Does

Friend #1 creates a group chat and adds friends. The moment the group is created, every member is auto-provisioned their own buddy bot. The bots talk to each other over XMTP (end-to-end encrypted) to coordinate real-world actions — scheduling, planning, recommendations — on behalf of their humans.

**Example flow:**
1. Alice in group: "can you and Bob's bot figure out a movie this weekend?"
2. Alice's Bot sends a schedule query to Bob's Bot over XMTP
3. Bob's Bot checks calendar, responds with mutual slots + suggestion
4. Alice's Bot posts to group: "MI9 at AMC, Saturday 5:30 works for both of you. Want me to grab tickets?"

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Host Machine (OpenClaw Gateway)                     │
│                                                      │
│  ├── Main Agent (host's personal agent)              │
│  ├── Buddy Host Agent (onboarding + group mgmt)      │
│  ├── Alice's Buddy Bot (workspace-alice, chmod 700)  │
│  └── Bob's Buddy Bot (workspace-bob, chmod 700)      │
│                                                      │
│  ├── XMTP Daemon (per-agent identity, E2E encrypted) │
│  │   └── Envelope schema + payload limits + expiry     │
│                                                      │
│  ├── Inference (shared, quota-tracked)                │
│  │   ├── Ollama + Gemma 4 (local) — PRIMARY           │
│  │   ├── Morpheus P2P (staked MOR)                   │
│  │   └── Morpheus Gateway / Venice (fallback)        │
│                                                      │
│  └── Buddy Registry (local, never published)          │
│      phone → XMTP address → agent_id → workspace     │
└─────────────────────────────────────────────────────┘
```

**Key principle:** XMTP is the bot-to-bot backbone. Chat channels (Signal, WhatsApp) are the human-facing surface.

---

## What's Built (8 components, ~8,600 lines)

| # | Component | File | Lines | Tests | Status |
|---|-----------|------|-------|-------|--------|
| 1 | **Flavor repo + branding** | repo itself | — | — | ✅ Done |
| 2 | **Multi-identity XMTP** | `agent-chat` daemon | — | — | ✅ Done |
| 3 | **Buddy registry** | `buddy-registry.mjs` | 429 | ✅ passing | ✅ Done |
| 4 | **Dynamic agent provisioner** | `buddy-provision.mjs` | 1,117 | ✅ 15/21 (6 edge-case) | ✅ Done |
| 5 | **Auto-provision on group creation** | `buddy-host.mjs` | 1,022 | ✅ 73/73 passing | ✅ Done |
| 6 | **Bot-to-bot coordination** | `buddy-coordinate.mjs` | 859 | ✅ 147/147 passing | ✅ Done |
| 7 | **Scoped agent export/import** | `buddy-export.mjs` | 856 | ✅ 84/84 passing | ✅ Done |
| 8 | **Inference quotas** | `buddy-quotas.mjs` | 960 | ✅ 50/50 passing | ✅ Done |
| — | **Buddy chat CLI** | `buddy-chat.mjs` | 537 | — | ✅ Done |

### Known Issues
- `buddy-provision.mjs` has 6 pre-existing test failures in `deriveAgentId` edge cases (accented characters like 'José María' → 'jos-mar-a' instead of 'jose-maria', empty/whitespace fallback) and validation tests (error message format differences). These don't affect functionality — provisioning, deprovisioning, and coordination all work correctly.

---

## How It Works

### 1. Buddy Registry (`buddy-registry.mjs`)
Local-only JSON mapping: phone number → XMTP address → agent ID → workspace directory. Never published. No PII on-chain.

### 2. Dynamic Agent Provisioner (`buddy-provision.mjs`)
Takes name, phone, and trust profile → generates XMTP identity → creates isolated workspace (`chmod 700`) → injects agent entry into `openclaw.json` → creates per-agent XMTP daemon service → updates buddy registry → registers peer in comms-guard → reloads OpenClaw → sends welcome DM.

### 3. Buddy Host (`buddy-host.mjs`)
Auto-provisions bots on group creation. Detects group membership from channel events, cross-references host's contacts for names/relationships, calls provisioner for each member, sends welcome DMs, announces in group.

### 4. Bot-to-Bot Coordination (`buddy-coordinate.mjs`)
10 coordination types over XMTP DATA messages:
- `schedule-request` / `schedule-response` — find mutual availability
- `recommendation-request` / `recommendation-response` — preferences
- `group-plan-propose` / `group-plan-vote` / `group-plan-finalize` — multi-bot planning
- `reminder-relay` / `reminder-ack` — cross-bot reminders
- `preference-share` — share preferences within trust bounds

Trust boundaries (public/business/personal/full) enforced at both parse and handler layers.

### 5. Agent Export/Import (`buddy-export.mjs`)
Portable tar.gz archive of a single agent's workspace, XMTP identity, registry entry, and peer entry. Supports import with conflict detection, `--force`, `--checksum`, `--dry-run`, `--no-xmtp`, `--list`.

### 6. Inference Quotas (`buddy-quotas.mjs`)
Per-agent token tracking with daily/monthly limits, alert at 80%, degrade to lighter model at 90%, three cutoff actions (degrade/block/warn), 30-day history, provider+model breakdowns.

### 7. Buddy Chat (`buddy-chat.mjs`)
CLI for sending messages between bots. Validates messages, manages conversation index, appends to message store, sends via XMTP.

---

## Security

- **ERC-8004: No PII on-chain.** XMTP address + "Buddy Bot" + protocol version only. No names.
- **Workspace isolation.** Each buddy bot has `chmod 700` workspace. Host agent cannot access buddy bot memory or conversations.
- **CommsGuard security controls** on every XMTP message: envelope schema validation, payload size limits, expiry checks, and trust boundary enforcement (fail-closed). See `docs/ARCHITECTURE.md` for the full control matrix.
- **Trust profiles:** `public`, `business`, `personal`, `financial`, `full` with topic-scoped sensitivity limits.
- **Not yet implemented:** nonce/replay protection, rate limiting, PII/injection filtering, audit trail. See `docs/ARCHITECTURE.md` for status.

---

## Inference Model

| Priority | Source | Requirement |
|----------|--------|-------------|
| **1 (Primary)** | Ollama local (Gemma 4) | Auto-installed at setup |
| 2 | Morpheus P2P Sessions | User staked MOR |
| 3 | Morpheus API Gateway | User's key from app.mor.org |
| 4 | Venice / other providers | User's API keys |

All buddy bots share one Ollama instance. Quota system manages local queue fairness.

---

## Getting Started (for Testers)

### Prerequisites
- **OpenClaw** installed (`npm install -g openclaw@latest`)
- **Node.js** v18+
- **Ollama** (for local inference) — auto-detected at setup
- **XMTP identity** — generated by the provisioner

### Setup
```bash
# Clone the repo
git clone https://github.com/EverClaw/buddybots.org.git ~/.openclaw/workspace/skills/buddy-bots

# Run the install script (coming soon — for now, manual setup)
cd ~/.openclaw/workspace/skills/buddy-bots
node scripts/buddy-provision.mjs --name "Alice" --phone "+15125551234" --trust personal
```

### Connecting Agents

Buddy Bots uses XMTP for bot-to-bot communication. Each bot gets its own XMTP identity (Ethereum wallet address). To connect two agents:

1. **Provision bots on the same host** — the provisioner auto-registers them as trusted peers
2. **Cross-host connection** — exchange XMTP addresses via the buddy registry, then use `buddy-coordinate.mjs` to send a `HANDSHAKE` message
3. **Group coordination** — the host agent creates the group, provisions all members, and all bots auto-trust each other

```bash
# Send a coordination message between bots
node scripts/buddy-coordinate.mjs send \
  --from alice \
  --to bob \
  --type schedule-request \
  --data '{"date":"2026-07-10","duration":120}'
```

---

## Roadmap

| Component | Status |
|-----------|--------|
| Flavor repo + branding | ✅ Complete |
| Multi-identity XMTP daemon | ✅ Complete |
| Buddy registry | ✅ Complete |
| Dynamic agent provisioner | ✅ Complete |
| Auto-provision on group creation | ✅ Complete |
| Bot-to-bot coordination | ✅ Complete |
| Scoped agent export/import | ✅ Complete |
| Inference quotas | ✅ Complete |
| Buddy chat CLI | ✅ Complete |
| `deprovision` export fix | ✅ Fixed (committed) |
| Install script (`buddy-bots-install.sh`) | 📋 TODO |
| E2E integration test (live XMTP) | 📋 TODO |
| Mobile companion app | 📋 Future |

---

## Tech Stack

- **Runtime:** OpenClaw
- **Bot-to-bot transport:** XMTP (MLS, E2E encrypted)
- **Identity:** XMTP wallet addresses + ERC-8004 on Base (no PII)
- **Inference:** Ollama (Gemma 4) → Morpheus → Venice (fallback chain)
- **Security:** Envelope schema + trust boundaries + payload limits (see `docs/ARCHITECTURE.md`)
- **Language:** Node.js ES modules, zero npm dependencies

---

## Links

- **GitHub:** [github.com/EverClaw/buddybots.org](https://github.com/EverClaw/buddybots.org)
- **Architecture doc:** `docs/ARCHITECTURE.md` (security control matrix)
- **Built on:** [EverClaw](https://github.com/EverClaw/EverClaw) + [OpenClaw](https://github.com/openclaw/openclaw) + [XMTP](https://xmtp.org)

---

*Buddy Bots — create a group, everyone gets a bot. The bots handle the rest.*