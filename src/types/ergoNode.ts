export interface ErgoNodeInfo {
  name: string;
  network: string;
  fullHeight: number;
  headersHeight: number;
  bestHeaderId: string;
  indexedHeight?: number;
  maxIndexedHeight?: number;
}

export interface BlockHeader {
  id: string;
  height: number;
  timestamp: number;
}

export interface SpendingProof {
  proofBytes?: string;
  extension?: Record<string, string>;
}

export interface ErgoAsset {
  tokenId: string;
  amount: number;
}

export interface BlockTransactionInput {
  boxId: string;
  spendingProof?: SpendingProof | null;
}

export interface BlockTransactionOutput {
  boxId: string;
  value: number;
  ergoTree: string;
  assets: ErgoAsset[];
  creationHeight: number;
  transactionId: string;
  index: number;
}

export interface BlockTransactionSummary {
  id: string;
  inputs: BlockTransactionInput[];
  dataInputs: { boxId: string }[];
  outputs: BlockTransactionOutput[];
  size: number;
}

export interface BlockTransactions {
  headerId: string;
  transactions: BlockTransactionSummary[];
  blockVersion: number;
  size: number;
}

export interface TransactionBox {
  boxId: string;
  value: number;
  ergoTree: string;
  address: string;
  assets: ErgoAsset[];
  creationHeight: number;
  transactionId: string;
  index: number;
  spendingProof?: SpendingProof | null;
}

export interface IndexedTransaction {
  id: string;
  blockId: string;
  inclusionHeight: number;
  timestamp: number;
  index: number;
  globalIndex: number;
  numConfirmations: number;
  inputs: TransactionBox[];
  dataInputs: { boxId: string }[];
  outputs: TransactionBox[];
  size: number;
}

export interface IndexedBlock {
  header: BlockHeader;
  transactions: IndexedTransaction[];
  height: number;
  size: number;
}

export interface IndexedHeightInfo {
  indexedHeight: number;
  fullHeight?: number;
}

export interface IndexedToken {
  id: string;
  boxId: string;
  emissionAmount: number;
  name: string;
  description: string;
  decimals: number;
}
