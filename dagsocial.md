
# DAGsocial: A Self-Governing, Invite-Only Social Network

## Abstract
DAGsocial is a decentralized social networking protocol designed to eliminate spam, bots, and centralized moderation through economic incentives, proof-of-work, and community governance. Users control their experience, advertisers fund the network without buying influence, and reputation is earned—not purchased.

---

## 1. The Problem We Solve

Current social networks suffer from:
- **Spam & bots** – Sybil attacks are cheap and effective
- **Centralized moderation** – Admins become bottlenecks, prone to bias and burnout
- **Privacy erosion** – Users are the product, not the customer
- **Incentive misalignment** – Platforms profit from outrage, not quality content

**Our goal:** A social network that runs without admin intervention, where quality content is rewarded, spam is economically irrational, and users control their own experience.

---

## 2. Core Design Pillars

### 2.1 Invite-Only with Skin in the Game
- Every user has **3 invite slots** (regenerating slowly, max 5 stored).
- To invite someone, you **stake 10% of your karma** for 90 days.
- If your invitee posts quality content (stays above downvote threshold), you get your stake back + a minted bonus.
- If your invitee spams or gets slashed, **you lose the staked karma permanently**.
- The invite graph forms a natural social trust network—bad actors risk burning their inviter's reputation.

**Motivation:** Creates natural sybil resistance. Inviters become curators. Bad actors are costly to onboard.

---

### 2.2 Proof-of-Work as Spam Deterrent (Two-Phase)

Every post requires two PoW steps, decoupling heavy computation from the writing process:

| Phase | Action | Difficulty | Purpose |
|-------|--------|------------|---------|
| **Phase 1: Slot Request** | User solves PoW to obtain a time-limited slot token | High (10-30s compute) | Prevent pre-computation; rate-limit new posts |
| **Phase 2: Post Submission** | User solves second PoW including the token as proof | Low (0.1-0.5s compute) | Validate slot; consume token; submit content |

**Slot token:** Valid for 5-15 minutes (scales with account karma). Only one active slot per user at a time. Tokens are bound to the user's public key and consumed on use.

**Mobile UX:** The app silently requests a slot in the background while the user types. By the time they hit "Post," the slot is ready and the lightweight Phase 2 completes instantly.

**Uniform difficulty:** All clients use the same algorithm and target. No client-type shortcuts.

**Dynamic difficulty:** Both targets scale with network load, account age, and karma score. New users face higher barriers; trusted users enjoy convenience.

**Rationale:** Eliminates pre-computation attacks, keeps UX seamless, and ensures every post incurs real computational cost—without burdening legitimate users.

---

