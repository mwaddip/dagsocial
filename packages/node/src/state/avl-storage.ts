import type { VersionedAVLStorage, BatchAVLProver, AvlTreeConfig } from '@ergots/avltree';
import { serializeNode, deserializeNode, label, newInternal } from '@ergots/avltree';
import type { AvlNode } from '@ergots/avltree';
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
  private config: AvlTreeConfig;

  constructor(db: Database.Database, config: AvlTreeConfig) {
    this.db = db;
    this.config = config;
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
    const nodeData = serializeNode(node, this.config);
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
      const node = deserializeNode(new Uint8Array(row.node_data), this.config);
      const lbl = Buffer.from(row.label).toString('hex');
      nodeMap.set(lbl, node);
    }

    // Rebuild the tree bottom-up from the root label (version = rootLabel || height).
    // deserializeNode returns each internal node's children as LabelNode stubs;
    // nodes are immutable, so stubs are resolved into real subtrees by
    // constructing fresh internal nodes rather than relinking in place.
    // A stored version is self-contained -- a missing child means the stored
    // data is corrupt, so fail closed instead of returning a tree the prover
    // cannot traverse. The internal `key` is not part of the node's label but
    // the prover needs it for descent, so it is carried through.
    const resolve = (labelHex: string): AvlNode => {
      const node = nodeMap.get(labelHex);
      if (!node) throw new Error(`Missing node for label ${labelHex} in stored version`);
      if (node.kind !== 'internal') return node;
      const left = resolve(Buffer.from(label(node.left)).toString('hex'));
      const right = resolve(Buffer.from(label(node.right)).toString('hex'));
      return newInternal(left, right, node.balance, node.key);
    };

    const root = resolve(Buffer.from(version.slice(0, 32)).toString('hex'));
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

  /**
   * Return the version digest at or before the given block height.
   * Returns the version with the highest height <= maxHeight, or null if none.
   */
  versionAtOrBeforeHeight(maxHeight: number): Uint8Array | null {
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
