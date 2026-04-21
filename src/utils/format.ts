const ergFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 9,
});

const integerFormatter = new Intl.NumberFormat('en-US');

export const formatErg = (nanoErg: number) => `${ergFormatter.format(nanoErg / 1e9)} ERG`;

export const formatCount = (value: number) => integerFormatter.format(value);

export const formatAssetAmount = (amount: number, decimals = 0) => {
  const isNegative = amount < 0;
  const normalizedAmount = Math.abs(Math.trunc(amount));

  if (decimals <= 0) {
    return `${isNegative ? '-' : ''}${integerFormatter.format(normalizedAmount)}`;
  }

  const rawDigits = normalizedAmount.toString().padStart(decimals + 1, '0');
  const wholePart = rawDigits.slice(0, -decimals) || '0';
  const fractionalPart = rawDigits.slice(-decimals).replace(/0+$/, '');

  return `${isNegative ? '-' : ''}${integerFormatter.format(Number(wholePart))}${fractionalPart ? `.${fractionalPart}` : ''}`;
};

const dateTimeFormatter = new Intl.DateTimeFormat('de-DE', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export const formatDateTime = (timestamp: number) =>
  dateTimeFormatter.format(timestamp).replace(',', '');

export const shortenId = (value: string, visible = 10) => {
  if (value.length <= visible * 2) {
    return value;
  }
  return `${value.slice(0, visible)}...${value.slice(-visible)}`;
};

export const formatHeightRange = (
  highestHeight: number | null,
  lowestHeight: number | null,
) => {
  if (highestHeight === null || lowestHeight === null) {
    return 'Not loaded yet';
  }
  if (highestHeight === lowestHeight) {
    return formatCount(highestHeight);
  }
  return `${formatCount(highestHeight)} -> ${formatCount(lowestHeight)}`;
};

export const formatTokenLabel = (count: number) =>
  `${formatCount(count)} token ${count === 1 ? 'id' : 'ids'}`;