### 2.3 Directed Acyclic Graph (DAG) for Content Storage
- Each post references one or more previous posts (like IOTA's Tangle).
- No global blockchain—each user maintains their own local view.
- Validators confirm transactions by referencing them; confirmation weight = cumulative karma of referencers.
- Periodically, checkpoints are created via validator consensus to prune old data.
- Old posts remain content-addressed and retrievable (IPFS-like), but not in the active DAG.

**Motivation:** Scalable, asynchronous, and permissionless. No single point of failure. Storage cost is distributed across validators.

---

### 2.4 Dual-Token Economy (Karma + Currency)

| **Karma** | **Currency** |
|-----------|--------------|
| Non-transferable, non-purchasable | Transferable, tradeable |
| Earned via upvotes from others | Earned via mining/validation + post rewards |
| Spent on voting, inviting, and appeals | Spent on keyword bids, validator fees |
| Decays over time (half-life ~6 months) | Deflationary (ad buys are burned) |
| Gives voting weight in governance | Gives no governance weight |

**Currency Flow:**
- **Mining:** Validators earn currency for securing the DAG (fixed emission per block).
- **Posting:** Users earn currency if their post survives 24 hours with net positive karma (minted from a daily pool).
- **Advertisers:** Buy currency with fiat to bid on keywords. Spent currency is **burned** (deflationary pressure).
- **Burn pool:** A portion of burned ad currency is redistributed to validators as additional rewards.

**Motivation:** Separates influence from wealth. You cannot buy your way to power, but you can participate economically.

---

### 2.5 Governance (Adapted from Cardano's DRep Model)

Three bodies with distinct powers and checks:

#### 2.5.1 Delegated Representatives (DReps)
- Users delegate their voting weight (based on karma) to DReps.
- DReps vote on: slashing bad actors, changing invite mechanics, adjusting PoW difficulty, treasury allocation.
- Voting thresholds scale with impact:
  - Minor parameter changes: 51%
  - Slashing a user: 67% supermajority
  - Constitutional amendments: 75% supermajority

#### 2.5.2 Constitutional Committee (CC)
- Elected by DReps for fixed terms (e.g., 12 months).
- Reviews governance actions for constitutionality.
- Can veto actions that violate the network's core principles (e.g., "no doxxing," "no censorship of minority views," "no retroactive punishment").
- Veto can be overridden by a 75% DRep vote.

#### 2.5.3 Validators (Node Operators)
- Technical operators who secure the DAG and process transactions.
- Vote on protocol-level changes: DAG pruning rules, checkpoint frequency, fee structures, PoW algorithm updates.
- Earn currency from block rewards + share of the advertiser burn pool.

**Motivation:** Distributed, checks-and-balances governance that doesn't require admin intervention. Prevents both tyranny of the majority and capture by a single powerful user.

---

### 2.6 Advertiser Integration (Funding Model)

- Advertisers buy currency with fiat (the **only** fiat on-ramp).
- They bid on keywords for sponsored placement:
  - Sponsored content appears in a clearly labeled, separate feed.
  - Organic content remains untouched and rank-ordered by karma/engagement.
- Currency spent on ads is **burned** (deflationary).
- The burn pool is partially redistributed to validators as additional rewards.

**Motivation:** Self-funding network. Advertisers pay, users never pay to post. No surveillance-based targeting—keywords only, no user profiling.

**Privacy guarantee:** Advertisers never see user data. Bids are on topics, not audiences.

---

## 3. User Journey

| Step | Action | Cost | Earns |
|------|--------|------|-------|
| 1 | Get invited (from existing user) | Inviter stakes 10% karma | Your account is created |
| 2 | Request a slot (background) | PoW (High difficulty) | Slot token (valid 5-15 min) |
| 3 | Post content | PoW (Low difficulty) + consume slot | Currency (if post survives 24hr with positive net karma) |
| 4 | Get upvoted | Upvoter spends karma | You earn karma + currency |
| 5 | Get downvoted | Downvoter spends karma | You lose karma (post may be hidden) |
| 6 | Invite a new user | Stake 10% karma | Get stake back + bonus if invitee is good |
| 7 | Vote in governance | Delegate karma to DRep | Influence network decisions |
| 8 | Advertise | Buy currency with fiat, bid on keywords | Sponsored visibility |

---

## 4. Attack Vectors & Mitigations

| Attack | Mitigation |
|--------|------------|
| Sybil (10k fake accounts) | Invite scarcity + staking makes it prohibitively expensive |
| 51% validation attack | Karma-weighted validators; attack would require controlling top 51% of karma accounts (impossible without owning invite tree) |
| Advertiser sock-puppets | No direct karma purchase; would need organic invite chain—risk of slashing entire lineage |
| High-karma user goes rogue | Governance vote (67% supermajority) to slash karma and revoke invite privileges |
| Spam via low-PoW posts | Two-phase PoW with uniform difficulty; every post requires fresh heavy work |
| Pre-computation attacks | Slot tokens expire; PoW bound to content + timestamp; tokens consumed on use |
| DAG bloat (infinite storage) | Periodic pruning via validator checkpoints; old posts archived (content-addressed, still retrievable) |
| Mobile emulation for easier PoW | Uniform difficulty across all clients; no client-type shortcuts |
| Invite selling (fiat) | Repeated bad invites permanently reduces max slot count; risk/reward makes selling unprofitable |

---

## 5. MVP Scope (Phase 1)

For an initial prototype, we focus on core mechanics:

### Must Have
- [ ] Invite system (3 slots, 10% stake, 90-day lock)
- [ ] Two-phase PoW (slot request + submission, uniform difficulty)
- [ ] Single-validator DAG implementation (for testing)
- [ ] Karma scoring (upvote/downvote, decay, invite bonuses)
- [ ] Currency minting (fixed emission per block, no exchange integration)
- [ ] Basic governance (DRep delegation via manual vote, no smart contracts)
- [ ] Web client (posting, reading, voting, inviting)

### Nice to Have (Phase 2)
- [ ] Full DRep voting UI with delegation
- [ ] Advertiser keyword auction dashboard
- [ ] Constitutional Committee election mechanism
- [ ] Mobile apps (iOS/Android) with background slot generation
- [ ] Multi-validator federation/peering
- [ ] Archival node support (full historical DAG)

---

## 6. Technical Specifications

### 6.1 PoW Algorithm
- **Algorithm:** Equihash-60,192/1 (ASIC-resistant, mobile-friendly ARM support)
- **Target adjustment:** Dynamic, based on 24-hour average submission rate
- **Scalar:** Karma multiplier (new users get 2x difficulty; 1000+ karma gets 0.75x)

### 6.2 DAG Data Structures
```rust
struct Post {
    id: Hash,
    content: String,
    author: PublicKey,
    parent_refs: Vec<Hash>,       // 1-8 references to previous posts
    slot_token: Token,            // consumed on submission
    pow_nonce: u64,
    timestamp: u64,
    signature: Signature,
}

struct Token {
    user_id: PublicKey,
    issued_at: u64,
    expires_at: u64,
    nonce: u64,
    hash: Hash,                   // H(user_id || issued_at || nonce) < target_slot
}
```

6.3 Karma Calculation

```
karma_score = (upvotes_received × age_factor) - (downvotes_received × decay_factor)
age_factor = 1 + log(1 + account_age_days) / 10
decay_factor = 1 + (downvotes_count / 100)
half_life = 180 days  // karma halves every 6 months if no activity
```

6.4 Currency Emission Schedule

· Block reward: Fixed 100 coins per block (halving every 2 years)
· Post reward: Daily pool of 10,000 coins, distributed proportionally to posts with net positive karma
· Validator bonus: 20% of ad burn pool distributed weekly

6.5 Invite Staking Math

· Stake = 10% of inviter's current karma (min 100, max 5000)
· Lock period = 90 days
· Bonus = (invitee's karma after 90 days) × 0.01 coins per karma point
· Penalty = Loss of entire stake if invitee is slashed within 90 days

---

7. Open Questions for Discussion

Question Options Recommendation
Karma decay half-life 3, 6, 12 months 6 months (balances trust vs. mobility)
PoW slot validity 5, 10, 15 minutes 10 minutes (sufficient for composing)
Invite stake percentage 5%, 10%, 15% 10% (meaningful but not crippling)
Currency name "Rep", "Node", "Flux", "Signal" Vote via initial governance
Content policy (constitution) Community-defined + CC enforcement Start with minimal: no CSAM, no doxxing, no incitement to violence
Validator minimum stake None, 100, 1000 coins 100 coins (lowers barrier to entry)

---

8. Why This Matters

We're building a social network where:

· You own your data (no surveillance economy)
· You control who joins (invite-only with real stake)
· Your reputation is your influence (not your wallet)
· The community governs itself (no admins, no dictators)
· Advertisers fund the network (without buying power over content)

This isn't just a protocol—it's a social experiment in distributed governance. If successful, it proves that online communities can self-regulate without surveillance, censorship, or centralized control.

---

9. Next Steps

1. Recruit contributors
   · Backend: Rust/Go (DAG implementation, validator node)
   · Frontend: React/TypeScript (web client)
   · Cryptography: PoW optimization, signature schemes
   · Governance: Smart contract design (or off-chain voting)
2. Design the DAG spec
   · Data structures, serialization (CBOR/Protobuf), validation rules
   · Checkpointing and pruning logic
3. Build the MVP
   · Single-validator PoC with invite + two-phase PoW + karma
   · Command-line client for testing
4. Test with 100 initial users
   · Stress test mechanics, gather feedback
   · Measure: post latency, spam rate, governance participation
5. Iterate toward decentralization
   · Multi-validator, DRep voting, treasury management
   · Open-source release + documentation

---

Let's build the network that doesn't need us.

---

DAGsocial - v0.1 Design Draft - July 2026
