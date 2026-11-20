// Presentation of existing strategy counters; content handlers remain their only writers.
export function bandProgressView(ps) {
  const band = ps.bandId ? ps.gd.band(ps.bandId) : null;
  const buff = band?.buffs?.find(b => b.key === 'refresh_shop_count_gain_coin_bond_char_chess');
  if (!buff) return null;
  const params = { ...buff.bb, ...buff.bbStr };
  const positive = n => Number.isFinite(n) && Math.trunc(n) > 0 ? Math.trunc(n) : null;
  const count = key => Number.isFinite(ps.counters[key]) ? Math.max(0, Math.trunc(ps.counters[key])) : 0;
  const total = positive(params.refresh_count), limit = positive(params.max_count);
  if (!total) return null;
  // The 规程 handler counts the cycle within the round (roundStats().refreshes); the 下半 one counts the whole match.
  // Reading either source must not reset it.
  const refreshes = ps.gd?.raw?.config?.version?.family === 'regulation'
    ? (Number.isFinite(ps.round?.refreshes) ? Math.max(0, Math.trunc(ps.round.refreshes)) : 0)
    : count('band:chiave:refreshes');
  // Round counters reset lazily in the content handler. Reading a view must not reset them.
  const rewards = ps.counters['band:chiave:r'] === ps.m.round ? count('band:chiave') : 0;
  return {
    progress: { current: refreshes % total, total },
    ...(limit ? { roundProgress: { current: rewards, total: limit } } : {}),
  };
}
