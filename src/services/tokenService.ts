import type { IndexedToken } from '../types/ergoNode';

const TOKEN_METADATA_CACHE_KEY = 'sr-tracker:token-metadata:v1';

const tokenMetadataCache = new Map<string, IndexedToken>();
const tokenMetadataRequestCache = new Map<string, Promise<IndexedToken>>();

let hydrated = false;

const canUseStorage = () =>
  typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

const hydrateTokenMetadataCache = () => {
  if (hydrated || !canUseStorage()) {
    hydrated = true;
    return;
  }

  hydrated = true;

  try {
    const rawCache = window.localStorage.getItem(TOKEN_METADATA_CACHE_KEY);
    if (!rawCache) {
      return;
    }

    const parsedCache = JSON.parse(rawCache) as Record<string, IndexedToken>;
    Object.values(parsedCache).forEach((tokenMetadata) => {
      tokenMetadataCache.set(tokenMetadata.id, tokenMetadata);
    });
  } catch {
    window.localStorage.removeItem(TOKEN_METADATA_CACHE_KEY);
  }
};

const persistTokenMetadataCache = () => {
  if (!canUseStorage()) {
    return;
  }

  try {
    const serializedCache = Object.fromEntries(tokenMetadataCache.entries());
    window.localStorage.setItem(TOKEN_METADATA_CACHE_KEY, JSON.stringify(serializedCache));
  } catch {
    // Ignore storage quota and serialization failures. The in-memory cache still works.
  }
};

const fetchJson = async <T>(url: string): Promise<T> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Ergo node error (${response.status}): ${response.statusText}`);
  }
  return (await response.json()) as T;
};

const fetchTokenMetadata = async (nodeUrl: string, tokenId: string) => {
  hydrateTokenMetadataCache();

  const cachedToken = tokenMetadataCache.get(tokenId);
  if (cachedToken) {
    return cachedToken;
  }

  if (!tokenMetadataRequestCache.has(tokenId)) {
    const request = fetchJson<IndexedToken>(`${nodeUrl}/blockchain/token/byId/${tokenId}`)
      .then((tokenMetadata) => {
        tokenMetadataCache.set(tokenId, tokenMetadata);
        persistTokenMetadataCache();
        return tokenMetadata;
      })
      .finally(() => {
        tokenMetadataRequestCache.delete(tokenId);
      });

    tokenMetadataRequestCache.set(tokenId, request);
  }

  return tokenMetadataRequestCache.get(tokenId)!;
};

export const getCachedTokenMetadata = () => {
  hydrateTokenMetadataCache();
  return Object.fromEntries(tokenMetadataCache.entries());
};

export const loadTokenMetadata = async (nodeUrl: string, tokenIds: string[]) => {
  hydrateTokenMetadataCache();

  const uniqueTokenIds = Array.from(new Set(tokenIds.filter(Boolean)));
  const results = await Promise.allSettled(
    uniqueTokenIds.map((tokenId) => fetchTokenMetadata(nodeUrl, tokenId)),
  );

  const loadedMetadata: Record<string, IndexedToken> = {};

  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      loadedMetadata[uniqueTokenIds[index]] = result.value;
    }
  });

  return loadedMetadata;
};
