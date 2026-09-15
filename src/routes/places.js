// Places Routes
import express from 'express';
import { searchPlaces, getPlaceDetails } from '../services/external-apis/google-places.js';

const router = express.Router();

router.get('/search', async (req, res) => {
  try {
    const { query, location } = req.query;
    const result = await searchPlaces(query, location);
    res.json({ success: true, results: result.results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:placeId', async (req, res) => {
  try {
    const result = await getPlaceDetails(req.params.placeId);
    res.json({ success: true, details: result.details });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
