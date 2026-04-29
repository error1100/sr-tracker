import { BLOCK_SLICE_SIZE, MINER_FEE_ERGO_TREE } from '../config';
import type {
  BlockHeader,
  ErgoAsset,
  ErgoNodeInfo,
  IndexedBlock,
  IndexedHeightInfo,
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
  highestBlockTimestamp: number | null;
  lowestBlockTimestamp: number | null;
}

interface BlockChainContext {
  spendByBoxId: Map<string, string>;
  txOrder: Map<string, number>;
  txById: Map<string, IndexedTransaction>;
}

interface CachedProcessedBlock {
  headerId: string;
  height: number;
  events: RentCollectionEvent[];
}

const processedBlockCache = new Map<string, CachedProcessedBlock>();
const processedBlockRequestCache = new Map<string, Promise<CachedProcessedBlock>>();

const PROCESSED_BLOCK_CACHE_KEY = 'sr-tracker:processed-blocks:v3';
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
  highestBlockTimestamp: null,
  lowestBlockTimestamp: null,
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

const fetchIndexedHeight = async (nodeUrl: string, info?: ErgoNodeInfo | null) => {
  if (typeof info?.indexedHeight === 'number') {
    return info.indexedHeight;
  }

  const indexedHeightInfo = await fetchJson<IndexedHeightInfo>(
    `${nodeUrl}/blockchain/indexedHeight`,
  );
  return indexedHeightInfo.indexedHeight;
};

const fetchIndexedBlock = async (nodeUrl: string, headerId: string) =>
  fetchJson<IndexedBlock>(`${nodeUrl}/blockchain/block/byHeaderId/${headerId}`);

const buildBlockChainContext = (transactions: IndexedTransaction[]): BlockChainContext => {
  const txOrder = new Map<string, number>();
  const spendByBoxId = new Map<string, string>();
  const txById = new Map<string, IndexedTransaction>();

  transactions.forEach((transaction, index) => {
    txOrder.set(transaction.id, index);
    txById.set(transaction.id, transaction);
  });

  transactions.forEach((transaction) => {
    transaction.inputs.forEach((input) => {
      spendByBoxId.set(input.boxId, transaction.id);
    });
  });

  return { spendByBoxId, txOrder, txById };
};

interface ResolvedOutputs {
  outputs: TransactionBox[];
  chainTxIds: Set<string>;
}

type CollectorOutputMatcher = (output: TransactionBox) => boolean;

interface RecipientAccumulator {
  kind: RecipientSummary['kind'];
  address: string;
  nanoErg: number;
  outputCount: number;
  assetAmounts: Map<string, number>;
}

const sortTxIdsByBlockOrder = (txIds: Iterable<string>, blockContext: BlockChainContext) =>
  Array.from(new Set(txIds)).sort(
    (left, right) => (blockContext.txOrder.get(left) ?? 0) - (blockContext.txOrder.get(right) ?? 0),
  );

