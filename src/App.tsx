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
  formatDateTime,
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

type AppPage = 'transactions' | 'daily-addresses';

interface DailyAddressTotal {
  day: string;
  address: string;
  nanoErg: number;
  transactionCount: number;
  outputCount: number;
  highestHeight: number;
  lowestHeight: number;
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
  highestBlockTimestamp: null,
  lowestBlockTimestamp: null,
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

const NODE_API_BASE_URL_STORAGE_KEY = 'sr-tracker:node-api-base-url:v1';

const pageHashById: Record<AppPage, string> = {
  transactions: '#/transactions',
  'daily-addresses': '#/daily-addresses',
};

const normalizeNodeApiBaseUrl = (baseUrl: string) => {
  const normalizedUrl = (baseUrl.trim() || DEFAULT_ERGO_NODE_URL).replace(/\/+$/, '');
  return normalizedUrl || DEFAULT_ERGO_NODE_URL.replace(/\/+$/, '');
};

const canUseLocalStorage = () => {
  try {
    return typeof window !== 'undefined' && Boolean(window.localStorage);
  } catch {
    return false;
  }
};

const readPersistedNodeApiBaseUrl = () => {
  if (!canUseLocalStorage()) {
    return normalizeNodeApiBaseUrl(DEFAULT_ERGO_NODE_URL);
  }

  try {
    return normalizeNodeApiBaseUrl(
      window.localStorage.getItem(NODE_API_BASE_URL_STORAGE_KEY) ??
        DEFAULT_ERGO_NODE_URL,
    );
  } catch {
    return normalizeNodeApiBaseUrl(DEFAULT_ERGO_NODE_URL);
  }
};

const persistNodeApiBaseUrl = (baseUrl: string) => {
  if (!canUseLocalStorage()) {
    return;
  }

  try {
    window.localStorage.setItem(
      NODE_API_BASE_URL_STORAGE_KEY,
      normalizeNodeApiBaseUrl(baseUrl),
    );
  } catch {
    // Ignore storage failures. The active in-memory URL still works for this session.
  }
};

const readActivePageFromHash = (): AppPage => {
  if (typeof window === 'undefined') {
    return 'transactions';
  }

  return window.location.hash === pageHashById['daily-addresses']
    ? 'daily-addresses'
    : 'transactions';
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

interface CompactIdProps {
  value: string;
  visible?: number;
  mobileVisible?: number;
}

const CompactId = ({ value, visible = 10, mobileVisible = 5 }: CompactIdProps) => (
  <>
    <span className="compact-id-desktop">{shortenId(value, visible)}</span>
    <span className="compact-id-mobile">{shortenId(value, mobileVisible)}</span>
  </>
);

const getLocalDay = (timestamp: number) => {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
};

const getStartOfLocalDay = (timestamp = Date.now()) => {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);

  return date.getTime();
};

const hasLoadedBlockBeforeBoundary = (
  lowestBlockTimestamp: number | null,
  boundaryTimestamp: number,
) => lowestBlockTimestamp !== null && lowestBlockTimestamp < boundaryTimestamp;

const buildDailyAddressTotals = (events: RentCollectionEvent[]): DailyAddressTotal[] => {
  const totals = new Map<string, DailyAddressTotal>();

  events.forEach((event) => {
    const day = getLocalDay(event.timestamp);
    const dailyCollectors = event.dailyCollectors ?? event.collectors;

    dailyCollectors.forEach((collector) => {
      const key = `${day}:${collector.address}`;
      const existing = totals.get(key);

      if (existing) {
        existing.nanoErg += collector.nanoErg;
        existing.transactionCount += 1;
        existing.outputCount += collector.outputCount;
        existing.highestHeight = Math.max(existing.highestHeight, event.blockHeight);
        existing.lowestHeight = Math.min(existing.lowestHeight, event.blockHeight);
        return;
      }

      totals.set(key, {
        day,
        address: collector.address,
        nanoErg: collector.nanoErg,
        transactionCount: 1,
        outputCount: collector.outputCount,
        highestHeight: event.blockHeight,
        lowestHeight: event.blockHeight,
      });
    });
  });

  return Array.from(totals.values()).sort(
    (left, right) =>
      right.day.localeCompare(left.day) ||
      right.nanoErg - left.nanoErg ||
      left.address.localeCompare(right.address),
  );
};

function App() {
  const [state, setState] = useState<AppState>(initialState);
  const [activePage, setActivePage] = useState<AppPage>(() => readActivePageFromHash());
  const [nodeApiBaseUrl, setNodeApiBaseUrl] = useState(readPersistedNodeApiBaseUrl);
  const [nodeApiBaseUrlDraft, setNodeApiBaseUrlDraft] = useState(() => nodeApiBaseUrl);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(true);
  const [dailyLoadBoundaryTimestamp, setDailyLoadBoundaryTimestamp] = useState<number | null>(
    null,
  );
  const [tokenMetadata, setTokenMetadata] = useState<Record<string, IndexedToken>>(
    () => getCachedTokenMetadata(),
  );
  const stateRef = useRef(state);
  const nodeApiBaseUrlRef = useRef(nodeApiBaseUrl);
  const bootstrappedRef = useRef(false);
  const pollInFlightRef = useRef(false);
  const dailyAutoLoadAttemptHeightRef = useRef<number | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const reloadLatestRef = useRef<(baseUrl?: string) => Promise<void>>(async () => {});
  const loadMoreRef = useRef<() => Promise<void>>(async () => {});
  const checkForNewBlocksRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    nodeApiBaseUrlRef.current = nodeApiBaseUrl;
  }, [nodeApiBaseUrl]);

  const commitNodeApiBaseUrlDraft = (activate = false) => {
    const nextNodeApiBaseUrl = normalizeNodeApiBaseUrl(nodeApiBaseUrlDraft);

    setNodeApiBaseUrlDraft(nextNodeApiBaseUrl);
    persistNodeApiBaseUrl(nextNodeApiBaseUrl);

    if (activate) {
      nodeApiBaseUrlRef.current = nextNodeApiBaseUrl;
      setNodeApiBaseUrl(nextNodeApiBaseUrl);
    }

    return nextNodeApiBaseUrl;
  };

  useEffect(() => {
    const handleHashChange = () => {
      setActivePage(readActivePageFromHash());
    };

    handleHashChange();
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const loadSlice = async (
    fromHeight: number,
    previousStats: LoadedStats | null,
    reset: boolean,
    indexedHeight?: number,
    baseUrl = nodeApiBaseUrlRef.current,
  ) => {
    try {
      const slice = await fetchRentCollectionSlice(
        baseUrl,
        fromHeight,
        previousStats,
        indexedHeight,
      );

      if (nodeApiBaseUrlRef.current !== baseUrl) {
        return;
      }

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
      if (nodeApiBaseUrlRef.current !== baseUrl) {
        return;
      }

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

  const reloadLatest = async (baseUrl = nodeApiBaseUrlRef.current) => {
    dailyAutoLoadAttemptHeightRef.current = null;
    setDailyLoadBoundaryTimestamp(null);
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
      const nodeInfo = await fetchNodeInfo(baseUrl);
      if (nodeApiBaseUrlRef.current !== baseUrl) {
        return;
      }

      setState((current) => ({ ...current, nodeInfo }));
      await loadSlice(nodeInfo.indexedHeight, null, true, nodeInfo.indexedHeight, baseUrl);
    } catch (error) {
      if (nodeApiBaseUrlRef.current !== baseUrl) {
        return;
      }

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
    await loadSlice(
      snapshot.nextHeight,
      snapshot.stats,
      false,
      snapshot.nodeInfo?.indexedHeight,
      nodeApiBaseUrlRef.current,
    );
  };

  const loadOneMoreDay = () => {
    const lowestBlockTimestamp = stateRef.current.stats.lowestBlockTimestamp;

    dailyAutoLoadAttemptHeightRef.current = null;
    setDailyLoadBoundaryTimestamp(getStartOfLocalDay(lowestBlockTimestamp ?? Date.now()));
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
    const baseUrl = nodeApiBaseUrlRef.current;

    try {
      const latestNodeInfo = await fetchNodeInfo(baseUrl);
      if (nodeApiBaseUrlRef.current !== baseUrl) {
        return;
      }

      const previousNodeInfo = snapshot.nodeInfo;
      const latestIndexedHeight = latestNodeInfo.indexedHeight;
      const previousIndexedHeight = previousNodeInfo?.indexedHeight;

      if (!previousNodeInfo) {
        setState((current) => ({ ...current, nodeInfo: latestNodeInfo }));
        return;
      }

      if (
        latestNodeInfo.fullHeight === previousNodeInfo.fullHeight &&
        latestNodeInfo.bestHeaderId === previousNodeInfo.bestHeaderId &&
        latestIndexedHeight === previousIndexedHeight
      ) {
        setState((current) =>
          current.nodeInfo?.bestHeaderId === latestNodeInfo.bestHeaderId &&
          current.nodeInfo?.fullHeight === latestNodeInfo.fullHeight &&
          current.nodeInfo?.indexedHeight === latestIndexedHeight
            ? current
            : { ...current, nodeInfo: latestNodeInfo },
        );
        return;
      }

      if (
        latestNodeInfo.fullHeight < previousNodeInfo.fullHeight ||
        (typeof latestIndexedHeight === 'number' &&
          typeof previousIndexedHeight === 'number' &&
          latestIndexedHeight < previousIndexedHeight)
      ) {
        await reloadLatestRef.current();
        return;
      }

      if (
        typeof latestIndexedHeight !== 'number' ||
        typeof previousIndexedHeight !== 'number' ||
        latestIndexedHeight === previousIndexedHeight
      ) {
        setState((current) => ({
          ...current,
          nodeInfo: latestNodeInfo,
          error: null,
        }));
        return;
      }

      const range = await fetchRentCollectionRange(
        baseUrl,
        previousIndexedHeight + 1,
        latestIndexedHeight,
        latestIndexedHeight,
      );

      if (nodeApiBaseUrlRef.current !== baseUrl) {
        return;
      }

      startTransition(() => {
        setState((current) => {
          const currentIndexedHeight = current.nodeInfo?.indexedHeight ?? -1;
          if (currentIndexedHeight >= latestIndexedHeight) {
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
              range.highestBlockTimestamp,
              range.lowestBlockTimestamp,
            ),
            error: null,
          };
        });
      });
    } catch (error) {
      if (nodeApiBaseUrlRef.current !== baseUrl) {
        return;
      }

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
    if (activePage === 'daily-addresses') {
      return;
    }

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
  }, [activePage]);

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

  useEffect(() => {
    const loadBoundaryTimestamp = dailyLoadBoundaryTimestamp ?? getStartOfLocalDay();

    if (
      activePage !== 'daily-addresses' ||
      state.loadingInitial ||
      state.loadingMore ||
      !state.hasMore ||
      state.nextHeight === null ||
      hasLoadedBlockBeforeBoundary(state.stats.lowestBlockTimestamp, loadBoundaryTimestamp)
    ) {
      return;
    }

    if (state.error && dailyAutoLoadAttemptHeightRef.current === state.nextHeight) {
      return;
    }

    dailyAutoLoadAttemptHeightRef.current = state.nextHeight;
    void loadMoreRef.current();
  }, [
    activePage,
    dailyLoadBoundaryTimestamp,
    state.error,
    state.hasMore,
    state.loadingInitial,
    state.loadingMore,
    state.nextHeight,
    state.stats.lowestBlockTimestamp,
  ]);

  const headerRange = useMemo(
    () => formatHeightRange(state.stats.highestHeight, state.stats.lowestHeight),
    [state.stats.highestHeight, state.stats.lowestHeight],
  );
  const dailyAddressTotals = useMemo(
    () => buildDailyAddressTotals(state.events),
    [state.events],
  );
  const dailyAddressStats = useMemo(
    () => ({
      addressCount: new Set(dailyAddressTotals.map((total) => total.address)).size,
      dayCount: new Set(dailyAddressTotals.map((total) => total.day)).size,
      totalNanoErg: dailyAddressTotals.reduce((sum, total) => sum + total.nanoErg, 0),
    }),
    [dailyAddressTotals],
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

    void loadTokenMetadata(nodeApiBaseUrl, recipientAssetTokenIds)
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
  }, [nodeApiBaseUrl, recipientAssetTokenIds]);

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">Ergo Storage Rent</p>
          <h1>SR tracker</h1>
        </div>
        <div className="hero-actions">
          <form
            className="node-api-form"
            onSubmit={(event) => {
              event.preventDefault();
              void reloadLatestRef.current(commitNodeApiBaseUrlDraft(true));
            }}
          >
            <label className="node-api-control">
              <span>Node API</span>
              <input
                aria-label="Node API base URL"
                autoCapitalize="none"
                autoComplete="url"
                onBlur={() => commitNodeApiBaseUrlDraft()}
                onChange={(event) => setNodeApiBaseUrlDraft(event.target.value)}
                inputMode="url"
                spellCheck={false}
                type="text"
                value={nodeApiBaseUrlDraft}
              />
            </label>
            <button className="primary-button" type="submit">
              Refresh latest
            </button>
          </form>
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

      <nav className="view-nav" aria-label="Storage rent views">
        <a
          className={`view-tab ${activePage === 'transactions' ? 'view-tab-active' : ''}`}
          href={pageHashById.transactions}
        >
          Transactions
        </a>
        <a
          className={`view-tab ${activePage === 'daily-addresses' ? 'view-tab-active' : ''}`}
          href={pageHashById['daily-addresses']}
        >
          Daily by address
        </a>
      </nav>

      <section className="stats-grid">
        <article className="stat-card">
          <span className="label">Current Height</span>
          <strong>{state.nodeInfo ? formatCount(state.nodeInfo.fullHeight) : '...'}</strong>
          <p>
            {state.nodeInfo
              ? `Indexed ${formatCount(state.nodeInfo.indexedHeight)}`
              : nodeApiBaseUrl}
          </p>
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
          <p>Pulling the current tip, indexed height, and indexed block transaction payloads.</p>
        </section>
      ) : null}

      {!state.loadingInitial && !state.events.length ? (
        <section className="empty-state">
          <h2>No storage-rent transactions found in the loaded range.</h2>
          <p>Scroll or press refresh to scan the latest 20-block slice again.</p>
        </section>
      ) : null}

      {state.events.length && activePage === 'daily-addresses' ? (
        <>
          <section className="stats-grid daily-stats-grid">
            <article className="stat-card">
              <span className="label">Days</span>
              <strong>{formatCount(dailyAddressStats.dayCount)}</strong>
              <p>{formatCount(dailyAddressTotals.length)} address-day rows</p>
            </article>
            <article className="stat-card">
              <span className="label">Collector Addresses</span>
              <strong>{formatCount(dailyAddressStats.addressCount)}</strong>
              <p>Loaded range only</p>
            </article>
            <article className="stat-card stat-card-accent">
              <span className="label">Collector ERG</span>
              <strong>{formatErg(dailyAddressStats.totalNanoErg)}</strong>
              <p>Net daily sum across loaded collectors</p>
            </article>
          </section>

          {dailyAddressTotals.length ? (
            <section className="events-table-shell">
              <div className="events-table-scroll">
                <table className="events-table daily-address-table">
                  <thead>
                    <tr>
                      <th>Day</th>
                      <th>Address</th>
                      <th className="number-cell">Collector ERG</th>
                      <th className="number-cell">Rent Txs</th>
                      <th className="number-cell">Outputs</th>
                      <th>Height Range</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dailyAddressTotals.map((total) => (
                      <tr key={`${total.day}-${total.address}`}>
                        <td className="time-cell">{total.day}</td>
                        <td className="address-cell">
                          <a
                            className="address-link"
                            href={`${EXPLORER_UI_URL}/en/addresses/${total.address}`}
                            target="_blank"
                            rel="noreferrer"
                            title={total.address}
                          >
                            <CompactId value={total.address} visible={12} />
                          </a>
                        </td>
                        <td
                          className={`number-cell erg-total-cell ${
                            total.nanoErg < 0 ? 'negative-amount' : ''
                          }`}
                        >
                          {formatErg(total.nanoErg)}
                        </td>
                        <td className="number-cell">{formatCount(total.transactionCount)}</td>
                        <td className="number-cell">{formatCount(total.outputCount)}</td>
                        <td>{formatHeightRange(total.highestHeight, total.lowestHeight)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : (
            <section className="empty-state">
              <h2>No collector address totals in the loaded range.</h2>
              <p>Load older blocks to continue scanning.</p>
            </section>
          )}
        </>
      ) : null}

      {state.events.length && activePage === 'transactions' ? (
        <section className="events-table-shell">
          <div className="events-table-scroll">
            <table className="events-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Tx</th>
                  <th>Miner</th>
                  <th>Recipient Summary</th>
                </tr>
              </thead>
              <tbody>
                {state.events.map((event) => {
                  const recipients = rankRecipients(event);

                  return (
                    <tr key={event.txId}>
                      <td className="time-cell" title={new Date(event.timestamp).toISOString()}>
                        {formatDateTime(event.timestamp)}
                      </td>
                      <td className="tx-cell">
                        <div className="tx-stack">
                          <a
                            className="tx-link"
                            href={`${EXPLORER_UI_URL}/en/transactions/${event.txId}`}
                            target="_blank"
                            rel="noreferrer"
                            title={event.txId}
                          >
                            <CompactId value={event.txId} />
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
                                  title={chainTxId}
                                >
                                  <CompactId value={chainTxId} />
                                </a>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </td>
                      <td className="miner-cell">
                        {event.blockMinerAddress ? (
                          <a
                            className="miner-link"
                            href={`${EXPLORER_UI_URL}/en/addresses/${event.blockMinerAddress}`}
                            target="_blank"
                            rel="noreferrer"
                            title={event.blockMinerAddress}
                          >
                            <CompactId value={event.blockMinerAddress} />
                          </a>
                        ) : (
                          <span className="miner-missing">-</span>
                        )}
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
                                      <CompactId value={recipient.address} />
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
            onClick={
              activePage === 'daily-addresses'
                ? loadOneMoreDay
                : () => void loadMoreRef.current()
            }
          >
            {state.loadingMore
              ? activePage === 'daily-addresses'
                ? 'Loading another day...'
                : 'Loading older blocks...'
              : activePage === 'daily-addresses'
                ? 'Load one more day'
                : 'Load older blocks'}
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
