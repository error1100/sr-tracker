import { BLOCK_SLICE_SIZE, MINER_FEE_ERGO_TREE } from '../config';
import type {
  BlockHeader,
  BlockTransactions,
  ErgoAsset,
  ErgoNodeInfo,
  IndexedTransaction,
  TransactionBox,
} from '../types/ergoNode';
import type {
  CollectedAssetSummary,
  LoadedStats,
  RecipientSummary,
  RentCollectionEvent,
} from '../types/rent';

export interface RentCollectionSlice {
  events: RentCollectionEvent[];
  stats: LoadedStats;
  nextHeight: number | null;
  hasMore: boolean;
}

export interface RentCollectionRange {
  events: RentCollectionEvent[];
  scannedBlocks: number;
  highestHeight: number | null;
  lowestHeight: number | null;
}

interface BlockChainContext {
  spendByBoxId: Map<string, string>;
  txOrder: Map<string, number>;
}

interface CachedProcessedBlock {
  headerId: string;
  height: number;
  events: RentCollectionEvent[];
}

const ergoTreeAddressCache = new Map<string, string>();
const transactionCache = new Map<string, Promise<IndexedTransaction>>();
const processedBlockCache = new Map<string, CachedProcessedBlock>();
const processedBlockRequestCache = new Map<string, Promise<CachedProcessedBlock>>();

const PROCESSED_BLOCK_CACHE_KEY = 'sr-tracker:processed-blocks:v1';
const MAX_CACHED_PROCESSED_BLOCKS = 400;

let processedBlockCacheHydrated = false;

const createEmptyStats = (): LoadedStats => ({
  scannedBlocks: 0,
  rentTransactions: 0,
  rentInputs: 0,
  uniqueCollectorAddresses: 0,
  totalCollectorNanoErg: 0,
  totalMinerNanoErg: 0,
  highestHeight: null,
  lowestHeight: null,
  collectorAddresses: [],
});

const canUseStorage = () =>
  typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

const hydrateProcessedBlockCache = () => {
  if (processedBlockCacheHydrated || !canUseStorage()) {
    processedBlockCacheHydrated = true;
    return;
  }

  processedBlockCacheHydrated = true;

  try {
    const rawCache = window.localStorage.getItem(PROCESSED_BLOCK_CACHE_KEY);
    if (!rawCache) {
      return;
    }

    const parsedCache = JSON.parse(rawCache) as Record<string, CachedProcessedBlock>;
    Object.values(parsedCache).forEach((cachedBlock) => {
      processedBlockCache.set(cachedBlock.headerId, cachedBlock);
    });
  } catch {
    window.localStorage.removeItem(PROCESSED_BLOCK_CACHE_KEY);
  }
};

const persistProcessedBlockCache = () => {
  if (!canUseStorage()) {
    return;
  }

  try {
    const sortedEntries = Array.from(processedBlockCache.values())
      .sort((left, right) => right.height - left.height)
      .slice(0, MAX_CACHED_PROCESSED_BLOCKS);

    processedBlockCache.clear();
    sortedEntries.forEach((entry) => {
      processedBlockCache.set(entry.headerId, entry);
    });

    window.localStorage.setItem(
      PROCESSED_BLOCK_CACHE_KEY,
      JSON.stringify(
        Object.fromEntries(sortedEntries.map((entry) => [entry.headerId, entry])),
      ),
    );
  } catch {
    // Ignore storage quota and serialization failures. The in-memory cache still works.
  }
};

const fetchJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Ergo node error (${response.status}): ${response.statusText}`);
  }
  return (await response.json()) as T;
};

const rememberAddress = (box: TransactionBox) => {
  if (box.ergoTree && box.address) {
    ergoTreeAddressCache.set(box.ergoTree, box.address);
  }
};

const hasRentMarker = (extension?: Record<string, string> | null) =>
  Boolean(extension && Object.prototype.hasOwnProperty.call(extension, '127'));

const fetchBlockHeaders = async (
  nodeUrl: string,
  fromHeight: number,
  toHeight: number,
) => {
  const params = new URLSearchParams({
    fromHeight: Math.max(0, fromHeight).toString(),
    toHeight: Math.max(0, toHeight).toString(),
  });
  return fetchJson<BlockHeader[]>(`${nodeUrl}/blocks/chainSlice?${params.toString()}`);
};

const fetchBlockTransactions = async (nodeUrl: string, headerId: string) =>
  fetchJson<BlockTransactions>(`${nodeUrl}/blocks/${headerId}/transactions`);

const fetchIndexedTransaction = async (nodeUrl: string, txId: string) => {
  if (!transactionCache.has(txId)) {
    transactionCache.set(
      txId,
      fetchJson<IndexedTransaction>(`${nodeUrl}/blockchain/transaction/byId/${txId}`),
    );
  }
  return transactionCache.get(txId)!;
};

const buildBlockChainContext = (blockTransactions: BlockTransactions): BlockChainContext => {
  const txOrder = new Map<string, number>();
  const spendByBoxId = new Map<string, string>();

  blockTransactions.transactions.forEach((transaction, index) => {
    txOrder.set(transaction.id, index);
  });

  blockTransactions.transactions.forEach((transaction) => {
    transaction.inputs.forEach((input) => {
      spendByBoxId.set(input.boxId, transaction.id);
    });
  });

  return { spendByBoxId, txOrder };
};

interface ResolvedOutputs {
  outputs: TransactionBox[];
  chainTxIds: Set<string>;
}

type CollectorOutputMatcher = (output: TransactionBox) => boolean;

interface RecipientAccumulator {
  kind: RecipientSummary['kind'];
  address: string;
  ergoTree: string;
  nanoErg: number;
  outputCount: number;
  assetAmounts: Map<string, number>;
}

const sortTxIdsByBlockOrder = (txIds: Iterable<string>, blockContext: BlockChainContext) =>
  Array.from(new Set(txIds)).sort(
    (left, right) => (blockContext.txOrder.get(left) ?? 0) - (blockContext.txOrder.get(right) ?? 0),
  );

const resolveChainedOutputs = async (
  nodeUrl: string,
  output: TransactionBox,
  blockContext: BlockChainContext,
  isCollectorOutput: CollectorOutputMatcher,
  visitedTxIds = new Set<string>(),
): Promise<ResolvedOutputs> => {
  const spendTxId = blockContext.spendByBoxId.get(output.boxId);
  if (!spendTxId || visitedTxIds.has(spendTxId)) {
    return { outputs: [output], chainTxIds: new Set() };
  }

  const spendingTransaction = await fetchIndexedTransaction(nodeUrl, spendTxId);
  if (spendingTransaction.inputs.length !== 1) {
    return { outputs: [output], chainTxIds: new Set() };
  }

  const nextVisitedTxIds = new Set(visitedTxIds);
  nextVisitedTxIds.add(spendTxId);

  const chainTxIds = new Set<string>([spendTxId]);
  const resolvedOutputs: TransactionBox[] = [];

  for (const childOutput of spendingTransaction.outputs) {
    rememberAddress(childOutput);

    if (!isCollectorOutput(childOutput)) {
      resolvedOutputs.push(childOutput);
      continue;
    }

    const childResolution = await resolveChainedOutputs(
      nodeUrl,
      childOutput,
      blockContext,
      isCollectorOutput,
      nextVisitedTxIds,
    );
    childResolution.outputs.forEach((resolvedOutput) => resolvedOutputs.push(resolvedOutput));
    childResolution.chainTxIds.forEach((txId) => chainTxIds.add(txId));
  }

  return {
    outputs: resolvedOutputs,
    chainTxIds,
  };
};

const sortRecipients = (left: RecipientSummary, right: RecipientSummary) =>
  right.nanoErg - left.nanoErg || left.address.localeCompare(right.address);

const addAssetAmounts = (
  assetAmounts: Map<string, number>,
  assets: ErgoAsset[],
  multiplier = 1,
) => {
  assets.forEach((asset) => {
    assetAmounts.set(asset.tokenId, (assetAmounts.get(asset.tokenId) ?? 0) + asset.amount * multiplier);
  });
};

const mergeAssetAmounts = (
  target: Map<string, number>,
  source: Map<string, number>,
  multiplier = 1,
) => {
  source.forEach((amount, tokenId) => {
    target.set(tokenId, (target.get(tokenId) ?? 0) + amount * multiplier);
  });
};

const buildAssetSummaries = (assetAmounts: Map<string, number>): CollectedAssetSummary[] =>
  Array.from(assetAmounts.entries())
    .filter(([, amount]) => amount !== 0)
    .map(([tokenId, amount]) => ({ tokenId, amount }))
    .sort((left, right) => Math.abs(right.amount) - Math.abs(left.amount) || left.tokenId.localeCompare(right.tokenId));

const mergeRecipientsByAddress = (recipients: RecipientAccumulator[]) => {
  const grouped = new Map<string, RecipientAccumulator>();

  recipients.forEach((recipient) => {
    const key = `${recipient.kind}:${recipient.address}`;
    const existing = grouped.get(key);

    if (existing) {
      existing.nanoErg += recipient.nanoErg;
      existing.outputCount += recipient.outputCount;
      mergeAssetAmounts(existing.assetAmounts, recipient.assetAmounts);
      return;
    }

    grouped.set(key, {
      ...recipient,
      assetAmounts: new Map(recipient.assetAmounts),
    });
  });

  return Array.from(grouped.values()).map((recipient) => ({
    kind: recipient.kind,
    address: recipient.address,
    ergoTree: recipient.ergoTree,
    nanoErg: recipient.nanoErg,
    outputCount: recipient.outputCount,
    assets: buildAssetSummaries(recipient.assetAmounts),
  }));
};

const buildRecipientGroups = (
  rentInputErgoTrees: Set<string>,
  collectorInputNanoErgByErgoTree: Map<string, number>,
  collectorInputAssetsByErgoTree: Map<string, Map<string, number>>,
  resolvedOutputs: TransactionBox[],
) => {
  resolvedOutputs.forEach(rememberAddress);
  const collectorRecipients = new Map<string, RecipientAccumulator>();
  const minerRecipients = new Map<string, RecipientAccumulator>();

  resolvedOutputs.forEach((output) => {
    if (rentInputErgoTrees.has(output.ergoTree)) {
      return;
    }

    const address = ergoTreeAddressCache.get(output.ergoTree) ?? output.address;
    ergoTreeAddressCache.set(output.ergoTree, address);

    if (output.ergoTree === MINER_FEE_ERGO_TREE) {
      const key = address;
      const existing = minerRecipients.get(key);

      if (existing) {
        existing.nanoErg += output.value;
        existing.outputCount += 1;
        addAssetAmounts(existing.assetAmounts, output.assets);
        return;
      }

      minerRecipients.set(key, {
        kind: 'minerFee',
        address,
        ergoTree: output.ergoTree,
        nanoErg: output.value,
        outputCount: 1,
        assetAmounts: new Map(output.assets.map((asset) => [asset.tokenId, asset.amount])),
      });
      return;
    }

    const existingCollector = collectorRecipients.get(output.ergoTree);
    if (existingCollector) {
      existingCollector.nanoErg += output.value;
      existingCollector.outputCount += 1;
      addAssetAmounts(existingCollector.assetAmounts, output.assets);
      return;
    }

    collectorRecipients.set(output.ergoTree, {
      kind: 'collector',
      address,
      ergoTree: output.ergoTree,
      nanoErg: output.value,
      outputCount: 1,
      assetAmounts: new Map(output.assets.map((asset) => [asset.tokenId, asset.amount])),
    });
  });

  collectorInputNanoErgByErgoTree.forEach((inputNanoErg, ergoTree) => {
    const address = ergoTreeAddressCache.get(ergoTree) ?? ergoTree;
    const existingCollector = collectorRecipients.get(ergoTree);
    const inputAssetAmounts = collectorInputAssetsByErgoTree.get(ergoTree) ?? new Map<string, number>();

    if (existingCollector) {
      existingCollector.nanoErg -= inputNanoErg;
      mergeAssetAmounts(existingCollector.assetAmounts, inputAssetAmounts, -1);
      return;
    }

    collectorRecipients.set(ergoTree, {
      kind: 'collector',
      address,
      ergoTree,
      nanoErg: -inputNanoErg,
      outputCount: 0,
      assetAmounts: new Map(
        Array.from(inputAssetAmounts.entries()).map(([tokenId, amount]) => [tokenId, -amount]),
      ),
    });
  });

  const collectors = mergeRecipientsByAddress(Array.from(collectorRecipients.values())).sort(
    sortRecipients,
  );
  const minerFees = mergeRecipientsByAddress(Array.from(minerRecipients.values())).sort(
    sortRecipients,
  );
  const collectedAssetAmounts = new Map<string, number>();

  collectors.forEach((collector) => {
    collector.assets.forEach((asset) => {
      collectedAssetAmounts.set(
        asset.tokenId,
        (collectedAssetAmounts.get(asset.tokenId) ?? 0) + asset.amount,
      );
    });
  });

  return {
    collectors: collectors.filter(
      (collector) =>
        collector.nanoErg !== 0 || collector.outputCount !== 0 || collector.assets.length > 0,
    ),
    minerFees: minerFees.filter(
      (minerFee) =>
        minerFee.nanoErg !== 0 || minerFee.outputCount !== 0 || minerFee.assets.length > 0,
    ),
    collectedAssets: buildAssetSummaries(collectedAssetAmounts),
  };
};

const buildEvent = async (
  nodeUrl: string,
  transaction: IndexedTransaction,
  blockContext: BlockChainContext,
): Promise<RentCollectionEvent> => {
  transaction.inputs.forEach(rememberAddress);
  transaction.outputs.forEach(rememberAddress);

  const rentInputs = transaction.inputs.filter((input) =>
    hasRentMarker(input.spendingProof?.extension),
  );
  const rentInputCount = rentInputs.length;
  const rentInputErgoTrees = new Set(rentInputs.map((input) => input.ergoTree));
  const collectorInputNanoErgByErgoTree = new Map<string, number>();
  const collectorInputAssetsByErgoTree = new Map<string, Map<string, number>>();

  transaction.inputs.forEach((input) => {
    if (hasRentMarker(input.spendingProof?.extension) || input.ergoTree === MINER_FEE_ERGO_TREE) {
      return;
    }

    collectorInputNanoErgByErgoTree.set(
      input.ergoTree,
      (collectorInputNanoErgByErgoTree.get(input.ergoTree) ?? 0) + input.value,
    );

    if (!collectorInputAssetsByErgoTree.has(input.ergoTree)) {
      collectorInputAssetsByErgoTree.set(input.ergoTree, new Map());
    }

    addAssetAmounts(collectorInputAssetsByErgoTree.get(input.ergoTree)!, input.assets);
  });

  const isCollectorOutput = (output: TransactionBox) =>
    !rentInputErgoTrees.has(output.ergoTree) && output.ergoTree !== MINER_FEE_ERGO_TREE;
  const collectorOutputs = transaction.outputs.filter(isCollectorOutput);
  const minerOutputs = transaction.outputs.filter(
    (output) =>
      !rentInputErgoTrees.has(output.ergoTree) && output.ergoTree === MINER_FEE_ERGO_TREE,
  );
  const resolvedOutputs: TransactionBox[] = [...minerOutputs];
  const chainTxIds = new Set<string>();

  for (const output of collectorOutputs) {
    const resolution = await resolveChainedOutputs(
      nodeUrl,
      output,
      blockContext,
      isCollectorOutput,
    );
    resolution.outputs.forEach((resolvedOutput) => resolvedOutputs.push(resolvedOutput));
    resolution.chainTxIds.forEach((txId) => chainTxIds.add(txId));
  }

  const { collectors, minerFees, collectedAssets } = buildRecipientGroups(
    rentInputErgoTrees,
    collectorInputNanoErgByErgoTree,
    collectorInputAssetsByErgoTree,
    resolvedOutputs,
  );

  return {
    txId: transaction.id,
    blockId: transaction.blockId,
    blockHeight: transaction.inclusionHeight,
    timestamp: transaction.timestamp,
    txIndex: transaction.index,
    rentInputCount,
    chainTxIds: sortTxIdsByBlockOrder(chainTxIds, blockContext),
    collectors,
    minerFees,
    collectedAssets,
    totalCollectorNanoErg: collectors.reduce((sum, recipient) => sum + recipient.nanoErg, 0),
    totalMinerNanoErg: minerFees.reduce((sum, recipient) => sum + recipient.nanoErg, 0),
  };
};

export const accumulateLoadedStats = (
  previous: LoadedStats | null,
  scannedBlocks: number,
  events: RentCollectionEvent[],
  highestHeight: number | null,
  lowestHeight: number | null,
): LoadedStats => {
  const base = previous ?? createEmptyStats();
  const collectorAddresses = new Set(base.collectorAddresses);

  events.forEach((event) => {
    event.collectors.forEach((collector) => collectorAddresses.add(collector.address));
  });

  return {
    scannedBlocks: base.scannedBlocks + scannedBlocks,
    rentTransactions: base.rentTransactions + events.length,
    rentInputs: base.rentInputs + events.reduce((sum, event) => sum + event.rentInputCount, 0),
    uniqueCollectorAddresses: collectorAddresses.size,
    totalCollectorNanoErg:
      base.totalCollectorNanoErg +
      events.reduce((sum, event) => sum + event.totalCollectorNanoErg, 0),
    totalMinerNanoErg:
      base.totalMinerNanoErg +
      events.reduce((sum, event) => sum + event.totalMinerNanoErg, 0),
    highestHeight:
      base.highestHeight === null
        ? highestHeight
        : highestHeight === null
          ? base.highestHeight
          : Math.max(base.highestHeight, highestHeight),
    lowestHeight:
      base.lowestHeight === null
        ? lowestHeight
        : lowestHeight === null
          ? base.lowestHeight
          : Math.min(base.lowestHeight, lowestHeight),
    collectorAddresses: Array.from(collectorAddresses),
  };
};

const fetchProcessedBlock = async (nodeUrl: string, header: BlockHeader) => {
  hydrateProcessedBlockCache();

  const cachedBlock = processedBlockCache.get(header.id);
  if (cachedBlock) {
    return cachedBlock;
  }

  if (!processedBlockRequestCache.has(header.id)) {
    const request = (async () => {
      const blockTransactions = await fetchBlockTransactions(nodeUrl, header.id);
      const blockContext = buildBlockChainContext(blockTransactions);
      const rentTransactionIds = blockTransactions.transactions
        .filter((transaction) =>
          transaction.inputs.some((input) => hasRentMarker(input.spendingProof?.extension)),
        )
        .map((transaction) => transaction.id);
      const detailedTransactions = await Promise.all(
        rentTransactionIds.map((txId) => fetchIndexedTransaction(nodeUrl, txId)),
      );
      const events = await Promise.all(
        detailedTransactions.map((transaction) => buildEvent(nodeUrl, transaction, blockContext)),
      );

      events.sort((left, right) => right.txIndex - left.txIndex);

      const processedBlock: CachedProcessedBlock = {
        headerId: header.id,
        height: header.height,
        events,
      };

      processedBlockCache.set(header.id, processedBlock);
      persistProcessedBlockCache();

      return processedBlock;
    })().finally(() => {
      processedBlockRequestCache.delete(header.id);
    });

    processedBlockRequestCache.set(header.id, request);
  }

  return processedBlockRequestCache.get(header.id)!;
};

export const fetchRentCollectionRange = async (
  nodeUrl: string,
  fromHeight: number,
  toHeight: number,
): Promise<RentCollectionRange> => {
  if (toHeight < fromHeight) {
    return { events: [], scannedBlocks: 0, highestHeight: null, lowestHeight: null };
  }

  const headers = await fetchBlockHeaders(nodeUrl, fromHeight, toHeight);
  if (!headers.length) {
    return { events: [], scannedBlocks: 0, highestHeight: null, lowestHeight: null };
  }

  const sortedHeaders = [...headers].sort((left, right) => right.height - left.height);
  const processedBlocks = await Promise.all(
    sortedHeaders.map((header) => fetchProcessedBlock(nodeUrl, header)),
  );
  const events = processedBlocks.flatMap((processedBlock) => processedBlock.events);

  events.sort((left, right) => right.blockHeight - left.blockHeight || right.txIndex - left.txIndex);

  return {
    events,
    scannedBlocks: headers.length,
    highestHeight: sortedHeaders[0]?.height ?? null,
    lowestHeight: sortedHeaders[sortedHeaders.length - 1]?.height ?? null,
  };
};

export const fetchNodeInfo = async (nodeUrl: string) => {
  const info = await fetchJson<ErgoNodeInfo>(`${nodeUrl}/info`);
  return {
    name: info.name,
    network: info.network,
    fullHeight: info.fullHeight,
    headersHeight: info.headersHeight,
    bestHeaderId: info.bestHeaderId,
  };
};

export const fetchRentCollectionSlice = async (
  nodeUrl: string,
  fromHeight: number,
  previousStats: LoadedStats | null = null,
): Promise<RentCollectionSlice> => {
  const toHeight = Math.max(0, fromHeight);
  const sliceFromHeight = Math.max(0, toHeight - (BLOCK_SLICE_SIZE - 1));
  const range = await fetchRentCollectionRange(nodeUrl, sliceFromHeight, toHeight);

  if (!range.scannedBlocks) {
    return {
      events: [],
      stats: previousStats ?? createEmptyStats(),
      nextHeight: null,
      hasMore: false,
    };
  }

  const stats = accumulateLoadedStats(
    previousStats,
    range.scannedBlocks,
    range.events,
    range.highestHeight,
    range.lowestHeight,
  );
  const nextHeight = sliceFromHeight > 0 ? sliceFromHeight - 1 : null;

  return {
    events: range.events,
    stats,
    nextHeight,
    hasMore: nextHeight !== null,
  };
};
