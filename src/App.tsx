import { startTransition, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { DEFAULT_ERGO_NODE_URL, EXPLORER_UI_URL } from './config';
import {
  accumulateLoadedStats,
  fetchNodeInfo,
  fetchRentCollectionRange,
  fetchRentCollectionSlice,
  type RentCollectionSlice,
} from './services/rentService';
import {
  getCachedTokenMetadata,
  loadTokenMetadata,
} from './services/tokenService';
import type { IndexedToken } from './types/ergoNode';
import type { LoadedStats, RentCollectionEvent } from './types/rent';
import {
  formatAssetAmount,
  formatCount,
  formatErg,
  formatHeightRange,
  formatTokenLabel,
  shortenId,
} from './utils/format';

interface AppState {
  nodeInfo: Awaited<ReturnType<typeof fetchNodeInfo>> | null;
  events: RentCollectionEvent[];
  stats: LoadedStats;
  nextHeight: number | null;
  hasMore: boolean;
  loadingInitial: boolean;
  loadingMore: boolean;
  error: string | null;
}

const emptyStats: LoadedStats = {
  scannedBlocks: 0,
  rentTransactions: 0,
  rentInputs: 0,
  uniqueCollectorAddresses: 0,
  totalCollectorNanoErg: 0,
  totalMinerNanoErg: 0,
  highestHeight: null,
  lowestHeight: null,
  collectorAddresses: [],
};

const initialState: AppState = {
  nodeInfo: null,
  events: [],
  stats: emptyStats,
  nextHeight: null,
  hasMore: false,
  loadingInitial: true,
  loadingMore: false,
  error: null,
};

const mergeSlice = (state: AppState, slice: RentCollectionSlice): AppState => ({
  ...state,
  events: [...state.events, ...slice.events],
  stats: slice.stats,
  nextHeight: slice.nextHeight,
  hasMore: slice.hasMore,
  loadingInitial: false,
  loadingMore: false,
  error: null,
});

const sortEvents = (left: RentCollectionEvent, right: RentCollectionEvent) =>
  right.blockHeight - left.blockHeight || right.txIndex - left.txIndex;

const prependLatestEvents = (
  currentEvents: RentCollectionEvent[],
  incomingEvents: RentCollectionEvent[],
) => {
  const mergedEvents = new Map<string, RentCollectionEvent>();

  incomingEvents.forEach((event) => {
    mergedEvents.set(event.txId, event);
  });
  currentEvents.forEach((event) => {
    if (!mergedEvents.has(event.txId)) {
      mergedEvents.set(event.txId, event);
    }
  });

  return Array.from(mergedEvents.values()).sort(sortEvents);
};

const rankRecipients = (event: RentCollectionEvent) =>
  [...event.collectors, ...event.minerFees].sort(
    (left, right) =>
      right.nanoErg - left.nanoErg ||
      left.kind.localeCompare(right.kind) ||
      left.address.localeCompare(right.address),
  );

const recipientLabel = (kind: RentCollectionEvent['collectors'][number]['kind']) =>
  kind === 'minerFee' ? 'Miner fee' : 'Collector';

const recipientShortLabel = (kind: RentCollectionEvent['collectors'][number]['kind']) =>
  kind === 'minerFee' ? 'M' : 'C';

const formatRecipientAddress = (address: string) =>
  address.length > 80 ? shortenId(address, 24) : address;

function App() {
  const [state, setState] = useState<AppState>(initialState);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(true);
  const [tokenMetadata, setTokenMetadata] = useState<Record<string, IndexedToken>>(
    () => getCachedTokenMetadata(),
  );
  const stateRef = useRef(state);
  const bootstrappedRef = useRef(false);
  const pollInFlightRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const reloadLatestRef = useRef<() => Promise<void>>(async () => {});
  const loadMoreRef = useRef<() => Promise<void>>(async () => {});
  const checkForNewBlocksRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const loadSlice = async (
    fromHeight: number,
    previousStats: LoadedStats | null,
    reset: boolean,
  ) => {
    try {
      const slice = await fetchRentCollectionSlice(
        DEFAULT_ERGO_NODE_URL,
        fromHeight,
        previousStats,
      );
      startTransition(() => {
        setState((current) => {
          if (reset) {
            return {
              ...current,
              events: slice.events,
              stats: slice.stats,
              nextHeight: slice.nextHeight,
              hasMore: slice.hasMore,
              loadingInitial: false,
              loadingMore: false,
              error: null,
            };
          }
          return mergeSlice(current, slice);
        });
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to load storage-rent data.';
      setState((current) => ({
        ...current,
        loadingInitial: false,
        loadingMore: false,
        error: message,
      }));
    }
  };

  const reloadLatest = async () => {
    setState((current) => ({
      ...current,
      events: [],
      stats: emptyStats,
      nextHeight: null,
      hasMore: false,
      loadingInitial: true,
      loadingMore: false,
      error: null,
    }));

    try {
      const nodeInfo = await fetchNodeInfo(DEFAULT_ERGO_NODE_URL);
      setState((current) => ({ ...current, nodeInfo }));
      await loadSlice(nodeInfo.fullHeight, null, true);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to fetch current node height.';
      setState((current) => ({
        ...current,
        loadingInitial: false,
        error: message,
      }));
    }
  };

  const loadMore = async () => {
    const snapshot = stateRef.current;
    if (
      snapshot.loadingInitial ||
      snapshot.loadingMore ||
      !snapshot.hasMore ||
      snapshot.nextHeight === null
    ) {
      return;
    }

    setState((current) => ({ ...current, loadingMore: true, error: null }));
    await loadSlice(snapshot.nextHeight, snapshot.stats, false);
  };

  const checkForNewBlocks = async () => {
    const snapshot = stateRef.current;
    if (
      !autoRefreshEnabled ||
      snapshot.loadingInitial ||
      snapshot.loadingMore ||
      pollInFlightRef.current
    ) {
      return;
    }

    pollInFlightRef.current = true;

    try {
      const latestNodeInfo = await fetchNodeInfo(DEFAULT_ERGO_NODE_URL);
      const previousNodeInfo = snapshot.nodeInfo;

      if (!previousNodeInfo) {
        setState((current) => ({ ...current, nodeInfo: latestNodeInfo }));
        return;
      }

      if (
        latestNodeInfo.fullHeight === previousNodeInfo.fullHeight &&
        latestNodeInfo.bestHeaderId === previousNodeInfo.bestHeaderId
      ) {
        setState((current) =>
          current.nodeInfo?.bestHeaderId === latestNodeInfo.bestHeaderId &&
          current.nodeInfo?.fullHeight === latestNodeInfo.fullHeight
            ? current
            : { ...current, nodeInfo: latestNodeInfo },
        );
        return;
      }

      if (latestNodeInfo.fullHeight <= previousNodeInfo.fullHeight) {
        await reloadLatestRef.current();
        return;
      }

      const range = await fetchRentCollectionRange(
        DEFAULT_ERGO_NODE_URL,
        previousNodeInfo.fullHeight + 1,
        latestNodeInfo.fullHeight,
      );

      startTransition(() => {
        setState((current) => {
          if ((current.nodeInfo?.fullHeight ?? -1) >= latestNodeInfo.fullHeight) {
            return {
              ...current,
              nodeInfo: latestNodeInfo,
              error: null,
            };
          }

          return {
            ...current,
            nodeInfo: latestNodeInfo,
            events: prependLatestEvents(current.events, range.events),
            stats: accumulateLoadedStats(
              current.stats,
              range.scannedBlocks,
              range.events,
              range.highestHeight,
              range.lowestHeight,
            ),
            error: null,
          };
        });
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to check for new blocks.';
      setState((current) => ({
        ...current,
        error: message,
      }));
    } finally {
      pollInFlightRef.current = false;
    }
  };

  useEffect(() => {
    reloadLatestRef.current = reloadLatest;
    loadMoreRef.current = loadMore;
    checkForNewBlocksRef.current = checkForNewBlocks;
  });

  useEffect(() => {
    if (bootstrappedRef.current) {
      return;
    }
    bootstrappedRef.current = true;
    void reloadLatestRef.current();
  }, []);

  useEffect(() => {
    const target = sentinelRef.current;
    if (!target) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        if (entry?.isIntersecting) {
          void loadMoreRef.current();
        }
      },
      { rootMargin: '900px 0px' },
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!autoRefreshEnabled) {
      return;
    }

    void checkForNewBlocksRef.current();

    const intervalId = window.setInterval(() => {
      void checkForNewBlocksRef.current();
    }, 30000);

    return () => window.clearInterval(intervalId);
  }, [autoRefreshEnabled]);

  const headerRange = useMemo(
    () => formatHeightRange(state.stats.highestHeight, state.stats.lowestHeight),
    [state.stats.highestHeight, state.stats.lowestHeight],
  );
  const recipientAssetTokenIds = useMemo(
    () =>
      Array.from(
        new Set(
          state.events.flatMap((event) =>
            [...event.collectors, ...event.minerFees].flatMap((recipient) =>
              recipient.assets.map((asset) => asset.tokenId),
            ),
          ),
        ),
      ),
    [state.events],
  );

  useEffect(() => {
    if (!recipientAssetTokenIds.length) {
      return;
    }

    let cancelled = false;

    void loadTokenMetadata(DEFAULT_ERGO_NODE_URL, recipientAssetTokenIds)
      .then((loadedMetadata) => {
        if (cancelled || !Object.keys(loadedMetadata).length) {
          return;
        }

        setTokenMetadata((current) => {
          const hasChanges = Object.entries(loadedMetadata).some(
            ([tokenId, metadata]) => current[tokenId] !== metadata,
          );

          if (!hasChanges) {
            return current;
          }

          return {
            ...current,
            ...loadedMetadata,
          };
        });
      })
      .catch(() => {
        // Keep the table responsive even if some token metadata cannot be resolved.
      });

    return () => {
      cancelled = true;
    };
  }, [recipientAssetTokenIds]);

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">Ergo Storage Rent</p>
          <h1>SR tracker</h1>
        </div>
        <div className="hero-actions">
          <button className="primary-button" onClick={() => void reloadLatestRef.current()}>
            Refresh latest
          </button>
          <label className="auto-refresh-toggle">
            <input
              checked={autoRefreshEnabled}
              onChange={(event) => setAutoRefreshEnabled(event.target.checked)}
              type="checkbox"
            />
            <span>Auto-refresh</span>
          </label>
        </div>
      </section>

      <section className="stats-grid">
        <article className="stat-card">
          <span className="label">Current Height</span>
          <strong>{state.nodeInfo ? formatCount(state.nodeInfo.fullHeight) : '...'}</strong>
          <p>{state.nodeInfo?.name ?? DEFAULT_ERGO_NODE_URL}</p>
        </article>
        <article className="stat-card">
          <span className="label">Loaded Range</span>
          <strong>{headerRange}</strong>
          <p>{formatCount(state.stats.scannedBlocks)} scanned blocks</p>
        </article>
        <article className="stat-card">
          <span className="label">Rent Transactions</span>
          <strong>{formatCount(state.stats.rentTransactions)}</strong>
          <p>{formatCount(state.stats.rentInputs)} rent-marked inputs</p>
        </article>
        <article className="stat-card">
          <span className="label">Collector</span>
          <strong>{formatErg(state.stats.totalCollectorNanoErg)}</strong>
          <p>After subtracting non-rent collector inputs in the loaded range</p>
        </article>
        <article className="stat-card stat-card-accent">
          <span className="label">Miner</span>
          <strong>{formatErg(state.stats.totalMinerNanoErg)}</strong>
          <p>Unmatched miner-fee outputs across loaded rent txs</p>
        </article>
      </section>

      {state.error ? <div className="error-banner">{state.error}</div> : null}

      {state.loadingInitial ? (
        <section className="empty-state">
          <h2>Loading latest storage-rent transactions</h2>
          <p>
            Pulling current height, recent block transactions, and detailed rent tx
            payloads.
          </p>
        </section>
      ) : null}

      {!state.loadingInitial && !state.events.length ? (
        <section className="empty-state">
          <h2>No storage-rent transactions found in the loaded range.</h2>
          <p>Scroll or press refresh to scan the latest 20-block slice again.</p>
        </section>
      ) : null}

      {state.events.length ? (
        <section className="events-table-shell">
          <div className="events-table-scroll">
            <table className="events-table">
              <thead>
                <tr>
                  <th>Tx</th>
                  <th>Recipient Summary</th>
                </tr>
              </thead>
              <tbody>
                {state.events.map((event) => {
                  const recipients = rankRecipients(event);

                  return (
                    <tr key={event.txId}>
                      <td className="tx-cell">
                        <div className="tx-stack">
                          <a
                            className="tx-link"
                            href={`${EXPLORER_UI_URL}/en/transactions/${event.txId}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {event.txId}
                          </a>
                          {event.chainTxIds.length ? (
                            <div className="chain-link-list">
                              {event.chainTxIds.map((chainTxId) => (
                                <a
                                  className="chain-link"
                                  href={`${EXPLORER_UI_URL}/en/transactions/${chainTxId}`}
                                  key={`${event.txId}-${chainTxId}`}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {chainTxId}
                                </a>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </td>
                      <td className="recipient-cell">
                        {recipients.length ? (
                          <div className="recipient-summary-list">
                            {recipients.map((recipient) => (
                              <a
                                className={`recipient-row recipient-row-${recipient.kind}`}
                                href={`${EXPLORER_UI_URL}/en/addresses/${recipient.address}`}
                                key={`${event.txId}-${recipient.kind}-${recipient.address}`}
                                target="_blank"
                                rel="noreferrer"
                                title={`${recipientLabel(recipient.kind)} | ${recipient.address} | ${formatErg(recipient.nanoErg)} | ${formatCount(recipient.outputCount)} outputs${recipient.assets.length ? ` | ${formatTokenLabel(recipient.assets.length)}` : ''}`}
                              >
                                <div className="recipient-row-main">
                                  <span className="recipient-row-identity">
                                    <span className="recipient-kind-badge">
                                      {recipientShortLabel(recipient.kind)}
                                    </span>
                                    <span className="recipient-row-address">
                                      {formatRecipientAddress(recipient.address)}
                                    </span>
                                  </span>
                                  <span className="recipient-row-erg">
                                    {formatErg(recipient.nanoErg)}
                                  </span>
                                </div>
                                {recipient.assets.length ? (
                                  <div className="recipient-row-assets">
                                    {recipient.assets.map((asset) => {
                                      const metadata = tokenMetadata[asset.tokenId];
                                      const assetName =
                                        metadata?.name.trim() || shortenId(asset.tokenId, 6);
                                      const assetAmount = formatAssetAmount(
                                        asset.amount,
                                        metadata?.decimals ?? 0,
                                      );

                                      return (
                                        <span
                                          className="recipient-asset-entry"
                                          key={`${event.txId}-${recipient.address}-${asset.tokenId}`}
                                          title={`${assetName} | ${asset.tokenId} | ${assetAmount}${metadata ? ` | ${formatCount(metadata.decimals)} decimals` : ''}`}
                                        >
                                          <span className="recipient-asset-entry-name">{assetName}</span>
                                          <span className="recipient-asset-entry-value">{assetAmount}</span>
                                        </span>
                                      );
                                    })}
                                  </div>
                                ) : null}
                              </a>
                            ))}
                          </div>
                        ) : (
                          <span className="recipient-empty">None</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <div ref={sentinelRef} className="scroll-sentinel" />

      {!state.loadingInitial && state.hasMore ? (
        <div className="load-more-panel">
          <button
            className="secondary-button"
            disabled={state.loadingMore}
            onClick={() => void loadMoreRef.current()}
          >
            {state.loadingMore ? 'Loading older blocks...' : 'Load older blocks'}
          </button>
        </div>
      ) : null}

      {!state.loadingInitial && !state.hasMore ? (
        <div className="load-more-panel">
          <p>Reached the start of chain scanning.</p>
        </div>
      ) : null}
    </main>
  );
}

export default App;
