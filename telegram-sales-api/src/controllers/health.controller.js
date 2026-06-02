const getHealth = (req, res) => {
  res.json({
    ok: true,
    service: 'api',
    timestamp: new Date().toISOString()
  });
};

module.exports = { getHealth };
