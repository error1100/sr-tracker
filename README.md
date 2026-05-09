# Storage Rent Tracker

React + Vite frontend for scanning Ergo blocks newest-first and summarizing storage-rent collection transactions.

## How It Works

1. Reads the current chain tip from `/info`.
2. Reads the indexed height from `info.indexedHeight` when present, otherwise from `/blockchain/indexedHeight`.
3. Pulls block headers in configurable block slices from `/blocks/chainSlice`.
4. Processes only blocks at or below the indexed height.
5. Loads full indexed block payloads from `/blockchain/block/byHeaderId/{headerId}`.
6. Detects storage-rent transactions by checking `inputs[].spendingProof.extension["127"]`.

## Recipient Logic

- Rent-marked input scripts define the set that should be filtered from outputs.
- Outputs that are not in that rent-input script set are treated as recipients.
- Recipient grouping and netting are done by address from the indexed block payload.
- Miner outputs are identified by the miner-fee script.
- Collector totals are net values:
  - collector outputs
  - minus non-rent collector inputs
- Collector asset totals are also net:
  - collected output assets
  - minus assets from non-rent collector inputs
- Net collector ERG can be negative when a collector adds extra value to complete the transaction.
- Daily address totals assign each transaction's net collector ERG to collector output
  addresses. Non-rent collector inputs are treated as transaction funding, so a later
  storage-rent transaction does not move an earlier day's collected amount away from
  the address that originally received it.

## Same-Block Chain Handling

- Only collector outputs participate in same-block chain resolution.
- If a collector output is spent later in the same block by a single-input transaction, that child transaction is folded back into the original storage-rent row.
- Chained tx ids are shown under the storage-rent tx id.
- Adjusted collector and miner values reflect those same-block spends.

## Address And Metadata Sources

- Recipient addresses come directly from indexed block inputs and outputs.
- Block miner addresses come from the already-loaded indexed block/header payload.
- Token metadata is loaded lazily and cached locally in the browser.

## Caching And Refresh

- Processed blocks are cached locally by immutable block `headerId`.
- Auto-refresh is enabled by default and checks for newly indexed blocks every 30 seconds.
- When the indexed height advances, only the newly indexed block range is fetched and prepended.

## Development

```bash
npm install
npm run dev
```

## Production Build

```bash
npm run build
```
