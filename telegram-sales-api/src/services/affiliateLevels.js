const LEVELS = [
  { key: "NOVATO", label: "Novato", emoji: "🎖️", rate: 0.05 },
  { key: "BRONCE", label: "Bronce", emoji: "🥉", rate: 0.08 },
  { key: "PLATA", label: "Plata", emoji: "🥈", rate: 0.12 },
  { key: "ORO", label: "Oro", emoji: "🥇", rate: 0.15 },
  { key: "DIAMANTE", label: "Diamante", emoji: "💎", rate: 0.2 },
  { key: "ELITE", label: "Elite", emoji: "👑", rate: 0.3 },
];

function getBaseLevelIndex(salesTotal, earningsTotal) {
  if (salesTotal >= 200 && earningsTotal >= 800) return 5;
  if (salesTotal >= 100 && earningsTotal >= 500) return 4;
  if (salesTotal >= 40 && earningsTotal >= 200) return 3;
  if (salesTotal >= 20 && earningsTotal >= 50) return 2;
  if (salesTotal >= 2 && earningsTotal >= 5) return 1;
  return 0;
}

function getAffiliateLevel({ salesTotal, earningsTotal, daysSinceLastSale }) {
  const baseIndex = getBaseLevelIndex(salesTotal, earningsTotal);
  let downgradeSteps = 0;
  if (Number.isFinite(daysSinceLastSale) && daysSinceLastSale >= 30) {
    downgradeSteps = Math.floor(daysSinceLastSale / 30);
  }
  const index = Math.max(0, baseIndex - downgradeSteps);
  const level = LEVELS[index];
  return {
    index,
    ...level,
  };
}

module.exports = {
  getAffiliateLevel,
};