const resolveChainedOutputs = (
  output: TransactionBox,
  blockContext: BlockChainContext,
  isCollectorOutput: CollectorOutputMatcher,
  visitedTxIds = new Set<string>(),
): ResolvedOutputs => {
  const spendTxId = blockContext.spendByBoxId.get(output.boxId);
  if (!spendTxId || visitedTxIds.has(spendTxId)) {
    return { outputs: [output], chainTxIds: new Set<string>() };
  }

  const spendingTransaction = blockContext.txById.get(spendTxId);
  if (!spendingTransaction) {
    return { outputs: [output], chainTxIds: new Set<string>() };
  }

  if (spendingTransaction.inputs.length !== 1) {
    return { outputs: [output], chainTxIds: new Set<string>() };
  }

  const nextVisitedTxIds = new Set(visitedTxIds);
  nextVisitedTxIds.add(spendTxId);

  const chainTxIds = new Set<string>([spendTxId]);
  const resolvedOutputs: TransactionBox[] = [];

  for (const childOutput of spendingTransaction.outputs) {
    if (!isCollectorOutput(childOutput)) {
      resolvedOutputs.push(childOutput);
      continue;
    }

    const childResolution = resolveChainedOutputs(
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

const finalizeRecipients = (recipients: Map<string, RecipientAccumulator>) =>
  Array.from(recipients.values()).map((recipient) => ({
    kind: recipient.kind,
    address: recipient.address,
    nanoErg: recipient.nanoErg,
    outputCount: recipient.outputCount,
    assets: buildAssetSummaries(recipient.assetAmounts),
  }));

const buildRecipientGroups = (
  excludedRentInputTrees: Set<string>,
  collectorInputNanoErgByAddress: Map<string, number>,
  collectorInputAssetsByAddress: Map<string, Map<string, number>>,
  resolvedOutputs: TransactionBox[],
) => {
  const collectorRecipients = new Map<string, RecipientAccumulator>();
  const minerRecipients = new Map<string, RecipientAccumulator>();

  resolvedOutputs.forEach((output) => {
    if (excludedRentInputTrees.has(output.ergoTree)) {
      return;
    }

    const address = output.address;

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
        nanoErg: output.value,
        outputCount: 1,
        assetAmounts: new Map(output.assets.map((asset) => [asset.tokenId, asset.amount])),
      });
      return;
    }

    const existingCollector = collectorRecipients.get(address);
    if (existingCollector) {
      existingCollector.nanoErg += output.value;
      existingCollector.outputCount += 1;
      addAssetAmounts(existingCollector.assetAmounts, output.assets);
      return;
    }

    collectorRecipients.set(address, {
      kind: 'collector',
      address,
      nanoErg: output.value,
      outputCount: 1,
      assetAmounts: new Map(output.assets.map((asset) => [asset.tokenId, asset.amount])),
    });
  });

  collectorInputNanoErgByAddress.forEach((inputNanoErg, address) => {
    const existingCollector = collectorRecipients.get(address);
    const inputAssetAmounts = collectorInputAssetsByAddress.get(address) ?? new Map<string, number>();

    if (existingCollector) {
      existingCollector.nanoErg -= inputNanoErg;
      mergeAssetAmounts(existingCollector.assetAmounts, inputAssetAmounts, -1);
      return;
    }

    collectorRecipients.set(address, {
      kind: 'collector',
      address,
      nanoErg: -inputNanoErg,
      outputCount: 0,
      assetAmounts: new Map(
        Array.from(inputAssetAmounts.entries()).map(([tokenId, amount]) => [tokenId, -amount]),
      ),
    });
  });

  const collectors = finalizeRecipients(collectorRecipients).sort(sortRecipients);
  const minerFees = finalizeRecipients(minerRecipients).sort(sortRecipients);
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

const buildEvent = (
  transaction: IndexedTransaction,
  blockContext: BlockChainContext,
): RentCollectionEvent => {
  const rentInputs = transaction.inputs.filter((input) =>
    hasRentMarker(input.spendingProof?.extension),
  );
  const rentInputCount = rentInputs.length;
  const excludedRentInputTrees = new Set(rentInputs.map((input) => input.ergoTree));
  const collectorInputNanoErgByAddress = new Map<string, number>();
  const collectorInputAssetsByAddress = new Map<string, Map<string, number>>();

  transaction.inputs.forEach((input) => {
    if (hasRentMarker(input.spendingProof?.extension) || input.ergoTree === MINER_FEE_ERGO_TREE) {
      return;
    }

    collectorInputNanoErgByAddress.set(
      input.address,
      (collectorInputNanoErgByAddress.get(input.address) ?? 0) + input.value,
    );

    if (!collectorInputAssetsByAddress.has(input.address)) {
      collectorInputAssetsByAddress.set(input.address, new Map());
    }

    addAssetAmounts(collectorInputAssetsByAddress.get(input.address)!, input.assets);
  });

  const isCollectorOutput = (output: TransactionBox) =>
    !excludedRentInputTrees.has(output.ergoTree) && output.ergoTree !== MINER_FEE_ERGO_TREE;
  const collectorOutputs = transaction.outputs.filter(isCollectorOutput);
  const minerOutputs = transaction.outputs.filter(
    (output) =>
      !excludedRentInputTrees.has(output.ergoTree) && output.ergoTree === MINER_FEE_ERGO_TREE,
  );
  const resolvedOutputs: TransactionBox[] = [...minerOutputs];
  const chainTxIds = new Set<string>();

  for (const output of collectorOutputs) {
    const resolution = resolveChainedOutputs(output, blockContext, isCollectorOutput);
    resolution.outputs.forEach((resolvedOutput) => resolvedOutputs.push(resolvedOutput));
    resolution.chainTxIds.forEach((txId) => chainTxIds.add(txId));
  }

  const { collectors, minerFees, collectedAssets } = buildRecipientGroups(
    excludedRentInputTrees,
    collectorInputNanoErgByAddress,
    collectorInputAssetsByAddress,
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
  highestBlockTimestamp: number | null,
  lowestBlockTimestamp: number | null,
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
    highestBlockTimestamp:
      base.highestBlockTimestamp === null
        ? highestBlockTimestamp
        : highestBlockTimestamp === null
          ? base.highestBlockTimestamp
          : Math.max(base.highestBlockTimestamp, highestBlockTimestamp),
    lowestBlockTimestamp:
      base.lowestBlockTimestamp === null
        ? lowestBlockTimestamp
        : lowestBlockTimestamp === null
          ? base.lowestBlockTimestamp
          : Math.min(base.lowestBlockTimestamp, lowestBlockTimestamp),
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
      const indexedBlock = await fetchIndexedBlock(nodeUrl, header.id);
      const blockContext = buildBlockChainContext(indexedBlock.transactions);
      const events = indexedBlock.transactions
        .filter((transaction) =>
          transaction.inputs.some((input) => hasRentMarker(input.spendingProof?.extension)),
        )
        .map((transaction) => buildEvent(transaction, blockContext));

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
  indexedHeight?: number,
): Promise<RentCollectionRange> => {
  const effectiveIndexedHeight =
    typeof indexedHeight === 'number' ? indexedHeight : await fetchIndexedHeight(nodeUrl);
  const normalizedFromHeight = Math.max(0, fromHeight);
  const normalizedToHeight = Math.min(Math.max(0, toHeight), effectiveIndexedHeight);

  if (normalizedToHeight < normalizedFromHeight) {
    return {
      events: [],
      scannedBlocks: 0,
      highestHeight: null,
      lowestHeight: null,
      highestBlockTimestamp: null,
      lowestBlockTimestamp: null,
    };
  }

  const headers = await fetchBlockHeaders(nodeUrl, normalizedFromHeight, normalizedToHeight);
  if (!headers.length) {
    return {
      events: [],
      scannedBlocks: 0,
      highestHeight: null,
      lowestHeight: null,
      highestBlockTimestamp: null,
      lowestBlockTimestamp: null,
    };
  }

  const sortedHeaders = [...headers].sort((left, right) => right.height - left.height);
  const headerTimestamps = sortedHeaders.map((header) => header.timestamp);
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
    highestBlockTimestamp: Math.max(...headerTimestamps),
    lowestBlockTimestamp: Math.min(...headerTimestamps),
  };
};

export const fetchNodeInfo = async (nodeUrl: string) => {
  const info = await fetchJson<ErgoNodeInfo>(`${nodeUrl}/info`);
  const indexedHeight = await fetchIndexedHeight(nodeUrl, info);

  return {
    fullHeight: info.fullHeight,
    bestHeaderId: info.bestHeaderId,
    indexedHeight,
  };
};

export const fetchRentCollectionSlice = async (
  nodeUrl: string,
  fromHeight: number,
  previousStats: LoadedStats | null = null,
  indexedHeight?: number,
): Promise<RentCollectionSlice> => {
  const effectiveIndexedHeight =
    typeof indexedHeight === 'number' ? indexedHeight : await fetchIndexedHeight(nodeUrl);
  const toHeight = Math.max(0, Math.min(fromHeight, effectiveIndexedHeight));
  const sliceFromHeight = Math.max(0, toHeight - (BLOCK_SLICE_SIZE - 1));
  const range = await fetchRentCollectionRange(
    nodeUrl,
    sliceFromHeight,
    toHeight,
    effectiveIndexedHeight,
  );
  const nextHeight = sliceFromHeight > 0 ? sliceFromHeight - 1 : null;

  if (!range.scannedBlocks) {
    return {
      events: [],
      stats: previousStats ?? createEmptyStats(),
      nextHeight,
      hasMore: nextHeight !== null,
    };
  }

  const stats = accumulateLoadedStats(
    previousStats,
    range.scannedBlocks,
    range.events,
    range.highestHeight,
    range.lowestHeight,
    range.highestBlockTimestamp,
    range.lowestBlockTimestamp,
  );
  return {
    events: range.events,
    stats,
    nextHeight,
    hasMore: nextHeight !== null,
  };
};
