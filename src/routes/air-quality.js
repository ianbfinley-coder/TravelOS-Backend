// Air Quality Routes
import express from 'express';
import { getLatestAirQuality } from '../services/external-apis/openaq.js';

const router = express.Router();

router.get('/:latitude/:longitude', async (req, res) => {
  try {
    const { latitude, longitude } = req.params;
    const result = await getLatestAirQuality(parseFloat(latitude), parseFloat(longitude));
    res.json({ success: true, data: result.data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
