import type { VersionedAVLStorage, BatchAVLProver } from '@ergots/avltree';
import { serializeNode, deserializeNode, label } from '@ergots/avltree';
import type { AvlNode, InternalNode } from '@ergots/avltree';
import type Database from 'better-sqlite3';

/**
 * SQLite-backed VersionedAVLStorage.
 *
 * Stores each version's tree as individual serialized nodes keyed by
 * (version, node_label). All nodes are fully stored per version --
 * no cross-version deduplication, which keeps rollback self-contained.
 */
export class SqliteAvlStorage implements VersionedAVLStorage {
  private db: Database.Database;
  private keyLength: number;
  private valueLengthOpt: number | null;

  constructor(db: Database.Database, keyLength: number, valueLengthOpt: number | null) {
    this.db = db;
    this.keyLength = keyLength;
    this.valueLengthOpt = valueLengthOpt;
  }

  update(prover: BatchAVLProver, additionalData: [Uint8Array, Uint8Array][]): void {
    const newVersion = prover.digest();
    if (!newVersion) throw new Error('Prover digest is null');

    const insertVersion = this.db.prepare(
      'INSERT INTO avl_tree_versions (version, height) VALUES (?, ?)',
    );

    // Extract block height from additionalData (HEIGHT_SENTINEL -> height)
    let height = 0;
    for (const [k, v] of additionalData) {
      if (k.length === 32 && k.every(b => b === 0)) {
        height = new DataView(
          v.buffer,
          v.byteOffset,
          v.length,
        ).getUint32(0, false);
        break;
      }
    }

    const insertNode = this.db.prepare(
      'INSERT OR REPLACE INTO avl_tree_nodes (version, label, node_data) VALUES (?, ?, ?)',
    );

    const transaction = this.db.transaction(() => {
      insertVersion.run(newVersion, height);

      // Walk tree post-order, serialize and store every node
      if (prover.root) {
        this.walkAndStore(prover.root, insertNode, newVersion);
      }
    });

    transaction();
  }

  private walkAndStore(
    node: AvlNode,
    insertStmt: Database.Statement,
    version: Uint8Array,
  ): void {
    if (node.kind === 'internal') {
      this.walkAndStore(node.left, insertStmt, version);
      this.walkAndStore(node.right, insertStmt, version);
    }

    const nodeLabel = label(node);
    const nodeData = serializeNode(node);
    insertStmt.run(version, nodeLabel, nodeData);
  }

  rollback(version: Uint8Array): [AvlNode, number] {
    const rows = this.db
      .prepare('SELECT label, node_data FROM avl_tree_nodes WHERE version = ?')
      .all(version) as Array<{ label: Buffer; node_data: Buffer }>;

    if (rows.length === 0) {
      throw new Error(`Version not found: ${Buffer.from(version).toString('hex')}`);
    }

    // Deserialize all nodes, index by label hex
    const nodeMap = new Map<string, AvlNode>();
    for (const row of rows) {
      const node = deserializeNode(new Uint8Array(row.node_data));
      const lbl = Buffer.from(row.label).toString('hex');
      nodeMap.set(lbl, node);
    }

    // Re-link InternalNode children via leftLabel/rightLabel.
    // Children deserialize as LabelNodes; we replace them with the real
    // AvlNode from nodeMap so the prover can traverse the full tree.
    for (const node of nodeMap.values()) {
      if (node.kind === 'internal') {
        const internal = node as InternalNode;
        // Left child is referenced by label
        const leftLabel = label(internal.left as AvlNode);
        const leftKey = Buffer.from(leftLabel).toString('hex');
        const leftNode = nodeMap.get(leftKey);
        if (leftNode) internal.left = leftNode;

        const rightLabel = label(internal.right as AvlNode);
        const rightKey = Buffer.from(rightLabel).toString('hex');
        const rightNode = nodeMap.get(rightKey);
        if (rightNode) internal.right = rightNode;
      }
    }

    // Find root: the node whose label equals the first 32 bytes of the
    // version digest (the version is rootLabel || height).
    const rootLabel = version.slice(0, 32);
    const rootKey = Buffer.from(rootLabel).toString('hex');
    const root = nodeMap.get(rootKey);
    if (!root) throw new Error('Root node not found in stored version');

    const height = version[32]!;
    return [root, height];
  }

  version(): Uint8Array | null {
    const row = this.db
      .prepare('SELECT version FROM avl_tree_versions ORDER BY height DESC LIMIT 1')
      .get() as { version: Buffer } | undefined;
    return row ? new Uint8Array(row.version) : null;
  }

  rollbackVersions(): Uint8Array[] {
    const rows = this.db
      .prepare('SELECT version FROM avl_tree_versions ORDER BY height ASC')
      .all() as Array<{ version: Buffer }>;
    return rows.map(r => new Uint8Array(r.version));
  }

  /** Return the version digest at or before `maxHeight` (block height), or null. */
  versionAtHeight(maxHeight: number): Uint8Array | null {
    const row = this.db
      .prepare('SELECT version FROM avl_tree_versions WHERE height <= ? ORDER BY height DESC LIMIT 1')
      .get(maxHeight) as { version: Buffer } | undefined;
    return row ? new Uint8Array(row.version) : null;
  }

  /** Return the block height for a stored version, or null if not found. */
  versionHeight(version: Uint8Array): number | null {
    const row = this.db
      .prepare('SELECT height FROM avl_tree_versions WHERE version = ?')
      .get(version) as { height: number } | undefined;
    return row ? row.height : null;
  }

  pruneVersionsBefore(cutoffHeight: number): void {
    const transaction = this.db.transaction(() => {
      // Delete nodes first (FK to versions)
      this.db.prepare(
        'DELETE FROM avl_tree_nodes WHERE version IN ' +
        '(SELECT version FROM avl_tree_versions WHERE height < ?)',
      ).run(cutoffHeight);
      // Delete versions
      this.db.prepare(
        'DELETE FROM avl_tree_versions WHERE height < ?',
      ).run(cutoffHeight);
    });
    transaction();
  }

  flush(): void {
    // SQLite WAL is auto-flushed; explicit checkpoint for durability
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }
}
