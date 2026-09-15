// Map Routes
import express from 'express';
import { geocodeAddress, getDirections } from '../services/external-apis/mapbox.js';

const router = express.Router();

router.post('/geocode', async (req, res) => {
  try {
    const { address } = req.body;
    const result = await geocodeAddress(address);
    res.json({ success: true, coordinates: result.coordinates, place: result.place });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/directions', async (req, res) => {
  try {
    const { start, end } = req.body;
    const result = await getDirections(start, end);
    res.json({ success: true, route: result.route });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
