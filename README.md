# Storage Rent Tracker

Static React + Vite frontend for scanning Ergo blocks in reverse order and summarizing storage-rent collection transactions.

## What It Does

- Reads the current node height from `/info`
- Pulls block headers in 20-block slices from `/blocks/chainSlice`
- Reads each block's transactions from `/blocks/{headerId}/transactions`
- Detects rent-collection transactions by checking `inputs[].spendingProof.extension["127"]`
- Hydrates only matching rent txs through `/blockchain/transaction/byId/{txId}`
- Matches inputs and outputs by `ergoTree`
- Shows only unmatched recipients:
  - collectors
  - miner-fee output, when present

## Development

```bash
npm install
npm run dev
```

## Production Build

```bash
npm run build
```
