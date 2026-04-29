export interface CollectedAssetSummary {
  tokenId: string;
  amount: number;
}

export interface RecipientSummary {
  kind: 'collector' | 'minerFee';
  address: string;
  nanoErg: number;
  outputCount: number;
  assets: CollectedAssetSummary[];
}

export interface RentCollectionEvent {
  txId: string;
  blockId: string;
  blockHeight: number;
  timestamp: number;
  txIndex: number;
  rentInputCount: number;
  chainTxIds: string[];
  collectors: RecipientSummary[];
  minerFees: RecipientSummary[];
  collectedAssets: CollectedAssetSummary[];
  totalCollectorNanoErg: number;
  totalMinerNanoErg: number;
}

export interface LoadedStats {
  scannedBlocks: number;
  rentTransactions: number;
  rentInputs: number;
  uniqueCollectorAddresses: number;
  totalCollectorNanoErg: number;
  totalMinerNanoErg: number;
  highestHeight: number | null;
  lowestHeight: number | null;
  highestBlockTimestamp: number | null;
  lowestBlockTimestamp: number | null;
  collectorAddresses: string[];
}
